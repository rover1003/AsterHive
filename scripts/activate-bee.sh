#!/usr/bin/env bash
# AsterHive（星巢）工蜂（Bee）设备端安全激活与自愈脚本（Linux/macOS；Windows 原生用 activate-bee.ps1）
#
# 一行命令（从 Web「Agent 管理」页复制——服务器地址已自动内嵌）：
#   curl -fsSL http://<hive-ip>:8067/scripts/activate-bee.sh | bash
#
# 核心安全规范与防护边界：
# 1. 严格复用既有身份：按 worker CFG 优先级读取本地既有凭据（env > worker.json > token.txt），
#    检测到凭据冲突或缺失时立即阻断（Fail-Closed），严禁重新发起注册，严禁替换凭据。
# 2. 进程凭据零泄露：通过 Node.js 经私有 stdin 传递 Bearer Token，严禁将凭据置于 curl/wget 进程命令行参数中，杜绝进程列表探测泄露。
# 3. 严格身份确证：远端 GET /agents/me/profile 返回的 agentId 必须与本地生效工蜂句柄严格一致，杜绝身份漂移与冒名拉起。
# 4. 严格保全配置与工作区：不修改 ~/.asterhive/worker.json，不升级源码包，不破坏工作区与任务现场。
# 5. 进程防并发与不杀伤：检测到既有工蜂运行中时绝不终止、绝不重启、绝不拉起重复进程。
# 6. 用户授权最小防重注册硬安全补丁（Fail-Closed）：
#    若工蜂源码未集成防重注册护栏，在经用户授权下对已安装的 main.ts 执行最小、精准的硬安全补丁（备份保留为 main.ts.bak），
#    彻底阻断 401 与缺失 Token 时的自动重注册代码，杜绝 TOCTOU 导致二次污染；若源码结构未知则严格拒绝修改并退出。
# 7. 跨平台系统级持久化常驻服务：
#    Linux 环境优先配置并启动 systemd 用户服务（asterhive-worker.service）并提示 linger；
#    macOS 环境配置并加载 launchd 用户常驻守护代理（com.asterhive.worker.plist）；
#    两类持久化服务均显式注入 WORKER_NO_REGISTER=1 与 ASTERHIVE_NO_REGISTER=1 运行时护栏。
# 8. 真实服务与在线状态核验：通过 Hive 真实心跳验证在线状态，未收到新心跳如实报告“未知”，严禁虚标在线。
set -euo pipefail

INJECTED_HIVE_URL="__HIVE_URL_PLACEHOLDER__"
BEE_HOME="${BEE_HOME:-$HOME/.asterhive-worker}"
NODE_DIR="$BEE_HOME/node"
APP_DIR="$BEE_HOME/app"
CONFIG_DIR="$HOME/.asterhive"
CONFIG_FILE="$CONFIG_DIR/worker.json"
TOKEN_FILE="$APP_DIR/apps/worker-zcode/work/token.txt"
MAIN_TS="$APP_DIR/apps/worker-zcode/src/main.ts"
LOG_FILE="$BEE_HOME/worker.log"

log() { printf '\033[1;36m[bee-activate]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bee-activate]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bee-activate] [错误]\033[0m %s\n' "$*" >&2; exit 1; }
block() { printf '\033[1;31m[bee-activate] [安全阻断]\033[0m %s\n' "$*" >&2; }

echo ""
echo "=================================================="
echo "  AsterHive 工蜂状态检测与本地服务激活 (Linux/macOS)"
echo "=================================================="

# ---- 0. HTTP 基础通信工具（仅用于无凭据公共端点） ----
fetch_pipe() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 15 "$url" 2>/dev/null || true;
  elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=15 "$url" 2>/dev/null || true;
  else return 1; fi
}

fetch_status() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000"
  elif command -v wget >/dev/null 2>&1; then
    wget --spider --server-response --timeout=15 "$url" 2>&1 | awk '/^  HTTP/{print $2}' | tail -n 1 || echo "000"
  else
    echo "000"
  fi
}

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "需要 curl 或 wget 辅助通信，请先安装。"

# ---- 1. Node 运行环境探查与安全通信辅助 ----
NODE_BIN=""
if [ -x "$NODE_DIR/bin/node" ]; then
  NODE_BIN="$NODE_DIR/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

[ -n "$NODE_BIN" ] || die "未找到可用的 Node.js 运行环境（$NODE_DIR/bin/node 不存在且系统 PATH 中无 node）。激活脚本不执行自动下载安装，请先恢复环境。"

read_json_val() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  "$NODE_BIN" -e '
    try {
      const fs = require("fs");
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const keys = process.argv[2].split(".");
      let cur = c;
      for (const k of keys) {
        if (cur == null) break;
        cur = cur[k];
      }
      if (cur !== undefined && cur !== null) process.stdout.write(String(cur));
    } catch {}
  ' "$file" "$key" 2>/dev/null || true
}

# 安全鉴权请求：Token 严格经 stdin 管道传入 Node，绝不暴露在 ps 进程 argv 中
node_auth_get() {
  local url="$1"
  "$NODE_BIN" -e '
    let token = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => token += chunk);
    process.stdin.on("end", async () => {
      token = token.trim();
      const url = process.argv[1];
      try {
        const res = await fetch(url, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const status = res.status;
        let body = {};
        try { body = await res.json(); } catch {}
        process.stdout.write(JSON.stringify({ status, body }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ status: 0, error: err.message }));
      }
    });
  ' "$url" 2>/dev/null || echo '{"status":0,"error":"node_exec_fail"}'
}

