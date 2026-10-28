import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RepoManager } from '../src/repo-manager.ts';
import { registerAgent } from '../src/agents.ts';
import {
  createBoard,
  createTask,
  getTask,
  listTasks,
  updateTask,
  cancelTask,
  claimTaskForReview,
  finalizeTaskReview,
  returnTaskFromReview,
  setBoardRepoState,
  type Task,
} from '../src/tasks.ts';
import { claimTask, submitTask, checkpointTask, nextTask, releaseTask } from '../src/verbs.ts';
import { createApp } from '../src/http.ts';
import { listEvents } from '../src/write.ts';
import { listMessages } from '../src/messages.ts';
import { getFleetRadar } from '../src/fleet-radar.ts';
import { withTaskIntegrationLock } from '../src/task-integration-lock.ts';
import { createOrchestratorGroup, putOrchestratorSettings } from '../src/settings.ts';
import { releaseStuckTask } from '../src/worker-control.ts';
function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('T105: 保活心跳与真实进展分离，保活刷新租约但真实活动才刷新 progress.lastActivityAt', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'prog-b1', name: 'Progress' });
    const workerReg = registerAgent(rig.ctx, { id: 'w1', name: 'Worker 1', handle: 'w1', role: 'worker' });
    createTask(rig.ctx, board.id, { id: 'T105-1', title: 'Task with keepalive', lane: 'Ready', assignee: 'w1' });
    claimTask(rig.ctx, workerReg.agent, 'T105-1');

    const t0 = getTask(rig.ctx, 'T105-1');
    assert.ok(t0.claimedAt);
    const initialRealActivityAt = t0.progress?.lastActivityAt;
    assert.equal(initialRealActivityAt, null, '首认领初始无真实活动，应为 null');

    // 1. 发送显式保活心跳：推进 lastActivityAt 维持租约，但绝不推进真实活动时钟 progress.lastActivityAt
    const cpKeepalive = checkpointTask(rig.ctx, workerReg.agent, 'T105-1', {
      note: '进行中：任务持续执行（已耗时约 5 分钟）',
      kind: 'keepalive',
      isKeepalive: true,
    });
    assert.ok(cpKeepalive.task.lastActivityAt! >= t0.lastActivityAt!, '保活心跳必须刷新租约时钟 lastActivityAt');
    assert.equal(cpKeepalive.task.progress?.lastActivityAt, initialRealActivityAt, '显式保活不应更新 progress.lastActivityAt');
    assert.equal(cpKeepalive.task.lastRealActivityAt, initialRealActivityAt, '显式保活不应更新 lastRealActivityAt');

    // 2. 发送旧工蜂文本保活心跳（兼容旧工蜂）：亦不应推进 progress.lastActivityAt
    const cpLegacyKeepalive = checkpointTask(rig.ctx, workerReg.agent, 'T105-1', '进行中：任务持续执行（已耗时约 10 分钟）');
    assert.equal(cpLegacyKeepalive.task.progress?.lastActivityAt, initialRealActivityAt, '旧工蜂保活文本不应更新 progress.lastActivityAt');

    // 3. 真实里程碑/工具活动：推进租约时钟与真实活动时钟
    const cpReal = checkpointTask(rig.ctx, workerReg.agent, 'T105-1', {
      note: '单元测试已通过，生成结果',
      kind: 'milestone',
    });
    assert.ok(cpReal.task.progress?.lastActivityAt! >= initialRealActivityAt, '真实里程碑必须更新 progress.lastActivityAt');
    assert.equal(cpReal.task.progress?.lastActivityKind, 'milestone');
  } finally {
    rig.cleanup();
  }
});

test('T105 长任务模拟: 长时间运行每分钟保活，确保 sweep 不释放、不被他人接管，同时正确呈现无进展提示', async () => {
  // 创建一个 TTL 为 2 分钟的小超时测试 Rig
  const rig = mkRig(2);
  try {
    const board = createBoard(rig.ctx, { id: 'long-b', name: 'Long Task Board' });
    const worker1 = registerAgent(rig.ctx, { id: 'w-long1', name: 'Worker 1', handle: 'w-long1', role: 'worker' }).agent;
    const worker2 = registerAgent(rig.ctx, { id: 'w-long2', name: 'Worker 2', handle: 'w-long2', role: 'worker' }).agent;

    createTask(rig.ctx, board.id, { id: 'LONG-1', title: 'Heavy computing task', lane: 'Ready', assignee: 'w-long1' });
    claimTask(rig.ctx, worker1, 'LONG-1');

    // 模拟任务实际已运行 10 分钟（远超 2 分钟 TTL 阈值）
    const now = Date.now();
    const tenMinsAgo = now - 10 * 60_000;
    rig.ctx.holder.db.prepare('UPDATE task SET claimed_at = ?, last_real_activity_at = ?, last_progress_at = ? WHERE id = ?')
      .run(tenMinsAgo, tenMinsAgo, tenMinsAgo, 'LONG-1');

    // 模拟工蜂每分钟持续发送保活心跳（最新一次保活在 10 秒前）
    const tenSecsAgo = now - 10_000;
    rig.ctx.holder.db.prepare('UPDATE task SET last_activity_at = ? WHERE id = ?').run(tenSecsAgo, 'LONG-1');
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(tenSecsAgo, 'w-long1');

    // Worker 2 尝试执行 nextTask（会触发 sweepStale 扫掠）
    const nextResult = nextTask(rig.ctx, worker2, board.id);
    assert.deepEqual(nextResult.swept, [], '由于工蜂持续保活维持租约，正常长任务绝不能被 sweep 误判释放');
    assert.equal(nextResult.task, null, '未释放的任务不得被其他工蜂重复领取');

    // 检查任务当前状态：必须依然保持 InProgress，指派人依然为 worker1
    const currentTask = getTask(rig.ctx, 'LONG-1');
    assert.equal(currentTask.lane, 'InProgress');
    assert.equal(currentTask.assignee, 'w-long1');

    // 契约校验：界面必须正确提示无真实活动（no_recent_activity）
    assert.ok(currentTask.progress);
    assert.equal(currentTask.progress?.status, 'no_recent_activity', '虽有保活，但超 3 分钟无真实活动必须提示 no_recent_activity');

    // 随后工蜂汇报真实工具进展
    const realCp = checkpointTask(rig.ctx, worker1, 'LONG-1', {
      note: '重型静态分析通过，进入代码生成阶段',
      kind: 'tool',
    });
    assert.equal(realCp.task.progress?.status, 'active', '收到真实工具活动后状态立即恢复 active');
    assert.ok(realCp.task.progress?.lastActivityAt! >= now);
  } finally {
    rig.cleanup();
  }
});

