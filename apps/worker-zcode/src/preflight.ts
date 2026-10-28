/**
 * 工蜂运行环境与依赖前置预检模块
 * 负责在领活前对 Node、Git、Shell 进行可证明的实跑探针校验，
 * 以及在工作区解压后、模型启动前对 npm 依赖进行安全安装与环境闭环校验。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecutionPreflightCheck } from './sdk.ts';

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd = process.cwd(),
  timeoutMs = 10_000,
  extraEnv?: Record<string, string>,
): Promise<CommandOutput> {
  return new Promise<CommandOutput>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        shell: false,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({ code: -1, stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

/**
 * 解析宿主环境中真实 npm-cli.js 路径，避免 Windows 平台下直接 spawn .cmd 批处理脚本触发 EINVAL
 */
export function resolveNpmCommand(): { cmd: string; argsPrefix: string[] } {
  const nodeDir = dirname(process.execPath);
  const candidates: string[] = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  const pathDirs = (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  for (const dir of pathDirs) {
    candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return { cmd: process.execPath, argsPrefix: [candidate] };
      }
    } catch {
      // ignore
    }
  }

  return { cmd: 'npm', argsPrefix: [] };
}

/**
 * Node 运行时版本预检：要求符合项目引擎约束（Node >= 23.6，原生支持 TS 类型剥离）
 */
export async function checkNodePreflight(options?: {
  versionOverride?: string;
}): Promise<ExecutionPreflightCheck> {
  const version = options?.versionOverride ?? process.versions.node;
  const cleanVersion = version.replace(/^v/, '');
  const parts = cleanVersion.split('.').map((p) => parseInt(p, 10));
  const major = parts[0] || 0;
  const minor = parts[1] || 0;

  const isSatisfied = major > 23 || (major === 23 && minor >= 6);
  if (isSatisfied) {
    return { name: 'node', ok: true, detail: `v${cleanVersion}` };
  }
  return {
    name: 'node',
    ok: false,
    detail: `Node 版本过低（当前 v${cleanVersion}，要求 >= v23.6.0）`,
  };
}

/**
 * Git 命令行可用性预检：通过执行实际 git --version 验证
 */
export async function checkGitPreflight(options?: {
  gitCmd?: string;
  cwd?: string;
}): Promise<ExecutionPreflightCheck> {
  const gitBin = options?.gitCmd ?? 'git';
  const res = await runCommand(gitBin, ['--version'], options?.cwd ?? process.cwd(), 5000);
  if (res.code === 0 && res.stdout.trim()) {
    return { name: 'git', ok: true, detail: res.stdout.trim() };
  }
  const errDetail = res.stderr.trim() || res.stdout.trim() || `exitCode=${res.code}`;
  return {
    name: 'git',
    ok: false,
    detail: `Git 命令不可用（${gitBin}）：${errDetail}`,
  };
}

/**
 * Shell 执行环境预检：
 * Windows Pi 显式使用原生 powershell.exe（非 WSL/bash）；POSIX Pi 使用 bash。
 * 非 Pi 内核不强加 Pi 的 shell 约束，避免破坏 omp/zcode 自身的执行器探针。
 */
export async function checkShellPreflight(
  executor: string,
  options?: { shellOverride?: string },
): Promise<ExecutionPreflightCheck> {
  if (options?.shellOverride) {
    const res = await runCommand(options.shellOverride, ['-v'], process.cwd(), 5000);
    if (res.code === 0) {
      return { name: 'shell', ok: true, detail: `${options.shellOverride} ok` };
    }
    return { name: 'shell', ok: false, detail: `Shell 探针失败: ${res.stderr || res.stdout}` };
  }

  if (executor === 'pi') {
    if (process.platform === 'win32') {
      // Windows Pi 严格测试 native powershell
      const res = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        process.cwd(),
        5000,
      );
      if (res.code === 0 && res.stdout.trim()) {
        return { name: 'shell', ok: true, detail: `PowerShell ${res.stdout.trim()}` };
      }
      return {
        name: 'shell',
        ok: false,
        detail: `Windows 原生 PowerShell 不可用：${res.stderr || res.stdout || `exitCode=${res.code}`}`,
      };
    } else {
      // POSIX Pi 使用 bash
      const res = await runCommand('bash', ['-c', 'echo ok'], process.cwd(), 5000);
      if (res.code === 0 && res.stdout.includes('ok')) {
        return { name: 'shell', ok: true, detail: 'POSIX bash ready' };
      }
      return {
        name: 'shell',
        ok: false,
        detail: `POSIX bash 不可用：${res.stderr || res.stdout || `exitCode=${res.code}`}`,
      };
    }
  }

  // 非 Pi 内核（omp/zcode/opencode/worker）保持中性就绪，不干扰其内部执行器
  return { name: 'shell', ok: true, detail: `${executor} executor shell ready` };
}

/**
 * 领活前综合预检：检查 Node、必要时的 Git、以及选定内核的 Shell。
 * 任一检查失败均阻断领活并记录日志，绝不扣减任务重做次数。
 */
