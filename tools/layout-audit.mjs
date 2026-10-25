// 布局审计：CDP 驱动无头 Edge，对每个视图跑程序化布局断言。
// 病灶对照（用户点名）：① 按钮文字换行 ② 输入框挤压 ③ 聊天气泡排版错误。
// 另外捕获每页截图（base64 落盘）供人工复核。
// 用法：node tools/layout-audit.mjs [基础URL= http://127.0.0.1:18068]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:18068';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 19222;
const OUT_DIR = join(process.cwd(), '.shots');
mkdirSync(OUT_DIR, { recursive: true });

const VIEWS = [
  { name: 'board', hash: '#/board?board=zero-check', w: 1440, h: 900 },
  { name: 'board-1280', hash: '#/board?board=zero-check', w: 1280, h: 820 },
  { name: 'board-1024', hash: '#/board?board=zero-check', w: 1024, h: 760 },
  { name: 'board-960', hash: '#/board?board=zero-check', w: 960, h: 760, overlay: true },
  { name: 'agents', hash: '#/agents', w: 1440, h: 900 },
  { name: 'agents-1024', hash: '#/agents', w: 1024, h: 760 },
  { name: 'fleet', hash: '#/fleet', w: 1440, h: 900 },
  { name: 'settings', hash: '#/settings', w: 1440, h: 900 },
  { name: 'audit', hash: '#/audit', w: 1440, h: 900 },
];

