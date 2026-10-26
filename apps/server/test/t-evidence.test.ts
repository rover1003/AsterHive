import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard, createTask, setParticipants, getTask } from '../src/tasks.ts';
import { listEvents } from '../src/write.ts';
import { EVIDENCE_INLINE_LIMIT, EVIDENCE_MAX_BYTES } from '../src/evidence.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('T15 证据上传: 小文件入库、登记引用、下载校验与事件落账', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-ev', name: 'Evidence Board' });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen', handle: 'queen-ev', role: 'orchestrator',
    });
    createTask(rig.ctx, 'b-ev', { id: 'EV-1', title: '带证据的任务', lane: 'Ready' });

    const app = createApp(rig.ctx);
    const content = new Uint8Array(Buffer.from('测试证据内容 evidence-content-αβγ', 'utf8'));
    const sha = createHash('sha256').update(content).digest('hex');

    // 1. 上传小文件（JSON 角色即 user；这里用蜂后 token）
    const res = await app.request('/tasks/EV-1/evidence', {
      method: 'POST',
      headers: {
        ...H(queenToken),
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('测试报告.txt'),
        'x-note': encodeURIComponent('验收截图'),
        'x-content-sha256': sha,
      },
      body: content as unknown as BodyInit,
    });
    assert.equal(res.status, 201);
    const { file } = (await res.json()) as { file: { id: number; storage: string; sha256: string; size: number } };
    assert.equal(file.storage, 'db', '小文件应入库');
    assert.equal(file.sha256, sha);
    assert.equal(file.size, content.byteLength);

    // 2. 任务 evidence 引用已追加（看板卡片可见）
    const task = getTask(rig.ctx, 'EV-1');
    assert.ok(task.evidence.some((e) => e.path.startsWith(`evidence-file:${file.id}:`)));
    assert.ok(task.evidence.some((e) => e.note.includes('验收截图')));

    // 3. 列表端点
    const listRes = await app.request('/tasks/EV-1/evidence', { headers: H(queenToken) });
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as { files: { id: number; filename: string }[] };
    assert.equal(listData.files.length, 1);
    assert.equal(listData.files[0].filename, '测试报告.txt');

    // 4. 下载并核对内容与 SHA
    const dlRes = await app.request(`/tasks/EV-1/evidence/${file.id}`, { headers: H(queenToken) });
    assert.equal(dlRes.status, 200);
    const dlBuf = new Uint8Array(await dlRes.arrayBuffer());
    assert.deepEqual(dlBuf, content);
    assert.equal(dlRes.headers.get('x-content-sha256'), sha);

    // 5. 事件台账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'task.evidence_uploaded'));
  } finally {
    rig.cleanup();
  }
});

test('T15 证据上传: 大文件落数据卷磁盘、读回一致、删除清理', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-big', name: 'Big Evidence' });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, { name: 'Bee', handle: 'bee-ev' });
    setParticipants(rig.ctx, 'b-big', [worker.id]);
    createTask(rig.ctx, 'b-big', { id: 'BIG-2', title: '大文件任务', lane: 'Ready' });

    const app = createApp(rig.ctx);
    // 512KiB < size <= 50MiB → 磁盘
    const big = new Uint8Array(EVIDENCE_INLINE_LIMIT + 1024);
    big.fill(0x5a);
    const sha = createHash('sha256').update(big).digest('hex');

    const res = await app.request('/tasks/BIG-2/evidence', {
      method: 'POST',
      headers: {
        ...H(workerToken),
        'content-type': 'application/octet-stream',
        'x-filename': 'big.bin',
        'x-content-sha256': sha,
      },
      body: big as unknown as BodyInit,
    });
    assert.equal(res.status, 201);
    const { file } = (await res.json()) as { file: { id: number; storage: string } };
    assert.equal(file.storage, 'disk', '大文件应落数据卷磁盘');

    // 磁盘上确实有文件
    const diskPath = join(rig.ctx.cfg.dataDir, 'evidence', 'BIG-2');
    assert.ok(existsSync(diskPath), '数据卷 evidence/<taskId>/ 目录已创建');
    const onDisk = readFileSync(join(diskPath, `${file.id}-big.bin`));
    assert.equal(createHash('sha256').update(new Uint8Array(onDisk)).digest('hex'), sha);

    // 下载读回一致
    const dlRes = await app.request(`/tasks/BIG-2/evidence/${file.id}`, { headers: H(workerToken) });
    assert.equal(dlRes.status, 200);
    const dlBuf = new Uint8Array(await dlRes.arrayBuffer());
    assert.equal(dlBuf.byteLength, big.byteLength);

    // 删除：worker 403；蜂后删除后引用与磁盘文件一起清理
    const delRes = await app.request(`/tasks/BIG-2/evidence/${file.id}`, { method: 'DELETE', headers: H(workerToken) });
    assert.equal(delRes.status, 403, 'worker 不能删除证据');
    assert.ok(getTask(rig.ctx, 'BIG-2').evidence.some((e) => e.path.includes('big.bin')), '删除前引用存在');

    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen', handle: 'queen-big', role: 'orchestrator',
    });
    const delRes2 = await app.request(`/tasks/BIG-2/evidence/${file.id}`, { method: 'DELETE', headers: H(queenToken) });
    assert.equal(delRes2.status, 200);
    assert.ok(!existsSync(join(diskPath, `${file.id}-big.bin`)), '磁盘文件已清理');
    assert.ok(!getTask(rig.ctx, 'BIG-2').evidence.some((e) => e.path.includes('big.bin')), '任务引用已摘除');
  } finally {
    rig.cleanup();
  }
});

