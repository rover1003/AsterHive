// Pi 运行时管理器（T14）：服务器内嵌的 Pi agent 运行时装由数据卷自管理——
// 可更新/回滚，不进镜像、不随服务器进程重启。
//
// 目录布局：
//   <dataDir>/pi-runtime/
//     versions/<ver>/node_modules/@earendil-works/pi-coding-agent/   （npm install --prefix 落点）
//     current/version.json    {"version":"1.x.y"}                    （指针文件，Windows 友好；
//                              若运维改用符号链接指向 versions/<ver>，同样能解析）
//     installs.json           [{"version","installedAt"}]            （安装台账，回滚排序用）
//     extensions/             社区插件挂载点（每个子目录 = 一个 Pi 扩展路径，服务器不预装任何）
//     skills/                 主脑技能挂载点（递归扫描子目录里的 SKILL.md，服务器不预装任何）
//
// 解析顺序（resolveRuntime）：数据卷 current（须含 node_modules）→ 回落仓库 node_modules 基线。
// 基线 = apps/server 的普通 dependency @earendil-works/pi-coding-agent（npm install 随仓库走），
// 保证全新部署零配置即可用；数据卷一旦装好版本即优先于基线。
import { exec } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, logEvent } from './write.ts';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

export interface ResolvedRuntime {
  /** volume = 数据卷 current 指向的版本；baseline = 仓库 node_modules 基线 */
  source: 'volume' | 'baseline';
  /** Pi 包根目录（其下有 package.json 与 dist/index.js），主脑据此动态 import */
  pkgDir: string;
  /** 从该包 package.json 读出的版本号 */
  version: string;
}

export interface RuntimeUpdateState {
  from: string;
  to: string;
  startedAt: number;
}

export interface RuntimeStatus {
  current: string | null;
  source: 'volume' | 'baseline';
  latest: string | null;
  updating: RuntimeUpdateState | null;
  /** 社区插件挂载点（绝对路径），目录不存在时也已给出，供 UI 展示 */
  extensionsDir: string;
  /** 主脑技能挂载点（绝对路径），供 UI 展示与 T17 界面化管理预留 */
  skillsDir: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 执行器可注入（测试 stub 用）；默认经 shell 调 npm——Windows 下 npm 是 .cmd，
// Node 出于安全考虑禁止无 shell 直接 spawn .cmd，故统一走 shell，参数由本模块拼装
// （version 在 update() 入口已按 /^[\w.-]+$/ 校验，路径统一双引号包裹）。
export type RuntimeExecutor = (command: string, timeoutMs: number) => Promise<ExecResult>;

const VERSION_RE = /^[\w.-]+$/;
const NPM_TIMEOUT_MS = 10 * 60_000;

function defaultExecutor(command: string, timeoutMs: number): Promise<ExecResult> {
  // 测试注入优先（与 worker-control 的驱动注入同模式）：替换后不触真实 npm
  if (testExecutorOverride) return testExecutorOverride(command, timeoutMs);
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT = npm 不存在；其余带 exit code 与 stderr 原样回传
        resolve({
          code: typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? err.message),
        });
        return;
      }
      resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

let testExecutorOverride: RuntimeExecutor | null = null;

/** 测试注入：替换模块级默认执行器（HTTP 层构造的 PiRuntimeManager 也走这里） */
export function setRuntimeExecutorForTest(executor: RuntimeExecutor): void {
  testExecutorOverride = executor;
}

export function restoreRuntimeExecutor(): void {
  testExecutorOverride = null;
}

interface InstallRecord {
  version: string;
  installedAt: number;
}

type InstallsFile = InstallRecord[];

export class PiRuntimeManager {
  #ctx: Ctx;
  #executor: RuntimeExecutor;
  #npmTimeoutMs: number;
  #updating: RuntimeUpdateState | null = null;