test('T105 UI 契约: task.progress 状态投影字段在各运行状态下的行为', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'prog-b2', name: 'Progress' });
    const workerReg = registerAgent(rig.ctx, { id: 'w2', name: 'Worker 2', handle: 'w2', role: 'worker' });
    createTask(rig.ctx, board.id, { id: 'T105-2', title: 'Progress projection', lane: 'Ready', assignee: 'w2' });

    // Ready 泳道：无 InProgress 执行实例，progress 应为 null
    let task = getTask(rig.ctx, 'T105-2');
    assert.equal(task.progress, null, '未开始执行的任务 progress 为 null');

    // 工蜂在线心跳正常
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now(), 'w2');
    claimTask(rig.ctx, workerReg.agent, 'T105-2');
    task = getTask(rig.ctx, 'T105-2');
    assert.ok(task.progress, 'InProgress 任务必须具备 progress 投影');
    assert.equal(typeof task.progress?.workerLastSeenAt, 'number');
    assert.equal(task.progress?.lastActivityAt, null, '首帧未观测到真实活动应为 null');
    assert.equal(task.progress?.status, 'unknown', '首帧未观测到真实活动应为 unknown');

    // 产生真实工具活动后转为 active
    checkpointTask(rig.ctx, workerReg.agent, 'T105-2', { note: '运行工具', kind: 'tool' });
    task = getTask(rig.ctx, 'T105-2');
    assert.equal(typeof task.progress?.lastActivityAt, 'number');
    assert.equal(task.progress?.status, 'active');
    // 模拟工蜂长时间未活动（> 3 分钟），但工蜂仍然在线（心跳正常）
    const staleTime = Date.now() - 200_000;
    rig.ctx.holder.db.prepare('UPDATE task SET last_real_activity_at = ? WHERE id = ?').run(staleTime, 'T105-2');
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now(), 'w2');

    task = getTask(rig.ctx, 'T105-2');
    assert.equal(task.progress?.status, 'no_recent_activity', '工蜂在线但无活动必须投影为 no_recent_activity');

    // 模拟工蜂离线（> 60 秒无心跳）
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now() - 90_000, 'w2');
    task = getTask(rig.ctx, 'T105-2');
    assert.equal(task.progress?.status, 'offline', '工蜂失联必须投影为 offline');

    // 模拟无活动记录的旧工蜂任务
    rig.ctx.holder.db.prepare('UPDATE task SET last_real_activity_at = NULL, claimed_at = ? WHERE id = ?').run(Date.now(), 'T105-2');
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now(), 'w2');
    task = getTask(rig.ctx, 'T105-2');
    assert.equal(task.progress?.status, 'unknown', '未观测到活动的任务必须投影为 unknown');
  } finally {
    rig.cleanup();
  }
});

test('T105: 舰队雷达针对只有保活无进展的任务准确发出停滞预警', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'prog-b3', name: 'Fleet' });
    const workerReg = registerAgent(rig.ctx, { id: 'w3', name: 'Worker 3', handle: 'w3', role: 'worker' });
    createTask(rig.ctx, board.id, { id: 'T105-3', title: 'Stagnant task', lane: 'Ready', assignee: 'w3' });
    claimTask(rig.ctx, workerReg.agent, 'T105-3');

    // 模拟任务已认领 20 分钟，但自 15 分钟前以来只有保活心跳、无真实活动
    const now = Date.now();
    const twentyMinsAgo = now - 20 * 60_000;
    const fifteenMinsAgo = now - 15 * 60_000;
    rig.ctx.holder.db.prepare('UPDATE task SET claimed_at = ?, last_real_activity_at = ? WHERE id = ?')
      .run(twentyMinsAgo, fifteenMinsAgo, 'T105-3');
    rig.ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(now, 'w3');

    const radar = getFleetRadar(rig.ctx);
    const alert = radar.alerts.find((a) => a.taskId === 'T105-3');
    assert.ok(alert, '雷达必须产生停滞预警');
    assert.equal(alert?.agentId, 'w3');
    assert.ok(alert?.idleCheckpointMinutes >= 10, '空闲时间必须反映真实无活动间隔');
  } finally {
    rig.cleanup();
  }
});

test('跨任务与迟到数据隔离: 越权工蜂、已终结任务与迟到提交安全阻断', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'prog-b4', name: 'Isolation' });
    const workerA = registerAgent(rig.ctx, { id: 'wa', name: 'Worker A', handle: 'wa', role: 'worker' }).agent;
    const workerB = registerAgent(rig.ctx, { id: 'wb', name: 'Worker B', handle: 'wb', role: 'worker' }).agent;
    const user = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' }).agent;

    createTask(rig.ctx, board.id, { id: 'T105-4', title: 'Isolation task', lane: 'Ready', assignee: 'wa' });
    claimTask(rig.ctx, workerA, 'T105-4');

    // 1. Worker B 尝试对 Worker A 的任务进行 checkpoint 应被拒绝 (403)
    assert.throws(
      () => checkpointTask(rig.ctx, workerB, 'T105-4', 'Worker B trying to interfere'),
      /only assignee/i,
    );

    // 2. 任务已提交到 Review 泳道后，迟到的 InProgress checkpoint 必须拒绝 (409)
    submitTask(rig.ctx, workerA, 'T105-4', { summary: 'Initial submission' });
    assert.throws(
      () => checkpointTask(rig.ctx, workerA, 'T105-4', 'Late checkpoint after submit'),
      /not InProgress/i,
    );

    // 3. 已取消的任务禁止任何工蜂认领或 checkpoint
    createTask(rig.ctx, board.id, { id: 'T105-5', title: 'Cancelled task', lane: 'Ready', assignee: 'wa' });
    await cancelTask(rig.ctx, user, 'T105-5', '用户取消');
    assert.throws(() => claimTask(rig.ctx, workerA, 'T105-5'), /cancelled/i);
    assert.throws(() => checkpointTask(rig.ctx, workerA, 'T105-5', 'Note'), /cancelled|not InProgress/i);

    // 4. 执行尝试代次隔离 (attempt fencing)：持有旧代次的迟到数据必须拒绝 (409)
    createTask(rig.ctx, board.id, { id: 'T105-6', title: 'Fenced task', lane: 'Ready', assignee: 'wa' });
    const claimed = claimTask(rig.ctx, workerA, 'T105-6');
    const firstAttempt = claimed.attempt;
    assert.ok(firstAttempt >= 1);

    submitTask(rig.ctx, workerA, 'T105-6', { summary: 'First submit', attempt: firstAttempt });
    // 退回重做，代次自增
    const reworked = await returnTaskFromReview(rig.ctx, user, 'T105-6', { reason: 'Rework needed' });
    assert.equal(reworked.attempt, firstAttempt + 1);

    // 来自旧代次 firstAttempt 的迟到 checkpoint 必须被拒绝 (409)
    assert.throws(
      () => checkpointTask(rig.ctx, workerA, 'T105-6', { note: 'Late data from old attempt', attempt: firstAttempt }),
      /stale execution attempt/i,
    );

    // 来自旧代次 firstAttempt 的迟到 submit 必须被拒绝 (409)
    assert.throws(
      () => submitTask(rig.ctx, workerA, 'T105-6', { summary: 'Late submit from old attempt', attempt: firstAttempt }),
      /stale execution attempt/i,
    );

    // 新代次的正常 checkpoint 必须成功
    const cpOk = checkpointTask(rig.ctx, workerA, 'T105-6', { note: 'Fresh attempt checkpoint', attempt: reworked.attempt });
    assert.ok(cpOk.task);
  } finally {
    rig.cleanup();
  }
});

