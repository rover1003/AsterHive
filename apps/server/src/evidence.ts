import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { getTask, getBoard, requireParticipant, type Task } from './tasks.ts';
import type { Agent } from './agents.ts';
import { withWrite, logEvent } from './write.ts';
import {
  EXECUTION_REPORT_FILENAME,
  EXECUTION_REPORT_MAX_BYTES,
  parseExecutionReport,
  type ExecutionReport,
} from '../../../packages/sdk/src/execution-report.ts';

export { EXECUTION_REPORT_FILENAME, EXECUTION_REPORT_MAX_BYTES };


// 证据文件分层存储（立项计划 §10）：
// - 小文件（<= 512KiB）直接入库（SQLite BLOB，随库快照备份）
// - 大文件（<= 50MiB）落数据卷磁盘，库内只登记元数据与 SHA-256 校验和
export const EVIDENCE_INLINE_LIMIT = 512 * 1024;
export const EVIDENCE_MAX_BYTES = 50 * 1024 * 1024;

export interface EvidenceFile {
  id: number;
  taskId: string;
  boardId: string;
  filename: string;
  size: number;
  sha256: string;
  storage: 'db' | 'disk';
  note: string;
  uploadedBy: string;
  createdAt: number;
  attempt?: number | null;
}

type EvidenceFileRow = {
  id: number;
  task_id: string;
  board_id: string;
  filename: string;
  size: number;
  sha256: string;
  storage: 'db' | 'disk';
  content: Uint8Array | null;
  disk_path: string | null;
  note: string;
  uploaded_by: string;
  created_at: number;
  attempt: number | null;
};

function rowToFile(r: EvidenceFileRow): EvidenceFile {
  return {
    id: r.id,
    taskId: r.task_id,
    boardId: r.board_id,
    filename: r.filename,
    size: r.size,
    sha256: r.sha256,
    storage: r.storage,
    note: r.note,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    attempt: r.attempt ?? null,
  };
}

