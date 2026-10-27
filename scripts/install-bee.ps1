# AsterHive（星巢）托管工蜂（Bee）一键安装脚本 —— Windows 原生 PowerShell
#
# 一行命令（在 PowerShell 中执行；推荐由 Web「Agent 接入」页复制——服务器地址已自动注入）：
#   $env:ASTERHIVE_URL='http://<hive-ip>:8067'; iex (irm https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-bee.ps1)
#   （地址解析顺序：$env:ASTERHIVE_URL → 命令行参数 & ([scriptblock]::Create((irm <本脚本url>))) 'http://<hive-ip>:8067' → 交互提问）
#
# 全自动依赖检测与部署：Node ≥23.6 缺失/过旧 → 自动下载便携版并写入用户 PATH；
# 源码/依赖从 GitHub 自动拉取（tar 不可用时回退 zip）；安装完成后注册计划任务常驻化。
# 模型 Key 只写本设备（%USERPROFILE%\.asterhive\worker.json），服务器不经手。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Repo   = if ($env:ASTERHIVE_REPO) { $env:ASTERHIVE_REPO } else { 'https://github.com/rover1003/AsterHive' }
$Ref    = if ($env:ASTERHIVE_REF)  { $env:ASTERHIVE_REF }  else { 'main' }
$BeeHome = if ($env:BEE_HOME)      { $env:BEE_HOME }       else { Join-Path $env:USERPROFILE '.asterhive-worker' }
$NodeDir  = Join-Path $BeeHome 'node'
$AppDir   = Join-Path $BeeHome 'app'
$NodeMinMajor = 23

function Log($m)  { Write-Host "[bee] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[bee] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[bee] $m" -ForegroundColor Red; exit 1 }

# ---- 0. Hive 地址：env 优先 → 命令行参数次之 → 交互提问；取得后探活 ----
$HiveUrl = $env:ASTERHIVE_URL
if (-not $HiveUrl -and $args.Count -gt 0) { $HiveUrl = [string]$args[0] }
if (-not $HiveUrl) {
  Write-Host ''
  $HiveUrl = Read-Host 'Hive 服务器地址（如 http://192.168.1.10:8067，见部署完成输出或 Web「Agent 接入」页）'
}
if ($HiveUrl -notmatch '^https?://') { Die "hive 地址需以 http:// 或 https:// 开头：$HiveUrl" }
try {
  $null = Invoke-RestMethod -Uri "$HiveUrl/health" -TimeoutSec 10
  Log "Hive 连通：$HiveUrl"
} catch { Die "无法连接 $HiveUrl/health —— 请确认 Hive 已部署且地址可达。（$($_.Exception.Message)）" }

# ---- 1. 依赖自检与自动部署：Node ≥ 23.6（含 npm） ----
function Test-NodeOk {
  try {
    $v = (& node -p 'process.versions.node' 2>$null)
    if (-not $v) { return $false }
    return [int]($v.Split('.')[0]) -ge $NodeMinMajor
  } catch { return $false }
}

$NodeExe = 'node'
if (Test-NodeOk) {
  Log "使用系统 Node $(& node -p 'process.versions.node')"
} else {
  Log "系统 Node 缺失或 < $NodeMinMajor，自动安装便携版 Node 24 …"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $nv = ($index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
  if (-not $nv) { Die "无法确定 Node 24 版本号（nodejs.org 不可达？）。请手动安装 Node ≥ $NodeMinMajor 后重试。" }
  $zipUrl = "https://nodejs.org/dist/$nv/node-$nv-win-$arch.zip"
  $zipFile = Join-Path $env:TEMP "node-$nv-win-$arch.zip"
  Log "下载 Node $nv (win-$arch)…"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -TimeoutSec 600
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $BeeHome | Out-Null
  Expand-Archive -Path $zipFile -DestinationPath $BeeHome -Force
  $extracted = Get-ChildItem $BeeHome -Directory -Filter "node-$nv-win-$arch" | Select-Object -First 1
  if ($extracted) { Move-Item $extracted.FullName $NodeDir -Force }
  Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
  $NodeExe = Join-Path $NodeDir 'node.exe'
  # 写入用户 PATH（新终端自动可用；当前会话进程内即时生效）
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $NodeDir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $NodeDir), 'User')
  }
  $env:Path = "$NodeDir;$env:Path"
  & $NodeExe -p 'process.versions.node' | ForEach-Object { Log "Node $_ 就绪（$NodeDir）" }
}
$NpmCmd = 'npm'
try {
  $nodePath = (Get-Command $NodeExe -ErrorAction Stop).Path
  $candidate = Join-Path (Split-Path $nodePath) 'npm.cmd'
  if (Test-Path $candidate) { $NpmCmd = $candidate }
} catch { } # 系统 Node 场景 npm 在 PATH 中，直接用 npm

# ---- 2. 依赖自动部署：源码 + npm 依赖（重装前先停旧任务/旧进程，防文件占用） ----
Log "停止旧的 AsterHive worker（如有）…"
try { Stop-ScheduledTask -TaskName 'AsterHive worker' -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName 'AsterHive worker' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*worker-zcode*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }

