#!/usr/bin/env bash
# AsterHive（星巢）托管工蜂（Bee）一键安装与升级脚本（Linux/macOS；Windows 原生用 install-bee.ps1）
#
# 一行命令（从 Web「Agent 接入」页复制——服务器地址已自动内嵌）：
#   curl -fsSL http://<hive-ip>:8067/scripts/install-bee.sh | bash
#
# 交互式完成：自举 Node（无系统 Node 时自动装便携版）→ 优先从局域网 Hive 实例秒级拉取源码包 →
# 热升级自动识别并复用本设备既有工蜂身份，绝不产生冗余的新工蜂 →
# 模型配置（支持回车保持既有配置）→ 写入注册配置 →
# 前台首次自测与注册（--once）→ 常驻化（systemd 用户服务；无 systemd 时后台进程）→ 自动点亮上线。
set -euo pipefail

INJECTED_HIVE_URL="__HIVE_URL_PLACEHOLDER__"
SELF_URL="${SELF_URL:-https://raw.githubusercontent.com/${ASTERHIVE_REPO_OWNER:-rover1003}/AsterHive/${ASTERHIVE_REF:-main}/scripts/install-bee.sh}"
REPO="${ASTERHIVE_REPO:-https://github.com/rover1003/AsterHive}"
REF="${ASTERHIVE_REF:-main}"
BEE_HOME="${BEE_HOME:-$HOME/.asterhive-worker}"
NODE_MIN="23.6"
NODE_DIR="$BEE_HOME/node"
APP_DIR="$BEE_HOME/app"
CONFIG_FILE="$HOME/.asterhive/worker.json"
TOKEN_FILE="$APP_DIR/apps/worker-zcode/work/token.txt"

log() { printf '\033[1;36m[bee]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bee]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bee]\033[0m %s\n' "$*" >&2; exit 1; }

# 下载辅助：自动检测 curl / wget
fetch() { # fetch <url> <outfile>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1";
  else return 1; fi
}
fetch_pipe() { # fetch_pipe <url>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1";
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1";
  else return 1; fi
}
fetch_header() { # fetch_header <url> <header>
  local url="$1" hdr="$2"
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 20 "$url" -H "$hdr" 2>/dev/null || true;
  elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=20 --header="$hdr" "$url" 2>/dev/null || true;
  else true; fi
}

# curl | bash 时 stdin 是脚本本身，交互式 read 会读不到——
# 有真实终端（tty）时以 /dev/tty 重跑自己；纯非交互环境继续执行
if [ ! -t 0 ] && [ -z "${ASTERHIVE_REEXEC:-}" ] && [ -e /dev/tty ] && [ -t 1 ]; then
  TMP="$(mktemp /tmp/install-bee.XXXXXX.sh)"
  fetch "$SELF_URL" "$TMP" || true
  if [ -s "$TMP" ]; then
    log "管道模式：以交互方式重新运行安装脚本…"
    ASTERHIVE_REEXEC=1 exec bash "$TMP" "$@" < /dev/tty
  fi
fi
INTERACTIVE=1
if [ ! -t 0 ]; then
  warn "非交互环境：模型配置将复用既有配置（无则退出）。"
  INTERACTIVE=0
fi

# ---- 0. Hive 地址解析 ----
HIVE_URL="${ASTERHIVE_URL:-${1:-}}"
if [ -z "$HIVE_URL" ] && [ -n "$INJECTED_HIVE_URL" ] && [[ "$INJECTED_HIVE_URL" != *"PLACEHOLDER"* ]]; then
  HIVE_URL="$INJECTED_HIVE_URL"
fi
if [ -z "$HIVE_URL" ]; then
  read -r -p "Hive 服务器地址（如 http://192.168.1.10:8067）：" HIVE_URL