# 验证具体进程 PID 是否确属本设备本次激活的目标工蜂（匹配完整 $MAIN_TS 或以 $APP_DIR 为工作目录启动）
pid_matches_target_worker() {
  local p="$1"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1

  # 1. Linux /proc/$p 深度确证
  if [ -r "/proc/$p/cmdline" ]; then
    local cmd
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)"
    if [[ "$cmd" == *"$MAIN_TS"* ]]; then
      return 0
    fi
    if [ -L "/proc/$p/cwd" ]; then
      local cwd
      cwd="$(readlink -f "/proc/$p/cwd" 2>/dev/null || true)"
      if [ "$cwd" = "$APP_DIR" ] && [[ "$cmd" == *"apps/worker-zcode/src/main.ts"* ]]; then
        return 0
      fi
    fi
    return 1
  fi

  # 2. 跨平台 ps -ww -p $p 完整命令行确证 (Linux / macOS)
  local ps_cmd=""
  ps_cmd="$(ps -ww -p "$p" -o command= 2>/dev/null || ps -p "$p" -o args= 2>/dev/null || true)"
  if [ -n "$ps_cmd" ]; then
    if [[ "$ps_cmd" == *"$MAIN_TS"* ]]; then
      return 0
    fi
    if [[ "$ps_cmd" == *"$APP_DIR"* ]] && [[ "$ps_cmd" == *"main.ts"* ]]; then
      return 0
    fi
    return 1
  fi

  return 1
}

# 探测当前真正存活且归属确证的目标工蜂主进程 PID（严格隔离多工蜂与异构路径，Fail-Closed）
get_target_worker_pids() {
  local pids=""
  local os_type
  os_type="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "unknown")"

  # 1. systemd 主进程探测 (Linux)：必须同时确证服务单元配置指向本工蜂 APP_DIR/MAIN_TS
  if [ "$os_type" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    local unit_file="$HOME/.config/systemd/user/asterhive-worker.service"
    local unit_verified=0
    if [ -f "$unit_file" ]; then
      if grep -qF "$APP_DIR" "$unit_file" 2>/dev/null && grep -qF "$MAIN_TS" "$unit_file" 2>/dev/null; then
        unit_verified=1
      fi
    fi

    if [ "$unit_verified" = "1" ] && systemctl --user is-active asterhive-worker.service >/dev/null 2>&1; then
      local mpid
      mpid="$(systemctl --user show asterhive-worker.service --property=MainPID 2>/dev/null | cut -d= -f2 || true)"
      if [ -n "$mpid" ] && [ "$mpid" -gt 0 ] 2>/dev/null && pid_matches_target_worker "$mpid"; then
        pids="$mpid"
      fi
    fi
  fi

  # 2. launchd 进程探测 (macOS)：必须确证 plist 归属于本工蜂并匹配具体命令
  if [ -z "$pids" ] && [ "$os_type" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
    local plist_file="$HOME/Library/LaunchAgents/com.asterhive.worker.plist"
    local plist_verified=0
    if [ -f "$plist_file" ]; then
      if grep -qF "$APP_DIR" "$plist_file" 2>/dev/null && grep -qF "$MAIN_TS" "$plist_file" 2>/dev/null; then
        plist_verified=1
      fi
    fi

    if [ "$plist_verified" = "1" ]; then
      local lpid
      lpid="$(launchctl list 2>/dev/null | awk '$3 == "com.asterhive.worker" && $1 ~ /^[0-9]+$/ {print $1}' || true)"
      if [ -n "$lpid" ] && pid_matches_target_worker "$lpid"; then
        pids="$lpid"
      fi
    fi
  fi

  # 3. pgrep / 进程树探测：严格确证命令行与工作目录归属
  if [ -z "$pids" ] && command -v pgrep >/dev/null 2>&1; then
    local candidate_pids
    candidate_pids="$(pgrep -f "$MAIN_TS" 2>/dev/null || true)"
    if [ -z "$candidate_pids" ]; then
      local raw_pids
      raw_pids="$(pgrep -f 'apps/worker-zcode/src/main\.ts' 2>/dev/null || true)"
      for rp in $raw_pids; do
        if pid_matches_target_worker "$rp"; then
          candidate_pids="${candidate_pids:+$candidate_pids }$rp"
        fi
      done
    fi

    for p in $candidate_pids; do
      if pid_matches_target_worker "$p"; then
        pids="${pids:+$pids }$p"
      fi
    done
  fi

  printf '%s' "$pids"
}
# ---- 2. 读取本地配置与身份凭据（Fail-Closed 校验，遵从 worker CFG 优先级） ----
log "读取本地工蜂配置与身份凭据…"

CFG_URL=""
CFG_TOKEN=""
CFG_HANDLE=""
if [ -f "$CONFIG_FILE" ]; then
  CFG_URL="$(read_json_val "$CONFIG_FILE" "url")"
  CFG_TOKEN="$(read_json_val "$CONFIG_FILE" "token")"
  CFG_HANDLE="$(read_json_val "$CONFIG_FILE" "handle")"
fi

FILE_TOKEN=""
FILE_HANDLE=""
if [ -f "$TOKEN_FILE" ]; then
  FILE_TOKEN="$(sed -n '1p' "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  FILE_HANDLE="$(sed -n '2p' "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
fi

# 2.1 凭据缺失闭环阻断
if [ -z "${WORKER_TOKEN:-}" ] && [ -z "$CFG_TOKEN" ] && [ -z "$FILE_TOKEN" ]; then
  die "未检测到本地工蜂身份凭据（worker.json 与 token.txt 均无有效 Token）。\n【安全终止】激活脚本仅用于已有工蜂设备的激活与服务自愈，严禁自动发起新注册。如需全新注册，请执行 install-bee.sh。"
fi

# 2.2 凭据冲突不一致闭环阻断
if [ -n "$CFG_TOKEN" ] && [ -n "$FILE_TOKEN" ] && [ "$CFG_TOKEN" != "$FILE_TOKEN" ]; then
  die "本地工蜂凭据冲突：worker.json 中的 Token 与 token.txt 中的 Token 不一致。\n身份归属不确定，激活脚本严格拒绝继续执行以防止凭据损坏。"
fi
if [ -n "$CFG_HANDLE" ] && [ -n "$FILE_HANDLE" ] && [ "$CFG_HANDLE" != "$FILE_HANDLE" ]; then
  die "本地工蜂句柄冲突：worker.json 中的 handle (@$CFG_HANDLE) 与 token.txt 中的 handle (@$FILE_HANDLE) 不一致。\n身份不确定，激活脚本拒绝继续执行。"
fi

# 遵从 worker CFG 优先级：env > worker.json > token.txt
RESOLVED_TOKEN="${WORKER_TOKEN:-${CFG_TOKEN:-$FILE_TOKEN}}"
RESOLVED_HANDLE="${WORKER_HANDLE:-${CFG_HANDLE:-$FILE_HANDLE}}"

# ---- 3. 解析与验证 Hive 服务器地址（禁止跨 Hive 实例切换身份） ----
INPUT_URL="${1:-${ASTERHIVE_URL:-}}"
if [ -z "$INPUT_URL" ] && [ -n "$INJECTED_HIVE_URL" ] && [[ "$INJECTED_HIVE_URL" != *"PLACEHOLDER"* ]]; then
  INPUT_URL="$INJECTED_HIVE_URL"
fi

# 跨 Hive 实例冲突检查：若 worker.json 已绑定 URL 且与传入/环境变量不一致，立即 Fail-Closed 阻断，杜绝向不同 Hive 泄露 Token
if [ -n "$CFG_URL" ] && [ -n "$INPUT_URL" ]; then
  CLEAN_CFG="${CFG_URL%/}"
  CLEAN_IN="${INPUT_URL%/}"
  if [ "$CLEAN_CFG" != "$CLEAN_IN" ]; then
    die "检测到本地 worker.json 已绑定 Hive 实例 ($CFG_URL)，但请求/环境变量传入了不同地址 ($INPUT_URL)。\n【安全阻断】为防止身份凭据错乱及向非目标 Hive 泄露 Token，激活脚本严禁跨 Hive 实例切换身份。请在原 Hive 实例激活或使用安装脚本重新配置。"
  fi
fi

HIVE_URL="${CFG_URL:-$INPUT_URL}"
[ -n "$HIVE_URL" ] || die "未能确定 Hive 服务器地址（worker.json 中未配置 url 且命令行/环境变量未传入）。"
case "$HIVE_URL" in http://*|https://*) ;; *) die "Hive 服务器地址格式不合法（必须以 http:// 或 https:// 开头）：$HIVE_URL" ;; esac
HIVE_URL="${HIVE_URL%/}"
# ---- 4. 服务器连通性与 Token 合法性预检（绝不发起注册，无 argv 泄露） ----
log "连接 Hive 服务器健康检查端点 ($HIVE_URL/health)…"
HEALTH_STATUS="$(fetch_status "$HIVE_URL/health")"
if [ "$HEALTH_STATUS" != "200" ]; then
  die "无法连通 Hive 服务器 ($HIVE_URL/health，HTTP 状态码: $HEALTH_STATUS)。请确认 Hive 服务在线且网络可达。"
fi
log "Hive 服务器连通正常：$HIVE_URL"


log "向 Hive 验证工蜂身份凭据（GET /agents/me/profile，私有管道无 argv 凭据传输）…"
PROFILE_RAW="$(printf '%s' "$RESOLVED_TOKEN" | node_auth_get "$HIVE_URL/agents/me/profile")"

PROFILE_STATUS="$(printf '%s' "$PROFILE_RAW" | "$NODE_BIN" -e '
  let raw = ""; process.stdin.on("data", d => raw += d);
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(raw).status || 0)); } catch { process.stdout.write("0"); }
  });