test('T15 证据上传: 校验边界（SHA 不匹配 400、超限 413、非参与者 403、任务 404）', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-guard', name: 'Guard Board' });
    const { agent: insider } = registerAgent(rig.ctx, { name: 'Insider', handle: 'insider' });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, { name: 'Outsider', handle: 'outsider' });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen', handle: 'queen-guard', role: 'orchestrator',
    });
    // 参与者白名单只放 insider：outsider 应被门禁拒绝
    setParticipants(rig.ctx, 'b-guard', [insider.id]);
    createTask(rig.ctx, 'b-guard', { id: 'GUARD-3', title: '校验任务', lane: 'Ready' });
    const app = createApp(rig.ctx);
    const content = new Uint8Array(Buffer.from('guard-content', 'utf8'));

    // 1. SHA 不匹配 → 400
    const badSha = await app.request('/tasks/GUARD-3/evidence', {
      method: 'POST',
      headers: { ...H(queenToken), 'x-filename': 'a.txt', 'x-content-sha256': '0'.repeat(64) },
      body: content as unknown as BodyInit,
    });
    assert.equal(badSha.status, 400);

    // 2. 超限 → 413
    const oversized = new Uint8Array(EVIDENCE_MAX_BYTES + 1);
    const tooBig = await app.request('/tasks/GUARD-3/evidence', {
      method: 'POST',
      headers: { ...H(queenToken), 'x-filename': 'huge.bin' },
      body: oversized as unknown as BodyInit,
    });
    assert.equal(tooBig.status, 413);

    // 3. 非参与者 worker → 403
    const outsider = await app.request('/tasks/GUARD-3/evidence', {
      method: 'POST',
      headers: { ...H(workerToken), 'x-filename': 'x.txt' },
      body: content as unknown as BodyInit,
    });
    assert.equal(outsider.status, 403);

    // 4. 任务不存在 → 404
    const missing = await app.request('/tasks/NOPE-9/evidence', {
      method: 'POST',
      headers: { ...H(queenToken), 'x-filename': 'x.txt' },
      body: content as unknown as BodyInit,
    });
    assert.equal(missing.status, 404);

    // 5. 路径穿越文件名 → 消毒为纯 basename 后接受，绝不落盘到目录外
    const sneaky = await app.request('/tasks/GUARD-3/evidence', {
      method: 'POST',
      headers: { ...H(queenToken), 'x-filename': encodeURIComponent('../escape.txt') },
      body: content as unknown as BodyInit,
    });
    assert.equal(sneaky.status, 201, '路径穿越被消毒为 basename');
    const sneakyData = (await sneaky.json()) as { file: { filename: string } };
    assert.equal(sneakyData.file.filename, 'escape.txt', '存储文件名不含路径分隔符');
  } finally {
    rig.cleanup();
  }
});
