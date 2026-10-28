import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface CliCommandTarget {
  resolvedCmd: string;
  isBatch: boolean;
}

/**
 * 在 Windows 平台解析命令是否为 .cmd / .bat 批处理脚本，支持绝对路径与 PATH 探测。
 */
export function resolveCommandTarget(cmd: string): CliCommandTarget {
  if (process.platform !== 'win32') {
    return { resolvedCmd: cmd, isBatch: false };
  }

  // 显式以 .cmd / .bat 结尾
  if (/\.(cmd|bat)$/i.test(cmd)) {
    if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
      return { resolvedCmd: cmd, isBatch: true };
    }
    const pathDirs = (process.env.PATH ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = join(dir, cmd);
      if (existsSync(candidate)) return { resolvedCmd: candidate, isBatch: true };
    }
    return { resolvedCmd: cmd, isBatch: true };
  }
  // 显式以 .exe 或其他二进制扩展名结尾
  if (/\.(exe|com)$/i.test(cmd)) {
    return { resolvedCmd: cmd, isBatch: false };
  }

  // 绝对或相对路径且存在文件
  if ((isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) && existsSync(cmd)) {
    return { resolvedCmd: cmd, isBatch: /\.(cmd|bat)$/i.test(cmd) };
  }

  // 探测扩展名：.exe 优先，再探测 .cmd / .bat
  const extensions = ['.exe', '.cmd', '.bat'];
  const hasExt = /\.[a-z0-9]+$/i.test(cmd);

  if (!hasExt) {
    if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
      for (const ext of extensions) {
        if (existsSync(cmd + ext)) {
          return { resolvedCmd: cmd + ext, isBatch: /\.(cmd|bat)$/i.test(ext) };
        }
      }
    } else {
      const pathDirs = (process.env.PATH ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
      for (const dir of pathDirs) {
        for (const ext of extensions) {
          const candidate = join(dir, cmd + ext);
          if (existsSync(candidate)) {
            return { resolvedCmd: candidate, isBatch: /\.(cmd|bat)$/i.test(ext) };
          }
        }
      }
    }
  }

  return { resolvedCmd: cmd, isBatch: false };
}

/**
 * Windows cmd.exe 危险元字符与控制字符集合：
 * % ! ^ & | < > ( ) " 及 ASCII 0-31 / 127
 * 遇到上述任一字符均在派生前立即 fail-closed 阻断，杜绝二次变量展开、多指令执行与重定向注入。
 */
export const BATCH_UNSAFE_REGEX = /[\x00-\x1f\x7f%"!^&|<>]/;

export function containsUnsafeBatchArguments(args: string[]): boolean {
  return args.some((arg) => BATCH_UNSAFE_REGEX.test(arg));
}

export interface RunCliOptions {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunCliResult {
  stdout: string;
  code: number | null;
}

/**
 * 安全启动外部 CLI 进程（shell: false）。
 * - 针对可执行文件 / Node 路径含空格及任意不可信 Prompt：直接经 OS 进程接口传递，杜绝 shell 注入。
 * - 针对 Windows .cmd / .bat 脚本：严格执行 fail-closed 门禁；
 *   若命令路径或任一参数包含 % ! ^ & | < > ( ) " 或控制字符，立即拒绝并返回准确诊断，防止 cmd.exe 注入与二次展开；
 *   安全参数直接以 cmd.exe /d /c <script> <args> 调用（不使用 call 关键字，消除 call 的参数二次重评风险）。
 */
export function runCliExecutor(options: RunCliOptions): Promise<RunCliResult> {
  const { cmd, args, cwd, timeoutMs = 1_800_000, env = process.env } = options;
  const target = resolveCommandTarget(cmd);

  if (process.platform === 'win32' && target.isBatch) {
    if (BATCH_UNSAFE_REGEX.test(target.resolvedCmd) || containsUnsafeBatchArguments(args)) {
      return Promise.resolve({
        stdout: 'Windows .cmd/.bat 脚本拒绝执行包含特殊元字符（% ! ^ & | < > ( ) " 及控制字符）的命令路径或参数，防止 cmd.exe 二次展开与命令注入；请使用支持文件传参的内核（如 omp）或直接运行可执行文件/Node 脚本。',
        code: -1,
      });
    }

    const comspec = process.env.ComSpec || 'cmd.exe';
    const quoteArg = (arg: string) => `"${arg.replace(/(\\+)$/, '$1$1')}"`;
    const commandLine = `"${[target.resolvedCmd, ...args].map(quoteArg).join(' ')}"`;
    return executeSpawn(comspec, ['/d', '/s', '/c', commandLine], cwd, timeoutMs, env, true);
  }

  return executeSpawn(target.resolvedCmd, args, cwd, timeoutMs, env);
}

function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function executeSpawn(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments = false,
): Promise<RunCliResult> {
  return new Promise<RunCliResult>((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments,
        env: { ...env, ASTERHIVE_WORKER: '1' },
      });
    } catch (err) {
      resolve({ stdout: `启动子进程失败：${err instanceof Error ? err.message : String(err)}`, code: -1 });
      return;
    }

    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => (stdout += decodeOutput(d)));
    child.stderr?.on('data', (d: Buffer) => (stdout += decodeOutput(d)));

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: stdout + String(err), code: -1 });
    });
  });
}