// 在页面内执行的断言（返回 issues 数组）。扫描当前文档（含已打开的抽屉）。
const AUDIT_JS = `(() => {
  const issues = [];
  // 抽屉开启时只审抽屉内部（页面底层字段被遮罩盖住但仍在文档流，几何相交是误报）
  const root = document.querySelector('.drawer') ?? document;
  const q = (s) => [...root.querySelectorAll(s)];
  const docQ = (s) => [...document.querySelectorAll(s)];
  const txt = (el) => (el.innerText || '').trim().slice(0, 30);
  const scope = root !== document ? '（抽屉开启）' : '';
  const seen = new Set();
  const push = (check, detail) => {
    const key = check + '|' + detail;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ check, detail });
  };

  // 0) 页面非空白
  const app = document.querySelector('#app') || document.body;
  if ((app.innerText || '').trim().length < 50) push('空白页', '渲染内容过少');

  // 1) 横向溢出
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    push('横向溢出', \`scrollWidth=\${document.documentElement.scrollWidth} > \${window.innerWidth}\`);

  // 2) 按钮文字换行/溢出
  for (const b of q('button')) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height > 46) push('按钮换行' + scope, \`「\${txt(b)}」高 \${Math.round(r.height)}px\`);
    if (b.scrollWidth > b.clientWidth + 2) push('按钮文字溢出' + scope, \`「\${txt(b)}」\`);
  }

  // 3) 输入框挤压 + 字段重叠
  for (const i of q('input, select, textarea')) {
    const r = i.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.width < 90 && i.type !== 'checkbox')
      push('输入框挤压' + scope, \`\${i.className || i.tagName} 宽仅 \${Math.round(r.width)}px\`);
  }
  const fields = q('.field').filter((f) => f.getBoundingClientRect().width > 0);
  for (let a = 0; a < fields.length; a++) {
    for (let b = a + 1; b < fields.length; b++) {
      const ra = fields[a].getBoundingClientRect(), rb = fields[b].getBoundingClientRect();
      const overlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const sameRow = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 4;
      if (overlap > 6 && sameRow) push('字段重叠' + scope, '两个 .field 水平重叠');
    }
  }

  // 4) 聊天气泡：容器 .messages；.msg.me 靠右；气泡不占满全宽；不横向溢出（仅基础态查）
  let msgCount = 0, meCount = 0, hasContainer = false;
  if (root === document) {
    const container = docQ('.messages')[0];
    hasContainer = !!container;
    if (container) {
      const cr = container.getBoundingClientRect();
      const msgs = docQ('.msg');
      msgCount = msgs.length;
      const me = docQ('.msg.me');
      meCount = me.length;
      for (const bu of docQ('.bubble')) {
        const br = bu.getBoundingClientRect();
        if (br.width > 0 && br.width > cr.width * 0.92)
          push('气泡占满全宽', \`\${Math.round(br.width)}/\${Math.round(cr.width)}\`);
        if (bu.scrollWidth > bu.clientWidth + 2)
          push('气泡横向溢出', '长文本未换行');
      }
      const lastMe = me[me.length - 1];
      if (lastMe) {
        const mr = lastMe.getBoundingClientRect();
        const rightGap = cr.right - mr.right;
        const leftGap = mr.left - cr.left;
        if (rightGap > leftGap + 40)
          push('我的消息未右对齐', \`右距 \${Math.round(rightGap)} 左距 \${Math.round(leftGap)}\`);
      }
    } else if (location.hash.includes('board')) {
      push('聊天容器缺失', 'board 页未见 .messages');
    }
    const target = docQ('.composer-target')[0];
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.width > 0 && r.width < 90) push('目标下拉挤压', \`宽仅 \${Math.round(r.width)}px\`);
    }
    for (const p of docQ('[class*="pill"], [class*="badge"], .count')) {
      if (p.scrollWidth > p.clientWidth + 3) push('徽标文字溢出', txt(p));
    }
  }
  return { issues, msgCount, meCount, hasContainer };
})()`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const proc = spawn(EDGE, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--noerrdialogs',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${process.env.TEMP}\\edge-audit-profile`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    // 等 DevTools 端口就绪
    let targets = null;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        targets = await res.json();
        break;
      } catch {
        await wait(300);
      }
    }
    if (!targets) throw new Error('DevTools 端口未就绪');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

    const report = {};
    for (const v of VIEWS) {
      await send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: BASE + '/' + v.hash });
      await wait(3500); // SPA 渲染 + 数据拉取
      const issues = [];

      const runAudit = async (context) => {
        const evalRes = await send('Runtime.evaluate', { expression: AUDIT_JS, returnByValue: true });
        const result = evalRes.result?.result?.value ?? { issues: [{ check: '审计失败', detail: String(evalRes.result?.exceptionDetails?.text ?? '未知') }] };
        for (const i of result.issues) issues.push({ ...i, check: i.check + (context ? `［${context}］` : '') });
        return result;
      };
      const base = await runAudit('');

      // 逐个打开抽屉/浮层再审计（用户点名的按钮换行/挤压多发生在抽屉里）
      const openers = v.name.startsWith('board')
        ? [['建卡', '#new-task'], ['看板管理', '#manage-board']]
        : v.name === 'agents' ? [['agent设置', '[data-settings]']] : [];
      if (v.overlay) openers.unshift(['窄屏看板浮层', '#board-toggle']);
      for (const [ctx, sel] of openers) {
        await send('Runtime.evaluate', { expression: `document.querySelector('${sel}')?.click()` });
        await wait(700);
        await runAudit(ctx);
        await send('Runtime.evaluate', { expression: `document.querySelector('#drawer-close,.drawer-close')?.click()` });
        await wait(400);
      }
      report[v.name] = { issues, base };

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) writeFileSync(join(OUT_DIR, `audit-${v.name}.png`), Buffer.from(shot.result.data, 'base64'));
    }
    ws.close();

    let total = 0;
    for (const [name, r] of Object.entries(report)) {
      const n = r.issues.length;
      total += n;
      const b = r.base;
      console.log(`\n== ${name}（消息 ${b.msgCount}/${b.meCount} 容器 ${b.hasContainer ? '✓' : '✗'}）${n === 0 ? ' ✅ 全部通过' : ` ❌ ${n} 项`}`);
      for (const i of r.issues) console.log(`   - [${i.check}] ${i.detail}`);
    }
    console.log(`\n合计 ${total} 项问题；截图已存 ${OUT_DIR}\\audit-*.png`);
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error('审计失败:', e.message); process.exit(1); });
