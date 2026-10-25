// 审计页：写操作台账（writes.jsonl 的查询面）
import { api, type AuditEntry } from '../api.ts';
import { esc, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

export async function render(el: HTMLElement): Promise<void> {
  const load = async () => {
    const r = await api.get<{ entries: AuditEntry[] }>('/api/audit?limit=200');
    el.innerHTML = `
      <div class="view-head">
        <h2>${icon.list} 审计</h2>
        <button id="audit-refresh" class="sm">刷新</button>
      </div>
      <table class="table">
        <thead><tr><th>时间</th><th>操作</th><th>结果</th><th>详情</th></tr></thead>
        <tbody>
          ${r.entries
            .map(
              (e) => `
            <tr class="${e.result === 'ok' ? '' : 'row-rollback'}">
              <td>${fmtTime(e.time)}</td>
              <td><code>${esc(e.label)}</code></td>
              <td>${e.result === 'ok' ? '<span class="res-ok">成功</span>' : '<span class="res-fail">' + esc(e.result) + '</span>'}</td>
              <td class="muted">${esc(e.detail ?? '')}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
    (el.querySelector('#audit-refresh') as HTMLElement).addEventListener('click', () => void load());
  };
  try {
    await load();
  } catch (err) {
    el.innerHTML = `<div class="empty">加载失败：${esc(err instanceof Error ? err.message : '')}</div>`;
  }
  const timer = setInterval(() => void load().catch(() => {}), 15_000);
  (el as unknown as { __cleanup?: () => void }).__cleanup = () => clearInterval(timer);
}