export async function runPreclaimPreflight(options: {
  executor: string;
  repoMode?: boolean;
  gitCmd?: string;
  nodeVersionOverride?: string;
  cwd?: string;
}): Promise<{ ok: boolean; checks: ExecutionPreflightCheck[]; error?: string }> {
  const checks: ExecutionPreflightCheck[] = [];

  const nodeCheck = await checkNodePreflight({ versionOverride: options.nodeVersionOverride });
  checks.push(nodeCheck);
  if (options.repoMode) {
    const gitCheck = await checkGitPreflight({ gitCmd: options.gitCmd, cwd: options.cwd });
    checks.push(gitCheck);
  }

  const shellCheck = await checkShellPreflight(options.executor);
  checks.push(shellCheck);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    const errorMsg = failed.map((f) => `${f.name}: ${f.detail}`).join('; ');
    return { ok: false, checks, error: `领活前环境预检未通过：${errorMsg}` };
  }

  return { ok: true, checks };
}

/**
 * 工作区依赖预检：工作区解压后、模型启动前执行。
 * 若 package-lock.json 存在且 node_modules 缺失，使用受限参数执行 npm ci。
 * 若发现不支持的其他包管理器 lockfile，如实报告前置条件未满足而非盲目执行。
 */
export async function runWorkspaceDependencyPreflight(
  workspaceDir: string,
): Promise<{ ok: boolean; check?: ExecutionPreflightCheck; error?: string }> {
  if (!existsSync(workspaceDir)) {
    return {
      ok: false,
      check: { name: 'dependencies', ok: false, detail: `工作区目录不存在: ${workspaceDir}` },
      error: `工作区目录不存在: ${workspaceDir}`,
    };
  }

  const lockPath = join(workspaceDir, 'package-lock.json');
  const nodeModulesPath = join(workspaceDir, 'node_modules');
  const yarnLock = join(workspaceDir, 'yarn.lock');
  const pnpmLock = join(workspaceDir, 'pnpm-lock.yaml');
  const bunLock = join(workspaceDir, 'bun.lockb');

  // 不支持的其他 lockfile 明确阻断
  if (!existsSync(lockPath)) {
    if (existsSync(yarnLock) || existsSync(pnpmLock) || existsSync(bunLock)) {
      const unsupported = existsSync(yarnLock)
        ? 'yarn.lock'
        : existsSync(pnpmLock)
          ? 'pnpm-lock.yaml'
          : 'bun.lockb';
      const detail = `不支持的依赖锁定文件（当前执行环境仅支持 npm package-lock.json）：发现 ${unsupported}`;
      return {
        ok: false,
        check: { name: 'dependencies', ok: false, detail },
        error: detail,
      };
    }
    // 无 package-lock.json 视为无须自动 npm ci 的纯代码任务
    return {
      ok: true,
      check: { name: 'dependencies', ok: true, detail: '无 package-lock.json，无需前置安装' },
    };
  }
  const { cmd, argsPrefix } = resolveNpmCommand();

  // 1. 若 node_modules 已存在，不可仅因目录存在便假设依赖完好（例如失败的 npm ci 常残留半截 node_modules）
  // 运行受限 npm ls --depth=0 验证依赖树一致性
  let needsInstall = !existsSync(nodeModulesPath);
  if (!needsInstall) {
    const lsRes = await runCommand(
      cmd,
      [...argsPrefix, 'ls', '--depth=0'],
      workspaceDir,
      30_000,
    );
    if (lsRes.code !== 0) {
      needsInstall = true;
    }
  }

  // 2. 若依赖缺失或树校验不通过，在工作区内执行受限 npm ci。
  //    仅剥离父进程继承的 npm_config_allow_scripts 环境变量：npm 11+ 将
  //    --allow-scripts 视为 CLI/env 层配置，项目级安装（npm ci/install）中
  //    一旦该层有值即抛 EALLOWSCRIPTS（lib/utils/resolve-allow-scripts.js），
  //    而 npm test 等父进程会通过 set-envs.js 把非默认配置导出为
  //    npm_config_allow_scripts 传给子进程。该值只影响 allow-scripts 策略，
  //    剥离后其余 npm_config_*（registry/auth/proxy 等）原样保留。
  //    其余项目/用户 .npmrc、registry、auth、proxy 等设置一律不动。
  if (needsInstall) {
    // 空字符串会被 @npmcli/config loadEnv 跳过（envVal === '' 即忽略），
    // 等效于未设置该环境变量。
    const ciEnv = { ...process.env, npm_config_allow_scripts: '' };
    const ciRes = await runCommand(
      cmd,
      [...argsPrefix, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      workspaceDir,
      180_000, // 3 分钟超时
      ciEnv,
    );

    if (ciRes.code !== 0) {
      const detail = `npm ci 失败（exitCode=${ciRes.code}）：${ciRes.stderr.trim() || ciRes.stdout.trim() || '未知错误'}`;
      return {
        ok: false,
        check: { name: 'dependencies', ok: false, detail },
        error: detail,
      };
    }
    return {
      ok: true,
      check: { name: 'dependencies', ok: true, detail: 'npm ci 安装成功' },
    };
  }

  return {
    ok: true,
    check: { name: 'dependencies', ok: true, detail: 'node_modules 依赖树校验通过' },
  };
}
