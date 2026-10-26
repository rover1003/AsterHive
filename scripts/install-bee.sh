#!/usr/bin/env bash
# AsterHive（星巢）托管工蜂（Bee）一键安装脚本（Linux/macOS；Windows 原生用 install-bee.ps1）
#
# 一行命令（HIVE_URL 换成你的星巢服务器地址，在 Hive 部署完成的输出或 Web「Agent 接入」页可查）：
#   curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-bee.sh | bash -s -- http://<hive-ip>:8067
#
# 交互式完成：自举 Node（无系统 Node 时自动装便携版）→ 从 GitHub 拉取 worker 源码并安装依赖 →
# 模型配置（Base URL + API Key → 在线拉取模型列表选择，Key 只存本设备）→ 写入注册配置 →
# 常驻化（systemd 用户服务；无 systemd 时后台进程）→ 自动注册上线。
# 首次启动 worker 自助注册（开放注册）：句柄形如 pi-worker-<主机名>，撞名自动加后缀。
# 环境变量：ASTERHIVE_REPO / ASTERHIVE_REF（源码来源，默认 main 分支）、
#           BEE_HOME（安装根，默认 ~/.asterhive-worker）
set -euo pipefail

SELF_URL="${SELF_URL:-https://raw.githubusercontent.com/${ASTERHIVE_REPO_OWNER:-rover1003}/AsterHive/${ASTERHIVE_REF:-main}/scripts/install-bee.sh}"
REPO="${ASTERHIVE_REPO:-https://github.com/rover1003/AsterHive}"
REF="${ASTERHIVE_REF:-main}"
BEE_HOME="${BEE_HOME:-$HOME/.asterhive-worker}"
NODE_MIN="23.6"
NODE_DIR="$BEE_HOME/node"
APP_DIR="$BEE_HOME/app"

log() { printf '\033[1;36m[bee]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bee]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bee]\033[0m %s\n' "$*" >&2; exit 1; }

# curl | bash 时 stdin 是脚本本身，交互式 read 会读不到——
# 有真实终端（tty）时以 /dev/tty 重跑自己；纯非交互环境继续执行，
# 但要求 ~/.asterhive/worker.json 已含完整模型配置（重装/自动化场景），否则明确报错
if [ ! -t 0 ] && [ -z "${ASTERHIVE_REEXEC:-}" ] && [ -e /dev/tty ] && [ -t 1 ]; then
  TMP="$(mktemp /tmp/install-bee.XXXXXX.sh)"
  fetch "$SELF_URL" "$TMP"
  log "管道模式：以交互方式重新运行安装脚本…"
  ASTERHIVE_REEXEC=1 exec bash "$TMP" "$@" < /dev/tty
fi
INTERACTIVE=1
if [ ! -t 0 ]; then
  warn "非交互环境：模型配置将复用 ~/.asterhive/worker.json 既有值（无则退出）。"
  INTERACTIVE=0
fi

HIVE_URL="${1:-}"
[ -n "$HIVE_URL" ] || die "用法：install-bee.sh <hive服务器地址>（如 http://192.168.1.10:8067；见 Hive 部署输出或 Web「Agent 接入」页）"
case "$HIVE_URL" in http://*|https://*) ;; *) die "hive 地址需以 http:// 或 https:// 开头：$HIVE_URL" ;; esac
fetch "$HIVE_URL/health" /dev/null 2>/dev/null || (curl -fsS --max-time 10 "$HIVE_URL/health" >/dev/null 2>&1) || die "无法连接 $HIVE_URL/health ——请确认 Hive 已部署且地址可达。"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "需要 curl 或 wget 之一（下载依赖用），请先安装。"
command -v tar >/dev/null 2>&1 || die "未检测到 tar。"

# 下载辅助：自动检测 curl / wget（全脚本下载统一走这里，零手动依赖配置）
fetch() { # fetch <url> <outfile>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1";
  else return 1; fi
}
fetch_pipe() { # fetch_pipe <url>（输出到 stdout，供管道解压）
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1";
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1";
  else return 1; fi
}
fetch_header() { # fetch_header <url> <header>（带鉴权头的 API 调用）
  local url="$1" hdr="$2"
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 20 "$url" -H "$hdr" 2>/dev/null || true;
  elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=20 --header="$hdr" "$url" 2>/dev/null || true;
  else true; fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -1)" = "$NODE_MIN" ]
}