' 2>/dev/null || echo "0")"

if [ "$PROFILE_STATUS" = "401" ]; then
  die "本地工蜂 Token 在 Hive 服务器鉴权失败（401 Unauthorized：Token 已被吊销或服务端身份已重置）。\n【安全终止】根据代次隔离与防重复注册规范，激活脚本严禁发起重新注册，拒绝启动。请联系管理员确认工蜂身份。"
fi
if [ "$PROFILE_STATUS" != "200" ]; then
  die "验证工蜂身份凭据时服务器返回异常状态码 HTTP $PROFILE_STATUS。激活脚本拒绝启动未通过鉴权的工蜂。"
fi

REMOTE_AGENT_ID="$(printf '%s' "$PROFILE_RAW" | "$NODE_BIN" -e '
  let raw = ""; process.stdin.on("data", d => raw += d);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(raw);
      if (j.body && j.body.agentId) process.stdout.write(String(j.body.agentId));
    } catch {}
  });
' 2>/dev/null || true)"

[ -n "$REMOTE_AGENT_ID" ] || die "Hive 返回的工蜂档案结构异常（缺少 agentId），身份无法确证。"

# 严格比对 profile agentId 与本地生效工蜂句柄（规范化去除前导 @ 后比对）
CLEAN_REMOTE_ID="$(printf '%s' "$REMOTE_AGENT_ID" | sed 's/^@*//')"
CLEAN_LOCAL_HANDLE="$(printf '%s' "${RESOLVED_HANDLE:-}" | sed 's/^@*//')"
if [ -n "$CLEAN_LOCAL_HANDLE" ] && [ "$CLEAN_REMOTE_ID" != "$CLEAN_LOCAL_HANDLE" ]; then
  die "工蜂身份不一致（Hive 校验返回 agentId: $REMOTE_AGENT_ID 与本地生效句柄 @$RESOLVED_HANDLE 不符）。\n【安全阻断】拒绝拉起不匹配的工蜂身份。"
