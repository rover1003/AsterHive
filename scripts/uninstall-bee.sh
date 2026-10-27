#!/usr/bin/env bash
# AsterHive（星巢）工蜂（Bee）一键卸载销毁脚本（Linux/macOS；Windows 原生用 uninstall-bee.ps1）
#
# 一行命令：
#   curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/uninstall-bee.sh | bash -s -- http://<hive-ip>:8067
#   （也可直接执行不传参数，脚本会自动从本地 ~/.asterhive/worker.json 提取 Hive 地址）
#
# 全自动完成：
# 1. 停止并禁用 systemd 用户服务 asterhive-worker，终止所有运行中的工蜂进程；
# 2. 读取本地凭据，向 Hive 服务器注销自身身份（真删行 + 审计事件）；
# 3. 彻底删除工蜂安装目录（~/.asterhive-worker）与本地配置文件。
set -u

BEE_HOME="${BEE_HOME:-$HOME/.asterhive-worker}"
INJECTED_HIVE_URL="__HIVE_URL_PLACEHOLDER__"
APP_DIR="$BEE_HOME/app"
CONFIG="$HOME/.asterhive/worker.json"
TOKEN_FILE="$APP_DIR/apps/worker-zcode/work/token.txt"

log() { printf '\033[1;36m[bee-uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bee-uninstall]\033[0m %s\n' "$*"; }

echo
echo "=========================================="
echo "  AsterHive 工蜂卸载与销毁"
echo "=========================================="

# ---- 1. 读取本地配置与身份凭据 ----
HIVE_URL="${1:-${ASTERHIVE_URL:-}}"
if [ -z "$HIVE_URL" ] && [ -n "$INJECTED_HIVE_URL" ] && [[ "$INJECTED_HIVE_URL" != *"PLACEHOLDER"* ]]; then
  HIVE_URL="$INJECTED_HIVE_URL"
fi
TOKEN=""
HANDLE=""

if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(head -n 1 "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n' || true)"
  HANDLE="$(head -n 2 "$TOKEN_FILE" 2>/dev/null | tail -n 1 | tr -d '\r\n' || true)"
fi

if [ -f "$CONFIG" ]; then
  if command -v node >/dev/null 2>&1; then
    CFG_VALS="$(node -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log([c.url || "", c.token || "", c.handle || ""].join("\u0000"));
      } catch {}
    ' "$CONFIG" 2>/dev/null || true)"
    if [ -n "$CFG_VALS" ]; then
      IFS=$'\0' read -r -d '' F_URL F_TOKEN F_HANDLE <<< "$CFG_VALS" || true
      [ -z "$HIVE_URL" ] && HIVE_URL="$F_URL"
      [ -z "$TOKEN" ] && TOKEN="$F_TOKEN"
      [ -z "$HANDLE" ] && HANDLE="$F_HANDLE"
    fi
  fi
fi

# ---- 2. 停止并删除 systemd 服务与相关进程 ----
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/asterhive-worker.service"

if command -v systemctl >/dev/null 2>&1; then
  log "停止并禁用 systemd 用户服务 asterhive-worker…"
  systemctl --user stop asterhive-worker.service >/dev/null 2>&1 || true
  systemctl --user disable asterhive-worker.service >/dev/null 2>&1 || true
fi
if [ -f "$UNIT" ]; then
  rm -f "$UNIT"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
  log "systemd 单元文件已移除。"
fi

log "检查并终止残留工蜂进程…"
pkill -f 'apps/worker-zcode/src/main.ts' >/dev/null 2>&1 || true

# ---- 3. 向 Hive 服务器注销身份 ----
if [ -n "$HIVE_URL" ] && [ -n "$TOKEN" ]; then
  log "正在向 Hive 服务器 ($HIVE_URL) 注销工蜂身份…"
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST "${HIVE_URL%/}/agents/me/unregister" \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null || true)"
  if [ "$HTTP_CODE" = "200" ]; then
    log "Hive 身份已成功注销。"
  else
    warn "Hive 服务器返回状态码 $HTTP_CODE（可能已注销或地址离线，不影响本地清理）。"
  fi
else
  log "未检测到活跃的 Hive Token 或服务器地址，跳过远端注销。"
fi

# ---- 4. 删除本地工蜂文件与配置目录 ----
log "清理工蜂安装目录 ($BEE_HOME)…"
rm -rf "$BEE_HOME"
log "清理本地配置文件 ($CONFIG)…"
rm -f "$CONFIG"
rmdir "$HOME/.asterhive" >/dev/null 2>&1 || true

echo
echo "=========================================="
echo "  ✅ 工蜂已完全卸载并销毁"
[ -n "$HANDLE" ] && echo "  工蜂句柄：@$HANDLE"
echo "  服务/后台进程：已停止"
echo "  本地目录与配置：已彻底移除"
echo "=========================================="