# 1. 自举 Node（≥23.6：原生运行 TypeScript）：系统没有/版本过旧时装便携版到 BEE_HOME/node
if node_ok; then
  log "使用系统 Node $(node -p 'process.versions.node')"
  NODE_BIN="$(command -v node)"
else
  log "系统 Node 缺失或 < $NODE_MIN，安装便携版 Node 24 到 $NODE_DIR …"
  mkdir -p "$NODE_DIR"
  NODE_VERSION="$(fetch_pipe https://nodejs.org/dist/index.json | grep -o '"version":"v24[^"]*"' | head -1 | grep -o 'v24[0-9.]*')"
  [ -n "$NODE_VERSION" ] || die "无法确定 Node 24 版本号（nodejs.org 不可达？）。请手动安装 Node ≥ $NODE_MIN 后重试。"
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) NODE_DIST="linux-x64" ;;
    Linux/aarch64|Linux/arm64) NODE_DIST="linux-arm64" ;;
    Darwin/arm64) NODE_DIST="darwin-arm64" ;;
    Darwin/x86_64) NODE_DIST="darwin-x64" ;;
    *) die "暂不支持的平台：$(uname -s)/$(uname -m)。Windows 原生请用 PowerShell 版：iex (irm https://raw.githubusercontent.com/rover1003/AsterHive/$REF/scripts/install-bee.ps1)" ;;
  esac
  log "下载 Node $NODE_VERSION ($NODE_DIST)…"
  fetch_pipe "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_DIST.tar.gz" \
    | tar -xz -C "$NODE_DIR" --strip-components=1
  export PATH="$NODE_DIR/bin:$PATH"
  NODE_BIN="$NODE_DIR/bin/node"
  node_ok || die "便携 Node 安装后仍不可用，请检查网络。"
  log "Node $(node -p 'process.versions.node') 就绪（$NODE_DIR）"
fi

# 2. 拉取 worker 源码并安装依赖（整仓 tarball，仅装 worker+sdk 两个工作区的依赖）
log "下载 worker 源码（$REPO @$REF）…"
mkdir -p "$APP_DIR"
TMP_TGZ="$(mktemp /tmp/asterhive-worker.XXXXXX.tar.gz)"
fetch "$REPO/archive/refs/heads/$REF.tar.gz" "$TMP_TGZ" \
  || fetch "$REPO/archive/refs/tags/$REF.tar.gz" "$TMP_TGZ" \
  || die "源码下载失败：请检查网络与 ASTERHIVE_REF=$REF。"
tar -xzf "$TMP_TGZ" -C "$APP_DIR" --strip-components=1
rm -f "$TMP_TGZ"

log "安装依赖（npm，仅 worker + sdk 工作区；首次需数分钟）…"
( cd "$APP_DIR" && npm install --omit=dev \
    --workspace @asterhive/worker-zcode --workspace @asterhive/sdk --no-audit --no-fund ) \
  || die "npm install 失败——请检查网络后重试。"

# 3. 模型配置：交互式问答（Key 只写本设备文件 0600，服务器不经手）；
#    非交互环境复用 ~/.asterhive/worker.json 既有 model 段（重装/自动化场景），无则退出
if [ "$INTERACTIVE" = 1 ]; then
echo
echo "=========================================="
echo "  模型配置（工蜂执行内核为内置 Pi，模型 Key 只存本机）"
echo "=========================================="
read -r -p "Base URL [https://api.openai.com/v1]：" BASE_URL
BASE_URL="${BASE_URL:-https://api.openai.com/v1}"
read -rs -p "API Key：" API_KEY
echo
[ -n "$API_KEY" ] || die "API Key 不能为空（工蜂没有可用模型无法执行任务）。"

log "拉取模型清单（同时校验 Base URL 与 Key）…"
MODEL_JSON="$(fetch_header "${BASE_URL%/}/models" "Authorization: Bearer $API_KEY")"
[ -n "$MODEL_JSON" ] || die "模型清单拉取失败：请检查 Base URL 与 Key 是否正确。"

MODEL_FILE="$(mktemp /tmp/bee-models.XXXXXX)"
printf '%s' "$MODEL_JSON" | "$NODE_BIN" -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const j = JSON.parse(raw);
  const ids = (j.data ?? j.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  if (!ids.length) { console.error("模型清单为空"); process.exit(1); }
  ids.forEach((id, i) => console.log(`${i + 1}\t${id}`));
});' > "$MODEL_FILE" || die "模型清单解析失败（非 OpenAI 兼容端点？）。"