fi
EFFECTIVE_HANDLE="${CLEAN_LOCAL_HANDLE:-$CLEAN_REMOTE_ID}"
log "工蜂 Token 验证通过（Hive agentId: $REMOTE_AGENT_ID，句柄: @$EFFECTIVE_HANDLE）"

# ---- 5. 查询服务端真实心跳与工蜂档案（Truthful Heartbeat Verification） ----
log "查询服务端当前记录的工蜂心跳与档案状态…"
AGENTS_JSON="$(fetch_pipe "$HIVE_URL/agents" 2>/dev/null || true)"

AGENT_META="$(printf '%s' "$AGENTS_JSON" | "$NODE_BIN" -e '
  let raw = ""; process.stdin.on("data", d => raw += d);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(raw);
      const list = j.agents || [];
      const clean = (s) => String(s || "").replace(/^@+/, "");
      const targetId = clean(process.argv[1]);
      const targetHandle = clean(process.argv[2]);
      const a = list.find(x => clean(x.id) === targetId || clean(x.handle) === targetHandle || clean(x.handle) === targetId);
      if (a) {
        process.stdout.write(JSON.stringify({
          handle: a.handle || "",
          enabled: a.enabled !== false,
          lastSeenAt: a.lastSeenAt || null
        }));
      }
    } catch {}
  });
' "$REMOTE_AGENT_ID" "$EFFECTIVE_HANDLE" 2>/dev/null || true)"

SERVER_HEARTBEAT_AGE_SEC=""
SERVER_ENABLED="true"
if [ -n "$AGENT_META" ]; then
  SERVER_ENABLED="$("$NODE_BIN" -e 'try { console.log(JSON.parse(process.argv[1]).enabled); } catch { console.log("true"); }' "$AGENT_META" 2>/dev/null || echo "true")"
  LAST_SEEN_MS="$("$NODE_BIN" -e 'try { console.log(JSON.parse(process.argv[1]).lastSeenAt || ""); } catch { console.log(""); }' "$AGENT_META" 2>/dev/null || true)"
  if [ -n "$LAST_SEEN_MS" ]; then
    SERVER_HEARTBEAT_AGE_SEC="$("$NODE_BIN" -e '
      const ls = Number(process.argv[1]);
      if (ls > 0) {
        console.log(Math.max(0, Math.round((Date.now() - ls) / 1000)));
      }
    ' "$LAST_SEEN_MS" 2>/dev/null || true)"
  fi
fi

# ---- 6. 探查运行中进程（避免重复拉起，绝不杀伤现有进程） ----
log "检查本地工蜂运行进程…"
RUNNING_PIDS="$(get_target_worker_pids)"

if [ -n "$RUNNING_PIDS" ]; then
  echo ""
  warn "------------------------------------------------------------------------"
  warn "检测到工蜂进程已在运行中（PID: $RUNNING_PIDS）。"
  warn "【重要安全提示】该工蜂处于活跃运行状态，将持续接收并执行看板指派的任务！"
  warn "【进程安全策略】为防止多实例并发冲突与工作区竞争，激活脚本绝不终止现有进程，亦不重复启动新进程。"
  warn "------------------------------------------------------------------------"
  echo ""
  echo "=========================================="
  echo "  工蜂状态汇总（活跃运行中）"
  echo "  工蜂句柄：@$EFFECTIVE_HANDLE"
  echo "  Agent ID：$REMOTE_AGENT_ID"
  echo "  Hive 实例：$HIVE_URL"
  echo "  运行进程：PID $RUNNING_PIDS"
  echo "  服务状态：已启用=$SERVER_ENABLED"
  if [ -n "$SERVER_HEARTBEAT_AGE_SEC" ]; then
    echo "  服务端记录心跳：${SERVER_HEARTBEAT_AGE_SEC} 秒前（注意：预检鉴权已刷新时间戳，现有工蜂处于持续运行中，未由本次激活探测直接证实独立心跳）"
  else
    echo "  服务端记录心跳：无心跳记录"
  fi
  echo "=========================================="
  exit 0
fi

# ---- 7. 用户授权最小防重注册安全硬补丁（Fail-Closed，绝不全量升级） ----
log "工蜂当前未在运行，检查本地代码防重注册硬安全护栏…"

[ -f "$MAIN_TS" ] || die "未找到工蜂源码入口文件 ($MAIN_TS)。安装目录可能损坏，拒绝启动。"