  constructor(ctx: Ctx, opts: { executor?: RuntimeExecutor; npmTimeoutMs?: number } = {}) {
    this.#ctx = ctx;
    this.#executor = opts.executor ?? defaultExecutor;
    this.#npmTimeoutMs = opts.npmTimeoutMs ?? NPM_TIMEOUT_MS;
  }

  // ---- 目录布局 ----

  get root(): string {
    return join(this.#ctx.cfg.dataDir, 'pi-runtime');
  }

  get versionsDir(): string {
    return join(this.root, 'versions');
  }

  get currentDir(): string {
    return join(this.root, 'current');
  }

  /** 社区插件挂载点：将来把 billion-context 等社区插件目录放进来即可被主脑加载，服务器不预装任何 */
  get extensionsDir(): string {
    return join(this.root, 'extensions');
  }

  /**
   * 主脑技能挂载点：整个目录作为一条 additionalSkillPaths 传给 Pi DefaultResourceLoader。
   * Pi 的发现规则（dist/core/skills.d.ts loadSkillsFromDir）：目录含 SKILL.md 即技能根，
   * 否则递归下探子目录——所以既支持 skills/<skill-name>/SKILL.md，也支持更深一层嵌套。
   */
  get skillsDir(): string {
    return join(this.root, 'skills');
  }

  /**
   * 启动时确保挂载点目录存在（幂等）：主脑服务器启动即建好空目录，
   * 用户可在主脑下个会话之前随时往里放扩展/技能，无需先激活主脑。
   */
  ensureMountDirs(): void {
    for (const dir of [this.extensionsDir, this.skillsDir]) mkdirSync(dir, { recursive: true });
  }

  get #installsFile(): string {
    return join(this.root, 'installs.json');
  }

  // ---- 版本解析 ----

