#!/usr/bin/env bash
# AsterHive（星巢）服务器一键部署脚本（Linux/macOS，要求 Docker）
#
# 一行命令：
#   curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-hive.sh | bash
#
# 交互式完成：下载源码 → docker compose 构建启动 → 等待健康检查 →
# 初始设置（用户称呼、蜂后模型组 baseURL/API Key/模型选择）→ 打印工蜂接入命令。
# 环境变量：ASTERHIVE_REPO（仓库地址）、ASTERHIVE_REF（分支/标签，默认 main）、
#           ASTERHIVE_HOME（安装目录，默认 ~/AsterHive）
set -euo pipefail

SELF_URL="${SELF_URL:-https://raw.githubusercontent.com/${ASTERHIVE_REPO_OWNER:-rover1003}/AsterHive/${ASTERHIVE_REF:-main}/scripts/install-hive.sh}"
REPO="${ASTERHIVE_REPO:-https://github.com/rover1003/AsterHive}"
REF="${ASTERHIVE_REF:-main}"
HIVE_HOME="${ASTERHIVE_HOME:-$HOME/AsterHive}"
HIVE_PORT="${HIVE_PORT:-8067}"

log() { printf '\033[1;36m[hive]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hive]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[hive]\033[0m %s\n' "$*" >&2; exit 1; }

# curl | bash 时 stdin 是脚本本身，交互式 read 会读不到——
# 有真实终端（tty）时以 /dev/tty 重跑自己；纯非交互环境（自动化）则继续执行并跳过初始设置
if [ ! -t 0 ] && [ -z "${ASTERHIVE_REEXEC:-}" ] && [ -e /dev/tty ] && [ -t 1 ]; then
  TMP="$(mktemp /tmp/install-hive.XXXXXX.sh)"
  curl -fsSL "$SELF_URL" -o "$TMP"
  log "管道模式：以交互方式重新运行安装脚本…"
  ASTERHIVE_REEXEC=1 exec bash "$TMP" < /dev/tty
fi
INTERACTIVE=1
if [ ! -t 0 ]; then
  warn "非交互环境：将跳过初始设置（部署完成后可在 Web 设置页配置用户名与模型组）。"
  INTERACTIVE=0
fi

command -v docker >/dev/null 2>&1 || die "未检测到 docker。请先安装 Docker（https://docs.docker.com/engine/install/）后重试。"
docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 || die "未检测到 docker compose v2。请安装 docker-compose-plugin 后重试。"

echo
echo "=========================================="
echo "  AsterHive（星巢）服务器部署"
echo "  安装目录：$HIVE_HOME"
echo "=========================================="
echo

# 1. 获取源码（tarball，不要求 git；已存在的目录覆盖更新——业务数据在 docker 卷中不受影响）
log "下载源码（$REPO @$REF）…"
mkdir -p "$HIVE_HOME"
TMP_TGZ="$(mktemp /tmp/asterhive-src.XXXXXX.tar.gz)"
curl -fsSL "$REPO/archive/refs/heads/$REF.tar.gz" -o "$TMP_TGZ" \
  || curl -fsSL "$REPO/archive/refs/tags/$REF.tar.gz" -o "$TMP_TGZ" \
  || die "源码下载失败：请检查网络与 ASTERHIVE_REF=$REF 是否存在。"
tar -xzf "$TMP_TGZ" -C "$HIVE_HOME" --strip-components=1
rm -f "$TMP_TGZ"

# 2. 构建并启动容器
log "构建并启动容器（首次构建需数分钟）…"
cd "$HIVE_HOME"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
else
  docker-compose up -d --build
fi

# 3. 等待健康检查
log "等待服务健康检查…"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$HIVE_PORT/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "$READY" = 1 ] || die "服务未在预期时间内就绪：docker compose logs asterhive 查看日志。"
log "服务已就绪：http://127.0.0.1:$HIVE_PORT"

