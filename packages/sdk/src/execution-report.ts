/**
 * AsterHive 任务执行与验收报告（立项计划 / 共享契约）
 * 定义工蜂执行任务时的结构化报告模型、预检项、执行命令记录与脱敏/序列化工具。
 */

export const EXECUTION_REPORT_FILENAME = 'execution-report.json';
export const EXECUTION_REPORT_MAX_BYTES = 262144; // 256 KiB

export interface ExecutionPreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ExecutionCommand {
  tool: string;
  command: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export interface ExecutionReport {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  baseCommit?: string;
  commitHash?: string;
  outcome: 'completed' | 'environment_blocked' | 'verification_failed' | 'execution_failed';
  summary: string;
  startedAt: number;
  finishedAt: number;
  preflight: ExecutionPreflightCheck[];
  commands: ExecutionCommand[];
}

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const GENERIC_KEY_REGEX = /\b(?:sk-[A-Za-z0-9_-]{10,}|key-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,})\b/g;
const SENSITIVE_KV_REGEX = /\b([a-zA-Z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)(['"]?)([^'"\s,;&]+)\2/gi;

/**
 * 脱敏执行输出：过滤 ANSI 控制码、通用凭据/密钥与显式提供的本地密钥。
 */
export function redactExecutionText(text: string, secrets?: string[]): string {
  if (!text) return '';
  let result = text.replace(ANSI_REGEX, '');
  result = result.replace(BEARER_REGEX, 'Bearer [REDACTED]');
  result = result.replace(GENERIC_KEY_REGEX, '[REDACTED]');
  result = result.replace(SENSITIVE_KV_REGEX, '$1$2[REDACTED]$2');

  if (secrets && Array.isArray(secrets)) {
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.trim().length >= 4) {
        result = result.replaceAll(secret, '[REDACTED]');
      }
    }
  }
  return result;
}

/**
 * 在 UTF-8 字节维度安全截断文本，避免多字节字符截断为乱码
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: '', truncated: str.length > 0 };
  }
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text: str, truncated: false };
  }
  const suffix = '\n... [truncated]';
  const suffixBuf = Buffer.from(suffix, 'utf8');
  if (maxBytes <= suffixBuf.byteLength) {
    let sliceEnd = maxBytes;
    while (sliceEnd > 0 && (buf[sliceEnd] & 0xc0) === 0x80) {
      sliceEnd--;
    }
    return { text: buf.subarray(0, sliceEnd).toString('utf8'), truncated: true };
  }
  const targetBytes = maxBytes - suffixBuf.byteLength;

  let sliceEnd = targetBytes;
  // 避免在 UTF-8 多字节序列中间切断
  while (sliceEnd > 0 && (buf[sliceEnd] & 0xc0) === 0x80) {
    sliceEnd--;
  }
  const sliced = buf.subarray(0, sliceEnd).toString('utf8');
  return { text: sliced + suffix, truncated: true };
}

/**
 * 序列化执行报告，确保总字节严格在 maxBytes（默认 256KiB）以内。
 * 结构化缩减 summary、preflight detail 与 commands output，严禁直接对 JSON 字符串做文本截断产生破坏。
 */
export function serializeExecutionReport(
  report: ExecutionReport,
  maxBytes = EXECUTION_REPORT_MAX_BYTES,
  secrets?: string[],
): string {
  const cloned: ExecutionReport = {
    schemaVersion: 1,
    taskId: report.taskId,
    attempt: report.attempt,
    baseCommit: report.baseCommit,
    commitHash: report.commitHash,
    outcome: report.outcome,
    summary: redactExecutionText(report.summary || '', secrets),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    preflight: (report.preflight || []).map((p) => ({
      name: redactExecutionText(p.name || '', secrets),
      ok: Boolean(p.ok),
      detail: redactExecutionText(p.detail || '', secrets),
    })),
    commands: (report.commands || []).map((c) => ({
      tool: redactExecutionText(c.tool || '', secrets),
      command: redactExecutionText(c.command || '', secrets),
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      exitCode: c.exitCode,
      output: redactExecutionText(c.output || '', secrets),
      truncated: Boolean(c.truncated),
    })),
  };

  let json = JSON.stringify(cloned);
  let bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return json;

  // 骨架大小检查（无 outputs、空 summary）
  const skeleton = JSON.stringify({
    ...cloned,
    summary: '',
    commands: cloned.commands.map((c) => ({ ...c, output: '' })),
  });
  const skeletonBytes = Buffer.byteLength(skeleton, 'utf8');
  if (skeletonBytes + 64 > maxBytes) {
    throw new Error(`Execution report metadata exceeds maxBytes (${skeletonBytes} > ${maxBytes})`);
  }

  // 结构化预算分配：先缩减 summary，再均衡分配剩余预算给各命令 output
  const remainingForContent = maxBytes - skeletonBytes - 64;
  const summaryBudget = Math.min(
    Buffer.byteLength(cloned.summary, 'utf8'),
    Math.max(256, Math.floor(remainingForContent / 4)),
  );
  if (Buffer.byteLength(cloned.summary, 'utf8') > summaryBudget) {
    cloned.summary = truncateUtf8Bytes(cloned.summary, summaryBudget).text;
  }

  const baseMetaJson = JSON.stringify({
    ...cloned,
    commands: cloned.commands.map((c) => ({ ...c, output: '' })),
  });
  const baseMetaBytes = Buffer.byteLength(baseMetaJson, 'utf8');
  const remainingForOutputs = Math.max(0, maxBytes - baseMetaBytes - 64);
  const commandCount = cloned.commands.length || 1;
  const perCommandBudget = Math.floor(remainingForOutputs / commandCount);

  for (const cmd of cloned.commands) {
    if (cmd.output) {
      const truncated = truncateUtf8Bytes(cmd.output, perCommandBudget);
      cmd.output = truncated.text;
      cmd.truncated = cmd.truncated || truncated.truncated;
    }
  }

  json = JSON.stringify(cloned);
  bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    // 极限保护：将所有输出替换为固定截断标记
    for (const cmd of cloned.commands) {
      cmd.output = '... [truncated]';
      cmd.truncated = true;
    }
    json = JSON.stringify(cloned);
    bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`Execution report metadata exceeds maxBytes (${bytes} > ${maxBytes})`);
    }
  }
  return json;
}

