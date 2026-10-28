# AsterHive（星巢）托管工蜂（Bee）一键安装与升级脚本 —— Windows 原生 PowerShell
#
# 一行命令（在 PowerShell 中执行；从 Web「Agent 接入」页复制——服务器地址已自动内嵌）：
#   irm http://<hive-ip>:8067/scripts/install-bee.ps1 | iex
#   （地址解析顺序：$env:ASTERHIVE_URL → 命令行参数 → 服务端自动内嵌注入 → 交互提问）
#
# 全自动依赖自检与部署：Node ≥23.6 + MinGit 便携版自动安装并锁定运行环境；
# 源码优先从本局域网 Hive 实例内网直拉（50KB 秒级直达），零 GitHub 依赖；
# 热升级自动识别并复用本设备既有合法工蜂身份，绝不产生冗余的新工蜂；
# 模型 Key 只写本设备（%USERPROFILE%\.asterhive\worker.json），服务器不经手。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$InjectedHiveUrl = '__HIVE_URL_PLACEHOLDER__'
$Repo   = if ($env:ASTERHIVE_REPO) { $env:ASTERHIVE_REPO } else { 'https://github.com/rover1003/AsterHive' }
$Ref    = if ($env:ASTERHIVE_REF)  { $env:ASTERHIVE_REF }  else { 'main' }
$BeeHome = if ($env:BEE_HOME)      { $env:BEE_HOME }       else { Join-Path $env:USERPROFILE '.asterhive-worker' }
$NodeDir  = Join-Path $BeeHome 'node'
$GitDir   = Join-Path $BeeHome 'git'
$AppDir   = Join-Path $BeeHome 'app'
$ConfigDir = Join-Path $env:USERPROFILE '.asterhive'
$ConfigFile = Join-Path $ConfigDir 'worker.json'
$TokenFile = Join-Path $AppDir 'apps\worker-zcode\work\token.txt'
$NodeMinMajor = 23

function Log($m)  { Write-Host "[bee] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[bee] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[bee] $m" -ForegroundColor Red; exit 1 }

# ---- 0. Hive 地址：env 优先 → 命令行参数次之 → 服务端内嵌地址 → 交互提问；取得后探活 ----
$HiveUrl = $env:ASTERHIVE_URL
if (-not $HiveUrl -and $args.Count -gt 0) { $HiveUrl = [string]$args[0] }
if (-not $HiveUrl -and $InjectedHiveUrl -and $InjectedHiveUrl -notlike '*PLACEHOLDER*') { $HiveUrl = $InjectedHiveUrl }
if (-not $HiveUrl) {
  Write-Host ''
  $HiveUrl = Read-Host 'Hive 服务器地址（如 http://192.168.1.10:8067，见部署完成输出或 Web「Agent 接入」页）'
}
if ($HiveUrl -notmatch '^https?://') { Die "hive 地址需以 http:// 或 https:// 开头：$HiveUrl" }
try {
  $null = Invoke-RestMethod -Uri "$HiveUrl/health" -TimeoutSec 10
  Log "Hive 连通：$HiveUrl"
} catch { Die "无法连接 $HiveUrl/health —— 请确认 Hive 已部署且地址可达。（$($_.Exception.Message)）" }

# ---- 0.1 探查既有工蜂身份与模型配置（热升级无缝复用机制） ----
$existingToken = $null
$existingHandle = $null
$existingBaseURL = $null
$existingApiKey = $null
$existingThinkingLevel = $null
$existingThinkingMap = $null

if (Test-Path $TokenFile) {
  try {
    $tLines = Get-Content $TokenFile
    if ($tLines.Count -ge 1) { $existingToken = $tLines[0].Trim() }
    if ($tLines.Count -ge 2) { $existingHandle = $tLines[1].Trim() }
  } catch {}
}
if (Test-Path $ConfigFile) {
  try {
    $cfg = Get-Content -Raw $ConfigFile | ConvertFrom-Json
    if (-not $existingToken -and $cfg.token) { $existingToken = [string]$cfg.token }
    if (-not $existingHandle -and $cfg.handle) { $existingHandle = [string]$cfg.handle }
    if ($cfg.model) {
      $existingBaseURL = [string]$cfg.model.baseURL
      $existingApiKey = [string]$cfg.model.apiKey
      $existingModel = [string]$cfg.model.model
      $existingThinkingLevel = [string]$cfg.model.thinkingLevel
      $existingThinkingMap = $cfg.model.thinkingLevelMap
    }
  } catch {}
}

