// Agent 接入页：设备自助注册（SKILL 一句话自举）、手动预创建身份（高级）、在册列表（设备/生效模型列）

import { api, type Agent } from '../api.ts';
import { subscribe } from '../sse.ts';
import { esc, fmtTime, toast } from '../ui.ts';
import { icon } from '../icons.ts';

// 复制到剪贴板：navigator.clipboard 优先；非安全上下文（LAN http）退回临时 textarea + execCommand
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// 状态列：启用且有心跳 → 绿点「启用」；启用但从不上线 → 灰点「未上线」（pull 架构下未接入即如此）；停用 → 灰点
function statusCell(a: Agent): string {
  if (!a.enabled) return '<span class="status-dot off"></span>停用';
  if (a.lastSeenAt === null) return '<span class="status-dot off"></span>未上线';
  return '<span class="status-dot on"></span>启用';
}

export async function render(el: HTMLElement): Promise<void> {
  el.innerHTML = '<div class="loading">加载中…</div>';

  const load = async () => {
    const r = await api.get<{ agents: Agent[] }>('/agents');
    // 接入极简化：只需要一个信息——服务器地址，其余全部自动。
    // 主路径 = 自举协议一句话：把 <origin>/skill/asterhive-worker 丢给任意 agent，它照做即完成接入。
    const skillUrl = `${location.origin}/skill/asterhive-worker`;
    // 复制给 agent 的就是这句话本身（不含"告诉任何 agent："前缀）
    const bootLine = `访问 ${skillUrl} 并照做——它会自己完成注册、学习循环并常驻`;
    // 附注（人类手动操作时）：--url 默认当前 origin（同源部署）；<仓库> 由设备主人按 docs/WORKER.md clone 后替换
    const runCmd = `ASTERHIVE_URL=${location.origin} node <仓库>/apps/worker-zcode/src/main.ts`;
    const regCmd = `node <仓库>/packages/sdk/src/cli.ts register --url ${location.origin}`;
    el.innerHTML = `
      <div class="view-head"><h2>${icon.plug} Agent 接入</h2><span class="hint">接入一台设备只需要服务器地址——显示名/句柄自动生成，其余全部自动；启停 agent 需要你的身份（设置页配置）</span></div>
      <div class="panel">
        <h3>设备接入（推荐）</h3>
        <p style="font-size:14px;font-weight:600;margin:0 0 8px">告诉任何 agent：<code id="skill-url">${esc(skillUrl)}</code> 并照做——它会自己完成注册、学习循环并常驻 <button class="sm" id="skill-copy" style="margin-left:6px">复制这句话</button></p>
        <p class="hint">注册后的自动名（Worker@…）只是占位符：在下方列表的「设置」里给它改名、选首选模型。</p>
        <details style="margin-top:10px">
          <summary class="hint" style="cursor:pointer">附注（人类手动操作时）</summary>
          <div style="margin-top:8px">
            <p class="hint">接入动作发生在<b>目标设备</b>上：在哪台设备运行命令，身份就属于哪台设备。只需要一个信息——服务器地址；显示名/句柄自动生成（含设备名，撞名自动加后缀），设备名（hostname）自动上报为「设备」。</p>
            <p class="hint" style="margin:10px 0 4px"><b>① 常驻 worker（推荐，启动即自动注册）</b></p>
            <pre class="cmd-line"><code id="run-cmd">${esc(runCmd)}</code></pre>
            <button class="sm" id="run-copy">复制命令</button>
            <p class="hint" style="margin:12px 0 4px"><b>② 仅注册身份（给桌面会话/外部 agent 用）</b></p>
            <pre class="cmd-line"><code id="reg-cmd">${esc(regCmd)}</code></pre>
            <button class="sm" id="cmd-copy">复制命令</button>
            <p class="hint" style="margin-top:6px">&lt;仓库&gt; = 在目标设备 clone 本仓库并 npm install 后的路径（步骤见 docs/WORKER.md）。显示名/句柄自动生成（含设备名）；模型可后补——worker 用 WORKER_MODELS、注册用 --models；看板参与在本页看板管理里勾选即可，worker 多板巡检自动发现。</p>
          </div>
        </details>
      </div>
      <details class="panel">
        <summary style="cursor:pointer;font-weight:600">手动预创建身份（高级）</summary>
        <div class="token-once" style="margin-top:12px"><span class="warn">注意：</span>服务器不会探测设备（pull 架构，agent 不监听端口）——这里只创建身份壳。创建后需把一次性 token 写入目标设备的 ~/.asterhive/worker.json（在该设备上执行 <code>cli configure --token &lt;token&gt;</code>），agent 首次接入后模型/设备/在线状态才会出现。</div>
        <div class="grid-form" style="margin-top:12px">
          <div class="field"><label for="reg-name">名称</label><input id="reg-name" placeholder="如：ZCode 工作机" /></div>
          <div class="field"><label for="reg-handle">@句柄（唯一）</label><input id="reg-handle" placeholder="如：zcode" /></div>
          <div class="field"><label for="reg-role">角色</label>
            <select id="reg-role"><option value="worker">worker</option><option value="orchestrator">orchestrator（主脑）</option></select></div>
        </div>
        <button class="primary" id="reg-submit">注册并签发 token</button>
        <div id="reg-result"></div>
      </details>
      <div class="panel">
        <h3>在册 agent（${r.agents.length}）</h3>
        <table class="table">
          <thead><tr><th>名称</th><th>设备</th><th>@句柄</th><th>角色</th><th>模型</th><th>状态</th><th>心跳</th><th>操作</th></tr></thead>
          <tbody>
            ${r.agents
              .map(
                (a) => `
              <tr>
                <td>${esc(a.name)}</td>
                <td>${a.host ? esc(a.host) : '<span class="muted">—</span>'}</td>
                <td><code>@${esc(a.handle)}</code></td>
                <td><span class="role-badge role-${a.role}">${a.role}</span></td>
                <td class="cell-model">${
                  a.preferredModel
                    ? `<span title="首选模型（完整清单见设置）">${esc(a.preferredModel)}</span>`
                    : a.models.length
                      ? '<span class="muted" title="未指定首选模型，worker 用其本地配置">跟随本地配置</span>'
                      : '<span class="muted" title="接入时自报：CLI 注册 --models 或 worker WORKER_MODELS">未自报</span>'
                }</td>
                <td class="cell-status">${statusCell(a)}</td>
                <td>${a.lastSeenAt ? fmtTime(a.lastSeenAt) : '—'}</td>
                <td>
                  <button class="sm" data-settings="${esc(a.id)}">设置</button>
                  <button class="sm" data-toggle="${esc(a.id)}" data-to="${a.enabled ? 'false' : 'true'}">${a.enabled ? '停用' : '启用'}</button>
                  <button class="sm danger" data-delete="${esc(a.id)}" data-name="${esc(a.name)}">删除</button>
                </td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div id="drawer-host"></div>`;

    // 复制按钮统一接线（自举一句话、接入命令 ×2、桌面提示词 ×1 同一套复制模式）
    const wireCopy = (btnId: string, getText: () => string, label: string): void => {
      (el.querySelector(btnId) as HTMLElement).addEventListener('click', async () => {
        const btn = el.querySelector(btnId) as HTMLElement;
        const ok = await copyText(getText());
        if (ok) {
          btn.textContent = '已复制';
          setTimeout(() => {
            btn.textContent = label;
          }, 1500);
        } else {
          alert('复制失败：请手动选中文本复制');
        }
      });
    };
    wireCopy('#skill-copy', () => bootLine, '复制这句话');
    wireCopy('#run-copy', () => runCmd, '复制命令');
    wireCopy('#cmd-copy', () => regCmd, '复制命令');

    (el.querySelector('#reg-submit') as HTMLElement).addEventListener('click', async () => {
      const name = (el.querySelector('#reg-name') as HTMLInputElement).value.trim();
      const handle = (el.querySelector('#reg-handle') as HTMLInputElement).value.trim();
      const role = (el.querySelector('#reg-role') as HTMLSelectElement).value;
      if (!name || !handle) return;
      try {
        // 注册自由化：无管理令牌门槛，任意角色直接注册（不带 host——设备名属注册时自报，此处是身份壳）
        const res = await api.post<{ agent: Agent; token: string }>('/agents/register', { name, handle, role });
        (el.querySelector('#reg-result') as HTMLElement).innerHTML = `
          <div class="token-once">
            已注册 <b>${esc(res.agent.name)}</b>（@${esc(res.agent.handle)}）。
            token 仅显示这一次，请交给该 agent 的所有者：<code>${esc(res.token)}</code>
            <div class="muted small" style="margin-top:8px">下一步：在目标设备执行 <code>cli configure --token ${esc(res.token)} --url ${location.origin}</code> 写入 ~/.asterhive/worker.json；agent 首次接入后，设备/模型/在线状态才会出现在下方列表。</div>
          </div>`;
        setTimeout(() => void load(), 4000);
      } catch (err) {
        (el.querySelector('#reg-result') as HTMLElement).innerHTML =
          `<div class="token-once error">注册失败：${esc(err instanceof Error ? err.message : '')}</div>`;
      }
    });

    el.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.toggle!;
        const to = (btn as HTMLElement).dataset.to === 'true';
        try {
          // 零令牌：浏览器请求即唯一用户（worker token 才受角色限制）
          await api.patch(`/agents/${id}`, { enabled: to });
          await load();
        } catch (err) {
          alert(`操作失败：${err instanceof Error ? err.message : ''}`);
        }
      });
    });

    el.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.delete!;
        const name = (btn as HTMLElement).dataset.name ?? id;
        if (!confirm(`确定删除 agent「${name}」？\n删除 ≠ 停用：身份与 token 彻底移除，历史记录中的引用将只显示 id。`)) return;
        try {
          await api.del(`/agents/${id}`);
          await load();
        } catch (err) {
          alert(`删除失败：${err instanceof Error ? err.message : ''}`);
        }
      });
    });

    // 「设置」抽屉：改显示名/备注/首选模型（PATCH /agents/:id，零令牌即 user 身份）
    el.querySelectorAll('[data-settings]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.settings!;
        const agent = r.agents.find((a) => a.id === id);
        if (agent) openSettingsDrawer(agent);
      });
    });

    const drawerHost = el.querySelector('#drawer-host') as HTMLElement;

    function openSettingsDrawer(agent: Agent): void {
      const isBrain = agent.id === 'asterhive-brain';
      // 首选模型下拉：自报清单 + 自由填写；当前值不在清单里也单独回显
      const current = agent.preferredModel ?? '';
      const extra =
        current && !agent.models.includes(current)
          ? `<option value="${esc(current)}" selected>${esc(current)}（当前值）</option>`
          : '';
      const modelHint = isBrain
        ? '<div class="muted small">内置主脑的执行模型以「设置页 → 主脑」为准，此处仅作档案记录。</div>'
        : agent.models.length
          ? ''
          : '<div class="muted small">接入时自报：CLI 注册时 --models 一次上报，或 worker 启动经 WORKER_MODELS 上报。</div>';
      drawerHost.innerHTML = `
        <div class="drawer-mask" id="drawer-mask"></div>
        <aside class="drawer">
          <div class="drawer-head"><h3>${icon.gear} Agent 设置</h3><button class="icon-btn" id="drawer-close" title="关闭">${icon.x}</button></div>
          <div class="drawer-body">
            <div class="muted small">
              角色 <span class="role-badge role-${esc(agent.role)}">${esc(agent.role)}</span> ·
              @${esc(agent.handle)}${agent.host ? ` · ${esc(agent.host)}` : ''} ·
              心跳 ${agent.lastSeenAt ? fmtTime(agent.lastSeenAt) : '—'} ·
              id <code>${esc(agent.id)}</code>
            </div>
            <div class="field"><label for="as-name">显示名</label><input id="as-name" value="${esc(agent.name)}" /></div>
            <div class="field"><label for="as-note">备注</label><input id="as-note" value="${esc(agent.note)}" placeholder="如：机房 3 号机 / Mac mini" /></div>
            <div class="field">
              <label for="as-model">首选模型</label>
              ${modelHint}
              <select id="as-model">
                <option value="">（跟随本地配置——不指定）</option>
                ${agent.models.map((m) => `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('')}
                ${extra}
                <option value="__custom__">自定义…</option>
              </select>
              <input id="as-custom" placeholder="自定义模型名（留空 = 清空首选）" style="display:none;margin-top:6px" />
            </div>
            <button class="primary" id="as-save">保存</button>
          </div>
        </aside>`;
      const close = () => (drawerHost.innerHTML = '');
      drawerHost.querySelector('#drawer-close')!.addEventListener('click', close);
      drawerHost.querySelector('#drawer-mask')!.addEventListener('click', close);

      const select = drawerHost.querySelector('#as-model') as HTMLSelectElement;
      const custom = drawerHost.querySelector('#as-custom') as HTMLInputElement;
      const syncCustom = () => {
        const isCustom = select.value === '__custom__';
        custom.style.display = isCustom ? '' : 'none';
        if (isCustom && !custom.value) custom.value = current; // 切自定义时带回当前值便于改
      };
      select.addEventListener('change', syncCustom);
      syncCustom();

      drawerHost.querySelector('#as-save')!.addEventListener('click', async () => {
        const name = (drawerHost.querySelector('#as-name') as HTMLInputElement).value.trim();
        const note = (drawerHost.querySelector('#as-note') as HTMLInputElement).value;
        const preferredModel = (select.value === '__custom__' ? custom.value : select.value).trim();
        if (!name) {
          toast('显示名不能为空', true);
          return;
        }
        try {
          await api.patch(`/agents/${agent.id}`, { name, note, preferredModel });
          toast('已保存 agent 设置');
          close();
          await load();
        } catch (err) {
          toast(`保存失败：${err instanceof Error ? err.message : ''}`, true);
        }
      });
    }
  };

  try {
    await load();
  } catch (err) {
    el.innerHTML = `<div class="empty">加载失败：${esc(err instanceof Error ? err.message : '')}</div>`;
    return;
  }
  const unsub = subscribe((type) => {
    if (type.startsWith('agent.')) void load();
  });
  (el as unknown as { __cleanup?: () => void }).__cleanup = unsub;
}