fi
[ -n "$HIVE_URL" ] || die "缺少 Hive 服务器地址。"
case "$HIVE_URL" in http://*|https://*) ;; *) die "hive 地址需以 http:// 或 https:// 开头：$HIVE_URL" ;; esac
fetch "$HIVE_URL/health" /dev/null 2>/dev/null || (curl -fsS --max-time 10 "$HIVE_URL/health" >/dev/null 2>&1) || die "无法连接 $HIVE_URL/health ——请确认 Hive 已部署且地址可达。"
log "Hive 连通：$HIVE_URL"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "需要 curl 或 wget 之一（下载依赖用），请先安装。"
command -v tar >/dev/null 2>&1 || die "未检测到 tar。"

# ---- 0.1 既有身份与模型配置探查（热升级复用机制） ----
EXISTING_TOKEN=""
EXISTING_HANDLE=""
EXISTING_BASE_URL=""
EXISTING_API_KEY=""
EXISTING_MODEL=""

if [ -f "$TOKEN_FILE" ]; then
  EXISTING_TOKEN="$(head -n 1 "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n' || true)"
  EXISTING_HANDLE="$(head -n 2 "$TOKEN_FILE" 2>/dev/null | tail -n 1 | tr -d '\r\n' || true)"
fi
if [ -f "$CONFIG_FILE" ] && command -v node >/dev/null 2>&1; then
  CFG_VALS="$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const m = c.model ?? {};
      console.log([c.token || "", c.handle || "", m.baseURL || "", m.apiKey || "", m.model || ""].join("\u0000"));
    } catch {}
  ' "$CONFIG_FILE" 2>/dev/null || true)"
  if [ -n "$CFG_VALS" ]; then
    IFS=$'\0' read -r -d '' C_TOKEN C_HANDLE C_BASE C_KEY C_MODEL <<< "$CFG_VALS" || true
    [ -z "$EXISTING_TOKEN" ] && EXISTING_TOKEN="$C_TOKEN"
    [ -z "$EXISTING_HANDLE" ] && EXISTING_HANDLE="$C_HANDLE"
    EXISTING_BASE_URL="$C_BASE"
    EXISTING_API_KEY="$C_KEY"
    EXISTING_MODEL="$C_MODEL"
  fi
fi

REUSE_IDENTITY=0
if [ -n "$EXISTING_TOKEN" ]; then
  CHECK_PROF="$(fetch_header "${HIVE_URL%/}/agents/me/profile" "Authorization: Bearer $EXISTING_TOKEN")"
  if [ -n "$CHECK_PROF" ]; then
    REUSE_IDENTITY=1
    log "检测到本设备已有有效工蜂身份（@$EXISTING_HANDLE），热升级将保持并复用该身份。"
  else
    warn "本地既有工蜂凭据在当前 Hive 上未通过鉴权（可能已注销或服务器已重置），将重新注册新身份。"
    EXISTING_TOKEN=""
    EXISTING_HANDLE=""
  fi
fi

# ---- 1. Node 环境自检与自动安装 ----
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -n1)" = "$NODE_MIN" ]
}

NODE_BIN="node"
if node_ok; then
  log "使用系统 Node $(node -v) ($(command -v node))"
