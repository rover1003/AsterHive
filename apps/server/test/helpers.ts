import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { makeCtx, type Ctx } from '../src/types.ts';

export interface TestRig {
  ctx: Ctx;
  cleanup: () => void;
}

export function mkRig(ttlMinutes = 240): TestRig {
  const dataDir = mkdtempSync(join(tmpdir(), 'asterhive-test-'));
  const db = openDb(dataDir);
  const ctx = makeCtx(db, { dataDir, ttlMinutes, keepSnapshots: 3 });
  return {
    ctx,
    cleanup: () => {
      // 恢复操作会替换 holder.db 为新句柄，必须关"当前"句柄而非创建时的引用
      try {
        ctx.holder.db.close();
      } catch {
        /* 已关闭则忽略 */
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