test('T107: Review 任务可由用户/主脑安全退回指定工蜂重做，权限隔离并原子记录历史', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'rev-b1', name: 'Review Return', repoMode: 'managed', repoStatus: 'ready' });
    const user = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' }).agent;
    const workerA = registerAgent(rig.ctx, { id: 'wa', name: 'Worker A', handle: 'wa', role: 'worker' }).agent;
    const workerB = registerAgent(rig.ctx, { id: 'wb', name: 'Worker B', handle: 'wb', role: 'worker' }).agent;

    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });

    createTask(rig.ctx, board.id, { id: 'T107-1', title: 'Task in review', lane: 'Ready', assignee: 'wa' });
    claimTask(rig.ctx, workerA, 'T107-1');
    submitTask(rig.ctx, workerA, 'T107-1', { summary: 'Ready for review' });

    let t = getTask(rig.ctx, 'T107-1');
    assert.equal(t.lane, 'Review');
    assert.equal(t.reviewStatus, 'pending');

    // 1. 普通工蜂无权退回 Review 任务 (403)
    await assert.rejects(
      async () => returnTaskFromReview(rig.ctx, workerA, 'T107-1', { reason: '工蜂自己退回' }),
      /only user or orchestrator/i,
    );

    // 2. 用户明确退回重做并指派回 workerA（退回原工蜂）
    const returned = await returnTaskFromReview(rig.ctx, user, 'T107-1', {
      reason: '缺少边界校验，请补充测试后重提',
      assignee: 'wa',
    });

    assert.equal(returned.lane, 'InProgress', '退回后泳道必须回到 InProgress');
    assert.equal(returned.reviewStatus, 'rework', 'reviewStatus 必须为 rework');
    assert.equal(returned.reviewReworks, 1, '重做计数必须自增');
    assert.equal(returned.assignee, 'wa', '指派人必须为目标工蜂');
    assert.equal(returned.reviewSummary, '缺少边界校验，请补充测试后重提');

    // 历史审计与消息
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'task.review_returned' && e.payload.taskId === 'T107-1'));
    assert.ok(events.some((e) => e.type === 'task.lane_changed' && e.payload.taskId === 'T107-1' && e.payload.to === 'InProgress'));
    const messages = listMessages(rig.ctx, board.id);
    assert.ok(messages.some((m) => m.content.includes('@wa') && m.content.includes('缺少边界校验')));

    // 3. 处于 rework 的 InProgress 任务不能被 reviewer 误认领或误审核
    assert.equal(claimTaskForReview(rig.ctx, 'T107-1'), null, 'InProgress 任务绝对不可被 review 认领');

    // 4. 用户亦可通过退回指令改派给另一只指定工蜂 (workerB)
    submitTask(rig.ctx, workerA, 'T107-1', { summary: 'Resubmitted', attempt: returned.attempt });
    assert.equal(getTask(rig.ctx, 'T107-1').lane, 'Review');

    const reassigned = await returnTaskFromReview(rig.ctx, user, 'T107-1', {
      reason: '改由 Worker B 处理架构适配',
      assignee: 'wb',
    });
    assert.equal(reassigned.lane, 'InProgress');
    assert.equal(reassigned.assignee, 'wb', '退回时指定新工蜂必须生效');
  } finally {
    rig.cleanup();
  }
});

test('T107 并发安全: Review 退回与代码集成锁互斥，避免并发合并竞态', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'rev-b2', name: 'Lock Race', repo: '' });
    const user = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' }).agent;
    const worker = registerAgent(rig.ctx, { id: 'w-race', name: 'Worker Race', handle: 'w-race', role: 'worker' }).agent;

    createTask(rig.ctx, board.id, { id: 'T107-2', title: 'Integration race', lane: 'Ready', assignee: 'w-race' });
    claimTask(rig.ctx, worker, 'T107-2');
    submitTask(rig.ctx, worker, 'T107-2', { summary: 'Submitted' });

    // 模拟正在进行 git 仓库集成，持有该 task 锁
    const { promise: integrationRunning, resolve: finishIntegration } = Promise.withResolvers<void>();
    const integrationPromise = withTaskIntegrationLock('T107-2', async () => {
      await integrationRunning;
    });

    let returnFinished = false;
    const returnPromise = returnTaskFromReview(rig.ctx, user, 'T107-2', { reason: '退回' }).then((res) => {
      returnFinished = true;
      return res;
    });

    await Promise.resolve();
    assert.equal(returnFinished, false, '在集成锁释放前，Review 退回操作必须被互斥阻塞');

    finishIntegration();
    await integrationPromise;
    const res = await returnPromise;
    assert.equal(res.lane, 'InProgress');
    assert.equal(returnFinished, true);
  } finally {
    rig.cleanup();
  }
});

test('T107 HTTP 端点: POST /tasks/:id/review/return 与 /tasks/:id/review/reject', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'rev-b3', name: 'HTTP Return' });
    const userReg = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' });
    const workerReg = registerAgent(rig.ctx, { id: 'wh', name: 'Worker HTTP', handle: 'wh', role: 'worker' });

    createTask(rig.ctx, board.id, { id: 'T107-3', title: 'HTTP Return task', lane: 'Ready', assignee: 'wh' });
    claimTask(rig.ctx, workerReg.agent, 'T107-3');
    submitTask(rig.ctx, workerReg.agent, 'T107-3', { summary: 'Submitted for HTTP test' });

    const app = createApp(rig.ctx);

    // 1. 普通工蜂访问返回 403
    const forbiddenRes = await app.request('/tasks/T107-3/review/return', {
      method: 'POST',
      headers: H(workerReg.token),
      body: JSON.stringify({ reason: '工蜂不能自审自退' }),
    });
    assert.equal(forbiddenRes.status, 403);

    // 2. 用户访问返回 200，并正确返回更新后的任务
    const okRes = await app.request('/tasks/T107-3/review/return', {
      method: 'POST',
      headers: H(userReg.token),
      body: JSON.stringify({ reason: '通过 HTTP 退回重做' }),
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as { task: { lane: string; reviewStatus: string } };
    assert.equal(body.task.lane, 'InProgress');
    assert.equal(body.task.reviewStatus, 'rework');
  } finally {
    rig.cleanup();
  }
});

test('代次栅栏回归: attempt > 1 强制阻断无 attempt 旧请求与旧 attempt 迟到数据', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'fence-b1', name: 'Attempt Fence' });
    const user = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' }).agent;
    const worker = registerAgent(rig.ctx, { id: 'w-fence', name: 'Worker', handle: 'w-fence', role: 'worker' }).agent;

    createTask(rig.ctx, board.id, { id: 'TF-1', title: 'Task with attempts', lane: 'Ready', assignee: 'w-fence' });
    const claimed = claimTask(rig.ctx, worker, 'TF-1');
    assert.equal(claimed.attempt, 1, '首认领 attempt 基线为 1');

    // 1. attempt === 1 首次尝试时，旧工蜂无代次请求正常放行（兼容旧工蜂）
    const cpInit = checkpointTask(rig.ctx, worker, 'TF-1', '旧工蜂首轮纯文本汇报');
    assert.ok(cpInit.task);
    const subInit = submitTask(rig.ctx, worker, 'TF-1', { summary: '首轮提交', attempt: 1 });
    assert.equal(subInit.lane, 'Review');

    // 2. 退回重做，跨入新代次 attempt = 2
    const reworked = await returnTaskFromReview(rig.ctx, user, 'TF-1', { reason: '需要重做' });
    assert.equal(reworked.attempt, 2, '退回重做后 attempt 自增为 2');

    // 3. attempt > 1 时，无 attempt 的旧工蜂 checkpoint 必须被拒绝 (409) 并提示升级指引
    assert.throws(
      () => checkpointTask(rig.ctx, worker, 'TF-1', '旧工蜂纯文本汇报无代次'),
      /stale or unversioned execution attempt.*upgrade worker SDK/i,
    );

    // 4. 携带旧代次 attempt: 1 的迟到 checkpoint 必须被拒绝 (409)
    assert.throws(
      () => checkpointTask(rig.ctx, worker, 'TF-1', { note: '迟到汇报', attempt: 1 }),
      /stale execution attempt: expected 2, got 1/i,
    );

    // 5. 携带正确代次 attempt: 2 的 checkpoint 正常通过
    const cpOk = checkpointTask(rig.ctx, worker, 'TF-1', { note: '新工蜂正常汇报', attempt: 2 });
    assert.ok(cpOk.task);

    // 6. attempt > 1 时，无 attempt 的旧工蜂 submit 必须被拒绝 (409)
    assert.throws(
      () => submitTask(rig.ctx, worker, 'TF-1', { summary: '无代次提交' }),
      /stale or unversioned execution attempt.*upgrade worker SDK/i,
    );

    // 7. 携带旧代次 attempt: 1 的迟到 submit 必须被拒绝 (409)
    assert.throws(
      () => submitTask(rig.ctx, worker, 'TF-1', { summary: '旧代次提交', attempt: 1 }),
      /stale execution attempt: expected 2, got 1/i,
    );

    // 8. 携带当前 attempt: 2 的提交正常进入 Review
    const subOk = submitTask(rig.ctx, worker, 'TF-1', { summary: '正确代次提交', attempt: 2 });
    assert.equal(subOk.lane, 'Review');

    // 9. 用户再次退回重做，attempt 进一步自增为 3
    const reworked2 = await returnTaskFromReview(rig.ctx, user, 'TF-1', { reason: '第二次退回' });
    assert.equal(reworked2.attempt, 3);

    // 10. 此时即使携带上一轮的 attempt: 2 也会被拦截
    assert.throws(
      () => checkpointTask(rig.ctx, worker, 'TF-1', { note: 'Attempt 2 迟到', attempt: 2 }),
      /stale execution attempt: expected 3, got 2/i,
    );
  } finally {
    rig.cleanup();
  }
});

