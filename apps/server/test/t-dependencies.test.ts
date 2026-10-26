import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { listEvents } from '../src/write.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';
import { analyzeTaskDependencies, inferAndApplyTaskDependencies } from '../src/dependencies.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('Phase 7 依赖推导: RAW 读写依赖自动发现与 WAW 并发写冲突告警', () => {
  // 1. 纯算法层测试：任务 A 产出，任务 B 读取，任务 C 产生写冲突
  const taskA = {
    id: 'AUTH-1',
    boardId: 'b-dep',
    title: '实现身份鉴权模块',
    files: ['src/auth/jwt.ts', 'src/auth/token.ts'],
    reads: [],
    dependsOn: [],
    lane: 'Backlog',
  } as unknown as import('../src/tasks.ts').Task;

  const taskB = {
    id: 'HTTP-2',
    boardId: 'b-dep',
    title: '挂载 HTTP 路由鉴权中间件',
    files: ['src/http/router.ts'],
    reads: ['src/auth/jwt.ts'], // 读取了 AUTH-1 产出的文件
    dependsOn: [], // 漏配了 dependsOn
    lane: 'Backlog',
  } as unknown as import('../src/tasks.ts').Task;

  const taskC = {
    id: 'TOKEN-3',
    boardId: 'b-dep',
    title: '调整 token 格式',
    files: ['src/auth/token.ts'], // 与 AUTH-1 存在 WAW 冲突
    reads: [],
    dependsOn: [], // 未声明先后关系
    lane: 'Backlog',
  } as unknown as import('../src/tasks.ts').Task;

  const analysis = analyzeTaskDependencies([taskA, taskB, taskC]);

  // RAW 检验
  assert.equal(analysis.inferredDependencies.length, 1);
  const rawDep = analysis.inferredDependencies[0];
  assert.equal(rawDep.taskId, 'HTTP-2');
  assert.equal(rawDep.targetTaskId, 'AUTH-1');
  assert.equal(rawDep.type, 'RAW');
  assert.equal(rawDep.file, 'src/auth/jwt.ts');
  assert.ok(rawDep.reason.includes('读取文件'));

  // WAW 检验
  assert.equal(analysis.writeConflicts.length, 1);
  const waw = analysis.writeConflicts[0];
  assert.ok(
    (waw.taskA === 'AUTH-1' && waw.taskB === 'TOKEN-3') ||
    (waw.taskA === 'TOKEN-3' && waw.taskB === 'AUTH-1'),
  );
  assert.deepEqual(waw.files, ['src/auth/token.ts']);
  assert.ok(waw.warning.includes('并发写入冲突'));
});

test('Phase 7 依赖推导: 严格环路保护，绝不引入循环依赖死锁', () => {
  // 任务 A 已经 dependsOn 任务 B；即使任务 B 读取 A 的文件，算法也绝不推导 B dependsOn A
  const taskA = {
    id: 'A-1',
    boardId: 'b-cycle',
    title: '任务 A',
    files: ['shared/schema.ts'],
    reads: [],
    dependsOn: ['B-2'], // A 已经明确依赖 B
    lane: 'Backlog',
  } as unknown as import('../src/tasks.ts').Task;

  const taskB = {
    id: 'B-2',
    boardId: 'b-cycle',
    title: '任务 B',
    files: ['shared/types.ts'],
    reads: ['shared/schema.ts'], // B 想读 A 的文件
    dependsOn: [],
    lane: 'Backlog',
  } as unknown as import('../src/tasks.ts').Task;

  const analysis = analyzeTaskDependencies([taskA, taskB]);
  assert.equal(analysis.inferredDependencies.length, 0, '环路检测生效：不产生导致死锁的环路依赖');
});

test('Phase 7 依赖推导: 一键自动应用批量修补、台账落库与 HTTP / 工具面验证', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-patch', name: 'Patch Board' });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen',
      handle: 'queen-dep',
      role: 'orchestrator',
    });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, {
      name: 'Worker',
      handle: 'worker-dep',
      role: 'worker',
    });

    // 创建有 RAW 关系的两张卡
    createTask(rig.ctx, 'b-patch', {
      id: 'BASE-1',
      title: '底层数据模型定义',
      files: ['src/models.ts'],
      lane: 'Backlog',
    });
    createTask(rig.ctx, 'b-patch', {
      id: 'SERVICE-2',
      title: '业务服务层实现',
      files: ['src/service.ts'],
      reads: ['src/models.ts'],
      lane: 'Backlog',
    });

    const app = createApp(rig.ctx);

    // 1. dryRun = true 查询推导报告，不实际修改
    const dryRes = await app.request('/boards/b-patch/tasks/infer-dependencies', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ apply: false }),
    });
    assert.equal(dryRes.status, 200);
    const dryData = (await dryRes.json()) as { inferredDependencies: unknown[]; appliedCount: number };
    assert.equal(dryData.inferredDependencies.length, 1);
    assert.equal(dryData.appliedCount, 0);
    assert.deepEqual(getTask(rig.ctx, 'SERVICE-2').dependsOn, [], 'dryRun 模式不修改数据库');

    // 2. apply = true 自动批量修补依赖
    const applyRes = await app.request('/boards/b-patch/tasks/infer-dependencies', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ apply: true }),
    });
    assert.equal(applyRes.status, 200);
    const applyData = (await applyRes.json()) as { appliedCount: number };
    assert.equal(applyData.appliedCount, 1);

    // 验证数据库任务已自动加上 dependsOn: ['BASE-1']
    const updatedService = getTask(rig.ctx, 'SERVICE-2');
    assert.deepEqual(updatedService.dependsOn, ['BASE-1'], 'SERVICE-2 成功自动挂接依赖 BASE-1');

    // 检查事件台账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'dependencies.inferred_applied'), 'dependencies.inferred_applied 入台账');

    // 3. 蜂后协议工具 asterhive_infer_dependencies 调用
    const inferTool = TOOL_DEFS.find((t) => t.name === 'asterhive_infer_dependencies');
    assert.ok(inferTool, 'asterhive_infer_dependencies 工具已注册');

    const toolResult = (await inferTool.handle(rig.ctx, queen, {
      boardId: 'b-patch',
      apply: false,
    })) as { inferredDependencies: unknown[] };
    assert.ok(toolResult);

    // 4. 权限隔离：普通 worker 调用报 403
    await assert.rejects(
      async () => inferTool.handle(rig.ctx, worker, { boardId: 'b-patch' }),
      /workers cannot infer or modify/,
      'worker 调用报 403',
    );
  } finally {
    rig.cleanup();
  }
});
