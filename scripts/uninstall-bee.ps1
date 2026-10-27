# AsterHive（星巢）工蜂（Bee）一键卸载销毁脚本 —— Windows 原生 PowerShell
#
# 一行命令（在 PowerShell 中执行）：
#   $env:ASTERHIVE_URL='http://<hive-ip>:8067'; iex (irm https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/uninstall-bee.ps1)
#   （也可直接执行：iex (irm .../uninstall-bee.ps1)；Hive 地址会自动从本地 worker.json 提取）
#
# 全自动完成：
# 1. 停止并注销计划任务 AsterHive worker，终止所有运行中的工蜂进程；
# 2. 读取本地凭据，向 Hive 服务器注销自身身份（真删行 + 审计事件）；
# 3. 彻底删除工蜂安装目录（~/.asterhive-worker）、本地配置（~/.asterhive/worker.json）；
# 4. 从用户 PATH 环境变量中移除便携版 Node 路径（如曾安装）。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$BeeHome = if ($env:BEE_HOME) { $env:BEE_HOME } else { Join-Path $env:USERPROFILE '.asterhive-worker' }
$NodeDir = Join-Path $BeeHome 'node'
$AppDir  = Join-Path $BeeHome 'app'
$Config  = Join-Path $env:USERPROFILE '.asterhive\worker.json'
$TokenFile = Join-Path $AppDir 'apps\worker-zcode\work\token.txt'

function Log($m)  { Write-Host "[bee-uninstall] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[bee-uninstall] $m" -ForegroundColor Yellow }

Write-Host ''
Write-Host '=========================================='
Write-Host '  AsterHive 工蜂卸载与销毁'
Write-Host '=========================================='

# ---- 1. 读取本地配置与身份凭据 ----
$InjectedHiveUrl = '__HIVE_URL_PLACEHOLDER__'
$hiveUrl = $env:ASTERHIVE_URL
$token = $null
$handle = $null

if (Test-Path $TokenFile) {
  try {
    $tLines = Get-Content $TokenFile
    if ($tLines.Count -ge 1) { $token = $tLines[0].Trim() }
    if ($tLines.Count -ge 2) { $handle = $tLines[1].Trim() }
  } catch {}
}

if (Test-Path $Config) {
  try {
    $cfg = Get-Content -Raw $Config | ConvertFrom-Json
    if (-not $hiveUrl -and $cfg.url) { $hiveUrl = $cfg.url }
    if (-not $token -and $cfg.token) { $token = $cfg.token }
    if (-not $handle -and $cfg.handle) { $handle = $cfg.handle }
  } catch {}
}

if (-not $hiveUrl -and $args.Count -gt 0) {
  $hiveUrl = [string]$args[0]
}
if (-not $hiveUrl -and $InjectedHiveUrl -and $InjectedHiveUrl -notlike '*PLACEHOLDER*') {
  $hiveUrl = $InjectedHiveUrl
}

# ---- 2. 停止并删除 Windows 计划任务与相关进程 ----
Log '停止并注销计划任务 AsterHive worker…'
try {
  Stop-ScheduledTask -TaskName 'AsterHive worker' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'AsterHive worker' -Confirm:$false -ErrorAction SilentlyContinue
  Log '计划任务已清理。'
} catch {
  Warn "计划任务清理跳过：$($_.Exception.Message)"
}

Log '检查并终止运行中的工蜂进程…'
$killed = 0
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*worker-zcode*' } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
      } catch {}
    }
  if ($killed -gt 0) { Log "已终止 $killed 个工蜂进程。" }
} catch {}

# ---- 3. 向 Hive 服务器注销身份 ----
if ($hiveUrl -and $token) {
  Log "正在向 Hive 服务器 ($hiveUrl) 注销工蜂身份…"
  try {
    $res = Invoke-RestMethod -Uri "$($hiveUrl.TrimEnd('/'))/agents/me/unregister" `
      -Method Post `
      -Headers @{ Authorization = "Bearer $token" } `
      -TimeoutSec 10
    if ($res.ok) {
      Log "Hive 身份已成功注销（$($res.deleted)）。"
    } else {
      Warn "Hive 响应非预期：$res"
    }
  } catch {
    Warn "Hive 服务器注销请求未完成（可能已离线或已删除，不影响本地卸载）：$($_.Exception.Message)"
  }
} else {
  Log '未检测到活跃的 Hive Token 或服务器地址，跳过远端注销。'
}

# ---- 4. 清理用户环境变量中的 Node 便携版路径 ----
try {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and ($userPath -split ';') -contains $NodeDir) {
    Log '从用户 PATH 中移除便携版 Node 路径…'
    $newPath = ($userPath -split ';' | Where-Object { $_ -ne $NodeDir -and $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
} catch {}

# ---- 5. 删除本地工蜂文件与配置目录 ----
Log "清理工蜂安装目录 ($BeeHome)…"
if (Test-Path $BeeHome) {
  try {
    Remove-Item $BeeHome -Recurse -Force -ErrorAction Stop
    Log '安装目录已删除。'
  } catch {
    Warn "安装目录删除受阻（可能有文件被占用）：$($_.Exception.Message)"
  }
}

Log "清理本地配置文件 ($Config)…"
if (Test-Path $Config) {
  try {
    Remove-Item $Config -Force -ErrorAction SilentlyContinue
    $parent = Split-Path $Config
    if ((Get-ChildItem $parent -Force).Count -eq 0) {
      Remove-Item $parent -Force -ErrorAction SilentlyContinue
    }
    Log '配置文件已删除。'
  } catch {}
}

Write-Host ''
Write-Host '=========================================='
Write-Host '  ✅ 工蜂已完全卸载并销毁'
if ($handle) { Write-Host "  工蜂句柄：@$handle" }
Write-Host '  计划任务：已注销'
Write-Host '  运行进程：已终止'
Write-Host '  本地文件：已彻底清理'
Write-Host '=========================================='