# 检查已安装工蜂代码是否已具备运行时防重注册硬护栏（基于实际语法执行语义，绝不单纯信任魔术字符串）
ALREADY_GUARDED=0
GUARD_CHECK="$("$NODE_BIN" -e '
  const fs = require("fs");
  try {
    const c = fs.readFileSync(process.argv[1], "utf8");
    const has401Block = /if\s*\(\s*err\s+instanceof\s+SdkError\s*&&\s*err\.status\s*===\s*401\s*\)/.test(c);
    const has401ReRegister = /err\.status\s*===\s*401[\s\S]*?needRegister\s*=\s*true/s.test(c);
    const has401Exit = /err\.status\s*===\s*401[\s\S]*?(?:throw\s+new\s+Error|process\.exit)/s.test(c);
    const hasMissingTokenExit = /(!CFG\.token|!token)[\s\S]*?(?:throw\s+new\s+Error|process\.exit)/s.test(c);
    const hasUnsafeRegister = /if\s*\(\s*needRegister\s*\)\s*\{[\s\S]*?await\s+registerWithRetry/.test(c);
    let isGuarded = false;
    if (has401Block && !has401ReRegister && has401Exit && hasMissingTokenExit) {
      if (!hasUnsafeRegister || /if\s*\(\s*needRegister\s*\)\s*\{\s*(?:throw\s+new\s+Error|process\.exit)/.test(c)) {
        isGuarded = true;
      }
    }
    process.stdout.write(isGuarded ? "GUARDED" : "UNGUARDED");
  } catch (err) {
    process.stdout.write("ERROR:" + err.message);
  }
' "$MAIN_TS" 2>/dev/null || echo "UNGUARDED")"

if [ "$GUARD_CHECK" = "GUARDED" ]; then
  ALREADY_GUARDED=1
  log "工蜂源码已具备防重注册安全硬护栏（经代码执行语义核验证实生效）。"
fi

if [ "$ALREADY_GUARDED" = "0" ]; then
  log "检测到工蜂源码未集成防重注册硬护栏，执行用户授权的最小安全补丁…"

  # 使用 Node.js 对 main.ts 执行原子、精准且闭环的语法块加固
  PATCH_RES="$("$NODE_BIN" -e '
    const fs = require("fs");
    const mainPath = process.argv[1];
    function isWorkerMainGuarded(c) {
      const has401Block = /if\s*\(\s*err\s+instanceof\s+SdkError\s*&&\s*err\.status\s*===\s*401\s*\)/.test(c);
      if (!has401Block) return false;
      const has401ReRegister = /err\.status\s*===\s*401[\s\S]*?needRegister\s*=\s*true/s.test(c);
      if (has401ReRegister) return false;
      const has401Exit = /err\.status\s*===\s*401[\s\S]*?(?:throw\s+new\s+Error|process\.exit)/s.test(c);
      if (!has401Exit) return false;

      const hasMissingTokenExit = /(!CFG\.token|!token)[\s\S]*?(?:throw\s+new\s+Error|process\.exit)/s.test(c);
      if (!hasMissingTokenExit) return false;

      const hasUnsafeRegister = /if\s*\(\s*needRegister\s*\)\s*\{[\s\S]*?await\s+registerWithRetry/.test(c);
      if (hasUnsafeRegister) {
        const hasRegisterBlockGuard = /if\s*\(\s*needRegister\s*\)\s*\{\s*(?:throw\s+new\s+Error|process\.exit)/.test(c);
        if (!hasRegisterBlockGuard) return false;
      }
      return true;
    }

    try {
      const content = fs.readFileSync(mainPath, "utf8");
      if (isWorkerMainGuarded(content)) {
        process.stdout.write("ALREADY_PATCHED");
        process.exit(0);
      }

      const target1 = "let needRegister = !CFG.token;";
      const target2_pattern = /if\s*\(\s*err\s+instanceof\s+SdkError\s*&&\s*err\.status\s*===\s*401\s*\)\s*\{[^}]*needRegister\s*=\s*true;[^}]*\}/s;
      const target3 = "  if (needRegister) {";

      // 严格版本闭环检测：只有精确匹配已知未加固结构才允许补丁，未知修改立即 Fail-Closed
      if (!content.includes(target1) || !target2_pattern.test(content) || !content.includes(target3)) {
        process.stderr.write("UNRECOGNIZED_VERSION");
        process.exit(2);
      }

      const repl1 = `// [ASTERHIVE_NO_REGISTER_GUARD] 激活安全补丁：严禁无凭据自动注册
  if (!CFG.token) {
    throw new Error("[ASTERHIVE_NO_REGISTER_GUARD] 本地缺失工蜂 Token 凭据，已强制禁止自动发起新注册。");
  }
  let needRegister = false;`;

      const repl2 = `if (err instanceof SdkError && err.status === 401) {
        log("[ASTERHIVE_NO_REGISTER_GUARD] Token 鉴权失败 (401 Unauthorized)，已强制阻断自动重新注册。");
        throw new Error("[ASTERHIVE_NO_REGISTER_GUARD] Token 401 失效，禁止自动重新注册新身份。");
      }`;

      const repl3 = `  if (needRegister) {
    throw new Error("[ASTERHIVE_NO_REGISTER_GUARD] 激活安全门禁生效：工蜂运行时严禁调用注册接口。");`;

      let patched = content.replace(target1, repl1)
                           .replace(target2_pattern, repl2)
                           .replace(target3, repl3);

      if (!isWorkerMainGuarded(patched) || patched.includes("needRegister = true;")) {
        process.stderr.write("VERIFICATION_FAILED");
        process.exit(3);
      }

      // 备份原文件并原子写入新文件，绝对不触碰配置与工作区目录
      fs.copyFileSync(mainPath, mainPath + ".bak", fs.constants.COPYFILE_EXCL);
      const tmpPath = mainPath + ".tmp." + process.pid;
      fs.writeFileSync(tmpPath, patched, "utf8");
      fs.renameSync(tmpPath, mainPath);
      process.stdout.write("PATCH_APPLIED");
    } catch (err) {
      process.stderr.write("PATCH_ERROR: " + err.message);
      process.exit(4);
    }
  ' "$MAIN_TS" 2>&1 || true)"

  if [ "$PATCH_RES" = "PATCH_APPLIED" ]; then
    log "已成功对已安装工蜂代码应用用户授权的最小防重注册安全硬补丁（备份已保留于 $MAIN_TS.bak，配置与工作区完全不受影响）。"
  elif [ "$PATCH_RES" = "ALREADY_PATCHED" ]; then
    log "工蜂源码已包含防重注册安全硬护栏。"
  else
    echo ""
    block "================================================================================"
    block "【安全门禁拦截：拒绝拉起工蜂进程】"
    block "检测到本机已安装的工蜂源码 ($MAIN_TS) 结构与受支持版本不一致 ($PATCH_RES)，"
    block "最小安全补丁执行失败或代码已被外部修改。激活脚本拒绝启动未经安全证明的工蜂（Fail-Closed）。"
    block ""
    block "安全现状核实："
    block "  1. 本地身份凭据安全完好：Token 及配置已完整保留于 $CONFIG_FILE 与 $TOKEN_FILE，未被修改；"
    block "  2. 服务端 Token 状态：通过预检（Agent ID: $REMOTE_AGENT_ID, @$EFFECTIVE_HANDLE）；"
    block "  3. 阻断原因：工蜂内核缺乏强制禁止重注册保障，无法绝对免除运行期改写风险。"
    block ""
    block "解除建议：请联系管理员核对工蜂安装版本，包含 ASTERHIVE_NO_REGISTER 护栏后再行激活。"
    block "================================================================================"
    exit 2
  fi
fi

# 明确告知用户工蜂启动后可能会立即被派工
warn "⚠️ 警告：工蜂激活拉起后，可能会立即接收并开始执行蜂后已指派给本工蜂的任务。"

# ---- 8. 跨平台系统级持久化常驻服务修复与拉起 ----
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ACTIVATED_VIA="未知"

export WORKER_NO_REGISTER=1
export ASTERHIVE_NO_REGISTER=1

mkdir -p "$BEE_HOME"
SAFE_PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
if [ -d "$NODE_DIR/bin" ]; then
  case "$SAFE_PATH" in
    *"$NODE_DIR/bin"*) ;;
    *) SAFE_PATH="$NODE_DIR/bin:$SAFE_PATH" ;;
  esac
