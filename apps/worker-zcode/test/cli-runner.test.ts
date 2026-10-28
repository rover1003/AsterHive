import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCliExecutor,
  resolveCommandTarget,
  containsUnsafeBatchArguments,
} from '../src/cli-runner.ts';

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows file locks cleanup tolerance
  }
}

test('cli-runner: Windows 可执行脚本/Node 路径含空格时可安全执行（shell: false）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-spaces-'));
  try {
    const spaceDir = join(root, 'directory with spaces');
    mkdirSync(spaceDir, { recursive: true });
    const scriptPath = join(spaceDir, 'worker script.cjs');
    writeFileSync(
      scriptPath,
      `
const args = process.argv.slice(2);
console.log('CWD:' + process.cwd());
console.log('ARG_COUNT:' + args.length);
console.log('ARG0:' + args[0]);
`,
      'utf8',
    );

    const workDirWithSpaces = join(root, 'work tree spaces');
    mkdirSync(workDirWithSpaces, { recursive: true });

    const res = await runCliExecutor({
      cmd: process.execPath,
      args: [scriptPath, 'safe parameter'],
      cwd: workDirWithSpaces,
    });

    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('CWD:' + workDirWithSpaces));
    assert.ok(res.stdout.includes('ARG_COUNT:1'));
    assert.ok(res.stdout.includes('ARG0:safe parameter'));
  } finally {
    cleanup(root);
  }
});

test('cli-runner: 任意不可信恶意文本参数通过 shell: false 直传，杜绝命令注入与环境展开', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-hostile-'));
  try {
    const scriptPath = join(root, 'echo-args.cjs');
    writeFileSync(
      scriptPath,
      `
const payload = process.argv[2] ?? '';
console.log('PAYLOAD_START\\n' + payload + '\\nPAYLOAD_END');
`,
      'utf8',
    );

    const hostilePrompt = [
      '# 恶意任务说明',
      '& echo INJECTED_SHELL_COMMAND & calc.exe | dir > pwn.txt',
      '<script>alert("xss")</script>',
      '%PATH% %USERNAME% ^ & | < > "quoted argument"',
      '这是第二行\r\n这是第三行带有中文和各种特殊符号',
    ].join('\n');

    const res = await runCliExecutor({
      cmd: process.execPath,
      args: [scriptPath, hostilePrompt],
      cwd: root,
    });

    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('PAYLOAD_START\n' + hostilePrompt + '\nPAYLOAD_END'));
    // 确保没有创建恶意重定向文件 pwn.txt
    assert.equal(existsSync(join(root, 'pwn.txt')), false);
  } finally {
    cleanup(root);
  }
});

test('cli-runner: Windows .cmd/.bat 脚本安全传参可正常执行', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 平台测试 .cmd 行为');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-cmd-safe-'));
  try {
    const cmdPath = join(root, 'safe-runner.cmd');
    writeFileSync(
      cmdPath,
      `@echo off\r\nchcp 65001 >nul\r\necho RUNNER_OK\r\necho ARG1=%~1\r\necho ARG2=%~2\r\n`,
      'utf8',
    );

    const promptFile = join(root, 'prompt.md');
    writeFileSync(promptFile, '# safe prompt file content\n', 'utf8');

    const res = await runCliExecutor({
      cmd: cmdPath,
      args: ['--print', `@${promptFile.replace(/\\/g, '/')}`],
      cwd: root,
    });

    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('RUNNER_OK'));
    assert.ok(res.stdout.includes('ARG1=--print'));
    assert.ok(res.stdout.includes(`ARG2=@${promptFile.replace(/\\/g, '/')}`));
  } finally {
    cleanup(root);
  }
});

test('cli-runner: Windows 批处理路径和参数同时含空格时保持原样', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅在 Windows 平台测试');
  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-spaced-'));
  try {
    const dir = join(root, 'path with spaces');
    mkdirSync(dir);
    const cmdPath = join(dir, 'runner.cmd');
    writeFileSync(cmdPath, '@echo off\r\necho ARG=%~1\r\n');
    const result = await runCliExecutor({ cmd: cmdPath, args: ['value with spaces'], cwd: dir });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('ARG=value with spaces'));
  } finally {
    cleanup(root);
  }
});

