import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPiPrompt, setPiModuleForTest, type PiModelConfig } from '../src/pi-executor.ts';
import {
  checkNodePreflight,
  checkGitPreflight,
  checkShellPreflight,
  runPreclaimPreflight,
  runWorkspaceDependencyPreflight,
} from '../src/preflight.ts';
import { runValidationCommands, runShellCommand } from '../src/verification.ts';
import { pollNextDirectedTask } from '../src/polling.ts';
import { commitWorkspace, canSubmitExecution, type PreparedWorkspace } from '../src/workspace.ts';
import type { Task } from '../src/sdk.ts';

function tmpCwd(): { dir: string; agentDir: string; skillsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'exec-wf-test-'));
  const dir = join(root, 'work');
  const agentDir = join(root, 'agent');
  const skillsDir = join(root, 'skills');
  mkdirSync(dir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  return { dir, agentDir, skillsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CONFIG: PiModelConfig = {
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test-workflow-key',
  model: 'test-model',
};

test('Pi 执行器检测真实 SDK 错误状态并调用 dispose 释放资源', async () => {
  const rig = tmpCwd();
  let disposed = false;

  // 模拟端点返回 400 invalid_model：Pi SDK session.prompt 正常 resolve，但 agent.state.errorMessage 与 stopReason 均记录错误
  const stub = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => {},
        getModel: (_provider: string, id: string) => ({ id, provider: _provider }),
      }),
    },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      const session = {
        agent: {
          state: {
            errorMessage: 'HTTP 400: invalid_model: model "glm-5.3-oc" does not exist',
          },
        },
        messages: [
          { message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
          {
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'HTTP 400: invalid_model: model "glm-5.3-oc" does not exist',
              content: [],
            },
          },
        ],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {
          disposed = true;
        },
      };
      return { session };
    },
  };

  setPiModuleForTest(stub);
  try {
    const res = await runPiPrompt({
      prompt: 'test model error',
      cwd: rig.dir,
      agentDir: rig.agentDir,
      skillsDir: rig.skillsDir,
      config: CONFIG,
      timeoutMs: 10_000,
      log: () => {},
    });

    assert.equal(res.code, 1, 'SDK 错误状态必须返回退出码 1，绝不能返回 0 假装成功');
    assert.ok(res.stdout.includes('invalid_model'), '输出中必须包含具体模型错误信息');
    assert.equal(disposed, true, '发生错误时必须确定性调用 session.dispose 释放会话资源');
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('Preflight: Node 运行版本检查严格满足 >= 23.6 引擎边界约束', async () => {
  // 1. 低版本边界：Node 20 / 22 / 23.5 必须明确判为不就绪 (ok: false)
  const v20 = await checkNodePreflight({ versionOverride: '20.18.0' });
  assert.equal(v20.name, 'node');
  assert.equal(v20.ok, false, 'Node 20 不支持原生 TS 类型剥离，必须拒绝');
  assert.ok(v20.detail.includes('>= v23.6.0'));

  const v22 = await checkNodePreflight({ versionOverride: 'v22.14.0' });
  assert.equal(v22.ok, false, 'Node 22 必须拒绝');

  const v23_5 = await checkNodePreflight({ versionOverride: 'v23.5.0' });
  assert.equal(v23_5.ok, false, 'Node 23.5 未达到 23.6 最低阈值，必须拒绝');

  // 2. 合法版本边界：Node 23.6 / Node 24 必须判定为就绪 (ok: true)
  const v23_6 = await checkNodePreflight({ versionOverride: 'v23.6.0' });
  assert.equal(v23_6.ok, true, 'Node 23.6 刚好达标，必须允许');
  assert.equal(v23_6.detail, 'v23.6.0');

  const v24 = await checkNodePreflight({ versionOverride: 'v24.1.0' });
  assert.equal(v24.ok, true, 'Node 24+ 必须允许');

  // 3. 宿主环境版本满足 >= 23.6
  const hostCheck = await checkNodePreflight();
  assert.equal(hostCheck.name, 'node');
  assert.equal(hostCheck.ok, true, `当前宿主环境 Node ${process.versions.node} 必须满足 >= 23.6`);

  // 4. 当 Node 版本不达标时，runPreclaimPreflight 必须整体返回 ok: false 阻断领活
  const preclaimBlocked = await runPreclaimPreflight({
    executor: 'pi',
    repoMode: false,
    nodeVersionOverride: 'v22.0.0',
  });
  assert.equal(preclaimBlocked.ok, false, 'Node 版本不满足时必须阻断领活');
  assert.ok(preclaimBlocked.error?.includes('Node 版本过低'));
});

test('Preflight: 缺失 Git 命令行工具时严格阻断 repo 模式取活', async () => {
  // 注入不存在的 git 可执行命令
  const gitCheck = await checkGitPreflight({ gitCmd: 'non_existent_git_binary_xyz' });
  assert.equal(gitCheck.name, 'git');
  assert.equal(gitCheck.ok, false, '缺失 Git 命令时预检必须返回 ok: false');
  assert.ok(gitCheck.detail.length > 0, '缺失 Git 时必须包含明确错误诊断');

  const preclaim = await runPreclaimPreflight({
    executor: 'pi',
    repoMode: true,
    gitCmd: 'non_existent_git_binary_xyz',
  });
  assert.equal(preclaim.ok, false, 'repo 模式下缺失 Git 必须严格阻断取活');
  assert.ok(preclaim.error?.includes('git'), '阻断原因必须包含 Git 缺失说明');
});

test('Preflight: Shell 可用性检测与异常阻断', async () => {
  // 正常 Pi shell 预检
  const validShell = await checkShellPreflight('pi');
  assert.equal(validShell.name, 'shell');
  assert.equal(typeof validShell.ok, 'boolean');

  // 注入不可用的 shell 命令
  const badShell = await checkShellPreflight('pi', { shellOverride: 'non_existent_shell_cmd_xyz' });
  assert.equal(badShell.ok, false, 'shell 不可用时预检必须返回 ok: false');
});

test('Polling: 轮询严格跳过 environment_blocked 任务，不自动重跑', async () => {
  const mockTasks: Task[] = [
    {
      id: 'T-ENV-BLOCKED',
      boardId: 'B-1',
      title: '环境受阻任务',
      detail: '',
      lane: 'InProgress',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 'high',
      category: 'dev',
      acceptance: '',
      workspace: {},
      files: [],
      evidence: [],
      protectedPaths: [],
      claimedAt: 1000,
      lastActivityKind: 'environment_blocked',
      reviewStatus: 'rework',
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: 'T-NORMAL-REWORK',
      boardId: 'B-1',
      title: '正常退回重做任务',
      detail: '',
      lane: 'InProgress',
      assignee: 'worker-1',
      dependsOn: [],
      priority: 'high',
      category: 'dev',
      acceptance: '',
      workspace: {},
      files: [],
      evidence: [],
      protectedPaths: [],
      claimedAt: 1000,
      lastActivityKind: 'milestone',
      reviewStatus: 'rework',
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];

  const result = await pollNextDirectedTask(['B-1'], {
    listMine: async (_boardId, lane) => {
      if (lane === 'InProgress') return mockTasks;
      return [];
    },
    claim: async (id) => mockTasks.find((t) => t.id === id)!,
  });

  assert.ok(result);
  assert.equal(result?.task.id, 'T-NORMAL-REWORK', '轮询必须跳过 environment_blocked 任务，直接命中正常重做任务');
});

test('Workspace: 纯净 package-lock.json 夹具预检安装依赖成功', async () => {
  const rig = tmpCwd();
  try {
    // 构造自包含、零外部依赖的合法 package.json 与 package-lock.json
    writeFileSync(
      join(rig.dir, 'package.json'),
      JSON.stringify({ name: 'zero-dep-fixture', version: '1.0.0' }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(rig.dir, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'zero-dep-fixture',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'zero-dep-fixture',
              version: '1.0.0',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const check = await runWorkspaceDependencyPreflight(rig.dir);
    assert.equal(check.ok, true, '自包含零依赖的 lockfile 执行 npm ci 必须成功');
  } finally {
    rig.cleanup();
  }
});

test('Workspace: 损坏的依赖关系必须确定性报告环境受阻', async () => {
  const rig = tmpCwd();
  try {
    // 使用确定性离线的本地文件依赖 (file:./non-existent-local-dep)，避免向公共 npm registry 发起网络请求
    writeFileSync(
      join(rig.dir, 'package.json'),
      JSON.stringify(
        {
          name: 'broken-pkg',
          version: '1.0.0',
          dependencies: { 'missing-local-dep': 'file:./non-existent-local-package-12345' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rig.dir, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'broken-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'broken-pkg',
              version: '1.0.0',
              dependencies: { 'missing-local-dep': 'file:./non-existent-local-package-12345' },
            },
            'node_modules/missing-local-dep': {
              version: 'file:non-existent-local-package-12345',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const check = await runWorkspaceDependencyPreflight(rig.dir);
    assert.equal(check.ok, false, '缺失依赖安装失败必须返回 ok: false');
    assert.ok(check.error?.length, '必须包含依赖安装失败的详细错误');
  } finally {
    rig.cleanup();
  }
});

test('Workspace: node_modules 目录存在但声明依赖缺失时必须触发验证重装并阻断', async () => {
  const rig = tmpCwd();
  try {
    // 使用确定性离线的本地文件依赖 (file:./non-existent-local-dep) 模拟残缺安装
    writeFileSync(
      join(rig.dir, 'package.json'),
      JSON.stringify(
        {
          name: 'partial-node-modules-pkg',
          version: '1.0.0',
          dependencies: { 'missing-local-dep': 'file:./non-existent-local-package-12345' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(rig.dir, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'partial-node-modules-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'partial-node-modules-pkg',
              version: '1.0.0',
              dependencies: { 'missing-local-dep': 'file:./non-existent-local-package-12345' },
            },
            'node_modules/missing-local-dep': {
              version: 'file:non-existent-local-package-12345',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    // 创建已存在的 node_modules 目录（模拟之前失败构建或中断残留的半截目录）
    const nmDir = join(rig.dir, 'node_modules');
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, '.placeholder'), 'partial installation');

    // 预检绝不能仅凭 node_modules 目录存在就返回 ok: true，必须通过 npm ls 探测出缺失并执行修复失败阻断
    const check = await runWorkspaceDependencyPreflight(rig.dir);
    assert.equal(check.ok, false, '存在残缺 node_modules 时必须通过 npm ls 探测缺失并触发安装失败阻断');
    assert.ok(check.error?.length, '必须包含缺失依赖导致的安装或校验错误详情');
  } finally {
    rig.cleanup();
  }
});

test('Workspace: 不支持的 lockfile（如 yarn.lock / pnpm-lock.yaml）明确报告环境受阻', async () => {
  const rig = tmpCwd();
  try {
    writeFileSync(join(rig.dir, 'yarn.lock'), '# yarn lockfile v1\n', 'utf8');
    writeFileSync(join(rig.dir, 'package.json'), JSON.stringify({ name: 'mock-yarn-pkg' }), 'utf8');

    const check = await runWorkspaceDependencyPreflight(rig.dir);
    assert.equal(check.ok, false, '遇到未支持的 lockfile 必须报告环境受阻');
    assert.ok(check.error?.includes('yarn.lock'), '错误信息必须指出具体的前置依赖文件');
  } finally {
    rig.cleanup();
  }
});

test('Verification: 运行真实 shell 验证命令捕获退出码，失败阻断交付', async () => {
  const rig = tmpCwd();
  try {
    const echoCmd = process.platform === 'win32' ? 'Write-Output "verify-step-1"' : 'echo "verify-step-1"';
    const failCmd = process.platform === 'win32' ? 'exit 42' : 'exit 42';

    // 单条命令真实执行
    const single = await runShellCommand(echoCmd, rig.dir);
    assert.equal(single.exitCode, 0);
    assert.ok(single.output.includes('verify-step-1'));
    assert.equal(single.truncated, false);

    // 包含失败命令的验证序列
    const res = await runValidationCommands([echoCmd, failCmd], rig.dir);
    assert.equal(res.ok, false, '验证命令非零退出必须标记整体验证失败');
    assert.equal(res.commands.length, 2);
    assert.equal(res.failedCommand?.exitCode, 42);
    assert.equal(res.failedCommand?.command, failCmd);
  } finally {
    rig.cleanup();
  }
});

test('Rework: 上轮代码 + 本轮仅证据（无新增 commit）仍关联正确 commitHash 并以代码任务进入审核', async () => {
  const rig = tmpCwd();
  try {
    const gitDir = rig.dir;
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: gitDir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };

    git(['init', '-q']);
    git(['config', 'user.name', 'Worker Test']);
    git(['config', 'user.email', 'worker@asterhive.invalid']);

    // 初始基线提交
    writeFileSync(join(gitDir, 'README.md'), '# Initial', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'base commit']);
    const baseCommit = git(['rev-parse', 'HEAD']);

    // 第一轮任务代码提交（taskRef 提交）
    git(['checkout', '-b', 'asterhive/T-REWORK-1']);
    writeFileSync(join(gitDir, 'solution.txt'), 'Attempt 1 solution code', 'utf8');
    git(['add', 'solution.txt']);
    git(['commit', '-q', '-m', 'attempt 1 implementation']);
    const attempt1Commit = git(['rev-parse', 'HEAD']);
    assert.notEqual(attempt1Commit, baseCommit);

    // 第二轮重做：工作区检出 attempt 1 的提交，但本轮执行只有验证，没有任何文件修改
    const ws: PreparedWorkspace = {
      dir: gitDir,
      mode: 'managed',
      taskId: 'T-REWORK-1',
      attempt: 2,
      branch: 'asterhive/T-REWORK-1',
      baseCommit,
      initialCommit: attempt1Commit,
    };

    // commitWorkspace 返回 undefined 因为没有新增文件变更
    const newCommit = await commitWorkspace(ws, 'attempt 2 verify');
    assert.equal(newCommit, undefined, '无代码变更时 commitWorkspace 必须返回 undefined');

    // 复现 main.ts 补证闭环决策逻辑
    let commitHash: string | undefined = newCommit;
    const isReworkWithPriorCommit = Boolean(
      ws.initialCommit &&
      ws.baseCommit &&
      ws.initialCommit !== ws.baseCommit,
    );
    if (isReworkWithPriorCommit) {
      const headHash = git(['rev-parse', 'HEAD']);
      if (headHash === ws.initialCommit) {
        commitHash = ws.initialCommit;
      }
    }

    assert.equal(commitHash, attempt1Commit, '必须保留并关联上一轮的 commitHash');

    const effectiveNoCode = !commitHash;
    assert.equal(effectiveNoCode, false, '不可将具有上一轮代码成果的任务误判为 effectiveNoCode');

    const canSubmit = canSubmitExecution({
      exitCode: 0,
      commitHash,
      commitFailed: false,
      noCode: effectiveNoCode,
    });
    assert.equal(canSubmit, true, '关联了上一轮 commitHash 的补证任务必须允许正常交付审核');
  } finally {
    rig.cleanup();
  }
});