/**
 * 解析并严格校验执行报告对象：校验所有字段类型、嵌套结构与数值有限性
 */
export function parseExecutionReport(content: string | Uint8Array): ExecutionReport | null {
  try {
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.taskId !== 'string' || !parsed.taskId.trim()) return null;
    if (typeof parsed.attempt !== 'number' || !Number.isInteger(parsed.attempt) || parsed.attempt < 1) return null;
    const outcomes = ['completed', 'environment_blocked', 'verification_failed', 'execution_failed'];
    if (!outcomes.includes(String(parsed.outcome))) return null;
    if (typeof parsed.summary !== 'string') return null;
    if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return null;
    if (typeof parsed.finishedAt !== 'number' || !Number.isFinite(parsed.finishedAt)) return null;

    if (parsed.baseCommit !== undefined && typeof parsed.baseCommit !== 'string') return null;
    if (parsed.commitHash !== undefined && typeof parsed.commitHash !== 'string') return null;

    if (!Array.isArray(parsed.preflight)) return null;
    for (const p of parsed.preflight) {
      if (!p || typeof p !== 'object') return null;
      if (typeof p.name !== 'string' || typeof p.ok !== 'boolean' || typeof p.detail !== 'string') return null;
    }

    if (!Array.isArray(parsed.commands)) return null;
    for (const c of parsed.commands) {
      if (!c || typeof c !== 'object') return null;
      if (typeof c.tool !== 'string' || typeof c.command !== 'string') return null;
      if (typeof c.startedAt !== 'number' || !Number.isFinite(c.startedAt)) return null;
      if (typeof c.finishedAt !== 'number' || !Number.isFinite(c.finishedAt)) return null;
      if (c.exitCode !== null && (typeof c.exitCode !== 'number' || !Number.isFinite(c.exitCode))) return null;
      if (typeof c.output !== 'string' || typeof c.truncated !== 'boolean') return null;
    }

    return {
      schemaVersion: 1,
      taskId: String(parsed.taskId),
      attempt: Number(parsed.attempt),
      baseCommit: parsed.baseCommit as string | undefined,
      commitHash: parsed.commitHash as string | undefined,
      outcome: parsed.outcome as ExecutionReport['outcome'],
      summary: String(parsed.summary),
      startedAt: Number(parsed.startedAt),
      finishedAt: Number(parsed.finishedAt),
      preflight: parsed.preflight as ExecutionPreflightCheck[],
      commands: parsed.commands as ExecutionCommand[],
    };
  } catch {
    return null;
  }
}
