import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_REPORT_MAX_BYTES,
  type ExecutionReport,
  redactExecutionText,
  truncateUtf8Bytes,
  serializeExecutionReport,
  parseExecutionReport,
} from '../src/index.ts';

test('ExecutionReport: 结构化解析与序列化往返保证', () => {
  const validReport: ExecutionReport = {
    schemaVersion: 1,
    taskId: 'T-200',
    attempt: 3,
    baseCommit: 'commit-base-1234567890abcdef',
    commitHash: 'commit-head-abcdef1234567890',
    outcome: 'completed',
    summary: '工蜂已成功执行所有验证命令并合入工作区',
    startedAt: 1700000000000,
    finishedAt: 1700000050000,
    preflight: [
      { name: 'node', ok: true, detail: 'v24.0.0' },
      { name: 'git', ok: true, detail: 'git version 2.45.0' },
      { name: 'shell', ok: true, detail: 'powershell 7.4.0' },
    ],
    commands: [
      {
        tool: 'powershell',
        command: 'npm run test:unit',
        startedAt: 1700000010000,
        finishedAt: 1700000040000,
        exitCode: 0,
        output: 'tests 10 passed',
        truncated: false,
      },
    ],
  };

  const serialized = serializeExecutionReport(validReport);
  const parsed = parseExecutionReport(serialized);

  assert.ok(parsed !== null, '合法报告必须成功解析');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.taskId, 'T-200');
  assert.equal(parsed.attempt, 3);
  assert.equal(parsed.baseCommit, 'commit-base-1234567890abcdef');
  assert.equal(parsed.commitHash, 'commit-head-abcdef1234567890');
  assert.equal(parsed.outcome, 'completed');
  assert.equal(parsed.summary, '工蜂已成功执行所有验证命令并合入工作区');
  assert.equal(parsed.preflight.length, 3);
  assert.equal(parsed.commands.length, 1);
  assert.equal(parsed.commands[0].exitCode, 0);
});

test('ExecutionReport: 非法 Schema、错误类型与损坏数据安全拒识', () => {
  assert.equal(parseExecutionReport('not-a-json'), null, '畸形 JSON 应返回 null');
  assert.equal(parseExecutionReport('{}'), null, '空对象应返回 null');

  // schemaVersion !== 1
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 2, taskId: 'T-1', attempt: 1, outcome: 'completed', preflight: [], commands: [] })),
    null,
    '未知的 schemaVersion 必须拒识',
  );

  // 非法 outcome
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: 'T-1', attempt: 1, outcome: 'unknown_status', preflight: [], commands: [] })),
    null,
    '非法的 outcome 状态必须拒识',
  );

  // 缺失 taskId 或 attempt 非正整数
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: '', attempt: 1, outcome: 'completed', preflight: [], commands: [] })),
    null,
    '空 taskId 必须拒识',
  );
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: 'T-1', attempt: '1', outcome: 'completed', preflight: [], commands: [] })),
    null,
    '字符串 attempt 必须拒识',
  );
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: 'T-1', attempt: 0, outcome: 'completed', preflight: [], commands: [] })),
    null,
    '非正整数 attempt (0) 必须拒识',
  );
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: 'T-1', attempt: 1.5, outcome: 'completed', preflight: [], commands: [] })),
    null,
    '浮点数 attempt 必须拒识',
  );

  // 非有限时间戳数值
  assert.equal(
    parseExecutionReport(JSON.stringify({ schemaVersion: 1, taskId: 'T-1', attempt: 1, outcome: 'completed', startedAt: '123', finishedAt: 456, preflight: [], commands: [] })),
    null,
    '非数值 startedAt 必须拒识',
  );

  // 嵌套 preflight 元素类型不符
  assert.equal(
    parseExecutionReport(JSON.stringify({
      schemaVersion: 1, taskId: 'T-1', attempt: 1, outcome: 'completed', startedAt: 100, finishedAt: 200, summary: '',
      preflight: [{ name: 'node', ok: 'yes', detail: 'v24' }],
      commands: [],
    })),
    null,
    'preflight.ok 为字符串时必须拒识',
  );

  // 嵌套 commands 元素字段缺失或类型错误
  assert.equal(
    parseExecutionReport(JSON.stringify({
      schemaVersion: 1, taskId: 'T-1', attempt: 1, outcome: 'completed', startedAt: 100, finishedAt: 200, summary: '',
      preflight: [],
      commands: [{ tool: 'bash', command: 'ls', startedAt: 10, finishedAt: 20, exitCode: '0', output: '', truncated: false }],
    })),
    null,
    'commands.exitCode 为字符串时必须拒识',
  );
  assert.equal(
    parseExecutionReport(JSON.stringify({
      schemaVersion: 1, taskId: 'T-1', attempt: 1, outcome: 'completed', startedAt: 100, finishedAt: 200, summary: '',
      preflight: [],
      commands: [{ tool: 'bash', command: 'ls', startedAt: 10, finishedAt: 20, exitCode: 0, output: '', truncated: 'false' }],
    })),
    null,
    'commands.truncated 非布尔时必须拒识',
  );
});

