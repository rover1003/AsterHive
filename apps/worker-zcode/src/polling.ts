// 多板巡检状态决策（ASTERHIVE_BOARD 接入极简化：缺省不再绑死单板，worker 自动巡检全部看板）。
// 这里只放「板清单 + 403 跳过集合」的纯决策函数，便于单测；main.ts 只做命令编排薄壳。
//
// 模式语义：
//   显式绑板（ASTERHIVE_BOARD 指定）—— 行为与旧单板模式完全一致：只巡检该板，清单无需刷新。
//   多板巡检（缺省）—— 每轮对全部已知看板逐板尝试领活（三通道复用既有实现）；
//     某板收到 403（非参与者）时该板本轮跳过并只 log 一次（firstSkip 防刷屏）；
//     403 的板**不**从清单剔除——下轮自然再试，参与者在页面里被勾上后无需任何特殊处理即自动恢复；
//     板清单定期全量刷新（参与者关系与新建板都可能变化），新板出现自动纳入巡检。

/** 板清单刷新周期：参与者关系与新建板都可能变化，定时全量拉取（默认 30 秒，新板秒级开工） */
export const BOARD_REFRESH_MS = 30_000;

export interface PatrolOptions {
  /** 显式绑定的单板（ASTERHIVE_BOARD）。给出时只巡检它，且永不刷新清单（兼容既有部署与文档） */
  explicitBoard?: string;
  /** 本轮时间戳（ms） */
  now: number;
  /** 上次成功拉取板清单的时间戳（0 = 尚未拉过，视为必刷） */
  lastRefresh: number;
  /** 清单刷新周期（默认 BOARD_REFRESH_MS） */
  refreshMs?: number;
}

export interface PatrolDecision {
  /** 本轮逐板尝试领活的板 id（保持传入顺序；显式绑板时只含该板） */
  poll: string[];
  /** 是否应在领活前重新拉取板清单（getBoards）；拉取失败沿用已知清单，下轮再试 */
  refreshDue: boolean;
}

/** 一轮巡检的板清单决策。
 *  返回的 poll 含全部已知板——**不含** 403 跳过过滤（skipped 集合只用于 firstSkip 的
 *  「只 log 一次」防刷屏，见上）；refreshDue：lastRefresh=0（从未拉过）视为必刷，
 *  否则距上次拉取超过 refreshMs 即刷新。 */
export function nextBoardsToPoll(boards: string[], opts: PatrolOptions): PatrolDecision {
  if (opts.explicitBoard) return { poll: [opts.explicitBoard], refreshDue: false };
  return {
    poll: [...boards],
    refreshDue:
      opts.lastRefresh === 0 || opts.now - opts.lastRefresh >= (opts.refreshMs ?? BOARD_REFRESH_MS),
  };
}

/** 收到 403 时该板是否首次跳过（true 才允许 log，进程级 Set 防刷屏）；副作用：登记进 skipped */
export function firstSkip(skipped: Set<string>, boardId: string): boolean {
  if (skipped.has(boardId)) return false;
  skipped.add(boardId);
  return true;
}