Log "下载 worker 源码（$Repo @$Ref）…"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$tmpTgz = Join-Path $env:TEMP "asterhive-worker-$Ref.tar.gz"
$ok = $false
foreach ($u in @("$Repo/archive/refs/heads/$Ref.tar.gz", "$Repo/archive/refs/tags/$Ref.tar.gz")) {
  try { Invoke-WebRequest -Uri $u -OutFile $tmpTgz -TimeoutSec 600; $ok = $true; break } catch {}
}
if (-not $ok) { Die "源码下载失败：请检查网络与 ASTERHIVE_REF=$REF。" }
if (Get-Command tar -ErrorAction SilentlyContinue) {
  tar -xzf $tmpTgz -C $AppDir --strip-components=1
} else {
  # 极老系统无 bsdtar：回退 zip 包 + Expand-Archive
  $tmpZip = Join-Path $env:TEMP "asterhive-worker-$Ref.zip"
  Invoke-WebRequest -Uri "$Repo/archive/refs/heads/$Ref.zip" -OutFile $tmpZip -TimeoutSec 600
  Expand-Archive -Path $tmpZip -DestinationPath $AppDir -Force
  $inner = Get-ChildItem $AppDir -Directory | Select-Object -First 1
  Get-ChildItem $inner.FullName | Move-Item -Destination $AppDir -Force
  Remove-Item $inner.FullName -Force; Remove-Item $tmpZip -Force
}
Remove-Item $tmpTgz -Force -ErrorAction SilentlyContinue

Log "安装依赖（npm，仅 worker + sdk 工作区；首次需数分钟）…"
Push-Location $AppDir
try {
  & $NpmCmd install --omit=dev --workspace '@asterhive/worker-zcode' --workspace '@asterhive/sdk' --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败——请检查网络后重试。" }
} finally { Pop-Location }

# ---- 3. 交互式模型配置（Key 只写本设备文件，服务器不经手） ----
Write-Host ''
Write-Host '=========================================='
Write-Host '  模型配置（工蜂执行内核为内置 Pi，模型 Key 只存本机）'
Write-Host '=========================================='
$baseURL = Read-Host 'Base URL [https://api.openai.com/v1]'
if (-not $baseURL) { $baseURL = 'https://api.openai.com/v1' }
$apiKey = Read-Host 'API Key'
if (-not $apiKey) { Die 'API Key 不能为空（工蜂没有可用模型无法执行任务）。' }

Log '拉取模型清单（同时校验 Base URL 与 Key）…'
try {
  $modelsResp = Invoke-RestMethod -Uri "$($baseURL.TrimEnd('/'))/models" -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 20
} catch { Die "模型清单拉取失败：请检查 Base URL 与 Key 是否正确。（$($_.Exception.Message)）" }
$modelIds = @($modelsResp.data | ForEach-Object { $_.id }) | Where-Object { $_ }
if (-not $modelIds -or $modelIds.Count -eq 0) { Die '模型清单为空（非 OpenAI 兼容端点？）。' }
Log "可用模型 $($modelIds.Count) 个："
for ($i = 0; $i -lt $modelIds.Count; $i++) { Write-Host ("{0,4}  {1}" -f ($i + 1), $modelIds[$i]) }
$pick = Read-Host '选择模型（输入序号，或直接粘贴模型 id）'
if ($pick -match '^\d+$' -and [int]$pick -le $modelIds.Count) { $modelId = $modelIds[[int]$pick - 1] } else { $modelId = $pick }
if (-not $modelId) { Die '未选择模型。' }
Log "已选择：$modelId"

# ---- 4. 写注册与执行配置（worker 首次启动自助注册：开放注册，token 自动落盘） ----
$configDir = Join-Path $env:USERPROFILE '.asterhive'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$config = Join-Path $configDir 'worker.json'
@{
  url = $HiveUrl
  executor = 'pi'
  model = @{ baseURL = $baseURL; apiKey = $apiKey; model = $modelId }
} | ConvertTo-Json -Depth 4 | ForEach-Object {
  # .NET WriteAllText 写 UTF-8 无 BOM——worker 的 JSON.parse 读到 BOM 会解析失败
  [System.IO.File]::WriteAllText($config, $_)
}
# 收紧 ACL：仅当前用户可读（0600 语义）
try { icacls $config /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null } catch {}
Log "配置已写入 $config（含模型 Key，仅当前用户可读）"

# ---- 5. 常驻化：注册计划任务（登录自启 + 崩溃自动重启，无时长上限） ----
Log '注册计划任务 AsterHive worker（登录自启、崩溃自动重启）…'
$workerMain = Join-Path $AppDir 'apps\worker-zcode\src\main.ts'
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "--experimental-strip-types `"$workerMain`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'AsterHive worker' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'AsterHive worker'
Log '计划任务已注册并启动。'

# ---- 6. 等待注册上线并回显 ----
Start-Sleep -Seconds 4
$handle = $null
$tokenFile = Join-Path $AppDir 'apps\worker-zcode\work\token.txt'
if (Test-Path $tokenFile) {
  $lines = Get-Content $tokenFile
  if ($lines.Count -ge 2) { $handle = $lines[1] }
}
Write-Host ''
Write-Host '=========================================='
Write-Host '  ✅ 工蜂安装完成'
if ($handle) { Write-Host "  句柄：@$handle（Fleet 总览中可见）" }
Write-Host "  Hive：$HiveUrl"
Write-Host "  源码：$AppDir   日志：$BeeHome\worker.log"
Write-Host '  执行内核：内置 Pi（无需本机任何 agent CLI）；模型 Key 仅存本机'
Write-Host '  常驻：计划任务 AsterHive worker（登录自启，taskschd.msc 可管理）'
Write-Host '=========================================='