  private readPackageVersion(pkgDir: string): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string };
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }

  // 从 volume 解析 current 指向的 Pi 包目录；无效返回 null（回落基线）。
  private resolveVolume(): { pkgDir: string; version: string } | null {
    const current = this.currentDir;
    if (!existsSync(current)) return null;
    let pkgDir: string | null = null;
    // 指针文件形态：current/version.json {"version"}
    const pointer = join(current, 'version.json');
    if (existsSync(pointer)) {
      try {
        const { version } = JSON.parse(readFileSync(pointer, 'utf8')) as { version?: string };
        if (typeof version === 'string' && version) {
          const target = join(this.versionsDir, version, 'node_modules', ...PI_PACKAGE.split('/'));
          if (existsSync(target)) pkgDir = target;
        }
      } catch {
        /* 指针损坏 → 视同无 volume */
      }
    }
    // 符号链接形态：current 直接指向版本目录（其内有 node_modules）
    if (!pkgDir && existsSync(join(current, 'node_modules'))) {
      pkgDir = join(current, 'node_modules', ...PI_PACKAGE.split('/'));
    }
    if (!pkgDir) return null;
    const version = this.readPackageVersion(pkgDir);
    if (!version) return null; // 包不完整 → 回落基线
    return { pkgDir, version };
  }

  // 基线：仓库/容器里随 dependency 安装的 Pi 包。用 import.meta.resolve（ESM "import" 条件——
  // 该包 exports 不含 "require" 条件，createRequire 会 ERR_PACKAGE_PATH_NOT_EXPORTED）解析包入口，
  // 再向上找 package.json；兼容 npm 工作区提升与容器 /app 布局。
  private resolveBaseline(): { pkgDir: string; version: string } {
    const entryUrl = import.meta.resolve(PI_PACKAGE); // → file:///…/dist/index.js
    let dir = dirname(fileURLToPath(entryUrl));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        const version = this.readPackageVersion(dir);
        if (version) return { pkgDir: dir, version };
      }
      dir = dirname(dir);
    }
    throw new HttpError(500, `baseline pi package not resolvable from ${entryUrl}`);
  }

  /** 解析当前生效运行时：数据卷优先（须含 node_modules 与完整包），否则回落基线 */
  resolveRuntime(): ResolvedRuntime {
    const volume = this.resolveVolume();
    if (volume) return { source: 'volume', ...volume };
    return { source: 'baseline', ...this.resolveBaseline() };
  }

  /** 主脑创建会话前调用：确保有可用运行时并返回动态 import 入口（dist/index.js 的 file URL） */
  ensureRuntimeEntry(): { entryUrl: string; version: string; source: 'volume' | 'baseline' } {
    const rt = this.resolveRuntime();
    const entry = join(rt.pkgDir, 'dist', 'index.js');
    if (!existsSync(entry)) {
      throw new HttpError(500, `pi runtime incomplete: ${entry} missing（可尝试在设置页更新运行时）`);
    }
    return { entryUrl: pathToFileURL(entry).href, version: rt.version, source: rt.source };
  }

  // ---- 版本查询 / 更新 / 回滚 ----

  /** 上游 latest：npm view 子进程查询；npm 不可用/离线返回 null（UI 显示未知） */
  async latestVersion(): Promise<string | null> {
    const r = await this.#executor(`npm view ${PI_PACKAGE} version`, 30_000);
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    return VERSION_RE.test(v) ? v : null;
  }

  #readInstalls(): InstallsFile {
    try {
      return JSON.parse(readFileSync(this.#installsFile, 'utf8')) as InstallsFile;
    } catch {
      return [];
    }
  }

  #recordInstall(version: string): void {
    const list = this.#readInstalls().filter((r) => r.version !== version);
    list.push({ version, installedAt: Date.now() });
    writeFileSync(this.#installsFile, JSON.stringify(list, null, 2));
  }

  // 原子切换 current 指针（指针文件形态）：先写临时文件再 rename 覆盖。
  // Windows 上 rename 覆盖已存在文件偶发 EPERM，失败则退化为 unlink+rename（毫秒级窗口）。
  #switchPointer(version: string): void {
    mkdirSync(this.currentDir, { recursive: true });
    const pointer = join(this.currentDir, 'version.json');
    const tmp = join(this.currentDir, `version.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ version }, null, 2));
    try {
      renameSync(tmp, pointer);
    } catch {
      try {
        unlinkSync(pointer);
      } catch {
        /* 目标本就不存在 */
      }
      renameSync(tmp, pointer);
    }
  }

  /**
   * 更新到指定版本（缺省 = 上游 latest）：
   * npm install --prefix versions/<ver> 包@<ver> → 写指针 → 事件 pi.runtime_updated。
   * 旧 versions/ 一律保留（回滚依据）。更新不重启服务器进程，仅影响下次主脑会话创建。
   */
  async update(version?: string): Promise<{ from: string; to: string }> {
    if (this.#updating) throw new HttpError(409, 'runtime update already in progress');
    const from = this.resolveRuntime().version;
    let to = version?.trim();
    if (to !== undefined && !VERSION_RE.test(to)) throw new HttpError(422, `invalid version: ${to}`);
    if (!to) {
      to = (await this.latestVersion()) ?? undefined;
      if (!to) {
        throw new HttpError(503, 'npm 不可用或离线：无法查询上游最新版本，可显式传 {version} 重试');
      }
    }
    this.#updating = { from, to, startedAt: Date.now() };
    try {
      const target = join(this.versionsDir, to);
      const installDir = join(target, 'node_modules');
      mkdirSync(installDir, { recursive: true });
      const r = await this.#executor(
        `npm install --prefix "${target}" ${PI_PACKAGE}@${to}`,
        this.#npmTimeoutMs,
      );
      if (r.code !== 0) {
        throw new HttpError(
          503,
          `npm install 失败（exit ${r.code}）：${(r.stderr || r.stdout).slice(-400) || 'npm 不可用或离线'}`,
        );
      }
      const installed = this.readPackageVersion(join(target, 'node_modules', ...PI_PACKAGE.split('/')));
      if (!installed) throw new HttpError(500, `安装后包不完整：${target}`);
      this.#recordInstall(to);
      this.#switchPointer(installed);
      withWrite(this.#ctx, 'pi.runtimeUpdate', () => {
        logEvent(this.#ctx, 'pi.runtime_updated', { from, to: installed });
      });
      return { from, to: installed };
    } finally {
      this.#updating = null;
    }
  }

  /** 回滚：切回 versions/ 里安装时间早于当前版本的最近一个（按 installs.json 台账排序） */
  async rollback(): Promise<{ from: string; to: string }> {
    if (this.#updating) throw new HttpError(409, 'runtime update already in progress');
    const current = this.resolveRuntime();
    if (current.source !== 'volume') {
      throw new HttpError(409, '当前运行在仓库基线版本，无可回滚的数据卷版本');
    }
    const installs = this.#readInstalls()
      .filter((r) => existsSync(join(this.versionsDir, r.version, 'node_modules')))
      .sort((a, b) => a.installedAt - b.installedAt);
    const idx = installs.findIndex((r) => r.version === current.version);
    const previous = idx > 0 ? installs[idx - 1] : idx === -1 && installs.length > 0 ? installs[installs.length - 1] : undefined;
    if (!previous) throw new HttpError(409, '没有更早的可回滚版本（versions/ 仅保留当前版本）');
    const from = current.version;
    this.#switchPointer(previous.version);
    withWrite(this.#ctx, 'pi.runtimeRollback', () => {
      logEvent(this.#ctx, 'pi.runtime_rolled_back', { from, to: previous.version });
    });
    return { from, to: previous.version };
  }

  /** REST 读侧：GET /settings/runtime */
  status(): RuntimeStatus {
    let current: string | null = null;
    let source: 'volume' | 'baseline' = 'baseline';
    try {
      const rt = this.resolveRuntime();
      current = rt.version;
      source = rt.source;
    } catch {
      current = null; // 基线都缺失（异常部署）：UI 显示未知
    }
    return {
      current,
      source,
      latest: null, // 由 HTTP 层异步填充（避免 GET 触发子进程时被缓存语义困住，见 http.ts）
      updating: this.#updating,
      extensionsDir: this.extensionsDir,
      skillsDir: this.skillsDir,
    };
  }

  /** 主脑会话创建时取社区插件路径：extensions/ 下每个子目录 = 一个 additionalExtensionPaths 条目 */
  communityExtensionPaths(): string[] {
    try {
      return readdirSync(this.extensionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        // node_modules 是 npm 安装落点（其内的包经注册表单独挂载），dot 目录为系统杂项
        .filter((d) => d.name !== 'node_modules' && !d.name.startsWith('.'))
        .map((d) => join(this.extensionsDir, d.name));
    } catch {
      return []; // 目录不存在 = 未挂载任何社区插件
    }
  }

  // ---- T17：主脑扩展 / 技能界面化管理 ----
  // 注册表文件（extensions.json）：npm 安装的扩展记 { name, path, enabled, installedAt }；
  // 手工放入的目录（无注册表项）默认视为启用。启停只改注册表，不动文件——
  // 主脑下个会话创建时重新读取，运行中会话不受影响。

  get #extensionsRegistryFile(): string {
    return join(this.root, 'extensions.json');
  }

  #readExtensionRegistry(): Record<string, { path: string; enabled: boolean; installedAt: number; source: string }> {
    try {
      const raw = JSON.parse(readFileSync(this.#extensionsRegistryFile, 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
      return raw as Record<string, { path: string; enabled: boolean; installedAt: number; source: string }>;
    } catch {
      return {};
    }
  }

  #writeExtensionRegistry(reg: Record<string, { path: string; enabled: boolean; installedAt: number; source: string }>): void {
    writeFileSync(this.#extensionsRegistryFile, JSON.stringify(reg, null, 2));
  }

  /** 已启用扩展的挂载路径列表：主脑会话创建时调用（手工目录扫描 + 注册表合并，启停过滤） */
  enabledExtensionPaths(): string[] {
    const reg = this.#readExtensionRegistry();
    const paths: string[] = [];
    // 1. 手工目录（顶层子目录扫描，排除 node_modules）：注册表有项则按项，无项默认启用
    for (const abs of this.communityExtensionPaths()) {
      const rel = abs.slice(this.extensionsDir.length + 1);
      const entry = reg[rel];
      if (!entry || entry.enabled !== false) paths.push(abs);
    }
    // 2. 注册表条目（npm 装在 node_modules/<pkg>，path 字段记录实际落点）：启用且目录存在才挂载
    for (const entry of Object.values(reg)) {
      if (entry.enabled === false) continue;
      const abs = join(this.extensionsDir, entry.path);
      if (existsSync(abs) && !paths.includes(abs)) paths.push(abs);
    }
    return paths;
  }

  /** 扩展清单：目录扫描 + 注册表状态合并（供 UI 列表） */
  listExtensions(): { name: string; enabled: boolean; source: string; installedAt: number | null }[] {
    const reg = this.#readExtensionRegistry();
    const dirs = new Set(
      this.communityExtensionPaths().map((abs) => abs.slice(this.extensionsDir.length + 1)),
    );
    const names = new Set([...dirs, ...Object.keys(reg)]);
    return [...names].sort().map((name) => {
      const entry = reg[name];
      return {
        name,
        enabled: entry ? entry.enabled !== false : true,
        source: entry?.source ?? 'manual',
        installedAt: entry?.installedAt ?? null,
      };
    });
  }

  /** npm 包名安装扩展：npm install --prefix extensions/ <pkg>[@<version>]，注册表登记并默认启用 */
  async installExtension(packageName: string, version?: string): Promise<{ name: string }> {
    const pkg = packageName.trim();
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) throw new HttpError(422, `invalid package name: ${pkg}`);
    let ver = version?.trim();
    if (ver !== undefined && !VERSION_RE.test(ver)) throw new HttpError(422, `invalid version: ${ver}`);
    const spec = ver ? `${pkg}@${ver}` : pkg;
    mkdirSync(this.extensionsDir, { recursive: true });
    const r = await this.#executor(`npm install --prefix "${this.extensionsDir}" ${spec}`, this.#npmTimeoutMs);
    if (r.code !== 0) {
      throw new HttpError(503, `npm install 失败（exit ${r.code}）：${(r.stderr || r.stdout).slice(-400) || 'npm 不可用或离线'}`);
    }
    // npm 可能安装为 scoped 包（node_modules/@scope/name）；确认落点存在
    const segs = pkg.split('/');
    const pkgDir = join(this.extensionsDir, 'node_modules', ...segs);
    if (!existsSync(pkgDir)) throw new HttpError(500, `安装后扩展目录缺失：${pkgDir}`);
    const reg = this.#readExtensionRegistry();
    // 注册表键 = 包名（如 @scope/name）；path = 相对 extensionsDir 的实际挂载落点
    reg[pkg] = { path: join('node_modules', ...segs), enabled: true, installedAt: Date.now(), source: 'npm' };
    this.#writeExtensionRegistry(reg);
    withWrite(this.#ctx, 'pi.extensionInstalled', () => {
      logEvent(this.#ctx, 'pi.extension_installed', { name: pkg, spec, source: 'npm' });
    });
    return { name: pkg };
  }

  /** 启停扩展（幂等）：只改注册表，主脑下个会话生效 */
  setExtensionEnabled(name: string, enabled: boolean): { name: string; enabled: boolean } {
    const reg = this.#readExtensionRegistry();
    const key = this.#normalizeExtensionName(name);
    const prev = reg[key];
    // npm 条目保留其 node_modules 落点；新键（手工目录）path = 顶层目录名
    const path = prev?.path ?? (key.includes('/') ? join('node_modules', key) : key);
    reg[key] = { path, enabled, installedAt: prev?.installedAt ?? Date.now(), source: prev?.source ?? 'manual' };
    this.#writeExtensionRegistry(reg);
    withWrite(this.#ctx, 'pi.extensionToggled', () => {
      logEvent(this.#ctx, 'pi.extension_toggled', { name: key, enabled });
    });
    return { name: key, enabled };
  }

  /** 删除扩展：目录整个移除（限 extensions/ 内）+ 注册表摘除 */
  deleteExtension(name: string): { name: string } {
    const key = this.#normalizeExtensionName(name);
    const reg = this.#readExtensionRegistry();
    const entry = reg[key];
    // npm 条目实际落点在 node_modules/<pkg>；手工条目在顶层目录
    const rel = entry?.path ?? (key.includes('/') ? join('node_modules', key) : key);
    const abs = join(this.extensionsDir, rel);
    if (!abs.startsWith(this.extensionsDir)) throw new HttpError(422, `invalid extension name: ${name}`);
    rmSync(abs, { recursive: true, force: true });
    delete reg[key];
    this.#writeExtensionRegistry(reg);
    withWrite(this.#ctx, 'pi.extensionDeleted', () => {
      logEvent(this.#ctx, 'pi.extension_deleted', { name: key });
    });
    return { name: key };
  }

  // 归一化名称：接受显示名（node_modules/<pkg> 或 <pkg>）或注册表键
  #normalizeExtensionName(name: string): string {
    const cleaned = name.trim().replace(/^node_modules[/\\]/, '');
    if (!cleaned || cleaned.includes('..')) throw new HttpError(422, `invalid extension name: ${name}`);
    return cleaned;
  }

  // ---- 技能（skills/）管理：目录含 SKILL.md 即技能根 ----

  /** 技能清单：扫描 skills/ 下含 SKILL.md 的目录（递归一层，与 Pi 发现规则一致） */
  listSkills(): { name: string; path: string; updatedAt: number | null }[] {
    const out: { name: string; path: string; updatedAt: number | null }[] = [];
    const scan = (dir: string, depth: number): void => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
        const skillFile = join(dir, 'SKILL.md');
        let updatedAt: number | null = null;
        try {
          updatedAt = statSync(skillFile).mtimeMs;
        } catch { /* 忽略 stat 失败 */ }
        out.push({ name: dir === this.skillsDir ? '(root)' : dir.slice(this.skillsDir.length + 1), path: dir, updatedAt });
        return; // 技能根不再下探（Pi 规则一致）
      }
      if (depth <= 0) return;
      for (const e of entries) {
        if (e.isDirectory()) scan(join(dir, e.name), depth - 1);
      }
    };
    scan(this.skillsDir, 1);
    return out;
  }

  /** 写入/覆盖技能：name 为目录名，markdown 为 SKILL.md 全文（下个会话生效） */
  writeSkill(name: string, markdown: string): { name: string } {
    if (!/^[\w][\w.-]*$/.test(name)) throw new HttpError(422, `invalid skill name: ${name}`);
    const dir = join(this.skillsDir, name);
    if (!dir.startsWith(this.skillsDir)) throw new HttpError(422, `invalid skill name: ${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
    withWrite(this.#ctx, 'pi.skillWritten', () => {
      logEvent(this.#ctx, 'pi.skill_written', { name, bytes: Buffer.byteLength(markdown) });
    });
    return { name };
  }

  /** 删除技能目录（限 skills/ 内） */
  deleteSkill(name: string): { name: string } {
    if (!/^[\w][\w.-]*$/.test(name)) throw new HttpError(422, `invalid skill name: ${name}`);
    const dir = join(this.skillsDir, name);
    if (!dir.startsWith(this.skillsDir)) throw new HttpError(422, `invalid skill name: ${name}`);
    rmSync(dir, { recursive: true, force: true });
    withWrite(this.#ctx, 'pi.skillDeleted', () => {
      logEvent(this.#ctx, 'pi.skill_deleted', { name });
    });
    return { name };
  }
}