log "可用模型："
cat -n "$MODEL_FILE"
read -r -p "选择模型（输入序号，或直接粘贴模型 id）：" MODEL_PICK
if printf '%s' "$MODEL_PICK" | grep -Eq '^[0-9]+$'; then
  MODEL_ID="$(sed -n "${MODEL_PICK}p" "$MODEL_FILE" | cut -f2)"
else
  MODEL_ID="$MODEL_PICK"
fi
rm -f "$MODEL_FILE"
[ -n "$MODEL_ID" ] || die "未选择模型。"
log "已选择：$MODEL_ID"
else
  EXISTING="$("$NODE_BIN" -e '
const fs = require("fs");
try {
  const cfg = JSON.parse(fs.readFileSync(require("os").homedir() + "/.asterhive/worker.json", "utf8"));
  const m = cfg.model ?? {};
  if (cfg.url && m.baseURL && m.apiKey && m.model) {
    console.log([cfg.url, m.baseURL, m.apiKey, m.model].join("\u0000"));
  }
} catch {}' || true)"
  if [ -z "$EXISTING" ]; then
    die "非交互环境且缺少完整既有模型配置。请交互式运行：curl -fsSL $SELF_URL -o install-bee.sh && bash install-bee.sh $HIVE_URL"
  fi
  IFS=$'\0' read -r -d '' HIVE_URL BASE_URL API_KEY MODEL_ID <<< "$EXISTING" || true
  log "复用既有模型配置：$MODEL_ID（$BASE_URL）"
fi

# 4. 写注册与执行配置（worker 首次启动自助注册：开放注册，token 自动落盘）
CONFIG="$HOME/.asterhive/worker.json"
mkdir -p "$HOME/.asterhive"
"$NODE_BIN" -e '
const fs = require("fs");
const [, , url, executor, baseURL, apiKey, model] = process.argv;
const path = require("os").homedir() + "/.asterhive/worker.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.url = url;
cfg.executor = executor;
cfg.model = { baseURL, apiKey, model };
fs.mkdirSync(require("path").dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
' "$HIVE_URL" "pi" "$BASE_URL" "$API_KEY" "$MODEL_ID"
chmod 600 "$CONFIG" 2>/dev/null || true
log "配置已写入 $CONFIG（含模型 Key，权限 0600）"

# 5. 常驻化：优先 systemd 用户服务（开机自启 + 崩溃重启），否则后台进程
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/asterhive-worker.service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1 || [ -d "$UNIT_DIR" ]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=AsterHive Worker Bee
After=network-online.target

[Service]
ExecStart=$NODE_BIN --experimental-strip-types $APP_DIR/apps/worker-zcode/src/main.ts
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || true
  systemctl --user enable --now asterhive-worker.service || warn "systemd 服务启用失败——可手动执行第 6 步的后台方式。"
  sudo -n loginctl enable-linger "$USER" 2>/dev/null \
    || warn "提示：执行 'sudo loginctl enable-linger $USER' 可让工蜂在你不登录时也保持常驻。"
  log "已安装并启动 systemd 用户服务：asterhive-worker"
else
  log "未检测到可用 systemd——以后台进程方式启动（日志 $BEE_HOME/worker.log）…"
  ( cd "$APP_DIR" && nohup "$NODE_BIN" --experimental-strip-types apps/worker-zcode/src/main.ts >> "$BEE_HOME/worker.log" 2>&1 & )
  warn "后台进程不会开机自启；建议配置 launchd/cron @reboot 拉起，或重跑本脚本。"
fi

# 6. 等待注册上线并回显
sleep 4
HANDLE="$(cut -s -f2 "$APP_DIR/apps/worker-zcode/work/token.txt" 2>/dev/null || true)"
echo
echo "=========================================="
echo "  ✅ 工蜂安装完成"
[ -n "$HANDLE" ] && echo "  句柄：@$HANDLE（Fleet 总览中可见）"
echo "  Hive：$HIVE_URL"
echo "  源码：$APP_DIR   日志：$BEE_HOME/worker.log"
echo "  执行内核：内置 Pi（无需本机任何 agent CLI）；模型 Key 仅存本机"
echo "=========================================="