test('Bundle 回传代次栅栏: POST /tasks/:id/repo-result 强制代次绑定，阻断无 attempt 旧工蜂与迟到 bundle', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'bundle-b1', name: 'Bundle Board', repoMode: 'managed', repoStatus: 'ready' });
    const user = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' }).agent;
    const workerA = registerAgent(rig.ctx, { id: 'wa', name: 'Worker A', handle: 'wa', role: 'worker' });
    const workerB = registerAgent(rig.ctx, { id: 'wb', name: 'Worker B', handle: 'wb', role: 'worker' });

    // 初始化托管裸仓及真实的 Git bundle
    const mgr = new RepoManager(rig.ctx);
    await mgr.initialize(board.id, 'empty');
    await mgr.waitForJob(board.id);
    const bareRepo = mgr.repoPath(board.id);
    const seed = join(rig.ctx.cfg.dataDir, 'seed');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'AsterHive Test',
      GIT_AUTHOR_EMAIL: 'test@asterhive.internal',
      GIT_COMMITTER_NAME: 'AsterHive Test',
      GIT_COMMITTER_EMAIL: 'test@asterhive.internal',
    };
    mkdirSync(seed, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seed, env: gitEnv });
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['push', '-q', bareRepo, 'main'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['checkout', '-q', '-b', 'asterhive/TB-1'], { cwd: seed, env: gitEnv });
    writeFileSync(join(seed, 'work.txt'), 'done\n');
    execFileSync('git', ['add', '-A'], { cwd: seed, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'task commit'], { cwd: seed, env: gitEnv });
    const bundlePath = join(rig.ctx.cfg.dataDir, 'result.bundle');
    execFileSync('git', ['bundle', 'create', bundlePath, 'asterhive/TB-1'], { cwd: seed, env: gitEnv });
    const dummyBundle = readFileSync(bundlePath);
    const bundleSha = createHash('sha256').update(dummyBundle).digest('hex');

    createTask(rig.ctx, board.id, { id: 'TB-1', title: 'Managed bundle task', lane: 'Ready', assignee: 'wa' });
    const claimed = claimTask(rig.ctx, workerA.agent, 'TB-1');
    assert.equal(claimed.attempt, 1, '首认领 attempt 基线为 1');
    submitTask(rig.ctx, workerA.agent, 'TB-1', { summary: 'Submit 1', attempt: 1 });

    // 退回重做，代次自增到 2
    await returnTaskFromReview(rig.ctx, user, 'TB-1', { reason: '退回' });
    assert.equal(getTask(rig.ctx, 'TB-1').attempt, 2);

    const app = createApp(rig.ctx);
    // 1. 非指派工蜂 workerB 尝试回传 bundle 返回 403
    const forbiddenRes = await app.request('/tasks/TB-1/repo-result', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerB.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(dummyBundle.byteLength),
        'x-content-sha256': bundleSha,
        'x-task-attempt': '2',
      },
      body: dummyBundle,
    });
    assert.equal(forbiddenRes.status, 403, '非指派工蜂上传 bundle 必须返回 403');

    // 2. attempt > 1 时，无 x-task-attempt 头的旧工蜂回传返回 409
    const unversionedRes = await app.request('/tasks/TB-1/repo-result', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerA.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(dummyBundle.byteLength),
        'x-content-sha256': bundleSha,
      },
      body: dummyBundle,
    });
    assert.equal(unversionedRes.status, 409, '无 x-task-attempt 头的旧请求必须返回 409');

    // 3. 携带旧代次 x-task-attempt: 2 的迟到回传返回 409
    const staleRes = await app.request('/tasks/TB-1/repo-result', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerA.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(dummyBundle.byteLength),
        'x-content-sha256': bundleSha,
        'x-task-attempt': '1',
      },
      body: dummyBundle,
    });
    assert.equal(staleRes.status, 409, '旧代次迟到 bundle 必须返回 409');

    // 4. 携带当前匹配代次 x-task-attempt: 2 的回传成功保存 (200)
    const okRes = await app.request('/tasks/TB-1/repo-result', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerA.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(dummyBundle.byteLength),
        'x-content-sha256': bundleSha,
        'x-task-attempt': '2',
      },
      body: dummyBundle,
    });
    assert.equal(okRes.status, 200, '匹配当前代次的 bundle 正常保存');

    // 5. 模拟异步竞争：持有 task 锁期间尝试回传 repo-result 必须被互斥阻塞
    const { promise: lockRunning, resolve: releaseLock } = Promise.withResolvers<void>();
    const lockPromise = withTaskIntegrationLock('TB-1', async () => {
      await lockRunning;
    });

    let uploadSettled = false;
    const concurrentUpload = app.request('/tasks/TB-1/repo-result', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerA.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(dummyBundle.byteLength),
        'x-content-sha256': bundleSha,
        'x-task-attempt': '2',
      },
      body: dummyBundle,
    }).then((res) => {
      uploadSettled = true;
      return res;
    });

    await Promise.resolve();
    assert.equal(uploadSettled, false, '持有集成锁期间，repo-result 必须被互斥等待');
    releaseLock();
    await lockPromise;
    const resAfter = await concurrentUpload;
    assert.equal(resAfter.status, 200);
  } finally {
    rig.cleanup();
  }
});

