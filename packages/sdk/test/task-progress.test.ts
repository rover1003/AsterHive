import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Worker,
  type Task,
  type TaskProgress,
} from '../src/index.ts';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responseBody: unknown = { ok: true }): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  }) as unknown as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('SDK: Worker.checkpoint 支持结构化 options 与纯字符串入参', async () => {
  const mockTask: Partial<Task> = {
    id: 'T-100',
    lane: 'InProgress',
    progress: {
      lastActivityAt: 1700000000000,
      lastActivityKind: 'milestone',
      lastProgressAt: 1700000000000,
      workerLastSeenAt: 1700000000000,
      status: 'active',
    },
  };

  const { requests, restore } = stubFetch({ task: mockTask, pendingMessages: [] });
  try {
    const worker = new Worker('http://127.0.0.1:8067', 'test-token', 'worker-1');

    // 1. 结构化入参：支持保活与里程碑分类
    await worker.checkpoint('T-100', {
      note: '定时保活心跳',
      kind: 'keepalive',
      isKeepalive: true,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'http://127.0.0.1:8067/tasks/T-100/checkpoint');
    assert.deepEqual(requests[0].body, {
      note: '定时保活心跳',
      kind: 'keepalive',
      isKeepalive: true,
    });

    // 2. 传统纯文本入参（旧工蜂兼容）
    await worker.checkpoint('T-100', '纯文本进展汇报');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, {
      note: '纯文本进展汇报',
    });
  } finally {
    restore();
  }
});

test('SDK: Worker.returnReviewTask 调用 /tasks/:id/review/return 端点', async () => {
  const mockTask: Partial<Task> = {
    id: 'T-101',
    lane: 'InProgress',
    reviewStatus: 'rework',
  };

  const { requests, restore } = stubFetch({ task: mockTask });
  try {
    const worker = new Worker('http://127.0.0.1:8067', 'admin-token', 'user');
    const returned = await worker.returnReviewTask('T-101', '退回修改', 'worker-2');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'http://127.0.0.1:8067/tasks/T-101/review/return');
    assert.deepEqual(requests[0].body, {
      reason: '退回修改',
      assignee: 'worker-2',
    });
    assert.equal(returned.lane, 'InProgress');
    assert.equal(returned.reviewStatus, 'rework');
  } finally {
    restore();
  }
});
