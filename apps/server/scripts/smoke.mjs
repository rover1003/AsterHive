// 端到端冒烟：模拟一期验收流程（用户提目标 → 主脑建卡派活 → worker 执行上交 → 主脑验收）
// 用法：node scripts/smoke.mjs [baseUrl]
const B = process.argv[2] ?? 'http://127.0.0.1:8079';
const ADMIN = process.env.SMOKE_ADMIN ?? 'boot-admin';

const api = async (method, path, { token, admin, body } = {}) => {
  const res = await fetch(B + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-admin-token': admin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

const assert = (cond, label) => {
  if (!cond) throw new Error('FAIL: ' + label);
  console.log('ok -', label);
};

// 1. 注册 worker 与主脑
const worker = await api('POST', '/agents/register', {
  body: { name: 'ZCode工作机', handle: 'zcode' },
});
const orch = await api('POST', '/agents/register', {
  admin: ADMIN,
  body: { name: '主脑A', handle: 'brain-a', role: 'orchestrator' },
});
assert(worker.token.startsWith('ah_'), 'worker 注册并签发 token');

// 2. 主脑建板建卡（含验收标准）
await api('POST', '/boards', { token: orch.token, body: { id: 'demo', name: '演示板' } });
await api('POST', '/boards/demo/tasks', {
  token: orch.token,
  body: { id: 'T42', title: '真实小任务', acceptance: '冒烟脚本全流程通过' },
});
await api('PATCH', '/tasks/T42', { token: orch.token, body: { lane: 'Ready' } });

// 3. SSE 订阅（后台收流）
const sseFrames = [];
const controller = new AbortController();
const sseDone = (async () => {
  const res = await fetch(B + '/events', { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (line.startsWith('event: ')) sseFrames.push(line.slice(7).trim());
      }
    }
  } catch {
    /* abort */
  }
})();
await new Promise((r) => setTimeout(r, 300));

// 4. 主脑分派（双通道：指派 + @消息）
const dispatched = await api('POST', '/tasks/T42/dispatch', {
  token: orch.token,
  body: { assignee: 'zcode', content: '@zcode 请领取 T42 任务，验收标准见卡片' },
});
assert(dispatched.message.mentions.includes('zcode'), '分派消息 @zcode');
assert(dispatched.message.taskRef === 'T42', '分派消息挂 taskRef');

// 5. 用户干预
await api('POST', '/boards/demo/messages', {
  body: { content: '@zcode 注意保持中文注释' },
});

// 6. worker 领取 → checkpoint（应带回干预）→ 上交
const claimed = await api('POST', '/tasks/T42/claim', { token: worker.token, body: {} });
assert(claimed.task.lane === 'InProgress', '认领进 InProgress');
const cp = await api('POST', '/tasks/T42/checkpoint', {
  token: worker.token,
  body: { note: '收到干预，执行中' },
});
// 首次 checkpoint 按投递游标带回全部未达：分派消息 + 用户干预
assert(cp.pendingMessages.length === 2, 'checkpoint 带回分派与干预两条消息');
assert(
  cp.pendingMessages.some((m) => m.content.includes('中文注释')),
  '干预内容正确',
);
const submitted = await api('POST', '/tasks/T42/submit', {
  token: worker.token,
  body: { summary: '冒烟完成', evidence: [{ path: 'docs/smoke.md', machine: 'workstation' }] },
});
assert(submitted.task.lane === 'Review', '上交进 Review');

// 7. 聊天室可见 @主脑 上交消息
const room = await api('GET', '/boards/demo/messages');
const submitMsg = room.messages.find((m) => m.kind === 'submit');
assert(submitMsg && submitMsg.mentions.includes('主脑'), '上交自动渲染 @主脑 消息');

// 8. 主脑核对证据验收 Done（信任分层：主脑操作）
const done = await api('PATCH', '/tasks/T42', { token: orch.token, body: { lane: 'Done' } });
assert(done.task.lane === 'Done', '主脑验收 Done');

// 9. SSE 收到了全程事件
await new Promise((r) => setTimeout(r, 500));
controller.abort();
await sseDone;
for (const expected of ['task.dispatched', 'message.created', 'task.claimed', 'task.checkpoint', 'task.submitted', 'task.lane_changed']) {
  assert(sseFrames.includes(expected), `SSE 实时收到 ${expected}`);
}

// 10. 审计与快照纪律
const audit = await api('GET', '/api/audit?limit=100');
const labels = new Set(audit.entries.map((e) => e.label));
assert(labels.has('task.dispatch') && labels.has('task.submit'), '审计覆盖全程');
const snaps = await api('GET', '/api/admin/snapshots');
assert(snaps.snapshots.length <= 3, '快照 ≤3 份');

console.log('\nSMOKE PASS - 一期端到端闭环（模式 A）全流程通过');