test('ExecutionReport: 中文多字节与 Emoji 截断边界安全且不超 256KiB 上限', () => {
  // 每个中文字符占 3 字节，Emoji 占 4 字节
  const multibyteChunk = '星巢蜂群任务执行验证报告🚀💥';
  const repeated = multibyteChunk.repeat(20_000); // 远超 256KiB

  const report: ExecutionReport = {
    schemaVersion: 1,
    taskId: 'T-MULTI',
    attempt: 1,
    outcome: 'completed',
    summary: '多字节截断测试',
    startedAt: 1000,
    finishedAt: 2000,
    preflight: [{ name: 'node', ok: true, detail: 'v24.0.0' }],
    commands: [
      {
        tool: 'shell',
        command: 'run-multibyte-test',
        startedAt: 1100,
        finishedAt: 1900,
        exitCode: 0,
        output: repeated,
        truncated: false,
      },
    ],
  };

  const serialized = serializeExecutionReport(report);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  assert.ok(totalBytes <= EXECUTION_REPORT_MAX_BYTES, `序列化后字节 ${totalBytes} 必须严格 <= ${EXECUTION_REPORT_MAX_BYTES}`);

  // 验证截断后依然是合法 UTF-8，且能被正常反序列化，不会出现 UTF-8 乱码导致的 JSON 解析失败
  const parsed = parseExecutionReport(serialized);
  assert.ok(parsed !== null, '截断后的内容必须保持合法 JSON 与完整字符边界');
  assert.equal(parsed.commands[0].truncated, true, '被截断的命令必须标记 truncated: true');
  assert.ok(parsed.commands[0].output.includes('... [truncated]'), '输出尾部应包含截断标记');
});

test('ExecutionReport: 凭据脱敏、自定义模型 Key 脱敏与 ANSI 颜色代码清理', () => {
  const customModelKey = 'sk-custom-asterhive-agent-secret-9876543210';
  const text = [
    '\x1b[31;1m[ERROR]\x1b[0m 无法连接到上游',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak',
    `OPENAI_API_KEY=${customModelKey}`,
    'github_token=ghp_ABC1234567890abcdef1234567890abcdef',
    'api_secret: "my_secret_password_12345"',
  ].join('\n');

  const redacted = redactExecutionText(text, [customModelKey]);

  assert.ok(!redacted.includes('\x1b['), '所有 ANSI 控制字符均被清理');
  assert.ok(!redacted.includes('eyJhbGciOi'), 'Bearer 令牌被遮蔽');
  assert.ok(!redacted.includes(customModelKey), '传入的自定义模型 Key 被彻底遮蔽');
  assert.ok(!redacted.includes('ghp_ABC123'), 'GitHub Token 被遮蔽');
  assert.ok(!redacted.includes('my_secret_password'), '密码字段被遮蔽');
  assert.ok(redacted.includes('[REDACTED]'), '脱敏后必须包含占位符');
});

test('truncateUtf8Bytes: maxBytes 小于 suffix 字节长度时严格不超预算', () => {
  const raw = '这是一段测试文本，用于检验极小预算下的截断行为';
  for (const limit of [0, 1, 3, 5, 10, 15, 20]) {
    const res = truncateUtf8Bytes(raw, limit);
    const byteLen = Buffer.byteLength(res.text, 'utf8');
    assert.ok(byteLen <= limit, `实际字节数 ${byteLen} 不得超过限制 ${limit}`);
    if (limit === 0) {
      assert.equal(res.text, '');
    }
  }
});

test('serializeExecutionReport: 递归脱敏 command 与 preflight 并在元数据超限时抛错而非破损 JSON', () => {
  const secret = 'sk-secret-command-token-12345';
  const report: ExecutionReport = {
    schemaVersion: 1,
    taskId: 'T-REDACT-CMD',
    attempt: 1,
    outcome: 'completed',
    summary: `调用了包含 ${secret} 的命令`,
    startedAt: 1000,
    finishedAt: 2000,
    preflight: [{ name: `check-${secret}`, ok: true, detail: `detail-${secret}` }],
    commands: [
      {
        tool: 'powershell',
        command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com`,
        startedAt: 1100,
        finishedAt: 1200,
        exitCode: 0,
        output: `connected with ${secret}`,
        truncated: false,
      },
    ],
  };

  const json = serializeExecutionReport(report, EXECUTION_REPORT_MAX_BYTES, [secret]);
  assert.ok(!json.includes(secret), 'command、preflight.name 与 summary 中的密钥必须全部被脱敏');
  const parsed = parseExecutionReport(json);
  assert.ok(parsed !== null, '脱敏后必须保持合法可解析 JSON');
  assert.ok(parsed!.commands[0].command.includes('[REDACTED]'));

  // 元数据自身（骨架）超过预算时应抛出错误，严禁截断成破坏性 JSON
  assert.throws(
    () => serializeExecutionReport(report, 50),
    /Execution report metadata exceeds maxBytes/,
    '报告骨架超预算时必须抛错',
  );
});