$reuseIdentity = $false
if ($existingToken) {
  try {
    $prof = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents/me/profile" `
      -Headers @{ Authorization = "Bearer $existingToken" } -TimeoutSec 6
    if ($prof) {
      $reuseIdentity = $true
      Log "检测到本设备已有有效工蜂身份（@$existingHandle），热升级将保持并复用该身份。"
    }
  } catch {
    Warn "本地既有工蜂凭据在当前 Hive 上未通过验证（可能已被删除或服务器重置），将重新发起注册。"
    $existingToken = $null
    $existingHandle = $null
  }
}

# ---- 1. 依赖自检与自动部署：Node ≥ 23.6 ----
function Test-NodeOk {
  try {
    $v = (& node -p 'process.versions.node' 2>$null)
    if (-not $v) { return $false }
    return [int]($v.Split('.')[0]) -ge $NodeMinMajor
  } catch { return $false }
}

$NodeExe = 'node'
if (Test-NodeOk) {
  $nodeCmd = Get-Command node -ErrorAction Stop
  $NodeExe = $nodeCmd.Source
  Log "使用系统 Node $(& $NodeExe -p 'process.versions.node') ($NodeExe)"
} else {
  Log "系统 Node 缺失或 < $NodeMinMajor，自动安装便携版 Node 24 …"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $nv = ($index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
  if (-not $nv) { Die "无法确定 Node 24 版本号。请手动安装 Node ≥ $NodeMinMajor 后重试。" }
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
  # 写入用户 PATH
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
} catch { }

# ---- 1.1 Git 依赖自检与自动部署（MinGit 便携版） ----
function Test-GitOk {
  try {
    $v = (& git --version 2>$null)
    return [bool]$v
  } catch { return $false }
}

$GitCmdDir = $null
if (Test-GitOk) {
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCmd) { $GitCmdDir = Split-Path $gitCmd.Source }
  Log "使用系统 Git $(& git --version)"
} else {
  Log "系统 Git 缺失，自动安装便携版 MinGit…"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { '64-bit' }
  $minGitZip = Join-Path $env:TEMP "mingit.zip"
  $minGitUrl = "https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/MinGit-2.48.1-$arch.zip"
  Log "下载 MinGit 2.48.1 ($arch)…"
  try {
    Invoke-WebRequest -Uri $minGitUrl -OutFile $minGitZip -TimeoutSec 600
    if (Test-Path $GitDir) { Remove-Item $GitDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $GitDir | Out-Null
    Expand-Archive -Path $minGitZip -DestinationPath $GitDir -Force
    Remove-Item $minGitZip -Force -ErrorAction SilentlyContinue
    $GitCmdDir = Join-Path $GitDir 'cmd'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $GitCmdDir) {
      [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $GitCmdDir), 'User')
    }
    $env:Path = "$GitCmdDir;$env:Path"
    Log "MinGit 就绪：$(& (Join-Path $GitCmdDir 'git.exe') --version)"
  } catch {
    Warn "MinGit 自动安装受阻：$($_.Exception.Message)。无 Git 时工蜂将仅支持 scratch 一次性模式。"
  }
}