fi
case "$SAFE_PATH" in
  *"/opt/homebrew/bin"*) ;;
  *) SAFE_PATH="/opt/homebrew/bin:$SAFE_PATH" ;;
esac
case "$SAFE_PATH" in
  *"/usr/local/bin"*) ;;
  *) SAFE_PATH="/usr/local/bin:$SAFE_PATH" ;;
esac

# 启动前最后采样基准时间戳（在预检鉴权后、进程启动前采集，杜绝将预检鉴权误判为工蜂新心跳）
LAUNCH_BASELINE_SEEN_MS=""
RESP_BASE="$(fetch_pipe "$HIVE_URL/agents" 2>/dev/null || true)"
if [ -n "$RESP_BASE" ] && [ -n "$NODE_BIN" ]; then
  LAUNCH_BASELINE_SEEN_MS="$(printf '%s' "$RESP_BASE" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", d => raw += d);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw);
        const list = j.agents || [];
        const clean = (s) => String(s || "").replace(/^@+/, "");
        const targetId = clean(process.argv[1]);
        const targetHandle = clean(process.argv[2]);
        const a = list.find(x => clean(x.id) === targetId || clean(x.handle) === targetHandle || clean(x.handle) === targetId);
        if (a && a.lastSeenAt) process.stdout.write(String(a.lastSeenAt));
      } catch {}
    });
  ' "$REMOTE_AGENT_ID" "$EFFECTIVE_HANDLE" 2>/dev/null || true)"
fi

if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/asterhive-worker.service"
  mkdir -p "$UNIT_DIR"

  SHOULD_WRITE_UNIT=1
  if [ -f "$UNIT" ]; then
    # 严格检验既有单元是否归属于 AsterHive 工蜂，非 AsterHive 单元绝不能启动，立即 Fail-Closed 阻断
    if ! grep -q 'apps/worker-zcode' "$UNIT" 2>/dev/null && ! grep -q 'AsterHive' "$UNIT" 2>/dev/null; then
      die "检测到既有 systemd 服务文件 ($UNIT) 并非 AsterHive 工蜂服务配置（缺少 AsterHive/worker-zcode 标识）。\n【安全阻断】为防止意外启动未知服务或覆盖第三方配置，激活脚本拒绝操作非本工蜂的服务（Fail-Closed）。请管理员检查或移除该冲突服务单元。"
    fi
    # 确证服务文件是否指向当前工蜂的 APP_DIR 与 MAIN_TS
    if ! grep -qF "$APP_DIR" "$UNIT" 2>/dev/null || ! grep -qF "$MAIN_TS" "$UNIT" 2>/dev/null; then
      die "检测到既有 systemd 服务文件 ($UNIT) 指向的路径与当前安装路径不符。\n【安全阻断】拒绝启动路径不一致的服务单元，杜绝跨实例运行冲突。"
    fi
    log "保留已有 systemd 服务配置。"
    SHOULD_WRITE_UNIT=0
  fi

  if [ "$SHOULD_WRITE_UNIT" = "1" ]; then
    [ -f "$UNIT" ] && cp "$UNIT" "$UNIT.bak" 2>/dev/null || true
    cat > "$UNIT" <<EOF
[Unit]
Description=AsterHive Worker Bee
After=network-online.target

