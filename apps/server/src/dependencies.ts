import type { Ctx } from './types.ts';
import { listTasks, addDependencies, type Task } from './tasks.ts';
import type { Agent } from './agents.ts';
import { logEvent, withWrite } from './write.ts';

export interface InferredDependency {
  taskId: string;
  targetTaskId: string;
  type: 'RAW' | 'WAW';
  file: string;
  reason: string;
}

export interface WriteConflict {
  taskA: string;
  taskB: string;
  files: string[];
  warning: string;
}

export interface DependencyInferenceReport {
  boardId: string;
  inferredDependencies: InferredDependency[];
  writeConflicts: WriteConflict[];
  appliedCount: number;
}

/**
 * 路径重叠/匹配判断：
 * 标准化路径（POSIX 斜杠），匹配完全相等或父子目录从属关系。
 */
function pathOverlaps(p1: string, p2: string): boolean {
  const norm1 = p1.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const norm2 = p2.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;
  if (norm1.startsWith(norm2 + '/')) return true;
  if (norm2.startsWith(norm1 + '/')) return true;
  return false;
}

/**
 * 有向图判环：检查若添加 edge (u -> v) 是否会产生环路。
 */
function wouldCreateCycle(graph: Map<string, Set<string>>, from: string, to: string): boolean {
  if (from === to) return true;
  // DFS 查找是否已存在 to -> from 的路径（若已有路径，再加 from -> to 即成环）
  const visited = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === from) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const neighbors = graph.get(curr);
    if (neighbors) {
      for (const n of neighbors) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }
  return false;
}

/**
 * 拓扑关系检查：判断两个任务在当前依赖图上是否已存在先后偏序。
 */
function hasOrdering(graph: Map<string, Set<string>>, a: string, b: string): boolean {
  return !wouldCreateCycle(graph, a, b) === false || !wouldCreateCycle(graph, b, a) === false;
}

/**
 * 依赖推导与所有权分析算法：
 * 1. RAW (Read-after-Write): 任务 B 读取了任务 A 写入的文件 -> 推导 B dependsOn A
 * 2. WAW (Write-after-Write): 任务 A 与 B 同时修改相同文件且未声明偏序 -> 报警写冲突并建议偏序
 * 3. 严格环路保护，绝不引入循环依赖死锁
 */
export function analyzeTaskDependencies(tasks: Task[]): {
  inferredDependencies: InferredDependency[];
  writeConflicts: WriteConflict[];
} {
  // 构建当前依赖图：task -> 其所依赖的 targets
  const graph = new Map<string, Set<string>>();
  for (const t of tasks) {
    graph.set(t.id, new Set(t.dependsOn ?? []));
  }

  const inferred: InferredDependency[] = [];
  const conflicts: WriteConflict[] = [];

  // 1. RAW 分析：遍历每对任务 (producer, consumer)
  for (let i = 0; i < tasks.length; i++) {
    const producer = tasks[i];
    const writes = producer.files ?? [];
    if (writes.length === 0) continue;

    for (let j = 0; j < tasks.length; j++) {
      if (i === j) continue;
      const consumer = tasks[j];
      const reads = consumer.reads ?? [];
      if (reads.length === 0) continue;

      // 寻找 reads 与 writes 的重叠文件
      for (const r of reads) {
        const matchingWrite = writes.find((w) => pathOverlaps(w, r));
        if (matchingWrite) {
          // 检查 consumer 是否已经直接或间接依赖 producer
          const currentDeps = graph.get(consumer.id);

          if (!currentDeps?.has(producer.id)) {
            // 环路检查：加 consumer -> producer
            if (!wouldCreateCycle(graph, consumer.id, producer.id)) {
              inferred.push({
                taskId: consumer.id,
                targetTaskId: producer.id,
                type: 'RAW',
                file: matchingWrite,
                reason: `任务 ${consumer.id} 读取文件「${r}」，该文件由先行任务 ${producer.id} 产出/修改`,
              });
              // 乐观加入图，防止后续重复或逆向成环
              currentDeps?.add(producer.id);
            }
          }
          break;
        }
      }
    }
  }

  // 2. WAW 分析：并发写文件冲突检测与偏序建议
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const tA = tasks[i];
      const tB = tasks[j];
      const writesA = tA.files ?? [];
      const writesB = tB.files ?? [];
      if (writesA.length === 0 || writesB.length === 0) continue;

      const overlap = writesA.filter((wa) => writesB.some((wb) => pathOverlaps(wa, wb)));
      if (overlap.length > 0) {
        // 检查两任务间是否已有前后依赖先后次序
        const ordered = hasOrdering(graph, tA.id, tB.id);
        if (!ordered) {
          conflicts.push({
            taskA: tA.id,
            taskB: tB.id,
            files: overlap,
            warning: `并发写入冲突：任务 ${tA.id} 与 ${tB.id} 预期同时修改文件 [${overlap.join(', ')}]，但未声明依赖先后次序。`,
          });
        }
      }
    }
  }

  return { inferredDependencies: inferred, writeConflicts: conflicts };
}

/**
 * 对看板中的活跃任务执行依赖推导，可选自动应用到任务卡。
 */
export function inferAndApplyTaskDependencies(
  ctx: Ctx,
  actor: Agent,
  boardId: string,
  dryRun = true,
): DependencyInferenceReport {
  // 仅对未完成的活跃任务进行依赖分析
  const activeTasks = listTasks(ctx, boardId).filter((t) => t.lane !== 'Done');
  const { inferredDependencies, writeConflicts } = analyzeTaskDependencies(activeTasks);

  let appliedCount = 0;
  if (!dryRun && inferredDependencies.length > 0) {
    // 按 taskId 归并待新增的依赖
    const additionsByTask = new Map<string, Set<string>>();
    for (const item of inferredDependencies) {
      if (!additionsByTask.has(item.taskId)) {
        additionsByTask.set(item.taskId, new Set());
      }
      additionsByTask.get(item.taskId)!.add(item.targetTaskId);
    }

    for (const [taskId, newDeps] of additionsByTask.entries()) {
      addDependencies(ctx, actor, taskId, [...newDeps]);
      appliedCount += newDeps.size;
    }

    withWrite(ctx, 'dependencies.inferred_applied', () => {
      logEvent(ctx, 'dependencies.inferred_applied', {
        boardId,
        inferredCount: inferredDependencies.length,
        appliedCount,
        actorId: actor.id,
      });
    });
  }

  return {
    boardId,
    inferredDependencies,
    writeConflicts,
    appliedCount,
  };
}