# ---- 2. 源码下载：优先从 Hive 服务器直拉，外网不可用时自愈 ----
Log "停止旧的 AsterHive worker（如有）…"
try { Stop-ScheduledTask -TaskName 'AsterHive worker' -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName 'AsterHive worker' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*worker-zcode*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
if (-not $reuseIdentity) {
  if (Test-Path $TokenFile) { Remove-Item $TokenFile -Force -ErrorAction SilentlyContinue }
  $env:WORKER_TOKEN = $null
}

$tmpTgz = Join-Path $env:TEMP "asterhive-worker-bundle.tar.gz"
$sourceOk = $false

# 优先通道：从本地内网 Hive 实例直接拉取工蜂源码包（局域网秒级搞定，零 GitHub 依赖）
$hiveTgzUrl = "$($HiveUrl.TrimEnd('/'))/scripts/worker.tar.gz"
try {
  Log "从 Hive 服务器下载工蜂源码包（$hiveTgzUrl）…"
  Invoke-WebRequest -Uri $hiveTgzUrl -OutFile $tmpTgz -TimeoutSec 30
  if ((Get-Item $tmpTgz).Length -gt 1024) { $sourceOk = $true; Log "内网源码包获取成功。" }
} catch {
  Warn "内网源码包下载未成功，尝试从 GitHub 拉取…"
}

# 回退通道：GitHub archive
if (-not $sourceOk) {
  foreach ($u in @("$Repo/archive/refs/heads/$Ref.tar.gz", "$Repo/archive/refs/tags/$Ref.tar.gz")) {
    try { Invoke-WebRequest -Uri $u -OutFile $tmpTgz -TimeoutSec 600; $sourceOk = $true; break } catch {}
  }
}
if (-not $sourceOk) { Die "工蜂源码获取失败：内网与 GitHub 均不可达，请检查网络。" }

# 解压到 AppDir
if (Get-Command tar -ErrorAction SilentlyContinue) {
  try {
    tar -xzf $tmpTgz -C $AppDir
  } catch {
    tar -xzf $tmpTgz -C $AppDir --strip-components=1
  }
} else {
  Die "解压需要 tar 命令（Windows 10/11 内置 bsdtar）。"
}
Remove-Item $tmpTgz -Force -ErrorAction SilentlyContinue

# 若为热升级，确保工作区内恢复原工蜂凭据
if ($reuseIdentity -and $existingToken) {
  $workDir = Join-Path $AppDir 'apps\worker-zcode\work'
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  [System.IO.File]::WriteAllText($TokenFile, "$existingToken`n$existingHandle`n", [System.Text.Encoding]::UTF8)
}

Log "安装依赖（npm，仅 worker + sdk 工作区；首次需数分钟）…"
Push-Location $AppDir
try {
  & $NpmCmd install --omit=dev --workspace '@asterhive/worker-zcode' --workspace '@asterhive/sdk' --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败——请检查网络后重试。" }
} finally { Pop-Location }

# ---- 3. 交互式模型配置（Key 只写本设备文件，支持回车保持既有配置） ----
Write-Host ''
Write-Host '=========================================='
Write-Host '  模型配置（工蜂执行内核为内置 Pi，模型 Key 只存本机）'
Write-Host '=========================================='

$basePrompt = if ($existingBaseURL) { "Base URL [$existingBaseURL]" } else { "Base URL [https://api.openai.com/v1]" }
$baseURL = Read-Host $basePrompt
if (-not $baseURL) { $baseURL = if ($existingBaseURL) { $existingBaseURL } else { 'https://api.openai.com/v1' } }

$keyPrompt = if ($existingApiKey) { "API Key [回车保持既有密钥]" } else { "API Key" }
$apiKey = Read-Host $keyPrompt
if (-not $apiKey -and $existingApiKey) { $apiKey = $existingApiKey }
if (-not $apiKey) { Die 'API Key 不能为空（工蜂没有可用模型无法执行任务）。' }

Log '拉取模型清单（同时校验 Base URL 与 Key）…'
try {
  $modelsResp = Invoke-RestMethod -Uri "$($baseURL.TrimEnd('/'))/models" -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 20
} catch { Die "模型清单拉取失败：请检查 Base URL 与 Key 是否正确。（$($_.Exception.Message)）" }
$modelIds = @($modelsResp.data | ForEach-Object { $_.id }) | Where-Object { $_ }
if (-not $modelIds -or $modelIds.Count -eq 0) { Die '模型清单为空（非 OpenAI 兼容端点？）。' }
Log "可用模型 $($modelIds.Count) 个："
for ($i = 0; $i -lt $modelIds.Count; $i++) { Write-Host ("{0,4}  {1}" -f ($i + 1), $modelIds[$i]) }

$pickPrompt = if ($existingModel) { "选择模型（输入序号，直接粘贴，或回车保持 [$existingModel]）" } else { "选择模型（输入序号，或直接粘贴模型 id）" }
$pick = Read-Host $pickPrompt
if (-not $pick -and $existingModel) {
  $modelId = $existingModel
} elseif ($pick -match '^\d+$' -and [int]$pick -le $modelIds.Count) {
  $modelId = $modelIds[[int]$pick - 1]
} else {
  $modelId = $pick
}
if (-not $modelId) { Die '未选择模型。' }
Log "已选择：$modelId"

Write-Host '本机有限次档位探测会请求模型供应商，可能产生费用。'
$probeChoice = Read-Host '是否探测该模型的思考档位？[y/N]'
  $discoveryResult = $null
  if ($probeChoice -match '^(y|yes)$') {
    $previousProbeKey = $env:WORKER_PI_API_KEY
    try {
      $env:WORKER_PI_API_KEY = $apiKey
      $discoveryScript = Join-Path $AppDir 'apps\worker-zcode\src\thinking-discovery.ts'
      $discoveryOutput = & $NodeExe --experimental-strip-types $discoveryScript --discover $baseURL $modelId
      if ($LASTEXITCODE -eq 0) { try { $discoveryResult = ($discoveryOutput | Out-String | ConvertFrom-Json) } catch {} }
      if (-not $discoveryResult -or $discoveryResult.status -eq 'unknown') { Warn '未能识别档位；可继续手动选择/配置。' }
      else { Log "本机探测到上游档位：$($discoveryResult.tiers -join ', ')" }
    } finally {
      $env:WORKER_PI_API_KEY = $previousProbeKey
    }
  }
  $modelIdentityChanged = $existingModel -and ($existingModel -ne $modelId -or $existingBaseURL -ne $baseURL)
  if ($modelIdentityChanged) {
    Warn '模型或 endpoint 已变更；不继承旧思考标签映射。'
    $existingThinkingMap = $null
    $existingThinkingLevel = $null
  }
  $currentThinking = if ($existingThinkingLevel) { $existingThinkingLevel } else { 'medium' }
  Write-Host "可选思考等级：$($thinkingLevels -join ', ')（升级回车保留 [$currentThinking]）"
  $thinkingPick = Read-Host '思考等级'
  $thinkingLevel = if (-not $thinkingPick) { $currentThinking } elseif ($thinkingLevels -contains $thinkingPick) { $thinkingPick } else { Die '无效思考等级。' }
  $hasExistingLabel = $existingThinkingMap -and $existingThinkingMap.PSObject.Properties[$thinkingLevel]
  if ($discoveryResult.status -eq 'tiers') {
    if (-not $hasExistingLabel -and $discoveryResult.tiers -contains $thinkingLevel) {
      if (-not $existingThinkingMap) { $existingThinkingMap = [PSCustomObject]@{} }
      $existingThinkingMap | Add-Member -NotePropertyName $thinkingLevel -NotePropertyValue $thinkingLevel -Force
      Log "已按精确匹配的探测标签应用映射：$thinkingLevel"
    } elseif (-not $hasExistingLabel) {
      Warn "探测到档位 [$($discoveryResult.tiers -join ', ')]，与所选 Pi 档位不同；不会猜测映射，请手动设置。"
    }
  }
  $existingLabel = if ($hasExistingLabel) { $existingThinkingMap.$thinkingLevel } else { $null }
  $labelPrompt = if ($null -ne $existingLabel) { "当前等级上游标签 [$existingLabel]（回车保留；standard=恢复标准；-=禁用）" } else { "当前等级上游标签（回车=标准；-=禁用）" }
  $labelPick = Read-Host $labelPrompt
  if ($labelPick -eq '-') {
    if (-not $existingThinkingMap) { $existingThinkingMap = [PSCustomObject]@{} }
    $existingThinkingMap | Add-Member -NotePropertyName $thinkingLevel -NotePropertyValue $null -Force
  } elseif ($labelPick -eq 'standard') {
    if ($existingThinkingMap) { $existingThinkingMap.PSObject.Properties.Remove($thinkingLevel) }
  } elseif ($labelPick) {
    if (-not $existingThinkingMap) { $existingThinkingMap = [PSCustomObject]@{} }
    $existingThinkingMap | Add-Member -NotePropertyName $thinkingLevel -NotePropertyValue $labelPick -Force
  }


# ---- 4. 写注册与执行配置 ----
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$cfgObj = @{
  url = $HiveUrl
  executor = 'pi'
  model = @{ baseURL = $baseURL; apiKey = $apiKey; model = $modelId; thinkingLevel = $thinkingLevel; thinkingLevelMap = $existingThinkingMap }
}
if ($reuseIdentity -and $existingToken) {
  $cfgObj['token'] = $existingToken
  if ($existingHandle) { $cfgObj['handle'] = $existingHandle }
}
$cfgObj | ConvertTo-Json -Depth 4 | ForEach-Object {
  [System.IO.File]::WriteAllText($ConfigFile, $_)
}
try { icacls $ConfigFile /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null } catch {}
Log "配置已写入 $ConfigFile（含模型 Key，仅当前用户可读）"

# ---- 5. 首次自测上线（前台 --once 运行） ----
Log '执行工蜂首次自测（--once 模式，验证执行环境与 Hive 连通）…'
$workerMain = Join-Path $AppDir 'apps\worker-zcode\src\main.ts'
Push-Location $AppDir
$testExit = 0
try {
  & $NodeExe --experimental-strip-types "$workerMain" --once
  $testExit = $LASTEXITCODE
} catch {
  $testExit = 1
  Warn "工蜂首次运行异常：$($_.Exception.Message)"
} finally {
  Pop-Location
}
if ($testExit -ne 0) {
  Die "工蜂自测失败（exit=$testExit）。请根据上方具体错误排查；本次未注册后台计划任务，避免静默挂起。"
}

# ---- 6. 生成常驻启动器脚本（start-worker.cmd，带环境路径锁定与日志重定向） ----
$startCmd = Join-Path $BeeHome 'start-worker.cmd'
$nodeBinDir = Split-Path $NodeExe
$extraDirs = @($nodeBinDir, $GitCmdDir) | Where-Object { $_ -and (Test-Path $_) }
$pathPrefix = if ($extraDirs.Count -gt 0) { "set `"PATH=$($extraDirs -join ';');%PATH%`"`n" } else { "" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$cmdContent = "@echo off`r`n" +
  "chcp 65001 >nul`r`n" +
  $pathPrefix +
  "cd /d `"$AppDir`"`r`n" +
  "`"$NodeExe`" --experimental-strip-types `"$workerMain`" >> `"$BeeHome\worker.log`" 2>&1`r`n"
[System.IO.File]::WriteAllText($startCmd, $cmdContent, $utf8NoBom)

# ---- 7. 常驻化：首选计划任务；权限受限时自动降级为当前用户启动项（零提权要求） ----
$scheduledOk = $false
Log '配置工蜂常驻服务（登录自启与后台守护）…'

# 尝试方式 A：PowerShell 计划任务
try {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$startCmd`"" -WorkingDirectory $AppDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'AsterHive worker' -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName 'AsterHive worker' -ErrorAction Stop
  $scheduledOk = $true
  Log '计划任务已就绪并启动。'
} catch {}

# 尝试方式 B：schtasks 命令行（部分非提权环境可用）
if (-not $scheduledOk) {
  try {
    $null = & schtasks /Create /TN "AsterHive worker" /TR "`"$startCmd`"" /SC ONLOGON /F 2>&1
    if ($LASTEXITCODE -eq 0) {
      & schtasks /Run /TN "AsterHive worker" 2>$null | Out-Null
      $scheduledOk = $true
      Log '计划任务已通过 schtasks 配置完成并启动。'
    }
  } catch {}
}

# 兜底方式 C（100% 成功，零权限要求）：当前用户 Startup 目录自启 + 即时后台拉起
if (-not $scheduledOk) {
  try {
    $startupDir = [Environment]::GetFolderPath('Startup')
    if ($startupDir -and (Test-Path $startupDir)) {
      $vbsFile = Join-Path $startupDir 'AsterHive-worker.vbs'
      # VBScript 无黑框静默运行 start-worker.cmd
      $vbsContent = "CreateObject(`"Wscript.Shell`").Run `"`"`"$startCmd`"`"`", 0, False"
      [System.IO.File]::WriteAllText($vbsFile, $vbsContent, [System.Text.Encoding]::ASCII)
      Log '计划任务权限受限，已自动降级为当前用户专属启动项（登录自启，无需管理员权限）。'
    }
  } catch {
    Warn "写入启动项异常：$($_.Exception.Message)"
  }
  # 即时拉起后台常驻进程（无窗口静默运行）
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$startCmd`"" -WindowStyle Hidden
    Log '工蜂后台常驻进程已成功拉起。'
  } catch {
    Warn "拉起后台进程异常：$($_.Exception.Message)"
  }
}

# ---- 8. 回显已注册身份 ----
$handle = $null
if (Test-Path $TokenFile) {
  $lines = Get-Content $TokenFile
  if ($lines.Count -ge 2) { $handle = $lines[1] }
}
Write-Host ''
Write-Host '=========================================='
Write-Host '  ✅ 工蜂就绪（Hive 控制台已实时点亮）'
if ($handle) {
  Write-Host "  工蜂句柄：@$handle"
}
Write-Host "  Hive 服务器：$HiveUrl"
Write-Host "  源码目录：$AppDir"
Write-Host "  日志文件：$BeeHome\worker.log"
Write-Host '  执行内核：内置 Pi（自带 MinGit 与 Node 运行时；模型 Key 仅存本机）'
Write-Host '  常驻方式：Windows 计划任务 AsterHive worker（登录自启，taskschd.msc 可管理）'
Write-Host '=========================================='
