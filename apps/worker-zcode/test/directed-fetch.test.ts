import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollNextDirectedTask } from '../src/polling.ts';

interface MockTask {
  id: string;
  title: string;
  assignee?: string | null;
  reviewStatus?: string;
  lastActivityKind?: string | null;
}

test('pollNextDirectedTask: 优先认领退回重做的 InProgress 任务（无需重复 claim）', async () => {
  const reworkTask: MockTask = { id: 'T-rework', title: '修复反馈', assignee: 'worker-1', reviewStatus: 'rework' };
  const readyTask: MockTask = { id: 'T-ready', title: '新任务', assignee: 'worker-1' };

  let claimCalled = false;

  const result = await pollNextDirectedTask(['b1'], {
    listMine: async (boardId, lane) => {
      if (lane === 'InProgress') return [reworkTask];
      if (lane === 'Ready') return [readyTask];
      return [];
    },
    claim: async (id) => {
      claimCalled = true;
      return { id, title: 'claimed' };
    },
  });

  assert.ok(result);
  assert.equal(result.channel, 'rework');
  assert.equal(result.task.id, 'T-rework');
  assert.equal(claimCalled, false, '重做任务无需重复 claim');
});

test('pollNextDirectedTask: 已失败或超时的重做不自动重复执行', async () => {
  for (const kind of ['error', 'timeout']) {
    const result = await pollNextDirectedTask(['b1'], {
      listMine: async (_board, lane) => lane === 'InProgress'
        ? [{ id: 'T-failed', title: '失败现场', reviewStatus: 'rework', lastActivityKind: kind }]
        : [],
      claim: async (id) => ({ id, title: 'claimed' }),
    });
    assert.equal(result, null);
  }
});

test('pollNextDirectedTask: 无重做时原子 claim 定向指派给本工蜂的 Ready 任务', async () => {
  const readyTask: MockTask = { id: 'T-102', title: '专派任务', assignee: 'worker-1' };

  let claimedId: string | null = null;

  const result = await pollNextDirectedTask(['b1'], {
    listMine: async (boardId, lane) => {
      if (lane === 'InProgress') return [];
      if (lane === 'Ready') return [readyTask];
      return [];
    },
    claim: async (id) => {
      claimedId = id;
      return { id, title: '专派任务', assignee: 'worker-1' };
    },
  });

  assert.ok(result);
  assert.equal(result.channel, 'directed');
  assert.equal(result.task.id, 'T-102');
  assert.equal(claimedId, 'T-102', '必须触发对指派卡片的原子 claim');
});

test('pollNextDirectedTask: 门禁返回 stop 时跳过当前板，不触发 claim', async () => {
  const readyTask: MockTask = { id: 'T-blocked', title: '受阻任务' };
  let claimCalled = false;

  const result = await pollNextDirectedTask(['b-stopped', 'b-free'], {
    listMine: async (boardId) => {
      if (boardId === 'b-stopped') return [readyTask];
      return [];
    },
    checkGate: async (boardId) => {
      if (boardId === 'b-stopped') return 'stop';
      return 'ready';
    },
    claim: async (id) => {
      claimCalled = true;
      return { id, title: 'claimed' };
    },
  });

  assert.equal(result, null);
  assert.equal(claimCalled, false);
});

test('pollNextDirectedTask: 遇到 403 非参与者板时触发 onSkip403 并平滑巡检下一板', async () => {
  const readyTask: MockTask = { id: 'T-valid', title: '有效任务' };
  const skippedBoards: string[] = [];

  const result = await pollNextDirectedTask(['b-forbidden', 'b-valid'], {
    listMine: async (boardId) => {
      if (boardId === 'b-forbidden') {
        const err = new Error('Forbidden');
        Object.assign(err, { status: 403 });
        throw err;
      }
      return [readyTask];
    },
    claim: async (id) => ({ id, title: '有效任务' }),
    onSkip403: (boardId) => skippedBoards.push(boardId),
  });

  assert.ok(result);
  assert.equal(result.task.id, 'T-valid');
  assert.deepEqual(skippedBoards, ['b-forbidden']);
});

test('pollNextDirectedTask: 无定向任务时空转等待，严禁盲抢未指派公共池', async () => {
  let claimCalled = false;

  const result = await pollNextDirectedTask(['b1', 'b2'], {
    listMine: async () => [],
    claim: async (id) => {
      claimCalled = true;
      return { id, title: 'fail' };
    },
  });

  assert.equal(result, null, '未指派或无卡时应返回 null 保持空闲');
  assert.equal(claimCalled, false);
});