else
  log "系统 Node 缺失或 < $NODE_MIN，自动安装便携版 Node 24 …"
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "不支持的架构：$ARCH" ;;
  esac
  case "$OS" in
    linux) OS="linux" ;;
    darwin) OS="darwin" ;;
    *) die "不支持的系统：$OS（仅支持 Linux / macOS；Windows 请用 install-bee.ps1）" ;;
  esac

  NV="$(fetch_pipe "https://nodejs.org/dist/index.json" \
    | grep -o '"version":"v24\.[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
  [ -n "$NV" ] || die "无法确定 Node 24 最新版本号。请手动安装 Node >= $NODE_MIN 后重试。"

  TAR_URL="https://nodejs.org/dist/$NV/node-$NV-$OS-$ARCH.tar.gz"
  log "下载 Node $NV ($OS-$ARCH)…"
  mkdir -p "$BEE_HOME"
  rm -rf "$NODE_DIR"
  fetch_pipe "$TAR_URL" | tar -xz -C "$BEE_HOME"
  mv "$BEE_HOME/node-$NV-$OS-$ARCH" "$NODE_DIR"
  NODE_BIN="$NODE_DIR/bin/node"

  export PATH="$NODE_DIR/bin:$PATH"
  PROFILE="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && PROFILE="$HOME/.zshrc"
  if ! grep -q "$NODE_DIR/bin" "$PROFILE" 2>/dev/null; then
    printf '\n# AsterHive worker Node\nexport PATH="%s/bin:$PATH"\n' "$NODE_DIR" >> "$PROFILE"
    log "已将 Node 路径写入 $PROFILE"
  fi
  log "Node $($NODE_BIN -v) 就绪（$NODE_DIR）"
fi

# ---- 2. 源码下载：优先从局域网 Hive 实例秒级拉取 ----
log "停止旧的 AsterHive worker（如有）…"
systemctl --user stop asterhive-worker.service 2>/dev/null || true
pkill -f 'worker-zcode.*main.ts' 2>/dev/null || true

mkdir -p "$APP_DIR"
if [ "$REUSE_IDENTITY" = 0 ]; then
  rm -f "$TOKEN_FILE" 2>/dev/null || true
  unset WORKER_TOKEN || true
fi

TMP_TGZ="$(mktemp /tmp/asterhive-worker-bundle.XXXXXX.tar.gz)"
SOURCE_OK=0

HIVE_TGZ_URL="${HIVE_URL%/}/scripts/worker.tar.gz"
log "从 Hive 服务器下载工蜂源码包（$HIVE_TGZ_URL）…"
if fetch "$HIVE_TGZ_URL" "$TMP_TGZ" 2>/dev/null && [ -s "$TMP_TGZ" ]; then
  SOURCE_OK=1
  log "内网源码包获取成功。"
  tar -xzf "$TMP_TGZ" -C "$APP_DIR" 2>/dev/null || tar -xzf "$TMP_TGZ" -C "$APP_DIR" --strip-components=1
else
  warn "内网源码包下载未成功，尝试从 GitHub 拉取…"
  if fetch "$REPO/archive/refs/heads/$REF.tar.gz" "$TMP_TGZ" 2>/dev/null || fetch "$REPO/archive/refs/tags/$REF.tar.gz" "$TMP_TGZ" 2>/dev/null; then
    SOURCE_OK=1
    tar -xzf "$TMP_TGZ" -C "$APP_DIR" --strip-components=1
  fi
fi
rm -f "$TMP_TGZ"
[ "$SOURCE_OK" = 1 ] || die "源码下载失败：请检查网络与 Hive 服务器连接。"