export function ensureEvidenceTable(ctx: Ctx): void {
  ctx.holder.db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_file (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT NOT NULL,
      board_id     TEXT NOT NULL,
      filename     TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      storage      TEXT NOT NULL CHECK (storage IN ('db','disk')),
      content      BLOB,
      disk_path    TEXT,
      note         TEXT NOT NULL DEFAULT '',
      uploaded_by  TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      attempt      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence_file (task_id);
  `);
  try {
    ctx.holder.db.exec('ALTER TABLE evidence_file ADD COLUMN attempt INTEGER;');
  } catch {
    /* 列已存在 */
  }
}

// 文件名安全化：去路径分隔符与控制字符，防目录穿越；保留中文与常用符号
function sanitizeFilename(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\x00-\x1f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new HttpError(422, 'valid filename required');
  return cleaned.slice(0, 128);
}

function evidenceDiskRoot(ctx: Ctx): string {
  return join(ctx.cfg.dataDir, 'evidence');
}

/** 上传证据文件：SHA-256 校验、分层落库/落盘，并在任务 evidence 登记一条引用 */
export function storeEvidenceFile(
  ctx: Ctx,
  actor: Agent,
  taskId: string,
  filename: string,
  content: Uint8Array,
  note = '',
  expectedSha256 = '',
  attempt?: number,
): EvidenceFile {
  ensureEvidenceTable(ctx);
  const task = getTask(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  let resolvedAttempt: number | null = null;
  if (actor.role === 'worker') {
    requireParticipant(ctx, task.boardId, actor);
    if (task.assignee !== actor.id) {
      throw new HttpError(403, `worker ${actor.id} is not the current assignee of task ${taskId}`);
    }
    if (task.lane !== 'InProgress') {
      throw new HttpError(409, `task ${taskId} is not InProgress (current lane: ${task.lane})`);
    }
    const taskAttempt = task.attempt ?? 1;
    if (taskAttempt > 1) {
      if (attempt === undefined || Number.isNaN(attempt)) {
        throw new HttpError(
          409,
          `stale or unversioned execution attempt: task ${taskId} has been re-dispatched (attempt ${taskAttempt}); request must include current attempt (upgrade worker SDK)`,
        );
      }
      if (attempt !== taskAttempt) {
        throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${attempt}`);
      }
    } else if (attempt !== undefined && !Number.isNaN(attempt) && attempt !== taskAttempt) {
      throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${attempt}`);
    }
    resolvedAttempt = taskAttempt;
  } else {
    resolvedAttempt = attempt !== undefined && !Number.isNaN(attempt) ? attempt : (task.attempt ?? null);
  }
  getBoard(ctx, task.boardId);
  const safeName = sanitizeFilename(filename);
  if (content.byteLength < 1) throw new HttpError(422, 'evidence file must not be empty');
  if (content.byteLength > EVIDENCE_MAX_BYTES) {
    throw new HttpError(413, `evidence file exceeds ${EVIDENCE_MAX_BYTES} bytes; register it by path+checksum instead`);
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
    throw new HttpError(400, 'evidence SHA-256 mismatch');
  }
  const cleanNote = note.slice(0, 256);

  const storage: 'db' | 'disk' = content.byteLength <= EVIDENCE_INLINE_LIMIT ? 'db' : 'disk';
  const now = Date.now();

  const id = withWrite(ctx, 'task.evidence_uploaded', () => {
    // 先插行拿 id，再决定落盘位置（disk 行的 disk_path 用 id 命名防冲突）
    const result = ctx.holder.db
      .prepare(
        `INSERT INTO evidence_file (task_id, board_id, filename, size, sha256, storage, content, disk_path, note, uploaded_by, created_at, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        task.boardId,
        safeName,
        content.byteLength,
        sha256,
        storage,
        storage === 'db' ? content : null,
        null,
        cleanNote,
        actor.id,
        now,
        resolvedAttempt,
      ) as { lastInsertRowid: number | bigint };
    const rowId = Number(result.lastInsertRowid);

    if (storage === 'disk') {
      const abs = join(evidenceDiskRoot(ctx), taskId, `${rowId}-${safeName}`);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, { mode: 0o600 });
      ctx.holder.db
        .prepare('UPDATE evidence_file SET disk_path = ? WHERE id = ?')
        .run(abs, rowId);
    }

    // 任务 evidence 追加引用（看板卡片既有渲染直接可见）
    const evidence = task.evidence ?? [];
    evidence.push({
      path: `evidence-file:${rowId}:${safeName}`,
      machine: 'server',
      note: `${content.byteLength}B · sha256:${sha256.slice(0, 12)}${cleanNote ? ` · ${cleanNote}` : ''}`,
    });
    ctx.holder.db
      .prepare('UPDATE task SET evidence = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(evidence), now, taskId);

    logEvent(ctx, 'task.evidence_uploaded', {
      taskId,
      boardId: task.boardId,
      fileId: rowId,
      filename: safeName,
      size: content.byteLength,
      sha256,
      storage,
      by: actor.id,
      attempt: resolvedAttempt,
    });
    return rowId;
  });

  return getEvidenceFile(ctx, taskId, id);
}

export function listEvidenceFiles(ctx: Ctx, taskId: string): EvidenceFile[] {
  ensureEvidenceTable(ctx);
  getTask(ctx, taskId); // 404 if missing
  const rows = ctx.holder.db
    .prepare('SELECT * FROM evidence_file WHERE task_id = ? ORDER BY id')
    .all(taskId) as unknown as EvidenceFileRow[];
  return rows.map(rowToFile);
}

function fetchEvidenceRow(ctx: Ctx, taskId: string, fileId: number): EvidenceFileRow {
  const row = ctx.holder.db
    .prepare('SELECT * FROM evidence_file WHERE id = ? AND task_id = ?')
    .get(fileId, taskId) as unknown as EvidenceFileRow | undefined;
  if (!row) throw new HttpError(404, `evidence file not found: ${fileId}`);
  return row;
}

export function getEvidenceFile(ctx: Ctx, taskId: string, fileId: number): EvidenceFile {
  ensureEvidenceTable(ctx);
  getTask(ctx, taskId); // 404 if missing
  return rowToFile(fetchEvidenceRow(ctx, taskId, fileId));
}

