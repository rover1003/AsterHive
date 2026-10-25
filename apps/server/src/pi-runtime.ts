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
        .map((d) => join(this.extensionsDir, d.name));
    } catch {
      return []; // 目录不存在 = 未挂载任何社区插件
    }
  }
}
