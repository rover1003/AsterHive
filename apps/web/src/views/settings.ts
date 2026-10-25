// 设置页：用户名（显示名）+ 内置主脑设置（启用/模型/运行状态）+ Pi 运行时卡片
// 零令牌终态（2026-10-25 用户终裁）：浏览器不携带任何凭据，服务器把请求视为唯一用户——
// 用户名只是聊天室里的显示名，不存在 token 的签发/保存/轮换。
import { api, setCachedUserName, type OrchestratorSettings, type RuntimeStatus, type UserStatus } from '../api.ts';
import { esc, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

let modelsTimer: ReturnType<typeof setInterval> | null = null; // 模型列表 60s 自动刷新（视图重渲染时清理）

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
      <h3>主脑设置（内置主脑，模式 B）</h3>
      <p class="muted">内置主脑是服务器常驻的分派者：拆解建卡 / 分派 / 验收 / 汇报，绝不执行任务。启用前需先填好模型与 Base URL，否则即使开启也不会产生轮次。apiKey 加密存储，界面永不回显。保存授权：你的身份（user/orchestrator）即可。</p>
      <div class="grid-form">
        <div class="field"><label for="oc-enabled">启用主脑</label>
          <select id="oc-enabled"><option value="off">关闭（默认）</option><option value="on">启用</option></select>
        </div>
        <div class="field"><label for="oc-provider">Provider</label><input id="oc-provider" placeholder="openai" /></div>
        <div class="field"><label for="oc-baseurl">Base URL</label><input id="oc-baseurl" placeholder="https://api.openai.com/v1" /></div>
        <div class="field"><label for="oc-model">模型</label>
          <select id="oc-model" title="列表来自上游 /models 接口，每 60 秒自动刷新"></select>
          <input id="oc-model-custom" placeholder="自定义模型名" style="display:none; margin-top:6px" />
          <div class="inline-form" style="margin-top:6px">
            <button id="oc-model-refresh" title="立即从上游重新拉取模型列表">刷新列表</button>
            <button id="oc-model-test" title="向上游发一条极短的测试消息，确认当前选中模型真实可用">测试连通</button>
            <span id="oc-model-hint" class="muted small"></span>
          </div>
        </div>
        <div class="field"><label for="oc-key">API Key</label><input id="oc-key" type="password" placeholder="仅提交，不回显" /></div>
      </div>
      <div class="inline-form">
        <button class="primary" id="oc-save">保存</button>
      </div>
      <div id="oc-status" class="muted small">加载中…</div>
      <div id="oc-runtime-line" class="muted small" style="margin-top:8px"></div>
    </div>
    <div class="panel">
      <h3>Pi 运行时</h3>
      <p class="muted">主脑的 Pi agent 运行时装由服务器数据卷自管理（不进镜像）：装新版 → 原子切换 → 旧版保留可回滚；更新不重启服务器，只影响下次主脑会话创建。</p>
      <div id="rt-status" class="muted small">加载中…</div>
      <div class="inline-form">
        <button id="rt-update">更新到最新版</button>
        <button id="rt-rollback" class="danger">回滚上一版</button>
      </div>
      <div id="rt-result"></div>
      <p class="muted small">社区插件挂载点：<code id="rt-extdir">…</code><br />把社区插件放到该目录（每个插件一个子目录）即可被主脑会话加载；服务器不预装任何插件。</p>
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

  // ---- 主脑设置：有身份即直接保存（服务器接受 user/orchestrator 身份）----
  const ocStatus = el.querySelector('#oc-status') as HTMLElement;
  // 模型下拉：列表来自上游 /models（60s 缓存 + 页面停留期间每 60s 自动刷新），
  // 「自定义…」兜底列表滞后/私货模型；「测试连通」一键探测选中模型此刻是否真能用
  // （上游账号池瞬时耗尽时列表看着正常、实际 503，探测过才算数）。
  const modelSelect = el.querySelector('#oc-model') as HTMLSelectElement;
  const modelCustom = el.querySelector('#oc-model-custom') as HTMLInputElement;
  const modelHint = el.querySelector('#oc-model-hint') as HTMLElement;
  const CUSTOM_OPT = '__custom__';
  let currentModel = '';
  if (modelsTimer) clearInterval(modelsTimer); // 视图重渲染时清掉旧轮询
  function selectedModel(): string {
    return modelSelect.value === CUSTOM_OPT ? modelCustom.value.trim() : modelSelect.value;
  }
  function fillModelSelect(models: string[]): void {
    const cur = currentModel || selectedModel();
    const inList = models.includes(cur);
    modelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    }
    if (cur && !inList) {
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = `${cur}（当前，未见于上游列表）`;
      modelSelect.appendChild(opt);
    }
    const custom = document.createElement('option');
    custom.value = CUSTOM_OPT;
    custom.textContent = '自定义…';
    modelSelect.appendChild(custom);
    modelSelect.value = cur || (models[0] ?? CUSTOM_OPT);
    modelCustom.style.display = modelSelect.value === CUSTOM_OPT ? '' : 'none';
    if (modelSelect.value === CUSTOM_OPT) modelCustom.value = cur;
  }
  async function loadModels(silent = false): Promise<void> {
    if (!silent) modelHint.textContent = '拉取模型列表…';
    try {
      const r = await api.get<{ models: string[]; fetchedAt: number; cached: boolean }>(
        '/settings/orchestrator/models',
      );
      fillModelSelect(r.models);
      modelHint.textContent = `共 ${r.models.length} 个模型 · 更新于 ${new Date(r.fetchedAt).toLocaleTimeString()}`;
    } catch (err) {
      if (!silent) modelHint.textContent = `列表拉取失败：${err instanceof Error ? err.message : ''}`;
      if (modelSelect.options.length === 0) fillModelSelect([]);
    }
  }
  modelSelect.addEventListener('change', () => {
    modelCustom.style.display = modelSelect.value === CUSTOM_OPT ? '' : 'none';
    if (modelSelect.value === CUSTOM_OPT) modelCustom.focus();
  });
  (el.querySelector('#oc-model-refresh') as HTMLElement).addEventListener('click', () => void loadModels());
  (el.querySelector('#oc-model-test') as HTMLElement).addEventListener('click', async () => {
    const m = selectedModel();
    if (!m) {
      modelHint.textContent = '请先选择或填写模型';
      return;
    }
    modelHint.textContent = `测试 ${m} 中…`;
    try {
      const r = await api.post<{ ok: boolean; status: number; latencyMs: number; error?: string }>(
        '/settings/orchestrator/test',
        { model: m },
      );
      modelHint.innerHTML = r.ok
        ? `<span class="ok">✓ ${esc(m)} 可用 · ${r.latencyMs}ms</span>`
        : `<span class="warn">✗ ${esc(m)} 不可用（${r.status || '网络错误'}：${esc(r.error ?? '')}）</span>`;
    } catch (err) {
      modelHint.innerHTML = `<span class="warn">测试失败：${esc(err instanceof Error ? err.message : '')}</span>`;
    }
  });
  try {
    const s = await api.get<OrchestratorSettings>('/settings/orchestrator');
    (el.querySelector('#oc-enabled') as HTMLSelectElement).value = s.enabled ? 'on' : 'off';
    (el.querySelector('#oc-provider') as HTMLInputElement).value = s.provider ?? '';
    (el.querySelector('#oc-baseurl') as HTMLInputElement).value = s.baseURL ?? '';
    currentModel = s.model ?? '';
    void loadModels();
    modelsTimer = setInterval(() => void loadModels(true), 60_000);
    const cfgOk = !s.enabled || (s.baseURL && s.model);
    ocStatus.textContent = s.apiKeySet
      ? `已保存：enabled=${s.enabled ? '开' : '关'} model=${s.model ?? '—'} apiKey=已设置（加密）`
      : `已保存：enabled=${s.enabled ? '开' : '关'} model=${s.model ?? '—'}（未设 apiKey）`;
    if (s.enabled && !cfgOk) {
      ocStatus.innerHTML = '<span class="warn">主脑已启用但模型/Base URL 未配置——补全后主脑才会开始轮次。</span>';
    }
  } catch {
    ocStatus.textContent = '读取失败';
  }
  (el.querySelector('#oc-save') as HTMLElement).addEventListener('click', async () => {
    const body: Record<string, unknown> = {
      enabled: (el.querySelector('#oc-enabled') as HTMLSelectElement).value === 'on',
    };
    const provider = (el.querySelector('#oc-provider') as HTMLInputElement).value.trim();
    const baseURL = (el.querySelector('#oc-baseurl') as HTMLInputElement).value.trim();
    const model = selectedModel();
    const key = (el.querySelector('#oc-key') as HTMLInputElement).value.trim();
    if (provider) body.provider = provider;
    if (baseURL) body.baseURL = baseURL;
    if (model) body.model = model;
    if (key) body.apiKey = key;
    try {
      const s = await api.put<OrchestratorSettings>('/settings/orchestrator', body);
      ocStatus.textContent = s.enabled
        ? `已保存并启用：model=${s.model ?? '—'}${s.apiKeySet ? '，apiKey=已设置' : ''}`
        : '已保存（主脑关闭）';
      refreshBrainRuntimeLine();
    } catch (err) {
      ocStatus.textContent = `保存失败：${err instanceof Error ? err.message : ''}`;
    }
  });

  // ---- 主脑运行状态行：从事件台账尾部取最新 brain.* ----
  const runtimeLine = el.querySelector('#oc-runtime-line') as HTMLElement;
  async function refreshBrainRuntimeLine(): Promise<void> {
    try {
      const r = await api.get<{ events: { id: number; type: string; payload: Record<string, unknown>; time_created: number }[] }>(
        '/api/events?limit=50',
      );
      const latest = r.events.find((e) => e.type.startsWith('brain.'));
      if (!latest) {
        runtimeLine.textContent = '主脑运行状态：暂无记录（未启用或尚未唤醒过）';
        return;
      }
      const detail =
        latest.type === 'brain.turn_finished'
          ? `上轮耗时 ${Math.round(Number(latest.payload.turnMs ?? 0) / 1000)}s`
          : latest.type === 'brain.error' || latest.type === 'brain.turn_timeout'
            ? String(latest.payload.reason ?? '')
            : '';
      runtimeLine.textContent = `主脑运行状态：${latest.type}${detail ? `（${detail}）` : ''} · ${fmtTime(latest.time_created)}`;
    } catch {
      runtimeLine.textContent = '主脑运行状态：读取失败';
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
    if (!confirm('确认更新 Pi 运行时到上游最新版？安装期间主脑不能创建新会话。')) return;
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
}