test('失联与挂起任务栅栏安全: releaseStuckTask 与 sweepStale 建立有效代次栅栏，防止旧工蜂迟到写回', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'stuck-b', name: 'Stuck Board' });
    const userReg = registerAgent(rig.ctx, { id: 'user', name: 'Boss', handle: 'boss', role: 'user' });
    const queenReg = registerAgent(rig.ctx, { id: 'queen-agent', name: 'Queen', handle: 'queen-orch', role: 'orchestrator' });
    const worker1 = registerAgent(rig.ctx, { id: 'w-stuck1', name: 'Worker 1', handle: 'w-stuck1', role: 'worker' }).agent;
    const worker2 = registerAgent(rig.ctx, { id: 'w-stuck2', name: 'Worker 2', handle: 'w-stuck2', role: 'worker' }).agent;

    createTask(rig.ctx, board.id, { id: 'STK-1', title: 'Task on stuck worker', lane: 'Ready', assignee: 'w-stuck1' });
    claimTask(rig.ctx, worker1, 'STK-1');
    const initialAttempt = getTask(rig.ctx, 'STK-1').attempt;

    // 1. sweepStale 绝不自动释放 InProgress 任务，保留现场与所有权
    rig.ctx.holder.db.prepare("UPDATE task SET last_activity_at = ? WHERE id = 'STK-1'").run(Date.now() - 300_000);
    const sweepRes = nextTask(rig.ctx, worker2, board.id);
    assert.deepEqual(sweepRes.swept, [], '失联任务绝不被 sweepStale 自动释放');
    assert.equal(getTask(rig.ctx, 'STK-1').lane, 'InProgress');
    assert.equal(getTask(rig.ctx, 'STK-1').assignee, 'w-stuck1');

    // 模拟工蜂已离线（心跳过期超 60 秒）
    rig.ctx.holder.db.prepare("UPDATE agent SET last_seen_at = ? WHERE id = 'w-stuck1'").run(Date.now() - 120_000);

    // 2. 离线状态下，若未明确提供 confirmedStopped: true，默认拒绝解绑 (409)（网络断连不等于物理停止）
    await assert.rejects(
      async () => releaseStuckTask(rig.ctx, userReg.agent, 'w-stuck1', 'STK-1', '工蜂断连但未经确认物理停止'),
      /网络断连不等于物理停止|confirmedStopped/i,
    );

    // 3. 蜂后 (orchestrator) 即使传 confirmedStopped: true，亦报 403 拒绝（主脑不能代替用户确认物理停止）
    await assert.rejects(
      async () => releaseStuckTask(rig.ctx, queenReg.agent, 'w-stuck1', 'STK-1', '蜂后伪造确认', { confirmedStopped: true }),
      /only user role may confirm worker stopped/i,
    );

    // 4. HTTP API 端点权限与确认门禁校验
    const adminToken = 'A'.repeat(48);
    rig.ctx.cfg.adminRecoveryToken = adminToken;
    const app = createApp(rig.ctx);
    const queenHttpRes = await app.request('/agents/w-stuck1/control/release-task', {
      method: 'POST',
      headers: H(queenReg.token),
      body: JSON.stringify({ taskId: 'STK-1', confirmedStopped: true }),
    });
    assert.equal(queenHttpRes.status, 403, 'HTTP 端点必须拒绝非用户角色解绑');

    const userUnconfirmedHttpRes = await app.request('/agents/w-stuck1/control/release-task', {
      method: 'POST',
      headers: H(adminToken),
      body: JSON.stringify({ taskId: 'STK-1', confirmedStopped: false }),
    });
    assert.equal(userUnconfirmedHttpRes.status, 409, 'HTTP 端点未经用户明确确认必须报 409');

    // 5. 真实用户明确提供 confirmedStopped: true 后，受控解绑成功并建立代次栅栏（自增 attempt）
    const released = await releaseStuckTask(rig.ctx, userReg.agent, 'w-stuck1', 'STK-1', '用户确认工蜂停机', { confirmedStopped: true });
    assert.equal(released.lane, 'Ready');
    assert.equal(released.assignee, 'unassigned');
    assert.ok(released.attempt > initialAttempt, '受控解绑必须建立有效代次栅栏（自增 attempt）');

    // 审计事件确认
    const auditEvents = listEvents(rig.ctx);
    const forceEvent = auditEvents.find((e) => e.type === 'task.force_released' && e.payload.taskId === 'STK-1');
    assert.ok(forceEvent);
    assert.equal(forceEvent.payload.userConfirmedStopped, true, '审计日志必须记录 userConfirmedStopped: true');

    // 6. 此时旧工蜂 w-stuck1 恢复网络并尝试提交旧结果：由于已不在 InProgress 且 attempt 已过时，必须被 409 阻断
    assert.throws(
      () => checkpointTask(rig.ctx, worker1, 'STK-1', { note: '迟到保活', attempt: initialAttempt }),
      /not InProgress|cancelled|stale execution attempt/i,
    );
    // 新工蜂 w-stuck2 被重新指派并认领
    rig.ctx.holder.db.prepare("UPDATE task SET assignee = 'w-stuck2' WHERE id = 'STK-1'").run();
    const reClaimed = claimTask(rig.ctx, worker2, 'STK-1');
    assert.ok(reClaimed.attempt > released.attempt, '新认领建立更高代次');
    assert.equal(reClaimed.assignee, 'w-stuck2');

    // 旧工蜂 w-stuck1 即使尝试提交结果，也因指派人与代次不匹配被严格拒绝 (403/409)
    assert.throws(
      () => submitTask(rig.ctx, worker1, 'STK-1', { summary: '迟到提交', attempt: initialAttempt }),
      /only assignee|stale execution attempt/i,
    );
  } finally {
    rig.cleanup();
  }
});

