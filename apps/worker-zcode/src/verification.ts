/**
 * 任务完成后的显式验证命令执行器（Verification Runner）
 * 依据 workspace.validationCommands 与 validationScope，
 * 使用当前平台原生 Shell（Windows: powershell.exe; POSIX: bash）安全执行测试验证命令，
 * 并以结构化方式捕获真实的退出码、输出、执行耗时与截断标记，杜绝从模型文本臆测。
 */

import { spawn } from 'node:child_process';
import type { ExecutionCommand } from './sdk.ts';
import { truncateUtf8Bytes } from './sdk.ts';

const MAX_COMMAND_OUTPUT_BYTES = 65536; // 单条验证命令最大输出 64KiB

export interface RunShellOptions {
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * 运行单条验证命令，捕获真实的退出码与输出
 */
export async function runShellCommand(
  cmd: string,
  cwd: string,
  options?: RunShellOptions,
): Promise<ExecutionCommand> {
  const isWindows = process.platform === 'win32';
  const tool = isWindows ? 'powershell' : 'bash';
  const shellBin = isWindows ? 'powershell.exe' : 'bash';
  const shellArgs = isWindows
    ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
    : ['-c', cmd];

  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 120_000;

  return new Promise<ExecutionCommand>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    let child;
    try {
      child = spawn(shellBin, shellArgs, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        shell: false,
      });
    } catch (err) {
      const finishedAt = Date.now();
      resolve({
        tool,
        command: cmd,
        startedAt,
        finishedAt,
        exitCode: -1,
        output: `进程拉起失败: ${err instanceof Error ? err.message : String(err)}`,
        truncated: false,
      });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        const finishedAt = Date.now();
        const combinedOutput = [stdout, stderr, `Command timed out after ${timeoutMs}ms`].filter(Boolean).join('\n');
        const { text } = truncateUtf8Bytes(combinedOutput, MAX_COMMAND_OUTPUT_BYTES);
        resolve({
          tool,
          command: cmd,
          startedAt,
          finishedAt,
          exitCode: -1,
          output: text,
          truncated: true,
        });
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finishedAt = Date.now();
      const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
      const { text, truncated } = truncateUtf8Bytes(combinedOutput, MAX_COMMAND_OUTPUT_BYTES);

      resolve({
        tool,
        command: cmd,
        startedAt,
        finishedAt,
        exitCode: code,
        output: text,
        truncated,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finishedAt = Date.now();
      resolve({
        tool,
        command: cmd,
        startedAt,
        finishedAt,
        exitCode: -1,
        output: `执行出错: ${err.message}`,
        truncated: false,
      });
    });
  });
}

export interface ValidationResult {
  ok: boolean;
  commands: ExecutionCommand[];
  failedCommand?: ExecutionCommand;
}

/**
 * 顺序执行声明的 validationCommands 列表，任一命令失败即短路阻断
 */
export async function runValidationCommands(
  commands: string[],
  cwd: string,
  options?: RunShellOptions,
): Promise<ValidationResult> {
  const executedCommands: ExecutionCommand[] = [];

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;

    options?.log?.(`[validation] 正在执行命令: ${trimmed}`);
    const result = await runShellCommand(trimmed, cwd, options);
    executedCommands.push(result);

    if (result.exitCode !== 0) {
      options?.log?.(`[validation] 命令失败（exitCode=${result.exitCode}）: ${trimmed}`);
      return {
        ok: false,
        commands: executedCommands,
        failedCommand: result,
      };
    }
  }

  return {
    ok: true,
    commands: executedCommands,
  };
}