/** 读取证据文件内容：db 行直读 BLOB；disk 行从数据卷读回。 */
export function readEvidenceContent(ctx: Ctx, taskId: string, fileId: number): { file: EvidenceFile; content: Uint8Array } {
  ensureEvidenceTable(ctx);
  getTask(ctx, taskId); // 404 if missing
  const row = fetchEvidenceRow(ctx, taskId, fileId);
  if (row.storage === 'db' && row.content) {
    return { file: rowToFile(row), content: new Uint8Array(row.content) };
  }
  if (row.storage === 'disk' && row.disk_path) {
    const abs = resolve(row.disk_path);
    const root = resolve(evidenceDiskRoot(ctx));
    // 防御：磁盘路径必须仍在 evidence 根内（脏数据兜底）
    if (abs !== root && !abs.startsWith(root + sep)) throw new HttpError(500, 'evidence disk path escaped data volume');
    return { file: rowToFile(row), content: new Uint8Array(readFileSync(abs)) };
  }
  throw new HttpError(500, 'evidence file content is missing');
}

/** 删除证据文件：连任务 evidence 引用与磁盘文件一起清理（用户/主脑仲裁用）。 */
export function deleteEvidenceFile(ctx: Ctx, actor: Agent, taskId: string, fileId: number): void {
  if (actor.role === 'worker') throw new HttpError(403, 'workers cannot delete evidence files');
  ensureEvidenceTable(ctx);
  const task: Task = getTask(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  const row = fetchEvidenceRow(ctx, taskId, fileId);
  withWrite(ctx, 'task.evidence_deleted', () => {
    // 磁盘行先取回实际路径再删行
    ctx.holder.db.prepare('DELETE FROM evidence_file WHERE id = ?').run(fileId);
    if (row.storage === 'disk' && row.disk_path) {
      const abs = resolve(row.disk_path);
      const root = resolve(evidenceDiskRoot(ctx));
      if (abs === root || abs.startsWith(root + sep)) {
        rmSync(abs, { force: true });
      }
    }
    // 从任务 evidence 引用里摘除
    const evidence = (task.evidence ?? []).filter((e) => !e.path.startsWith(`evidence-file:${fileId}:`));
    ctx.holder.db
      .prepare('UPDATE task SET evidence = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(evidence), Date.now(), taskId);
    logEvent(ctx, 'task.evidence_deleted', { taskId, fileId, by: actor.id });
  });
}

/**
 * 检索并校验当前代次的执行报告：
 * 必须由当前 assignee 上传、代次匹配、大小严格受限（<=256KiB）、schema 合法，
 * 且当存在被审提交时核验 commitHash 一致性。
 */
export function findCurrentExecutionReport(
  ctx: Ctx,
  taskId: string,
  assignee: string,
  attempt: number,
  expectedCommitHash?: string,
): { report: ExecutionReport; file: EvidenceFile } | { error: string } {
  ensureEvidenceTable(ctx);
  const files = listEvidenceFiles(ctx, taskId);
  const candidates = files
    .filter(
      (f) =>
        f.filename === EXECUTION_REPORT_FILENAME &&
        f.uploadedBy === assignee &&
        f.attempt === attempt,
    )
    .sort((a, b) => b.id - a.id);

  if (candidates.length === 0) {
    return { error: `missing execution report for task ${taskId} attempt ${attempt} by ${assignee}` };
  }

  const latestFile = candidates[0];
  if (latestFile.size > EXECUTION_REPORT_MAX_BYTES) {
    return { error: `execution report file exceeds ${EXECUTION_REPORT_MAX_BYTES} bytes` };
  }

  const { content } = readEvidenceContent(ctx, taskId, latestFile.id);
  const report = parseExecutionReport(content);
  if (!report) {
    return { error: `malformed execution report schema for task ${taskId}` };
  }

  if (report.taskId !== taskId) {
    return { error: `report taskId ${report.taskId} does not match ${taskId}` };
  }

  if (report.attempt !== attempt) {
    return { error: `report attempt ${report.attempt} does not match expected attempt ${attempt}` };
  }

  if (expectedCommitHash) {
    if (!report.commitHash) {
      return { error: `report missing commitHash for task ${taskId}; expected ${expectedCommitHash}` };
    }
    if (report.commitHash !== expectedCommitHash) {
      return { error: `report commitHash ${report.commitHash} does not match reviewed head ${expectedCommitHash}` };
    }
  }

  return { report, file: latestFile };
}