[Service]
Environment="WORKER_NO_REGISTER=1"
Environment="ASTERHIVE_NO_REGISTER=1"
Environment="PATH=$SAFE_PATH"
Environment="ASTERHIVE_URL=$HIVE_URL"
ExecStart=$NODE_BIN --experimental-strip-types $MAIN_TS
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload || true
  fi

  systemctl --user enable asterhive-worker.service 2>/dev/null || warn "systemd 服务 enable 失败"
  if ! systemctl --user start asterhive-worker.service; then
    warn "systemd 用户服务启动失败，回落至后台守护进程 (nohup) 启动…"
    ( cd "$APP_DIR" && ASTERHIVE_URL="$HIVE_URL" WORKER_NO_REGISTER=1 ASTERHIVE_NO_REGISTER=1 nohup "$NODE_BIN" --experimental-strip-types "$MAIN_TS" >> "$LOG_FILE" 2>&1 & )
    ACTIVATED_VIA="后台进程 (nohup，systemd 启动回落)"
  else
    ACTIVATED_VIA="Linux systemd 用户常驻服务 ($UNIT)"
    log "已通过 systemd 用户服务拉起工蜂持久化常驻服务。"
  fi

  CURRENT_USER="${USER:-$(id -un 2>/dev/null || echo "root")}"
  LINGER="$(loginctl show-user "$CURRENT_USER" --property=Linger 2>/dev/null || true)"
  if [[ "$LINGER" != *"Linger=yes"* ]]; then
    warn "【持久化提示】当前系统用户未开启 lingering ($LINGER)。当终端注销或 SSH 断开后，systemd 用户服务可能会被系统停止。"
    warn "建议由系统管理员执行：sudo loginctl enable-linger $CURRENT_USER 以确保后台永久常驻。"
  else
    log "用户 lingering 已开启，服务将在会话断开后继续常驻。"
  fi

elif [ "$OS" = "darwin" ]; then
  LAUNCH_DIR="$HOME/Library/LaunchAgents"
  PLIST="$LAUNCH_DIR/com.asterhive.worker.plist"
  mkdir -p "$LAUNCH_DIR"

  SHOULD_WRITE_PLIST=1
  if [ -f "$PLIST" ]; then
    # 严格检验既有 plist 是否归属于 AsterHive 工蜂，非 AsterHive 代理绝不能加载，立即 Fail-Closed 阻断
    if ! grep -q 'com.asterhive.worker' "$PLIST" 2>/dev/null && ! grep -q 'worker-zcode' "$PLIST" 2>/dev/null; then
      die "检测到既有 launchd 代理文件 ($PLIST) 并非标准 AsterHive 工蜂配置。\n【安全阻断】为防止意外启动未知服务，激活脚本拒绝操作非本工蜂的 launchd 配置（Fail-Closed）。"
    fi
    # 确证 plist 是否指向当前工蜂的 APP_DIR 与 MAIN_TS
    if ! grep -qF "$APP_DIR" "$PLIST" 2>/dev/null || ! grep -qF "$MAIN_TS" "$PLIST" 2>/dev/null; then
      die "检测到既有 launchd 代理文件 ($PLIST) 指向的路径与当前安装路径不符。\n【安全阻断】拒绝加载路径不一致的 launchd 代理，杜绝跨实例运行冲突。"
    fi
    log "保留已有 launchd 服务配置。"
    SHOULD_WRITE_PLIST=0
  fi

  if [ "$SHOULD_WRITE_PLIST" = "1" ]; then
    [ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak" 2>/dev/null || true
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.asterhive.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--experimental-strip-types</string>
    <string>$MAIN_TS</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKER_NO_REGISTER</key>
    <string>1</string>
    <key>ASTERHIVE_NO_REGISTER</key>
    <string>1</string>
    <key>PATH</key>
    <string>$SAFE_PATH</string>
    <key>ASTERHIVE_URL</key>
    <string>$HIVE_URL</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF
  fi

  launchctl unload "$PLIST" 2>/dev/null || true
  if ! launchctl load -w "$PLIST"; then
    warn "macOS launchctl 加载服务代理失败 ($PLIST)，回落至后台守护进程 (nohup) 启动…"
    ( cd "$APP_DIR" && ASTERHIVE_URL="$HIVE_URL" WORKER_NO_REGISTER=1 ASTERHIVE_NO_REGISTER=1 nohup "$NODE_BIN" --experimental-strip-types "$MAIN_TS" >> "$LOG_FILE" 2>&1 & )
    ACTIVATED_VIA="后台进程 (nohup，launchd 启动回落)"
  else
    ACTIVATED_VIA="macOS launchd 常驻代理 ($PLIST)"
    log "已通过 macOS launchd 守护代理激活工蜂服务并配置登录常驻。"
  fi

else
  log "未检测到可用 systemd/launchd（环境为容器、WSL 或轻量 Linux）。以后台守护进程方式启动…"
  ( cd "$APP_DIR" && ASTERHIVE_URL="$HIVE_URL" WORKER_NO_REGISTER=1 ASTERHIVE_NO_REGISTER=1 nohup "$NODE_BIN" --experimental-strip-types "$MAIN_TS" >> "$LOG_FILE" 2>&1 & )
  ACTIVATED_VIA="后台进程 (nohup)"
  warn "【说明】工蜂作为当前会话后台进程启动，日志输出至 $LOG_FILE。"
  warn "注意：后台进程不会在系统重启后自动恢复，并非持久化系统服务。"
fi

# ---- 9. 启动后真实状态与心跳确认（Truthful Heartbeat Verification） ----
log "等待服务初始化并验证工蜂实时心跳（最多等待 15 秒）…"

query_agent_last_seen() {
  local resp
  resp="$(fetch_pipe "$HIVE_URL/agents" 2>/dev/null || true)"
  if [ -n "$resp" ] && [ -n "$NODE_BIN" ]; then
    printf '%s' "$resp" | "$NODE_BIN" -e '
      let raw = "";
      process.stdin.on("data", d => raw += d);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(raw);
          const list = j.agents || [];
          const clean = (s) => String(s || "").replace(/^@+/, "");
          const targetId = clean(process.argv[1]);
          const targetHandle = clean(process.argv[2]);
          const a = list.find(x => clean(x.id) === targetId || clean(x.handle) === targetHandle || clean(x.handle) === targetId);
          if (a && a.lastSeenAt) process.stdout.write(String(a.lastSeenAt));
        } catch {}
      });
    ' "$REMOTE_AGENT_ID" "$EFFECTIVE_HANDLE" 2>/dev/null || true
  fi
}

