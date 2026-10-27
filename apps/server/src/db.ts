import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
      review_status    TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed')),
      review_attempts  INTEGER NOT NULL DEFAULT 0,
      review_reworks   INTEGER NOT NULL DEFAULT 0,
      review_summary   TEXT NOT NULL DEFAULT '',
      submit_summary   TEXT NOT NULL DEFAULT '',
      requirements     TEXT NOT NULL DEFAULT '{}',
      claimed_at       INTEGER,
      last_activity_at INTEGER,
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
    ['review_status', "TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed'))"],
    ['review_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_reworks', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_summary', "TEXT NOT NULL DEFAULT ''"],
    ['submit_summary', "TEXT NOT NULL DEFAULT ''"],
    ['requirements', "TEXT NOT NULL DEFAULT '{}'"],
    ['reads', "TEXT NOT NULL DEFAULT '[]'"],
    ['status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE task ADD COLUMN ${column} ${declaration}`);
    } catch {
      /* 列已存在 */
    }
  }
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
  return db;
}
