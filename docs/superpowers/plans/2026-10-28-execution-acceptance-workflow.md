# Execution and Acceptance Workflow Repair

> **For agentic workers:** Use subagent-driven-development for scoped implementation and verification-before-completion for final acceptance.

**Goal:** Stop environment failures and missing execution evidence from causing repeated code rework, while retaining correctness and security gates.

**Architecture:** Keep HTTP, SQLite, Pi and existing evidence attachments. Introduce a bounded, task/attempt-bound execution report, perform real runtime preflight and explicitly declared verification commands, and distinguish code rejection from environment/evidence waits. Production remains paused throughout local development and sandbox verification.

**Tech Stack:** TypeScript, Node 24, Hono, SQLite, Pi SDK, existing npm workspaces.

## Spec and global constraints

The approved scope is: environment readiness before work, risk-scoped acceptance, separate environment blockage from code rework, and automatically retained verification evidence. Existing tasks, commits and workspaces must be preserved. Do not push, deploy, restart production workers or resume scheduling without separate authorization. Missing evidence is not a pass. Mocked pipelines are not proof of real execution. No secrets or full model conversations are collected as verification reports.

## Shared report contract

`packages/sdk/src/execution-report.ts` defines `ExecutionReport`, `ExecutionPreflightCheck`, `ExecutionCommand`, `EXECUTION_REPORT_FILENAME = 'execution-report.json'`, and `EXECUTION_REPORT_MAX_BYTES = 262144`.

```ts
interface ExecutionReport {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  baseCommit?: string;
  commitHash?: string;
  outcome: 'completed' | 'environment_blocked' | 'verification_failed' | 'execution_failed';
  summary: string;
  startedAt: number;
  finishedAt: number;
  preflight: { name: string; ok: boolean; detail: string }[];
  commands: {
    tool: string; command: string;
    startedAt: number; finishedAt: number;
    exitCode: number | null;
    output: string; truncated: boolean;
  }[];
}
```

The complete serialized UTF-8 report is bounded, redacted and uploaded using the existing evidence endpoint with `x-task-attempt`. Old evidence remains readable but cannot be treated as a current runtime report. The server checks the uploader, current assignment, attempt and code reference correlation. Runtime results are not derived from model claims.

## Work packages

| Package | Owned files | Observable acceptance |
|---|---|---|
| Worker execution | `apps/worker-zcode/src/{main,pi-executor,polling}.ts`, new scoped helpers, `packages/sdk/src` and corresponding tests | Native Windows PowerShell works without WSL; missing runtime/dependencies block before implementation; actual command results survive submission; model errors do not become successful no-code results |
| Review and policy | `apps/server/src/{evidence,http,tasks,verbs,brain,repo-manager}.ts` as required, server tests, minimal existing status labels | Current runtime evidence reaches the reviewer; code defects consume rework, environment/evidence waits do not; stale reports/verdicts cannot approve a different attempt or commit |
| Integration | Existing docs and isolated smoke harness | Real command success/failure, model HTTP error, evidence upload/read, blocked classification, retry and reviewed code correlation are exercised without production mutation |

### 1. Worker execution

- [ ] Write failing behavioral regressions for real model-error semantics, environment blocking, command reporting and poll gating; main runs RED before implementation.
- [ ] Probe Node, required Git and the selected shell using bounded real commands. On Windows select Pi's native PowerShell tool rather than WSL/bash. Do not change global PATH or install OS software.
- [ ] In a prepared npm project with a lockfile and no dependencies, run bounded `npm ci --ignore-scripts --no-audit --no-fund`; prerequisite failure is `environment_blocked`, not a successful submission.
- [ ] Run explicit `workspace.validationCommands` after implementation using the real selected shell; retain command/time/exit/output. Scope is `workspace.validationScope: 'task' | 'integration'`.
- [ ] Retain a bounded complete final report rather than only six lines; redact model keys and credential-like values. Correlate report with the resulting commit, upload it before submit, and preserve the workspace on upload/verification failure.

### 2. Review and policy

- [ ] Write failing behavioral regressions for attachment fencing, current report selection, outcome transitions and rework budgets; main runs RED before implementation.
- [ ] Extend the existing evidence table additively with nullable attempt metadata; preserve legacy attachments. Worker uploads must belong to their current task/attempt.
- [ ] Accept reviewer verdicts `pass`, `reject`, `environment_blocked`, `needs_evidence`. Only substantive code rejection increments the rework count. Other waits retain Review and can use the explicit retry path after conditions change.
- [ ] Supply bounded validated runtime reports to the reviewer. Diff proves implementation; execution reports prove actual command outcomes. Missing/truncated evidence requests evidence instead of rewriting code. Serious correctness/security defects still reject.
- [ ] Bind asynchronous verdict/application to the captured attempt and commit. Missing code results cannot silently become Done; legitimate no-code results remain supportable.
- [ ] Update Queen planning instructions: minimal task-local acceptance, explicit executable validation commands, integration requirements at milestones, no unrelated/style-only blocking requests.

### 3. Verification and delivery

- [ ] Run newly added regressions RED, then final affected suites, typecheck and existing regression suite on the final working snapshot.
- [ ] Exercise real native shell commands and a real Pi SDK request to an isolated local HTTP error endpoint; use no paid upstream model.
- [ ] Exercise current-attempt report upload and reviewer ingestion, environment/evidence waits with unchanged code rework budget, explicit retry, and stale result refusal in an isolated server/database/repository.
- [ ] Update operational documentation with report limits, visible wait states, dependency preparation behavior, and the distinction between server deployment and installed worker upgrades.

## Rulings

- Production tasks are paused, not cancelled. Their prior acceptance texts and evidence are not rewritten by this change.
- Preserve physical-stop and attempt fencing protections; no fake timeout completion or automatic release.
- New work occurs on `fix/execution-acceptance-workflow`; no production or shared-branch mutation is part of this implementation.
