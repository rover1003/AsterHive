import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeExecutions } from './executions.ts';
import { initializeSessionObservation } from './session-observation.ts';

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'asterhive.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS event (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      time_created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_type_time ON event (type, time_created);

    CREATE TABLE IF NOT EXISTS board (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      wip         TEXT NOT NULL DEFAULT '{}',
      repo        TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      repo_mode TEXT NOT NULL DEFAULT 'remote-legacy' CHECK (repo_mode IN ('managed','remote-legacy')),
      repo_status TEXT NOT NULL DEFAULT 'ready' CHECK (repo_status IN ('empty','queued','running','ready','failed')),
      repo_error TEXT NOT NULL DEFAULT '',
      repo_head TEXT NOT NULL DEFAULT '',
      repo_source TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- 看板参与者：空表 = 开放给所有 agent；有行 = 仅列表内 worker 可领活/认领/被派活
    CREATE TABLE IF NOT EXISTS board_participant (
      board_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (board_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS task (
      id               TEXT PRIMARY KEY,
      board_id         TEXT NOT NULL REFERENCES board(id),
      title            TEXT NOT NULL,
      detail           TEXT NOT NULL DEFAULT '',
      lane             TEXT NOT NULL DEFAULT 'Backlog'
                       CHECK (lane IN ('Backlog','Ready','InProgress','Review','Done')),
      assignee         TEXT NOT NULL DEFAULT 'unassigned',
      depends_on       TEXT NOT NULL DEFAULT '[]',
      priority         TEXT NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0','P1','P2')),
      category         TEXT NOT NULL DEFAULT '',
      acceptance       TEXT NOT NULL DEFAULT '',
      workspace        TEXT NOT NULL DEFAULT '{}',
      files            TEXT NOT NULL DEFAULT '[]',
      reads            TEXT NOT NULL DEFAULT '[]',
      evidence         TEXT NOT NULL DEFAULT '[]',
      protected_paths  TEXT NOT NULL DEFAULT '[]',
      review_status    TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed','environment_blocked','needs_evidence')),
      review_attempts  INTEGER NOT NULL DEFAULT 0,
      review_reworks   INTEGER NOT NULL DEFAULT 0,
      review_summary   TEXT NOT NULL DEFAULT '',
      submit_summary   TEXT NOT NULL DEFAULT '',
      requirements     TEXT NOT NULL DEFAULT '{}',
      claimed_at       INTEGER,
      last_activity_at INTEGER,
      last_real_activity_at INTEGER,
      last_progress_at INTEGER,
      last_activity_kind TEXT,
      attempt          INTEGER NOT NULL DEFAULT 1,
      auto_unblocked_at INTEGER,
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_board_lane ON task (board_id, lane);

    CREATE TABLE IF NOT EXISTS agent (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      handle       TEXT NOT NULL UNIQUE,
      role         TEXT NOT NULL CHECK (role IN ('worker','orchestrator','user')),
      token_hash   TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER,
      delivered_message_id INTEGER NOT NULL DEFAULT 0,
      models       TEXT NOT NULL DEFAULT '[]',
      preferred_model TEXT,
      note         TEXT NOT NULL DEFAULT '',
      host         TEXT NOT NULL DEFAULT '',
      specs        TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS message (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id   TEXT NOT NULL,
      author     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      mentions   TEXT NOT NULL DEFAULT '[]',
      task_ref   TEXT,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_board_id ON message (board_id, id);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // 旧库升级：agent 消息投递游标
  try {
    db.exec('ALTER TABLE agent ADD COLUMN delivered_message_id INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* 列已存在 */
  }
  // 旧库升级：board 项目元数据（GitHub 仓库地址 / 描述）
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo_mode TEXT NOT NULL DEFAULT 'remote-legacy'");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo_status TEXT NOT NULL DEFAULT 'ready'");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo_error TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo_head TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE board ADD COLUMN repo_source TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  // 旧库升级：独立审核员 Profile 的任务审核状态与有限重做计数
  for (const [column, declaration] of [
    ['review_status', "TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed','environment_blocked','needs_evidence'))"],
    ['review_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_reworks', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_summary', "TEXT NOT NULL DEFAULT ''"],
    ['submit_summary', "TEXT NOT NULL DEFAULT ''"],
    ['requirements', "TEXT NOT NULL DEFAULT '{}'"],
    ['reads', "TEXT NOT NULL DEFAULT '[]'"],
    ['status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))"],
    ['last_real_activity_at', 'INTEGER'],
    ['last_progress_at', 'INTEGER'],
    ['last_activity_kind', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
  ] as const) {
    try {
      db.exec(`ALTER TABLE task ADD COLUMN ${column} ${declaration}`);
    } catch {
      /* 列已存在 */
    }
  }
  // 旧库升级：若 task 表包含旧的 review_status CHECK 约束，以安全事务重建表以放行 environment_blocked 与 needs_evidence
  migrateTaskReviewStatusCheck(db);
  // 旧库升级：agent 档案（自报模型清单 JSON / 首选模型 / 备注）
  try {
    db.exec("ALTER TABLE agent ADD COLUMN models TEXT NOT NULL DEFAULT '[]'");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec('ALTER TABLE agent ADD COLUMN preferred_model TEXT');
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("ALTER TABLE agent ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  // 旧库升级：agent 接入设备名（注册时自报——在哪台设备跑 cli register 就属于哪台设备）
  try {
    db.exec("ALTER TABLE agent ADD COLUMN host TEXT NOT NULL DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  // 旧库升级：agent 设备能力自报（操作系统、架构、CPU、内存等规格）
  try {
    db.exec("ALTER TABLE agent ADD COLUMN specs TEXT NOT NULL DEFAULT '{}'");
  } catch {
    /* 列已存在 */
  }
  initializeExecutions(db);
  initializeSessionObservation(db);
  return db;
}

export function migrateTaskReviewStatusCheck(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task'").get() as { sql?: string } | undefined;
  if (!row?.sql || !row.sql.includes('review_status') || row.sql.includes('environment_blocked')) {
    return;
  }

  const checkRegex = /CHECK\s*\(\s*review_status\s+IN\s*\(\s*'none'\s*,\s*'pending'\s*,\s*'reviewing'\s*,\s*'passed'\s*,\s*'rework'\s*,\s*'blocked'\s*,\s*'failed'\s*\)\s*\)/i;
  if (!checkRegex.test(row.sql)) {
    return;
  }

  // 获取所有关联的索引与触发器创建语句（排除 sqlite 内部自动生成的索引，如 sqlite_autoindex_*）
  const relatedObjects = db
    .prepare("SELECT name, type, sql FROM sqlite_master WHERE tbl_name = 'task' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all() as { name: string; type: string; sql: string }[];

  const newCheck = "CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed','environment_blocked','needs_evidence'))";
  let newSql = row.sql.replace(checkRegex, newCheck);
  if (newSql === row.sql) {
    throw new Error('failed to update review_status CHECK constraint in task table definition');
  }

  const tableCreateRegex = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"task"|`task`|\[task\]|task)\b/i;
  if (!tableCreateRegex.test(newSql)) {
    throw new Error(`cannot match CREATE TABLE statement for task in: ${row.sql}`);
  }
  newSql = newSql.replace(tableCreateRegex, 'CREATE TABLE task_migrating');

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(newSql);
    db.exec('INSERT INTO task_migrating SELECT * FROM task;');
    db.exec('DROP TABLE task;');
    db.exec('ALTER TABLE task_migrating RENAME TO task;');
    for (const obj of relatedObjects) {
      if (obj.sql) {
        db.exec(obj.sql);
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* ignore rollback error */
    }
    throw new Error(`failed to migrate task table review_status check constraint: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
