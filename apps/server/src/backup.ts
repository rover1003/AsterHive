import type { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import type { Holder } from './types.ts';

const SNAP_PREFIX = 'asterhive-snap-';
const AUDIT_FILE = 'writes.jsonl';

function sqlString(path: string): string {
  return "'" + path.split('\\').join('/').replace(/'/g, "''") + "'";
}

export interface SnapshotInfo {
  name: string;
  size: number;
  time: number;
}

export function listSnapshots(dataDir: string): SnapshotInfo[] {
  const dir = join(dataDir, 'snapshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(SNAP_PREFIX) && f.endsWith('.db'))
    .map((f) => {
      const full = join(dir, f);
      return {
        name: f,
        size: statSync(full).size,
        time: Number(f.slice(SNAP_PREFIX.length).replace('.db', '')) || 0,
      };
    })
    .sort((a, b) => b.time - a.time);
}

// 写前快照：VACUUM INTO 生成干净副本（WAL 活动时可安全执行），按时间轮换保留最近 N 份。
export function snapshotNow(db: DatabaseSync, dataDir: string, keep: number): SnapshotInfo {
  const dir = join(dataDir, 'snapshots');
  mkdirSync(dir, { recursive: true });
  const name = `${SNAP_PREFIX}${Date.now()}.db`;
  db.exec(`VACUUM INTO ${sqlString(join(dir, name))}`);
  for (const old of listSnapshots(dataDir).slice(keep)) {
    rmSync(join(dir, old.name), { force: true });
  }
  return listSnapshots(dataDir).find((s) => s.name === name)!;
}

// 恢复：关闭当前句柄 → 快照覆盖主库 → 重开。服务器是唯一写者，短暂关闭安全。
export function restoreSnapshot(holder: Holder, dataDir: string, name: string): void {
  const snapPath = join(dataDir, 'snapshots', name);
  if (!name.startsWith(SNAP_PREFIX) || !name.endsWith('.db') || !existsSync(snapPath)) {
    throw new Error(`snapshot not found: ${name}`);
  }
  holder.db.close();
  const mainPath = join(dataDir, 'asterhive.db');
  copyFileSync(snapPath, mainPath);
  rmSync(mainPath + '-wal', { force: true });
  rmSync(mainPath + '-shm', { force: true });
  holder.db = openDb(dataDir);
}

// 独立写审计日志（Hermes kanban_db 纪律）：每次结构化写一条 JSONL。
export interface AuditEntry {
  time: number;
  label: string;
  result: 'ok' | 'rollback';
  detail?: string;
}

export function auditWrite(dataDir: string, entry: AuditEntry): void {
  appendFileSync(join(dataDir, AUDIT_FILE), JSON.stringify(entry) + '\n');
}

export function readAudit(dataDir: string, limit: number): AuditEntry[] {
  const file = join(dataDir, AUDIT_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as AuditEntry);
}