test('cli-runner: Windows .cmd/.bat 脚本遇多行/换行 Prompt 必须 fail-closed 阻断，严禁经由 unsafe cmd 传递', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 平台测试 .cmd 行为');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-cmd-unsafe-'));
  try {
    const cmdPath = join(root, 'unsafe-target.cmd');
    writeFileSync(cmdPath, `@echo off\r\necho SHOULD_NOT_RUN\r\n`, 'utf8');

    const multilinePrompt = 'line1\r\n& echo injected & calc.exe\r\nline3';
    assert.equal(containsUnsafeBatchArguments(['--flag', multilinePrompt]), true);

    const res = await runCliExecutor({
      cmd: cmdPath,
      args: ['--mode', 'yolo', multilinePrompt],
      cwd: root,
    });

    assert.equal(res.code, -1);
    assert.ok(res.stdout.includes('特殊元字符') || res.stdout.includes('Windows .cmd/.bat'));
  } finally {
    cleanup(root);
  }
});

test('cli-runner: Windows 批处理对命令路径及参数的 shell 元字符全面 fail-closed（% ! ^ & | < > ( ) " 及控制字符）', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅在 Windows 平台测试');
  const root = mkdtempSync(join(tmpdir(), 'asterhive-cli-injection-'));
  try {
    const cmdPath = join(root, 'runner.cmd');
    writeFileSync(cmdPath, '@echo off\r\necho safe\r\n', 'utf8');

    // 1. 命令注入载荷被阻断，未执行副作用
    const resInjection = await runCliExecutor({ cmd: cmdPath, args: ['&cd.>marker&'], cwd: root });
    assert.equal(resInjection.code, -1);
    assert.equal(existsSync(join(root, 'marker')), false);
    assert.ok(resInjection.stdout.includes('特殊元字符'));

    // 2. 各类危险元字符均在派生前立即阻断
    const dangerousTokens = ['%VAR%', '!EXPAND!', '^', '|', '<', '>', '(', ')', '"quoted"'];
    for (const token of dangerousTokens) {
      assert.equal(containsUnsafeBatchArguments([token]), true, `Token ${token} 应当被识别为不安全参数`);
      const r = await runCliExecutor({ cmd: cmdPath, args: [token], cwd: root });
      assert.equal(r.code, -1, `Token ${token} 应当返回 -1 阻断执行`);
      assert.ok(r.stdout.includes('特殊元字符'));
    }

    // 3. 命令路径自身含有元字符时同样 fail-closed
    const badCmdPath = join(root, 'runner&inject.cmd');
    const resBadPath = await runCliExecutor({ cmd: badCmdPath, args: ['safe'], cwd: root });
    assert.equal(resBadPath.code, -1);
    assert.ok(resBadPath.stdout.includes('特殊元字符'));

    // 4. 安全的中文及空格路径正常支持，不误报
    const safeChineseDir = join(root, '中文 工作区 safe');
    mkdirSync(safeChineseDir, { recursive: true });
    const safeCmdPath = join(safeChineseDir, 'safe runner.cmd');
    writeFileSync(safeCmdPath, '@echo off\r\necho CHINESE_PATH_OK\r\n', 'utf8');
    const resSafe = await runCliExecutor({ cmd: safeCmdPath, args: ['--safe-arg'], cwd: safeChineseDir });
    assert.equal(resSafe.code, 0);
    assert.ok(resSafe.stdout.includes('CHINESE_PATH_OK'));
  } finally {
    cleanup(root);
  }
});

test('cli-runner: 命令解析识别 .cmd / .bat / .exe 及无扩展名可执行文件', () => {
  if (process.platform === 'win32') {
    assert.equal(resolveCommandTarget('test.cmd').isBatch, true);
    assert.equal(resolveCommandTarget('test.bat').isBatch, true);
    assert.equal(resolveCommandTarget('test.BAT').isBatch, true);
    assert.equal(resolveCommandTarget('test.exe').isBatch, false);
    assert.equal(resolveCommandTarget(process.execPath).isBatch, false);
  } else {
    assert.equal(resolveCommandTarget('/bin/sh').isBatch, false);
  }
});