test('审核退回重做: 原子自增 attempt 并建立代次栅栏，快照 Bundle 包含上一代变更与原始 baseCommit', async () => {
  const rig = mkRig();
  try {
    const userReg = registerAgent(rig.ctx, { id: 'u-rwk', name: 'User', handle: 'u-rwk', role: 'user' });
    const reviewerReg = registerAgent(rig.ctx, { id: 'rev-rwk', name: 'Reviewer', handle: 'rev-rwk', role: 'orchestrator' });
    const workerReg = registerAgent(rig.ctx, { id: 'w-rwk', name: 'Worker', handle: 'w-rwk', role: 'worker' });
    const board = createBoard(rig.ctx, { id: 'b-rework-snap', name: 'Rework Snapshot Board', repoMode: 'managed', repoStatus: 'ready' });

    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });

    const mgr = new RepoManager(rig.ctx);
    await mgr.initialize(board.id, 'empty');
    await mgr.waitForJob(board.id);
    const bareRepo = mgr.repoPath(board.id);

    const seedDir = join(rig.ctx.cfg.dataDir, 'rework-seed');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'AsterHive Test',
      GIT_AUTHOR_EMAIL: 'test@asterhive.internal',
      GIT_COMMITTER_NAME: 'AsterHive Test',
      GIT_COMMITTER_EMAIL: 'test@asterhive.internal',
    };
    mkdirSync(seedDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seedDir, env: gitEnv });
    writeFileSync(join(seedDir, 'README.md'), 'initial version\n');
    execFileSync('git', ['add', '-A'], { cwd: seedDir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: seedDir, env: gitEnv });
    execFileSync('git', ['push', '-q', bareRepo, 'main'], { cwd: seedDir, env: gitEnv });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRepo, env: gitEnv });
    const initialBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir, env: gitEnv }).toString().trim();
    setBoardRepoState(rig.ctx, board.id, { status: 'ready', head: initialBase });

    // 1. 创建任务并首次认领（attempt = 1）
    createTask(rig.ctx, board.id, { id: 'RWK-1', title: 'Task with rework', lane: 'Ready', assignee: 'w-rwk' });
    const initialClaim = claimTask(rig.ctx, workerReg.agent, 'RWK-1');
    assert.equal(initialClaim.attempt, 1);

    // 首次导出快照，确立 baseRef
    const firstSnap = await mgr.exportTaskSnapshot(board.id, 'RWK-1');
    assert.equal(firstSnap.baseCommit, initialBase);
    firstSnap.cleanup();

    // 工蜂在本地工作区提交第 1 代代码并打包上传
    execFileSync('git', ['checkout', '-q', '-b', 'asterhive/RWK-1'], { cwd: seedDir, env: gitEnv });
    writeFileSync(join(seedDir, 'feature.ts'), 'export const attemptOne = true;\n');
    execFileSync('git', ['add', '-A'], { cwd: seedDir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'attempt 1 commit'], { cwd: seedDir, env: gitEnv });
    const attempt1Commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir, env: gitEnv }).toString().trim();

    const bundleFile = join(rig.ctx.cfg.dataDir, 'rwk-result-1.bundle');
    execFileSync('git', ['bundle', 'create', bundleFile, 'asterhive/RWK-1'], { cwd: seedDir, env: gitEnv });
    const bundleBuf = readFileSync(bundleFile);
    const bundleSha = createHash('sha256').update(bundleBuf).digest('hex');

    await mgr.importTaskResult(board.id, 'RWK-1', [bundleBuf], bundleBuf.length, bundleSha);

    // 提交任务进入 Review
    submitTask(rig.ctx, workerReg.agent, 'RWK-1', { summary: 'Attempt 1 done', attempt: 1 });
    assert.equal(getTask(rig.ctx, 'RWK-1').lane, 'Review');

    // 2. 审核领取并驳回（finalizeTaskReview verdict: reject）
    assert.ok(claimTaskForReview(rig.ctx, 'RWK-1'));
    const rejectedTask = await finalizeTaskReview(rig.ctx, reviewerReg.agent, 'RWK-1', { verdict: 'reject', summary: 'Need fixes for attempt 1' });

    // 验证：原子转为 InProgress / rework，且 attempt 自增到 2
    assert.equal(rejectedTask.lane, 'InProgress');
    assert.equal(rejectedTask.reviewStatus, 'rework');
    assert.equal(rejectedTask.reviewReworks, 1);
    assert.equal(rejectedTask.attempt, 2, 'finalizeTaskReview 必须原子递增 attempt 到 2 建立代次栅栏');
    assert.equal(rejectedTask.lastActivityKind, 'rework');

    // 3. 旧代次阻断校验：旧工蜂持有 attempt=1 发送 checkpoint、submit 或上传 bundle 均报 409
    assert.throws(
      () => checkpointTask(rig.ctx, workerReg.agent, 'RWK-1', { note: '旧代次保活', attempt: 1 }),
      /stale execution attempt/i,
      '旧代次 checkpoint 必须被 409 拒绝',
    );
    assert.throws(
      () => submitTask(rig.ctx, workerReg.agent, 'RWK-1', { summary: '旧代次提交', attempt: 1 }),
      /stale execution attempt/i,
      '旧代次 submit 必须被 409 拒绝',
    );

    const app = createApp(rig.ctx);
    const staleUploadRes = await app.request('/tasks/RWK-1/repo-result', {
      method: 'POST',
      headers: {
        ...H(workerReg.token),
        'content-length': String(bundleBuf.length),
        'x-content-sha256': bundleSha,
        'x-task-attempt': '1',
      },
      body: bundleBuf,
    });
    assert.equal(staleUploadRes.status, 409, '旧代次 repo-result 上传必须报 409');

    // 4. 快照端点安全门禁与代次校验：GET /tasks/:id/repo-snapshot
    // 4.1 非指派工蜂请求：报 403 阻断
    const otherWorker = registerAgent(rig.ctx, { id: 'w-other', name: 'Other Worker', handle: 'w-other', role: 'worker' });
    const crossWorkerRes = await app.request('/tasks/RWK-1/repo-snapshot', {
      method: 'GET',
      headers: { ...H(otherWorker.token), 'x-task-attempt': '2' },
    });
    assert.equal(crossWorkerRes.status, 403, '非本任务指派工蜂下载快照必须报 403');

    // 4.2 本任务工蜂但未带 x-task-attempt（attempt > 1）：报 409 阻断
    const unversionedSnapRes = await app.request('/tasks/RWK-1/repo-snapshot', {
      method: 'GET',
      headers: H(workerReg.token),
    });
    assert.equal(unversionedSnapRes.status, 409, 'attempt > 1 未带 x-task-attempt 必须报 409');

    // 4.3 本任务工蜂但持有旧代次（x-task-attempt: 1）：报 409 阻断
    const staleSnapRes = await app.request('/tasks/RWK-1/repo-snapshot', {
      method: 'GET',
      headers: { ...H(workerReg.token), 'x-task-attempt': '1' },
    });
    assert.equal(staleSnapRes.status, 409, '旧代次工蜂下载快照必须报 409');

    // 4.4 合法提权角色（user/orchestrator）允许调用
    const userSnapRes = await app.request('/tasks/RWK-1/repo-snapshot', {
      method: 'GET',
      headers: H(userReg.token),
    });
    assert.equal(userSnapRes.status, 200, '合法用户角色允许读取任务快照');

    // 4.5 并发请求受 taskIntegrationLock 保护，串行生成无竞争
    const [snap1, snap2] = await Promise.all([
      app.request('/tasks/RWK-1/repo-snapshot', {
        method: 'GET',
        headers: { ...H(workerReg.token), 'x-task-attempt': '2' },
      }),
      app.request('/tasks/RWK-1/repo-snapshot', {
        method: 'GET',
        headers: { ...H(workerReg.token), 'x-task-attempt': '2' },
      }),
    ]);
    assert.equal(snap1.status, 200);
    assert.equal(snap2.status, 200);

    // 4.6 当前指派工蜂携带匹配代次 x-task-attempt: 2：返回 200 且包含重做快照
    const snapRes = snap1;
    assert.equal(snapRes.headers.get('x-base-commit'), initialBase, '快照必须保留最初的 baseCommit，绝不可被最新 HEAD 覆盖');
    assert.equal(snapRes.headers.get('x-rework-commit'), attempt1Commit, '快照响应头必须包含上一代的 reworkCommit');
    assert.equal(snapRes.headers.get('x-rework-branch'), 'asterhive/RWK-1');
    // 验证返回的 bundle 确实包含上一代的变更
    const snapBundleBuf = Buffer.from(await snapRes.arrayBuffer());
    const downloadedSnapFile = join(rig.ctx.cfg.dataDir, 'downloaded-snap.bundle');
    writeFileSync(downloadedSnapFile, snapBundleBuf);

    const verifyOut = execFileSync('git', ['bundle', 'verify', downloadedSnapFile], { cwd: seedDir, env: gitEnv }).toString();
    assert.match(verifyOut, /The bundle records/i);

    const headsOut = execFileSync('git', ['bundle', 'list-heads', downloadedSnapFile], { cwd: seedDir, env: gitEnv }).toString();
    assert.ok(headsOut.includes(attempt1Commit), '快照 bundle 必须包含上一代工蜂提交的 commit');
  } finally {
    rig.cleanup();
  }
});