# 热升级恢复 token.txt
if [ "$REUSE_IDENTITY" = 1 ] && [ -n "$EXISTING_TOKEN" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  printf '%s\n%s\n' "$EXISTING_TOKEN" "$EXISTING_HANDLE" > "$TOKEN_FILE"
fi

log "安装依赖（npm，仅 worker + sdk 工作区；首次需数分钟）…"
( cd "$APP_DIR" && npm install --omit=dev \
    --workspace @asterhive/worker-zcode --workspace @asterhive/sdk --no-audit --no-fund ) \
  || die "npm install 失败——请检查网络后重试。"

# ---- 3. 模型配置 ----
if [ "$INTERACTIVE" = 1 ]; then
  echo
  echo "=========================================="
  echo "  模型配置（工蜂执行内核为内置 Pi，模型 Key 只存本机）"
  echo "=========================================="
  DEFAULT_BASE="${EXISTING_BASE_URL:-https://api.openai.com/v1}"
  read -r -p "Base URL [$DEFAULT_BASE]：" BASE_URL
  BASE_URL="${BASE_URL:-$DEFAULT_BASE}"

  if [ -n "$EXISTING_API_KEY" ]; then
    read -rs -p "API Key [回车保持既有密钥]：" API_KEY
    echo
    API_KEY="${API_KEY:-$EXISTING_API_KEY}"
  else
    read -rs -p "API Key：" API_KEY
    echo
  fi
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
  PICK_PROMPT="选择模型（输入序号，直接粘贴"
  [ -n "$EXISTING_MODEL" ] && PICK_PROMPT="$PICK_PROMPT，或回车保持 [$EXISTING_MODEL]"
  PICK_PROMPT="$PICK_PROMPT）："
  read -r -p "$PICK_PROMPT" MODEL_PICK
  if [ -z "$MODEL_PICK" ] && [ -n "$EXISTING_MODEL" ]; then
    MODEL_ID="$EXISTING_MODEL"
  elif printf '%s' "$MODEL_PICK" | grep -Eq '^[0-9]+$'; then
    MODEL_ID="$(sed -n "${MODEL_PICK}p" "$MODEL_FILE" | cut -f2)"
  else
    MODEL_ID="$MODEL_PICK"
  fi
  rm -f "$MODEL_FILE"
  [ -n "$MODEL_ID" ] || die "未选择模型。"
  log "已选择：$MODEL_ID"
else
  [ -n "$EXISTING_BASE_URL" ] && [ -n "$EXISTING_API_KEY" ] && [ -n "$EXISTING_MODEL" ] \
    || die "非交互环境且缺少完整既有模型配置。请交互式运行。"
  BASE_URL="$EXISTING_BASE_URL"
  API_KEY="$EXISTING_API_KEY"
  MODEL_ID="$EXISTING_MODEL"
  log "复用既有模型配置：$MODEL_ID（$BASE_URL）"
fi

# ---- 4. 写注册与执行配置 ----
CONFIG="$HOME/.asterhive/worker.json"
mkdir -p "$HOME/.asterhive"
"$NODE_BIN" -e '
const fs = require("fs");
const [, , url, executor, baseURL, apiKey, model, reuse, token, handle] = process.argv;
const path = require("os").homedir() + "/.asterhive/worker.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.url = url;
cfg.executor = executor;
cfg.model = { baseURL, apiKey, model };
if (reuse === "1" && token) {
  cfg.token = token;
  if (handle) cfg.handle = handle;
}
fs.mkdirSync(require("path").dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
' "$HIVE_URL" "pi" "$BASE_URL" "$API_KEY" "$MODEL_ID" "$REUSE_IDENTITY" "$EXISTING_TOKEN" "$EXISTING_HANDLE"
chmod 600 "$CONFIG" 2>/dev/null || true
log "配置已写入 $CONFIG（含模型 Key，权限 0600）"

# ---- 5. 首次自测上线（前台 --once 单轮运行） ----
log "执行工蜂首次自测（--once 模式，验证执行环境与 Hive 连通）…"
( cd "$APP_DIR" && "$NODE_BIN" --experimental-strip-types apps/worker-zcode/src/main.ts --once ) \
  || die "工蜂自测失败。请根据上方具体错误排查；本次未注册后台常驻服务，避免静默失败挂起。"

# ---- 6. 常驻化 ----
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
fi

# ---- 7. 回显已就绪身份 ----
sleep 1
HANDLE="$(cut -s -f2 "$TOKEN_FILE" 2>/dev/null || true)"
echo
echo "=========================================="
echo "  ✅ 工蜂就绪（Hive 控制台已实时点亮）"
if [ -n "$HANDLE" ]; then
  echo "  句柄：@$HANDLE"
fi
echo "  Hive：$HIVE_URL"
echo "  源码：$APP_DIR   日志：$BEE_HOME/worker.log"
echo "  执行内核：内置 Pi（无需本机任何 agent CLI）；模型 Key 仅存本机"
echo "=========================================="