INITIAL_SEEN="${LAUNCH_BASELINE_SEEN_MS:-}"
FRESH_HEARTBEAT=0

# 只有在成功获取到远端基准时间戳的情况下，才能通过递增数值证实新心跳；基准未知即代表未知，严禁使用本地时钟虚构推断
if [ -n "$INITIAL_SEEN" ]; then
  for i in {1..5}; do
    sleep 3
    LATEST_SEEN="$(query_agent_last_seen)"
    if [ -n "$LATEST_SEEN" ]; then
      IS_NEWER="$("$NODE_BIN" -e '
        const b = Number(process.argv[1]) || 0;
        const l = Number(process.argv[2]) || 0;
        process.stdout.write(l > b ? "1" : "0");
      ' "$INITIAL_SEEN" "$LATEST_SEEN" 2>/dev/null || echo "0")"
      if [ "$IS_NEWER" = "1" ]; then
        FRESH_HEARTBEAT=1
        break
      fi
    fi
  done
else
  # 基准时间戳未能从服务端获取（网络瞬断或服务端未返回），观察期内不推断伪心跳
  sleep 3
fi

# 严格确证工蜂目标进程是否物理存活（即使服务端收到心跳，若进程已退出亦属严重故障，绝不虚假断言运行）
POST_RUNNING_PIDS="$(get_target_worker_pids)"

echo ""
echo "=========================================="
if [ "$FRESH_HEARTBEAT" = "1" ] && [ -n "$POST_RUNNING_PIDS" ]; then
  printf '  \033[1;32m✅ 工蜂本地服务已成功激活并运行\033[0m\n'
  echo "  心跳状态：Hive 服务器已成功接收到工蜂新心跳（时间戳递增确认）"
  echo "  工蜂句柄：@$EFFECTIVE_HANDLE"
  echo "  Agent ID：$REMOTE_AGENT_ID"
  echo "  Hive 服务器：$HIVE_URL"
  echo "  激活方式：$ACTIVATED_VIA"
  echo "  进程 PID：$POST_RUNNING_PIDS (验证物理存活)"
  echo "  日志路径：$LOG_FILE"
  echo "  本地配置与凭据：已完整保全，未做任何修改"
  echo "=========================================="
  exit 0
elif [ "$FRESH_HEARTBEAT" = "1" ] && [ -z "$POST_RUNNING_PIDS" ]; then
  printf '  \033[1;31m❌ 工蜂服务激活失败：目标进程在上报心跳后已异常消亡（Process Dead）\033[0m\n'
  echo "  心跳状态：服务端曾观察到心跳时间戳更新，但本地目标工蜂进程未持续常驻，进程已消亡退出"
  echo "  工蜂句柄：@$EFFECTIVE_HANDLE"
  echo "  Agent ID：$REMOTE_AGENT_ID"
  echo "  Hive 服务器：$HIVE_URL"
  echo "  激活方式：$ACTIVATED_VIA"
  echo "  进程状态：未存活 (PID 无)"
  echo "  日志路径：$LOG_FILE"
  echo "  排查建议：请检查启动日志 ($LOG_FILE) 获取进程退出栈追踪或错误原因"
  echo "=========================================="
  exit 1
elif [ -n "$POST_RUNNING_PIDS" ]; then
  printf '  \033[1;33m⚠️ 工蜂本地服务已启动并常驻，但服务端在线状态暂未确证\033[0m\n'
  echo "  进程状态：进程物理存活运行中 (PID: $POST_RUNNING_PIDS)"
  if [ -z "$INITIAL_SEEN" ]; then
    echo "  心跳状态：启动前未从服务端获取到基线时间戳，无法确证心跳递增，如实报告为未知"
  else
    echo "  心跳状态：在观察期内（15s）服务端未观察到递增的新心跳戳，如实报告为未知"
  fi
  echo "  工蜂句柄：@$EFFECTIVE_HANDLE"
  echo "  Agent ID：$REMOTE_AGENT_ID"
  echo "  Hive 服务器：$HIVE_URL"
  echo "  激活方式：$ACTIVATED_VIA"
  echo "  日志路径：$LOG_FILE"
  echo "  排查建议：请查看本地日志 ($LOG_FILE) 或刷新 Hive 控制台"
  echo "=========================================="
  exit 0
else
  printf '  \033[1;31m❌ 工蜂服务激活失败：本地未检测到运行中的工蜂进程，且服务端未收到新心跳\033[0m\n'
  echo "  进程状态：未启动或启动后瞬间崩溃 (PID 无)"
  echo "  工蜂句柄：@$EFFECTIVE_HANDLE"
  echo "  Agent ID：$REMOTE_AGENT_ID"
  echo "  Hive 服务器：$HIVE_URL"
  echo "  激活方式：$ACTIVATED_VIA"
  echo "  日志路径：$LOG_FILE"
  echo "  排查建议：请检查启动日志 ($LOG_FILE) 或 systemd/launchd 日志"
  echo "=========================================="
  exit 1
fi