test('依赖解锁: 前置任务全部 Done 时 eligible active Backlog 原子转移至 Ready；cancelled 任务绝不移动', async () => {
  const rig = mkRig();
  try {
    const userReg = registerAgent(rig.ctx, { id: 'u-dep', name: 'User', handle: 'u-dep', role: 'user' });
    const board = createBoard(rig.ctx, { id: 'b-deps', name: 'Dependencies Board' });

    // 前置任务 P1 和 P2
    createTask(rig.ctx, board.id, { id: 'DEP-1', title: 'Prereq 1', lane: 'Ready' });
    createTask(rig.ctx, board.id, { id: 'DEP-2', title: 'Prereq 2', lane: 'Ready' });

    // 子任务：
    // DEP-3: 正常活跃 Backlog，依赖 DEP-1 和 DEP-2
    createTask(rig.ctx, board.id, { id: 'DEP-3', title: 'Active Backlog Child', lane: 'Backlog', dependsOn: ['DEP-1', 'DEP-2'] });
    // DEP-4: 已取消任务，依赖 DEP-1 和 DEP-2
    createTask(rig.ctx, board.id, { id: 'DEP-4', title: 'Cancelled Child', lane: 'Backlog', dependsOn: ['DEP-1', 'DEP-2'] });
    await cancelTask(rig.ctx, userReg.agent, 'DEP-4', '用户取消该需求');
    assert.equal(getTask(rig.ctx, 'DEP-4').status, 'cancelled');

    // DEP-5: 处于 InProgress 的任务，依赖 DEP-1
    const worker = registerAgent(rig.ctx, { id: 'w-dep', name: 'Worker', handle: 'w-dep', role: 'worker' }).agent;
    createTask(rig.ctx, board.id, { id: 'DEP-5', title: 'InProgress Child', lane: 'Ready', assignee: 'w-dep' });
    claimTask(rig.ctx, worker, 'DEP-5');
    // 构造历史不一致状态，验证解锁逻辑不会重置已领取任务。
    rig.ctx.holder.db.prepare('UPDATE task SET depends_on = ? WHERE id = ?').run(JSON.stringify(['DEP-1']), 'DEP-5');
    assert.equal(getTask(rig.ctx, 'DEP-5').lane, 'InProgress');

    // 1. 将 DEP-1 移入 Done (使用 updateTask 将 Ready 移至 Done)
    updateTask(rig.ctx, userReg.agent, 'DEP-1', { lane: 'Done' });

    // 此时 DEP-2 尚未完成，DEP-3 应仍在 Backlog
    assert.equal(getTask(rig.ctx, 'DEP-3').lane, 'Backlog');
    assert.equal(getTask(rig.ctx, 'DEP-3').autoUnblockedAt, null);

    // 2. 将 DEP-2 移入 Done -> 所有依赖已全部就绪
    updateTask(rig.ctx, userReg.agent, 'DEP-2', { lane: 'Done' });

    // 验证：DEP-3 必须原子自动转移到 Ready，并记录 autoUnblockedAt
    const b1 = getTask(rig.ctx, 'DEP-3');
    assert.equal(b1.lane, 'Ready', '依赖全部完成时，活跃 Backlog 任务必须原子转为 Ready');
    assert.ok(b1.autoUnblockedAt !== null, 'autoUnblockedAt 必须记录时间戳');

    // 验证审计事件
    const events = listEvents(rig.ctx);
    const laneChangedEvent = events.find((e) => e.type === 'task.lane_changed' && e.payload.taskId === 'DEP-3' && e.payload.to === 'Ready');
    assert.ok(laneChangedEvent, '必须记录 task.lane_changed 事件');
    assert.equal(laneChangedEvent.payload.from, 'Backlog');
    assert.equal(laneChangedEvent.payload.to, 'Ready');

    const unlockedEvent = events.find((e) => e.type === 'task.auto_unlocked' && e.payload.taskId === 'DEP-3');
    assert.ok(unlockedEvent, '必须记录 task.auto_unlocked 事件');

    // 验证：已取消任务 DEP-4 绝不可移动，仍为 Backlog，且不记录 autoUnblockedAt
    const b2 = getTask(rig.ctx, 'DEP-4');
    assert.equal(b2.lane, 'Backlog', '已取消任务绝不可转移到 Ready');
    assert.equal(b2.status, 'cancelled');
    assert.equal(b2.autoUnblockedAt, null);

    // 验证：已经在 InProgress 的任务 DEP-5 绝不可被重置回 Ready
    const b3 = getTask(rig.ctx, 'DEP-5');
    assert.equal(b3.lane, 'InProgress', '非 Backlog 泳道任务绝不可被 unlockDependents 重置');
  } finally {
    rig.cleanup();
  }
});

test('错误状态投影: error/timeout 保持失败直到受控恢复，展示原因并拒绝迟到活动', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'b-err-proj', name: 'Error Projection Board' });
    const workerReg = registerAgent(rig.ctx, { id: 'w-err', name: 'Worker Err', handle: 'w-err', role: 'worker' });
    rig.ctx.holder.db.prepare("UPDATE agent SET last_seen_at = ? WHERE id = 'w-err'").run(Date.now());

    createTask(rig.ctx, board.id, { id: 'ERR-1', title: 'Task with failure checkpoint', lane: 'Ready', assignee: 'w-err' });
    const claimed = claimTask(rig.ctx, workerReg.agent, 'ERR-1');
    assert.equal(claimed.lane, 'InProgress');
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.progress?.status, 'unknown');
    assert.equal(claimed.progress?.errorNote, null);

    // 1. 发送 kind: 'error' 的 checkpoint 上报执行失败
    const errCheckpoint = checkpointTask(rig.ctx, workerReg.agent, 'ERR-1', {
      kind: 'error',
      note: 'Fatal: TypeScript build failed with TS2304: Cannot find name "Foo"',
      attempt: 1,
    });

    const taskWithError = errCheckpoint.task;
    assert.equal(taskWithError.lane, 'InProgress', '报错后任务依然停留在 InProgress，不可自动释放或重跑');
    assert.equal(taskWithError.attempt, 1, '报错后 attempt 保持不变');
    assert.equal(taskWithError.lastActivityKind, 'error');
    assert.equal(taskWithError.progress?.status, 'failed', 'progress.status 必须明确投影为 failed');
    assert.equal(taskWithError.progress?.errorNote, 'Fatal: TypeScript build failed with TS2304: Cannot find name "Foo"');

    // 2. 即使工蜂心跳超时离线，status=failed 依然保持最高优先级（不被 offline 覆盖）
    rig.ctx.holder.db.prepare("UPDATE agent SET last_seen_at = ? WHERE id = 'w-err'").run(Date.now() - 300_000);
    const refreshed = getTask(rig.ctx, 'ERR-1');
    assert.equal(refreshed.progress?.status, 'failed', 'failed 状态必须优先于 offline 阈值判定');
    assert.equal(refreshed.progress?.errorNote, 'Fatal: TypeScript build failed with TS2304: Cannot find name "Foo"');
    checkpointTask(rig.ctx, workerReg.agent, 'ERR-1', {
      kind: 'timeout',
      note: '执行器超时，工作区已保留',
      attempt: 1,
    });
    const timedOut = getTask(rig.ctx, 'ERR-1');
    assert.equal(timedOut.progress?.status, 'failed');
    assert.equal(timedOut.progress?.errorNote, '执行器超时，工作区已保留');

    // 3. 同一代次的迟到活动不能清除失败状态或触发自动重试。
    assert.throws(() => checkpointTask(rig.ctx, workerReg.agent, 'ERR-1', {
      kind: 'milestone', note: 'late event', attempt: 1,
    }), /failed|恢复/i);
    assert.throws(() => submitTask(rig.ctx, workerReg.agent, 'ERR-1', { summary: 'late submit', attempt: 1 }), /failed|恢复/i);
    assert.equal(getTask(rig.ctx, 'ERR-1').progress?.status, 'failed');

    // 4. 回归验证：通过真实 HTTP 端点 POST /tasks/:id/checkpoint 发送 kind: error
    const app = createApp(rig.ctx);
    const httpCpRes = await app.request('/tasks/ERR-1/checkpoint', {
      method: 'POST',
      headers: H(workerReg.token),
      body: JSON.stringify({
        kind: 'error',
        note: 'Regression note: exit code 1 from sandbox runner',
        attempt: 1,
      }),
    });
    assert.equal(httpCpRes.status, 200);

    const httpGetTaskRes = await app.request('/tasks/ERR-1', {
      method: 'GET',
      headers: H(workerReg.token),
    });
    assert.equal(httpGetTaskRes.status, 200);
    const getTaskJson = (await httpGetTaskRes.json()) as { task: Task };
    assert.equal(getTaskJson.task.progress?.status, 'failed');
    assert.equal(getTaskJson.task.progress?.errorNote, 'Regression note: exit code 1 from sandbox runner');
  } finally {
    rig.cleanup();
  }
});

