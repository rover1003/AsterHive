import type { DatabaseSync } from 'node:sqlite';

export interface Config {
  dataDir: string;
  ttlMinutes: number;
  keepSnapshots: number;
  adminRecoveryToken?: string;
}

export interface Holder {
  db: DatabaseSync;
}

export interface PendingEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface Ctx {
  holder: Holder;
  cfg: Config;
  bus: Bus;
  pending: PendingEvent[];
}

export type Listener = (type: string, payload: Record<string, unknown>, id: number) => void;

export class Bus {
  #listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  publish(type: string, payload: Record<string, unknown>, id = 0): void {
    for (const fn of this.#listeners) fn(type, payload, id);
  }
}

export function makeCtx(db: DatabaseSync, cfg: Config): Ctx {
  return { holder: { db }, cfg, bus: new Bus(), pending: [] };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 拒收乱码输入：坏编码客户端（如 Windows GBK 控制台 curl）会产生 U+FFFD 替换符，
// 与其存进库不如当场报错——浏览器正常 UTF-8 提交不受影响。
export function assertNoMojibake(value: string, field: string): void {
  if (value.includes('\uFFFD')) {
    throw new HttpError(422, `invalid encoding in ${field}: 请用 UTF-8 提交`);
  }
}