# 4. 交互式初始设置（可跳过，之后可在 Web 设置页配置）
API="http://127.0.0.1:$HIVE_PORT"
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [ "$INTERACTIVE" = 1 ]; then
echo
read -r -p "① 用户称呼（聊天室显示名，回车跳过）：" USER_NAME
if [ -n "$USER_NAME" ]; then
  curl -fsS -X PUT "$API/api/user" -H 'content-type: application/json' \
    -d "{\"handle\":\"$(json_escape "$USER_NAME")\"}" >/dev/null \
    && log "用户称呼已设为：$USER_NAME" || warn "用户称呼设置失败（可在 Web 设置页手动改）。"
fi

echo
echo "② 蜂后模型组（OpenAI 兼容端点；直接回车跳过，之后在 Web「设置 → 模型组」配置）"
read -r -p "   Base URL [https://api.openai.com/v1]：" BASE_URL
BASE_URL="${BASE_URL:-https://api.openai.com/v1}"
read -rs -p "   API Key：" API_KEY
echo
if [ -n "$API_KEY" ]; then
  log "探测模型清单（同时校验 Base URL 与 Key）…"
  MODEL_LIST="$(curl -fsS --max-time 20 "${BASE_URL%/}/models" -H "Authorization: Bearer $API_KEY" 2>/dev/null || true)"
  if [ -z "$MODEL_LIST" ]; then
    warn "模型清单拉取失败——请检查 Base URL 与 Key；可稍后在 Web 设置页重试。"
  else
    echo "$MODEL_LIST" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*:[[:space:]]*"//; s/"$//' | sort -u | grep -v '^$' > /tmp/hive-models.$$
    MODEL_COUNT="$(wc -l < /tmp/hive-models.$$)"
    log "可用模型 $MODEL_COUNT 个："
    cat -n /tmp/hive-models.$$
    read -r -p "   选择模型（输入序号，或直接粘贴模型 id）：" MODEL_PICK
    MODEL_ID="$(printf '%s' "$MODEL_PICK" | grep -Eq '^[0-9]+$' && sed -n "${MODEL_PICK}p" /tmp/hive-models.$$ || printf '%s' "$MODEL_PICK")"
    rm -f /tmp/hive-models.$$
    if [ -z "$MODEL_ID" ]; then
      warn "未选择模型——跳过模型组配置。"
    else
      GROUP_ID="$(curl -fsS -X POST "$API/settings/orchestrator/groups" -H 'content-type: application/json' \
        -d "{\"name\":\"default\",\"baseURL\":\"$(json_escape "$BASE_URL")\",\"apiKey\":\"$(json_escape "$API_KEY")\",\"model\":\"$(json_escape "$MODEL_ID")\"}" \
        | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//' || true)"
      if [ -n "$GROUP_ID" ]; then
        curl -fsS -X PUT "$API/settings/orchestrator/active" -H 'content-type: application/json' -d "{\"groupId\":\"$GROUP_ID\"}" >/dev/null || true
        curl -fsS -X PUT "$API/settings/orchestrator" -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null \
          && log "蜂后已启用：通道「default」· 模型 $MODEL_ID（聊天室 @Queen 唤醒）" \
          || warn "模型组已创建但启用失败——请在 Web 设置页手动启用。"
      else
        warn "模型组创建失败——请在 Web 设置页手动配置。"
      fi
    fi
  fi
fi
fi  # INTERACTIVE

# 5. 探测本机局域网地址，打印工蜂接入命令
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$LAN_IP" ] || LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1 || true)"
BEE_HOST="${LAN_IP:-127.0.0.1}"
echo
echo "=========================================="
echo "  ✅ AsterHive 部署完成"
echo "  Web 界面：http://$BEE_HOST:$HIVE_PORT"
echo
echo "  接入工蜂：在目标设备上执行（Linux/macOS）"
echo "    curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/$REF/scripts/install-bee.sh | bash -s -- http://$BEE_HOST:$HIVE_PORT"
echo "  Windows 设备（PowerShell）："
echo "    iex (irm https://raw.githubusercontent.com/rover1003/AsterHive/$REF/scripts/install-bee.ps1)  # 地址在脚本内按提示填写，或先 \$env:ASTERHIVE_URL='http://$BEE_HOST:$HIVE_PORT'"
echo
echo "  ⚠ 安全模型：星巢为可信内网设计（匿名请求即用户，全权限）。"
echo "    不要把 $HIVE_PORT 暴露到公网；跨网组网请用 WireGuard 等隧道。"
echo "=========================================="
