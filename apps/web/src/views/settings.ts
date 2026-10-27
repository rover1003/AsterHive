// 设置页：用户名（显示名）+ 内置蜂后设置（启用开关/运行状态）+ 模型组（多模型组）+ Pi 运行时卡片
// 零令牌终态（2026-10-25 用户终裁）：浏览器不携带任何凭据，服务器把请求视为唯一用户——
// 用户名只是聊天室里的显示名，不存在 token 的签发/保存/轮换。
//
// 蜂后多模型组（2026-10-25）：蜂后的模型通道（Base URL + API Key + 模型）按「组」管理——
// 每组可独立刷新模型列表 / 测试连通 / 一键启用；启用组即蜂后下一轮使用的通道。
// 背景痛点：上游账号池瞬时 503 时，切到备用组立刻恢复（服务端经 settings.orchestrator_updated
// 弃旧会话重建，见 brain.ts）。全局面板只管 enabled 开关；组数据走组接口（CRUD/active/models/test）。
import {
  api,
  setCachedUserName,
  type OrchestratorModelsResult,
  type OrchestratorSettings,
  type OrchestratorTestResult,
  type RuntimeStatus,
  type UserStatus,
} from '../api.ts';
import { esc, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

let modelsTimer: ReturnType<typeof setInterval> | null = null; // 模型列表 60s 自动刷新（视图重渲染时清理）

// 模型下拉的「自定义…」兜底：列表滞后/私货模型时手填（沿用旧单配置时代的模式）
const CUSTOM_OPT = '__custom__';

// 组卡的本地视图模型（apiKey 永不回显，只有 apiKeySet 布尔）
interface GroupVm {
  id: string;
  name: string;
  baseURL: string;
  model?: string;
  apiKeySet: boolean;
}

export async function render(el: HTMLElement): Promise<void> {
  el.innerHTML = `
    <div class="view-head"><h2>${icon.gear} 设置</h2></div>
    <div class="panel">
      <h3>用户</h3>
      <p class="muted">单用户系统——用户名只是聊天室里的显示名，保存即生效，无需任何令牌。</p>
      <div class="grid-form">
        <div class="field"><label for="user-handle">用户名</label><input id="user-handle" placeholder="如 老板" /></div>
      </div>
      <div class="inline-form">
        <button class="primary" id="user-save">保存</button>
      </div>
      <p class="muted small">当前状态：<span id="user-status">加载中…</span></p>
      <div id="user-result"></div>
    </div>
    <div class="panel">
      <h3>蜂后设置（内置蜂后，模式 B）</h3>
      <p class="muted">蜂后是服务器常驻的调度者：拆解建卡 / 分派 / 验收 / 汇报，绝不执行任务。模型通道（Base URL + API Key + 模型）在下方「模型组」按组管理，这里只管总开关。</p>
      <div class="grid-form">
        <div class="field"><label for="oc-enabled">启用蜂后</label>
          <select id="oc-enabled"><option value="off">关闭（默认）</option><option value="on">启用</option></select>
        </div>
        <div class="field"><label for="oc-reviewer-enabled">独立审核员</label>
          <select id="oc-reviewer-enabled"><option value="off">关闭（蜂后手动验收）</option><option value="on">启用（托管仓库自动审核）</option></select>
        </div>
        <div class="field"><label for="oc-reviewer-group">审核模型</label>
          <div style="display:flex; gap:8px; align-items:stretch">
            <select id="oc-reviewer-group" style="flex:1; min-width:0"><option value="">跟随蜂后当前模型组</option></select>
            <button class="sm" id="oc-reviewer-refresh" style="height:auto" title="绕过 60 秒缓存，强制重新拉取各组模型清单">刷新</button>
          </div>
        </div>
      </div>
      <div class="inline-form">
        <button class="primary" id="oc-save">保存</button>
        <span id="oc-status" class="muted small">加载中…</span>
      </div>
      <div id="oc-runtime-line" class="muted small" style="margin-top:8px"></div>
    </div>
    <div class="panel">
      <h3>模型组</h3>
      <p class="muted">蜂后的模型通道按组管理：每组 = 名称 + Base URL + API Key（加密存储，界面永不回显）+ 模型。各组可独立刷新模型列表、测试连通、一键启用——上游账号池瞬时 503 时切到备用组，蜂后下一轮即走新通道。</p>
      <div id="oc-groups"></div>
      <div class="inline-form">
        <button class="primary" id="oc-group-add">＋ 添加模型组</button>
        <span id="oc-groups-status" class="muted small"></span>
      </div>
    </div>
    <div class="panel">
      <h3>Pi 运行时</h3>
      <p class="muted">蜂后的 Pi agent 运行时装由服务器数据卷自管理（不进镜像）：装新版 → 原子切换 → 旧版保留可回滚；更新不重启服务器，只影响下次蜂后会话创建。</p>
      <div id="rt-status" class="muted small">加载中…</div>
      <div class="inline-form">
        <button id="rt-update">更新到最新版</button>
        <button id="rt-rollback" class="danger">回滚上一版</button>
      </div>
      <div id="rt-result"></div>
      <p class="muted small">社区插件挂载点：<code id="rt-extdir">…</code><br />把社区插件放到该目录（每个插件一个子目录）即可被蜂后会话加载；服务器不预装任何插件。</p>
    </div>
    <div class="panel">
      <h3>蜂后扩展与技能</h3>
      <p class="muted">管理蜂后的 Pi 扩展插件与技能：npm 包名安装（服务器代装入数据卷）、启停、删除；技能直接写 SKILL.md。变更不打断运行中的会话，蜂后下个会话生效。</p>
      <div id="ext-list" class="muted small">加载中…</div>
      <div class="inline-form">
        <input id="ext-pkg" placeholder="npm 包名，如 @scope/some-pi-ext" style="flex:1;min-width:220px" />
        <button class="primary" id="ext-install">安装扩展</button>
      </div>
      <div id="ext-result" class="muted small"></div>
      <div style="margin-top:12px"><b class="small">技能（skills/）</b></div>
      <div id="skill-list" class="muted small">加载中…</div>
      <div class="inline-form">
        <input id="skill-name" placeholder="技能目录名，如 deep-review" style="min-width:180px" />
        <button id="skill-refresh">刷新</button>
      </div>
      <textarea id="skill-markdown" rows="6" placeholder="SKILL.md 全文（Markdown，可含 frontmatter）" style="width:100%;margin-top:6px"></textarea>
      <div class="inline-form">
        <button class="primary" id="skill-save">保存 / 覆盖技能</button>
        <button class="danger" id="skill-delete">删除该技能</button>
      </div>
      <div id="skill-result" class="muted small"></div>
    </div>`;

  // ---- 用户：回填用户名；保存只是改名 ----
  const statusEl = el.querySelector('#user-status') as HTMLElement;
  const input = el.querySelector('#user-handle') as HTMLInputElement;
  const result = el.querySelector('#user-result') as HTMLElement;
  try {
    const u = await api.get<UserStatus>('/api/user');
    input.value = u.handle ?? '';
    statusEl.textContent = u.handle ? `当前用户名：${u.handle}` : '未设置（用默认名"用户"）';
  } catch (err) {
    statusEl.textContent = `读取失败：${err instanceof Error ? err.message : ''}`;
  }

  (el.querySelector('#user-save') as HTMLElement).addEventListener('click', async () => {
    const h = input.value.trim();
    if (!h) {
      result.innerHTML = '<span class="warn">请输入用户名</span>';
      return;
    }
    try {
      const res = await api.put<{ handle: string }>('/api/user', { handle: h });
      setCachedUserName(res.handle);
      statusEl.textContent = `当前用户名：${res.handle}`;
      result.innerHTML = `已保存：${esc(res.handle)}`;
    } catch (err) {
      result.innerHTML = `<span class="warn">保存失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
  });

  // ---- 蜂后全局开关：保存只管 enabled（wakeOn 无界面字段，走同一接口透传）----
  const ocStatus = el.querySelector('#oc-status') as HTMLElement;
  const groupsStatus = el.querySelector('#oc-groups-status') as HTMLElement;
  const groupsBox = el.querySelector('#oc-groups') as HTMLElement;
  let brainEnabled = false;
  let reviewerEnabled = false;
  let reviewerGroupId: string | null = null;
  let reviewerModel: string | null = null;

  // ---- 模型组：本地状态 + 事件委托（innerHTML 重渲染不重复绑监听）----
  let groups: GroupVm[] = [];
  let activeGroupId: string | null = null;
  let editingId: string | null = null; // 内联编辑中的组（null = 无；显示下拉被编辑表单取代）
  let creating = false; // 「＋ 添加模型组」的空白内联表单
  const modelCache = new Map<string, { models: string[]; fetchedAt: number }>(); // groupId → 上游清单
  const hints = new Map<string, string>(); // groupId → 模型区反馈（重渲染后保留）

  const cssId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, ''); // 组 id 恒为 g+hex，无损

  function setHint(id: string, html: string): void {
    hints.set(id, html);
    const span = groupsBox.querySelector(`[data-id="${cssId(id)}"] span[data-role="hint"]`) as HTMLElement | null;
    if (span) span.innerHTML = html;
  }

  // 下拉选项：cur 未设且有清单 → 占位项；cur 不在清单 → 「（当前，未见于上游列表）」；末尾恒有自定义兜底
  function modelOptionsHtml(models: string[], cur: string): string {
    const opts: string[] = [];
    if (!cur && models.length > 0) opts.push('<option value="">（未设置——选择或自定义）</option>');
    for (const m of models) opts.push(`<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`);
    if (cur && !models.includes(cur)) {
      opts.push(`<option value="${esc(cur)}" selected>${esc(cur)}（当前，未见于上游列表）</option>`);
    }
    opts.push(`<option value="${CUSTOM_OPT}"${!cur && models.length === 0 ? ' selected' : ''}>自定义…</option>`);
    return opts.join('');
  }

  function fillSelect(sel: HTMLSelectElement, custom: HTMLInputElement | null, models: string[], cur: string): void {
    sel.innerHTML = modelOptionsHtml(models, cur);
    if (custom) custom.style.display = sel.value === CUSTOM_OPT ? '' : 'none';
  }

  // 读取某容器内「下拉 + 自定义兜底」的最终模型值
  function readModelField(card: HTMLElement, selRole: string, customRole: string): string {
    const sel = card.querySelector(`select[data-role="${selRole}"]`) as HTMLSelectElement | null;
    if (!sel) return '';
    if (sel.value === CUSTOM_OPT) {
      const custom = card.querySelector(`input[data-role="${customRole}"]`) as HTMLInputElement | null;
      return custom?.value.trim() ?? '';
    }
    return sel.value;
  }

  // 用缓存清单回填某组的所有模型下拉（显示 + 编辑表单）；用户正选「自定义…」时不打断
  function hydrateGroupSelects(id: string): void {
    const card = groupsBox.querySelector(`[data-id="${cssId(id)}"]`);
    const g = groups.find((x) => x.id === id);
    if (!card || !g) return;
    const models = modelCache.get(id)?.models ?? [];
    for (const [selRole, customRole] of [['model', 'model-custom'], ['f-model', 'f-model-custom']] as const) {
      const sel = card.querySelector(`select[data-role="${selRole}"]`) as HTMLSelectElement | null;
      if (!sel || sel.value === CUSTOM_OPT) continue;
      const custom = card.querySelector(`input[data-role="${customRole}"]`) as HTMLInputElement | null;
      fillSelect(sel, custom, models, sel.value !== '' ? sel.value : (g.model ?? ''));
    }
  }

  // 编辑/新建内联表单（g=null 即新建空白表单；apiKey 仅提交不回显）
  function groupFormHtml(g: GroupVm | null): string {
    const models = g ? (modelCache.get(g.id)?.models ?? []) : [];
    const cur = g?.model ?? '';
    return `
    <div class="oc-group-form grid-form" style="margin-top:14px">
      <div class="field"><label>名称</label><input data-role="f-name" value="${g ? esc(g.name) : ''}" placeholder="如 主通道 / 备用池" /></div>
      <div class="field"><label>Base URL</label><input data-role="f-baseurl" value="${g ? esc(g.baseURL) : ''}" placeholder="https://api.openai.com/v1" /></div>
      <div class="field"><label>API Key</label><input data-role="f-key" type="password" autocomplete="new-password" placeholder="${g ? (g.apiKeySet ? '留空保留原 KEY' : '输入 API Key') : 'API Key（加密存储，仅提交不回显）'}" /></div>
      <div class="field"><label>模型</label>
        <select data-role="f-model" title="列表来自该组上游 /models 接口；列表缺失时选「自定义…」手填">${modelOptionsHtml(models, cur)}</select>
        <input data-role="f-model-custom" placeholder="自定义模型名" style="display:none; margin-top:6px" />
      </div>
    </div>
    <div class="inline-form">
      <button class="primary" data-act="${g ? 'save-edit' : 'save-new'}">${g ? '保存修改' : '创建模型组'}</button>
      <button data-act="cancel">取消</button>
    </div>`;
  }

  function groupCardHtml(g: GroupVm): string {
    const isActive = g.id === activeGroupId;
    return `
    <div class="oc-group${isActive ? ' oc-group-active' : ''}" data-id="${esc(g.id)}">
      <div class="oc-group-head">
        <div class="oc-group-title">
          <b>${esc(g.name)}</b>${isActive ? '<span class="oc-active-badge">当前使用</span>' : ''}
          <div class="muted small">${esc(g.baseURL)}${g.apiKeySet ? ' · KEY 已设置' : ' · <span class="warn">未设 KEY</span>'}</div>
        </div>
        <div class="oc-group-actions">
          <button data-act="refresh" title="立即从上游重新拉取该组的模型列表">刷新列表</button>
          <button data-act="test" title="向上游发一条极短的测试消息，确认选中模型此刻真实可用">测试连通</button>
          ${isActive
            ? '<button disabled title="正在使用该组">当前使用</button>'
            : '<button data-act="activate" class="primary" title="切换蜂后到此通道，下一轮生效">启用此组</button>'}
          <button data-act="edit" title="修改名称 / Base URL / KEY / 模型">编辑</button>
          <button data-act="del" class="danger" title="删除该组（当前使用的组需先切换）">删除</button>
        </div>
      </div>
      ${editingId === g.id
        ? groupFormHtml(g)
        : `<div class="grid-form" style="margin-top:12px; margin-bottom:0">
            <div class="field"><label>模型</label>
              <select data-role="model" title="列表来自该组上游 /models 接口，每 60 秒静默刷新；改动即保存"></select>
              <input data-role="model-custom" placeholder="自定义模型名" style="display:none; margin-top:6px" />
              <div class="inline-form" style="margin-top:6px"><span data-role="hint" class="muted small">${hints.get(g.id) ?? '拉取模型列表…'}</span></div>
            </div>
          </div>`}
    </div>`;
  }

  function renderGroups(): void {
    const cards = groups.map(groupCardHtml).join('');
    const newForm = creating
      ? `<div class="oc-group" data-id="__new__">
          <div class="oc-group-head"><div class="oc-group-title"><b>新模型组</b><div class="muted small">创建后即可刷新模型列表 / 测试连通 / 启用；空组态创建的第一组自动启用</div></div></div>
          ${groupFormHtml(null)}
        </div>`
      : '';
    groupsBox.innerHTML =
      cards + newForm ||
      '<p class="muted small">还没有模型组——添加第一组（名称 + Base URL + API KEY + 模型）后蜂后才能开始轮次。</p>';
    for (const g of groups) hydrateGroupSelects(g.id);
  }

  // 审核员模型下拉：复用各组已拉取的完整清单（optgroup 按组分组），与下方模型组共用 modelCache。
  // 选中值编码为 "组id|模型名"；未拉取到清单的组回退为该组当前 model 单项。
  function populateReviewerSelect(): void {
    const sel = el.querySelector('#oc-reviewer-group') as HTMLSelectElement;
    const parts: string[] = ['<option value="">跟随蜂后当前模型组</option>'];
    for (const g of groups) {
      const cached = modelCache.get(g.id);
      const models = cached?.models?.length ? cached.models : g.model ? [g.model] : [];
      if (models.length) {
        parts.push(
          `<optgroup label="${esc(g.name)}">${models
            .map((m) => `<option value="${esc(`${g.id}|${m}`)}"${reviewerGroupId === g.id && reviewerModel === m ? ' selected' : ''}>${esc(m)}</option>`)
            .join('')}</optgroup>`,
        );
      } else {
        parts.push(`<option value="${esc(g.id)}|"${reviewerGroupId === g.id && !reviewerModel ? ' selected' : ''}>${esc(g.name)}（未拉取到模型清单）</option>`);
      }
    }
    sel.innerHTML = parts.join('');
  }

  // 全局状态行：启用态与激活组配置是否齐全（与服务端 #turn 的启动条件一致）
  function updateGlobalStatus(): void {
    const active = groups.find((g) => g.id === activeGroupId);
    const reviewerGroupObj = reviewerGroupId ? groups.find((g) => g.id === reviewerGroupId) : active;
    const reviewerModelShown = reviewerGroupId ? (reviewerModel ?? reviewerGroupObj?.model) : active?.model;
    const reviewerReady = !!reviewerGroupObj?.baseURL && !!reviewerModelShown && reviewerGroupObj.apiKeySet;
    const reviewerStatus = reviewerEnabled
      ? reviewerReady ? ` · Reviewer「${reviewerGroupObj!.name} · ${reviewerModelShown}」` : ' · Reviewer 模型组配置不完整'
      : ' · Reviewer 关闭';
    if (!brainEnabled) {
      ocStatus.textContent = `蜂后关闭 · 模型组 ${groups.length} 个`;
      return;
    }
    if (!active) {
      ocStatus.innerHTML = '<span class="warn">蜂后已启用但没有任何模型组——添加并启用一组后蜂后才会开始轮次。</span>';
      return;
    }
    if (!active.model || !active.apiKeySet) {
      const missing = [active.model ? '' : '模型', active.apiKeySet ? '' : 'API KEY'].filter(Boolean).join('和');
      ocStatus.innerHTML = `<span class="warn">蜂后已启用，当前通道「${esc(active.name)}」缺${missing}——补全后蜂后才会开始轮次。</span>`;
      return;
    }
    ocStatus.textContent = `运行中：通道「${active.name}」 · 模型 ${active.model}${reviewerStatus}`;
  }

  async function reload(): Promise<void> {
    try {
      const s = await api.get<OrchestratorSettings>('/settings/orchestrator');
      groups = (s.groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        baseURL: g.baseURL,
        ...(g.model ? { model: g.model } : {}),
        apiKeySet: !!g.apiKeySet,
      }));
      activeGroupId = s.activeGroupId ?? null;
      reviewerGroupId = s.reviewerGroupId ?? null;
      reviewerModel = s.reviewerModel ?? null;
      reviewerEnabled = !!s.reviewerEnabled;
      brainEnabled = !!s.enabled;
      (el.querySelector('#oc-enabled') as HTMLSelectElement).value = brainEnabled ? 'on' : 'off';
      (el.querySelector('#oc-reviewer-enabled') as HTMLSelectElement).value = reviewerEnabled ? 'on' : 'off';
      if (reviewerGroupId && !groups.some((g) => g.id === reviewerGroupId)) {
        reviewerGroupId = null;
        reviewerModel = null;
      }
      populateReviewerSelect();
      renderGroups();
      updateGlobalStatus();
      for (const g of groups) if (!modelCache.has(g.id)) void loadGroupModels(g);
    } catch {
      groupsStatus.innerHTML = '<span class="warn">模型组读取失败</span>';
    }
  }

  // 按组拉取模型清单（60s 服务端缓存；成功后只回填下拉，不整卡重渲染——不打断编辑中的表单）；
  // force = 手动刷新按钮，绕过服务端缓存
  async function loadGroupModels(g: GroupVm, silent = true, force = false): Promise<void> {
    setHint(g.id, silent ? '刷新模型列表…' : '拉取模型列表…');
    try {
      const r = await api.get<OrchestratorModelsResult>(
        `/settings/orchestrator/models?group=${encodeURIComponent(g.id)}${force ? '&force=1' : ''}`,
      );
      modelCache.set(g.id, { models: r.models, fetchedAt: r.fetchedAt });
      setHint(
        g.id,
        `共 ${r.models.length} 个模型 · 更新于 ${new Date(r.fetchedAt).toLocaleTimeString()}${r.cached ? '（缓存）' : ''}`,
      );
      hydrateGroupSelects(g.id);
      populateReviewerSelect();
    } catch (err) {
      setHint(g.id, `列表拉取失败：${esc(err instanceof Error ? err.message : '')}`);
      if (!modelCache.has(g.id)) hydrateGroupSelects(g.id); // 空清单 → 下拉只剩「自定义…」兜底
    }
  }

  // 展示下拉改动即保存（激活组改模型 → 服务端 orchestrator_updated → 蜂后重建会话走新模型）
  async function saveGroupModel(id: string, card: HTMLElement): Promise<void> {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const m = readModelField(card, 'model', 'model-custom');
    if (!m) return; // 占位项（未设置）不保存
    try {
      await api.put(`/settings/orchestrator/groups/${encodeURIComponent(id)}`, { model: m });
      g.model = m;
      setHint(id, `<span class="ok">模型已保存：${esc(m)}${id === activeGroupId ? '（当前通道，下一轮生效）' : ''}</span>`);
      updateGlobalStatus();
    } catch (err) {
      setHint(id, `<span class="warn">模型保存失败：${esc(err instanceof Error ? err.message : '')}</span>`);
    }
  }

  // 收集编辑/新建表单字段：apiKey 仅在非空时提交（服务端缺省 = 保留原 KEY）
  function readFormFields(card: HTMLElement): { name?: string; baseURL?: string; apiKey?: string; model?: string } {
    const val = (role: string): string =>
      (card.querySelector(`input[data-role="${role}"]`) as HTMLInputElement | null)?.value.trim() ?? '';
    const body: { name?: string; baseURL?: string; apiKey?: string; model?: string } = {
      name: val('f-name') || undefined,
      baseURL: val('f-baseurl') || undefined,
      model: readModelField(card, 'f-model', 'f-model-custom') || undefined,
    };
    const key = val('f-key');
    if (key) body.apiKey = key;
    return body;
  }

  async function handleGroupAction(act: string, id: string, card: HTMLElement | null): Promise<void> {
    const g = groups.find((x) => x.id === id);
    const fail = (err: unknown): void => {
      groupsStatus.innerHTML = `<span class="warn">操作失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    };
    try {
      switch (act) {
        case 'refresh': {
          if (g) await loadGroupModels(g, false);
          return;
        }
        case 'test': {
          if (!g || !card) return;
          const m = readModelField(card, 'model', 'model-custom');
          if (!m) {
            setHint(g.id, '<span class="warn">请先选择或填写模型</span>');
            return;
          }
          setHint(g.id, `测试 ${esc(m)} 中…`);
          const r = await api.post<OrchestratorTestResult>('/settings/orchestrator/test', { groupId: g.id, model: m });
          setHint(
            g.id,
            r.ok
              ? `<span class="ok">✓ ${esc(m)} 可用 · ${r.latencyMs}ms</span>`
              : `<span class="warn">✗ ${esc(m)} 不可用（${r.status || '网络错误'}：${esc(r.error ?? '')}）</span>`,
          );
          return;
        }
        case 'activate': {
          if (!g) return;
          await api.put('/settings/orchestrator/active', { groupId: g.id });
          await reload();
          groupsStatus.innerHTML = `<span class="ok">已切换到 ${esc(g.name)}，蜂后下一轮使用新通道</span>`;
          return;
        }
        case 'edit': {
          creating = false;
          editingId = editingId === id ? null : id;
          renderGroups();
          return;
        }
        case 'del': {
          if (!g) return;
          if (!confirm(`删除模型组「${g.name}」？该组配置不可恢复。`)) return;
          await api.del(`/settings/orchestrator/groups/${encodeURIComponent(g.id)}`);
          groupsStatus.innerHTML = `已删除「${esc(g.name)}」`;
          await reload();
          return;
        }
        case 'save-edit': {
          if (!g || !card) return;
          await api.put(`/settings/orchestrator/groups/${encodeURIComponent(g.id)}`, readFormFields(card));
          editingId = null;
          await reload();
          groupsStatus.innerHTML = `<span class="ok">已保存「${esc(g.name)}」</span>`;
          return;
        }
        case 'save-new': {
          if (!card) return;
          const body = readFormFields(card);
          if (!body.name || !body.baseURL) {
            groupsStatus.innerHTML = '<span class="warn">名称与 Base URL 必填</span>';
            return;
          }
          await api.post('/settings/orchestrator/groups', body);
          creating = false;
          await reload();
          groupsStatus.innerHTML = '<span class="ok">模型组已创建</span>';
          return;
        }
        case 'cancel': {
          editingId = null;
          creating = false;
          renderGroups();
          return;
        }
      }
    } catch (err) {
      fail(err);
    }
  }

  groupsBox.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const card = btn.closest('[data-id]') as HTMLElement | null;
    void handleGroupAction(btn.dataset.act ?? '', card?.dataset.id ?? '', card);
  });

  groupsBox.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest('select[data-role]') as HTMLSelectElement | null;
    if (!sel) return;
    const card = sel.closest('[data-id]') as HTMLElement | null;
    if (!card) return;
    const customRole = sel.dataset.role === 'model' ? 'model-custom' : 'f-model-custom';
    const custom = card.querySelector(`input[data-role="${customRole}"]`) as HTMLInputElement | null;
    if (custom) {
      custom.style.display = sel.value === CUSTOM_OPT ? '' : 'none';
      if (sel.value === CUSTOM_OPT) custom.focus();
    }
    // 展示下拉（非编辑态）改动即保存；编辑表单的下拉只改表单值，保存时统一提交
    if (sel.dataset.role === 'model' && card.dataset.id && card.dataset.id !== '__new__') {
      void saveGroupModel(card.dataset.id, card);
    }
  });

  (el.querySelector('#oc-group-add') as HTMLElement).addEventListener('click', () => {
    editingId = null;
    creating = true;
    renderGroups();
    (groupsBox.querySelector('[data-id="__new__"] input[data-role="f-name"]') as HTMLInputElement | null)?.focus();
  });

  (el.querySelector('#oc-save') as HTMLElement).addEventListener('click', async () => {
    const enabled = (el.querySelector('#oc-enabled') as HTMLSelectElement).value === 'on';
    const nextReviewerEnabled = (el.querySelector('#oc-reviewer-enabled') as HTMLSelectElement).value === 'on';
    // 审核员下拉选中值编码为 "组id|模型名"（空 = 跟随蜂后当前模型组）
    const rawReviewer = (el.querySelector('#oc-reviewer-group') as HTMLSelectElement).value || '';
    const sep = rawReviewer.indexOf('|');
    const nextReviewerGroupId = sep === -1 ? rawReviewer || null : rawReviewer.slice(0, sep) || null;
    const nextReviewerModel = sep === -1 ? null : rawReviewer.slice(sep + 1) || null;
    try {
      await api.put<OrchestratorSettings>('/settings/orchestrator', {
        enabled,
        reviewerEnabled: nextReviewerEnabled,
        reviewerGroupId: nextReviewerGroupId,
        reviewerModel: nextReviewerModel,
      });
      brainEnabled = enabled;
      reviewerEnabled = nextReviewerEnabled;
      reviewerGroupId = nextReviewerGroupId;
      reviewerModel = nextReviewerModel;
      updateGlobalStatus();
    } catch (err) {
      ocStatus.textContent = `保存失败：${err instanceof Error ? err.message : ''}`;
    }
  });

  // 审核员清单手动刷新：绕过服务端 60s 缓存，逐组强拉
  (el.querySelector('#oc-reviewer-refresh') as HTMLElement).addEventListener('click', async () => {
    const btn = el.querySelector('#oc-reviewer-refresh') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      for (const g of groups) await loadGroupModels(g, false, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });

  // 初始加载 + 60s 静默刷新各组模型清单（视图重渲染时清掉旧轮询）
  if (modelsTimer) clearInterval(modelsTimer);
  await reload();
  modelsTimer = setInterval(() => {
    for (const g of groups) void loadGroupModels(g, true);
  }, 60_000);

  // ---- 蜂后运行状态行：从事件台账尾部取最新 brain.* ----
  const runtimeLine = el.querySelector('#oc-runtime-line') as HTMLElement;
  async function refreshBrainRuntimeLine(): Promise<void> {
    try {
      const r = await api.get<{ events: { id: number; type: string; payload: Record<string, unknown>; time_created: number }[] }>(
        '/api/events?limit=50',
      );
      const latest = r.events.find((e) => e.type.startsWith('brain.'));
      if (!latest) {
        runtimeLine.textContent = '蜂后运行状态：暂无记录（未启用或尚未唤醒过）';
        return;
      }
      const detail =
        latest.type === 'brain.turn_finished'
          ? `上轮耗时 ${Math.round(Number(latest.payload.turnMs ?? 0) / 1000)}s`
          : latest.type === 'brain.error' || latest.type === 'brain.turn_timeout'
            ? String(latest.payload.reason ?? '')
            : latest.type === 'brain.turn_started' && typeof latest.payload.groupName === 'string'
              ? `通道「${latest.payload.groupName}」`
              : '';
      runtimeLine.textContent = `蜂后运行状态：${latest.type}${detail ? `（${detail}）` : ''} · ${fmtTime(latest.time_created)}`;
    } catch {
      runtimeLine.textContent = '蜂后运行状态：读取失败';
    }
  }
  refreshBrainRuntimeLine();

  // ---- Pi 运行时卡片：当前版本 | 上游最新 | 更新 / 回滚 ----
  const rtStatus = el.querySelector('#rt-status') as HTMLElement;
  const rtResult = el.querySelector('#rt-result') as HTMLElement;
  async function refreshRuntime(): Promise<void> {
    try {
      const s = await api.get<RuntimeStatus>('/settings/runtime');
      (el.querySelector('#rt-extdir') as HTMLElement).textContent = s.extensionsDir;
      if (s.updating) {
        rtStatus.textContent = `更新中：${s.updating.from} → ${s.updating.to}…`;
        return;
      }
      const cur = s.current ?? '未知';
      const src = s.source === 'volume' ? '数据卷' : '仓库基线';
      rtStatus.innerHTML = `当前版本：<b>${esc(cur)}</b>（${src}）｜ 上游最新：<b>${s.latest ? esc(s.latest) : '未知（npm 不可达或离线）'}</b>${
        s.latest && s.current && s.latest !== s.current ? ' —— 有新版本可更新' : ''
      }`;
    } catch (err) {
      rtStatus.textContent = `读取失败：${err instanceof Error ? err.message : ''}`;
    }
  }
  refreshRuntime();
  (el.querySelector('#rt-update') as HTMLElement).addEventListener('click', async () => {
    if (!confirm('确认更新 Pi 运行时到上游最新版？安装期间蜂后不能创建新会话。')) return;
    rtResult.textContent = '更新中（npm install 可能需要一两分钟）…';
    try {
      const r = await api.post<{ from: string; to: string }>('/settings/runtime/update', {});
      rtResult.innerHTML = `已更新：${esc(r.from)} → <b>${esc(r.to)}</b>（旧版本已保留，可回滚）`;
    } catch (err) {
      rtResult.innerHTML = `<span class="warn">更新失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshRuntime();
  });
  (el.querySelector('#rt-rollback') as HTMLElement).addEventListener('click', async () => {
    if (!confirm('确认回滚 Pi 运行时到上一个版本？')) return;
    rtResult.textContent = '回滚中…';
    try {
      const r = await api.post<{ from: string; to: string }>('/settings/runtime/rollback', {});
      rtResult.innerHTML = `已回滚：${esc(r.from)} → <b>${esc(r.to)}</b>`;
    } catch (err) {
      rtResult.innerHTML = `<span class="warn">回滚失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshRuntime();
  });

  // ---- 蜂后扩展与技能卡片：列表/安装/启停/删除 + 技能写入/删除 ----
  const extList = el.querySelector('#ext-list') as HTMLElement;
  const extResult = el.querySelector('#ext-result') as HTMLElement;
  const skillList = el.querySelector('#skill-list') as HTMLElement;
  const skillResult = el.querySelector('#skill-result') as HTMLElement;
  const skillNameInput = el.querySelector('#skill-name') as HTMLInputElement;
  const skillMd = el.querySelector('#skill-markdown') as HTMLTextAreaElement;

  async function refreshExtensions(): Promise<void> {
    try {
      const r = await api.get<{ extensions: { name: string; enabled: boolean; source: string }[] }>('/settings/runtime/extensions');
      extList.innerHTML = r.extensions.length
        ? r.extensions.map((x) => `
            <div class="inline-form" style="margin:4px 0;align-items:center">
              <code>${esc(x.name)}</code>
              <span class="muted small">（${x.source === 'npm' ? 'npm 安装' : '手工目录'} · ${x.enabled ? '已启用' : '已停用'}）</span>
              <button data-toggle="${esc(x.name)}" data-to="${x.enabled ? '0' : '1'}">${x.enabled ? '停用' : '启用'}</button>
              <button class="danger" data-del-ext="${esc(x.name)}">删除</button>
            </div>`).join('')
        : '暂无扩展——填 npm 包名安装，或把插件目录放入挂载点。';
    } catch (err) {
      extList.textContent = `读取失败：${err instanceof Error ? err.message : ''}`;
    }
  }

  extList.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    const toggle = t.dataset.toggle;
    const del = t.dataset.delExt;
    try {
      if (toggle) {
        await api.post(`/settings/runtime/extensions/${encodeURIComponent(toggle)}/enabled`, { enabled: t.dataset.to === '1' });
        extResult.textContent = `已切换：${toggle}`;
      } else if (del && confirm(`确认删除扩展 ${del}？目录将被整个移除。`)) {
        await api.del(`/settings/runtime/extensions/${encodeURIComponent(del)}`);
        extResult.textContent = `已删除：${del}`;
      }
    } catch (err) {
      extResult.innerHTML = `<span class="warn">操作失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshExtensions();
  });

  (el.querySelector('#ext-install') as HTMLElement).addEventListener('click', async () => {
    const pkg = (el.querySelector('#ext-pkg') as HTMLInputElement).value.trim();
    if (!pkg) return;
    extResult.textContent = `安装中：${pkg}（npm install，可能需要一两分钟）…`;
    try {
      await api.post<{ name: string }>('/settings/runtime/extensions/install', { package: pkg });
      extResult.innerHTML = `已安装：<b>${esc(pkg)}</b>（默认启用，蜂后下个会话生效）`;
      (el.querySelector('#ext-pkg') as HTMLInputElement).value = '';
    } catch (err) {
      extResult.innerHTML = `<span class="warn">安装失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshExtensions();
  });

  async function refreshSkills(): Promise<void> {
    try {
      const r = await api.get<{ skills: { name: string; updatedAt: number | null }[] }>('/settings/runtime/skills');
      skillList.innerHTML = r.skills.length
        ? r.skills.map((s) => `
            <div class="inline-form" style="margin:4px 0;align-items:center">
              <code>${esc(s.name)}</code>
              ${s.updatedAt ? `<span class="muted small">${fmtTime(s.updatedAt)}</span>` : ''}
              <button data-load-skill="${esc(s.name)}">载入编辑</button>
            </div>`).join('')
        : '暂无技能——填目录名并写 SKILL.md 保存即可。';
    } catch (err) {
      skillList.textContent = `读取失败：${err instanceof Error ? err.message : ''}`;
    }
  }

  skillList.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    const name = t.dataset.loadSkill;
    if (!name) return;
    skillNameInput.value = name;
    try {
      // 读取现有技能内容：经扩展端点拿不到文件体，技能内容用文本下载端点
      const res = await fetch(`/settings/runtime/skills/${encodeURIComponent(name)}/content`);
      if (res.ok) skillMd.value = await res.text();
      else skillMd.value = '';
      skillResult.textContent = `已载入：${name}`;
    } catch {
      skillMd.value = '';
    }
  });

  (el.querySelector('#skill-save') as HTMLElement).addEventListener('click', async () => {
    const name = skillNameInput.value.trim();
    const markdown = skillMd.value;
    if (!name || !markdown.trim()) {
      skillResult.innerHTML = '<span class="warn">需要目录名与 SKILL.md 内容</span>';
      return;
    }
    try {
      await api.put<{ name: string }>(`/settings/runtime/skills/${encodeURIComponent(name)}`, { markdown });
      skillResult.innerHTML = `已保存：<b>${esc(name)}</b>（蜂后下个会话生效）`;
    } catch (err) {
      skillResult.innerHTML = `<span class="warn">保存失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshSkills();
  });

  (el.querySelector('#skill-delete') as HTMLElement).addEventListener('click', async () => {
    const name = skillNameInput.value.trim();
    if (!name || !confirm(`确认删除技能 ${name}？`)) return;
    try {
      await api.del(`/settings/runtime/skills/${encodeURIComponent(name)}`);
      skillResult.textContent = `已删除：${name}`;
      skillMd.value = '';
    } catch (err) {
      skillResult.innerHTML = `<span class="warn">删除失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
    refreshSkills();
  });

  (el.querySelector('#skill-refresh') as HTMLElement).addEventListener('click', refreshSkills);
  refreshExtensions();
  refreshSkills();
}
