import { serve } from '@hono/node-server';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { makeCtx } from './types.ts';
import { createApp } from './http.ts';
import { RepoManager } from './repo-manager.ts';
import { snapshotNow } from './backup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ASTERHIVE_DATA ?? join(here, '..', 'data');
const db = openDb(dataDir);

const ctx = makeCtx(db, {
  dataDir,
  ttlMinutes: Number(process.env.ASTERHIVE_TTL_MINUTES ?? 240),
  keepSnapshots: Number(process.env.ASTERHIVE_KEEP_SNAPSHOTS ?? 3),
});
const repoManager = new RepoManager(ctx);
repoManager.recoverQueuedJobs();
const app = createApp(ctx, repoManager);

const port = Number(process.env.PORT ?? 8067);
const hostname = process.env.HOST ?? '127.0.0.1';

// 启动即留一份冷快照（boot 事件写入前），并记录启动事件。
snapshotNow(ctx.holder.db, ctx.cfg.dataDir, ctx.cfg.keepSnapshots);
ctx.holder.db
  .prepare('INSERT INTO event (type, payload, time_created) VALUES (?, ?, ?)')
  .run('server.started', JSON.stringify({ hostname, port, pid: process.pid }), Date.now());
ctx.bus.publish('server.started', { hostname, port, pid: process.pid });

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[asterhive] dispatch server listening on http://${hostname}:${info.port}`);
});