test('任务释放安全门禁: /tasks/:id/release 阻断 elevated 越权绕过，受控解绑 releaseStuckTask 在锁内单事务原子完成', async () => {
  const rig = mkRig();
  try {
    const userReg = registerAgent(rig.ctx, { id: 'u-sec', name: 'User Sec', handle: 'u-sec', role: 'user' });
    const queenReg = registerAgent(rig.ctx, { id: 'q-sec', name: 'Queen', handle: 'q-sec', role: 'orchestrator' });
    const workerReg = registerAgent(rig.ctx, { id: 'w-sec', name: 'Worker Sec', handle: 'w-sec', role: 'worker' });
    const board = createBoard(rig.ctx, { id: 'b-sec', name: 'Security Board' });

    createTask(rig.ctx, board.id, { id: 'SEC-1', title: 'Task security check', lane: 'Ready', assignee: 'w-sec' });
    claimTask(rig.ctx, workerReg.agent, 'SEC-1');

    // 1. 禁止通过 /tasks/:id/release 自愿释放运行中任务（Fail closed: 防止执行未 settled 时脑裂并发写）
    await assert.rejects(
      async () => releaseTask(rig.ctx, queenReg.agent, 'SEC-1', '主脑尝试释放'),
      /voluntary task release is disabled/i,
      '主脑调用 releaseTask 必须报 403 阻断',
    );
    await assert.rejects(
      async () => releaseTask(rig.ctx, userReg.agent, 'SEC-1', '用户尝试直接释放'),
      /voluntary task release is disabled/i,
      '用户调用 releaseTask 必须报 403 阻断',
    );
    await assert.rejects(
      async () => releaseTask(rig.ctx, workerReg.agent, 'SEC-1', '工蜂自愿交还'),
      /voluntary task release is disabled/i,
      '工蜂自愿交还 releaseTask 必须报 403 阻断以防执行未 settled 脑裂',
    );

    const app = createApp(rig.ctx);
    const userReleaseHttp = await app.request('/tasks/SEC-1/release', {
      method: 'POST',
      headers: H(userReg.token),
      body: JSON.stringify({ reason: 'HTTP release bypass attempt' }),
    });
    assert.equal(userReleaseHttp.status, 403, 'HTTP /tasks/:id/release 必须报 403 阻断自愿释放');

    // 2. 模拟运行中发生错误：error checkpoint 设置 status=failed
    checkpointTask(rig.ctx, workerReg.agent, 'SEC-1', { kind: 'error', note: 'Error state' });
    assert.equal(getTask(rig.ctx, 'SEC-1').progress?.status, 'failed');

    // 3. 只有经过认证的用户角色并明确提供 confirmedStopped: true，才能通过 releaseStuckTask 安全受控解绑
    await assert.rejects(
      async () => releaseStuckTask(rig.ctx, userReg.agent, 'w-sec', 'SEC-1', '未确认停机', { confirmedStopped: false }),
      /confirmedStopped/i,
    );

    const forceReleased = await releaseStuckTask(rig.ctx, userReg.agent, 'w-sec', 'SEC-1', '用户确认物理停止', { confirmedStopped: true });
    assert.equal(forceReleased.assignee, 'unassigned');
    assert.equal(forceReleased.lane, 'Ready');
    assert.equal(forceReleased.attempt, 2, '受控解绑建立代次栅栏');
    assert.equal(forceReleased.lastActivityKind, null, '受控解绑必须单事务原子清除 error 状态');
    assert.equal(forceReleased.progress, null, '解绑回 Ready 后 progress 归 null');
  } finally {
    rig.cleanup();
  }
});

test('updateTask 状态机安全门禁: 严禁通过通用 PATCH 绕过物理停止确认或绕过审核退回代次锁', async () => {
  const rig = mkRig();
  try {
    const userReg = registerAgent(rig.ctx, { id: 'u-patch', name: 'User Patch', handle: 'u-patch', role: 'user' });
    const workerReg = registerAgent(rig.ctx, { id: 'w-patch1', name: 'Worker 1', handle: 'w-patch1', role: 'worker' });
    registerAgent(rig.ctx, { id: 'w-patch2', name: 'Worker 2', handle: 'w-patch2', role: 'worker' });
    const board = createBoard(rig.ctx, { id: 'b-patch-gate', name: 'Patch Gate Board' });

    createTask(rig.ctx, board.id, { id: 'GAT-1', title: 'InProgress task', lane: 'Ready', assignee: 'w-patch1' });
    claimTask(rig.ctx, workerReg.agent, 'GAT-1');
    assert.equal(getTask(rig.ctx, 'GAT-1').lane, 'InProgress');

    // 1. InProgress 任务禁止通过 updateTask 挪动泳道（如 InProgress -> Ready 或 Backlog）
    assert.throws(
      () => updateTask(rig.ctx, userReg.agent, 'GAT-1', { lane: 'Ready' }),
      /cannot move task out of InProgress via generic update/i,
      'updateTask 严禁将 InProgress 移出泳道',
    );
    assert.throws(
      () => updateTask(rig.ctx, userReg.agent, 'GAT-1', { lane: 'Backlog' }),
      /cannot move task out of InProgress via generic update/i,
    );

    // 2. InProgress 任务禁止通过 updateTask 篡改指派人
    assert.throws(
      () => updateTask(rig.ctx, userReg.agent, 'GAT-1', { assignee: 'w-patch2' }),
      /cannot change assignee of InProgress task via generic update/i,
      'updateTask 严禁篡改 InProgress 任务的指派人',
    );

    // 3. InProgress 任务允许正常编辑元数据（title, detail, acceptance 等）
    const metaUpdated = updateTask(rig.ctx, userReg.agent, 'GAT-1', {
      title: 'Updated title safely',
      detail: 'Updated detail safely',
      acceptance: 'New acceptance',
    });
    assert.equal(metaUpdated.title, 'Updated title safely');
    assert.equal(metaUpdated.detail, 'Updated detail safely');
    assert.equal(metaUpdated.lane, 'InProgress', '编辑元数据不改变泳道');
    assert.equal(metaUpdated.assignee, 'w-patch1', '编辑元数据不改变指派人');

    // 4. Review 任务禁止通过 updateTask 直接移入 InProgress（退回重做必须走具备代次自增与锁的专用 API）
    createTask(rig.ctx, board.id, { id: 'GAT-2', title: 'Review task', lane: 'Ready', assignee: 'w-patch1' });
    claimTask(rig.ctx, workerReg.agent, 'GAT-2');
    submitTask(rig.ctx, workerReg.agent, 'GAT-2', { summary: 'Submitting GAT-2' });
    assert.equal(getTask(rig.ctx, 'GAT-2').lane, 'Review');

    assert.throws(
      () => updateTask(rig.ctx, userReg.agent, 'GAT-2', { lane: 'InProgress' }),
      /Review tasks cannot be moved to InProgress via generic update/i,
      'Review 任务退回重做严禁通过通用 PATCH 绕过',
    );
  } finally {
    rig.cleanup();
  }
});

