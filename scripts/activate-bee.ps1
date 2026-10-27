# AsterHive（星巢）托管工蜂（Bee）原生 PowerShell 激活与自启修复脚本 —— Windows
#
# 用途：
#   在已安装 AsterHive 工蜂的 Windows 设备上激活服务、校验身份凭据健康度、核对服务端心跳，
#   并在需要时以安全无害的方式修复本地登录自启动配置（计划任务 / 用户启动项）。
#
# 安全原则与防护边界：
#   1. 身份与凭据只读保全：只读读取既有 token、handle 及模型配置，严格遵循 CFG 优先级（环境变量 > worker.json > token.txt），
#      绝不重新发起注册，绝不修改、覆盖或替换既有凭据，绝不破坏既有模型配置与工作区数据；
#   2. 严格闭环验证（Fail Closed）：若本地身份凭据缺失、冲突不一致、服务端验证返回 401 或无效，立即阻断退出；
#   3. 远端身份与句柄确证：向 Hive /agents/me/profile 鉴权验证，严格比对远端 agentId 与本地有效 handle（@handle），
#      杜绝凭据错位与幽灵身份；全流程不将 token 暴露于命令行参数、系统进程列表或日志；
#   4. 真实预检心跳与基准对齐：在发起鉴权调用前预采样未经污染的心跳数据，真实诊断工蜂健康度；启动后记录基准点，杜绝自发请求伪造在线；
#   5. 最小化防重注册硬安全修补：对已安装的旧版工蜂源码，只更新确切已知的 401 与缺失 Token 自动注册语句为硬退出，
#      彻底阻断自动重注册通道，创建 .bak 备份且不触碰工作区与配置文件；对未知版本严格拒绝修补并阻断启动，绝不信任无实据的字符串标记；
#   6. 禁止跨 Hive 漂移：严格使用本地已绑定的 Hive 地址，禁止将现有身份凭据提交到不同 Hive 实例；
#   7. 进程防并发与不杀伤：若工蜂进程已在运行，绝不强制杀死，绝不重复拉起新进程；如实汇报心跳与状态；
#   8. 保全既有自启任务配置：确证计划任务归属后直接启动，绝不盲目重写覆盖用户自定义的高级任务属性；
#   9. 中文路径、编码与无 BOM 批处理安全：全链路使用 LiteralPath 与 UTF-8 规范，start-worker.cmd 使用无 BOM UTF-8 与 chcp 65001，
#      自启 VBS 包装器使用 Unicode 编码与 %COMSPEC% 显式调度，完美兼容包含空格与中文的 Windows 用户路径；
#  10. 严谨心跳轮询确证：启动后持续轮询进程存活与服务端真新心跳，杜绝过早中断或误报失败。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$InjectedHiveUrl = '__HIVE_URL_PLACEHOLDER__'
$BeeHome = if ($env:BEE_HOME) { $env:BEE_HOME } else { Join-Path $env:USERPROFILE '.asterhive-worker' }
$NodeDir = Join-Path $BeeHome 'node'
$GitDir  = Join-Path $BeeHome 'git'
$AppDir  = Join-Path $BeeHome 'app'
$ConfigDir = Join-Path $env:USERPROFILE '.asterhive'
$ConfigFile = Join-Path $ConfigDir 'worker.json'
$TokenFile = Join-Path $AppDir 'apps\worker-zcode\work\token.txt'
$WorkerMain = Join-Path $AppDir 'apps\worker-zcode\src\main.ts'
$StartCmd = Join-Path $BeeHome 'start-worker.cmd'
$LogFile = Join-Path $BeeHome 'worker.log'
$normBeeHome = [System.IO.Path]::GetFullPath($BeeHome)
$normAppDir = [System.IO.Path]::GetFullPath($AppDir)
$normWorkerMain = [System.IO.Path]::GetFullPath($WorkerMain)
$normStartCmd = [System.IO.Path]::GetFullPath($StartCmd)

function Test-IsTargetWorkerProcess([string]$procName, [string]$cmdLine) {
  if ([string]::IsNullOrWhiteSpace($cmdLine)) { return $false }
  if ($procName -eq 'node.exe') {
    if ($cmdLine -like "*$normWorkerMain*" -or $cmdLine -like "*$WorkerMain*") {
      return $true
    }
    if (($cmdLine -like "*$normAppDir*" -or $cmdLine -like "*$AppDir*") -and ($cmdLine -like "*worker-zcode*" -or $cmdLine -like "*main.ts*")) {
      return $true
    }
    return $false
  }
  if ($procName -eq 'cmd.exe') {
    if ($cmdLine -like "*$normStartCmd*" -or $cmdLine -like "*$StartCmd*") {
      return $true
    }
    if (($cmdLine -like "*$normBeeHome*" -or $cmdLine -like "*$BeeHome*") -and $cmdLine -like "*start-worker.cmd*") {
      return $true
    }
    return $false
  }
  return $false
}
function Read-VbsContentSafely([string]$filePath) {
  if (-not (Test-Path -LiteralPath $filePath)) { return $null }
  $bytes = [System.IO.File]::ReadAllBytes($filePath)
  if ($bytes.Length -eq 0) { return '' }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
  }
  if ($bytes.Length -ge 4 -and $bytes[1] -eq 0x00 -and $bytes[3] -eq 0x00) {
    return [System.Text.Encoding]::Unicode.GetString($bytes)
  }
  try {
    $utf8Text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($utf8Text -like "*start-worker.cmd*" -or $utf8Text -like "*asterhive*" -or $utf8Text -like "*Wscript*") {
      return $utf8Text
    }
  } catch {}
  return [System.Text.Encoding]::Default.GetString($bytes)
}

function Log($m)   { Write-Host "[bee-activate] $m" -ForegroundColor Cyan }
function Warn($m)  { Write-Host "[bee-activate] $m" -ForegroundColor Yellow }
function Die($m)   { Write-Host "[bee-activate] [错误] $m" -ForegroundColor Red; exit 1 }
function Block($m) { Write-Host "[bee-activate] [安全阻断] $m" -ForegroundColor Red; exit 2 }

Write-Host ''
Write-Host '=================================================='
Write-Host '  AsterHive 工蜂状态检测与本地服务激活 (Windows)  '
Write-Host '=================================================='

# ---- 1. 读取本地配置与身份凭据（Fail-Closed 校验与 CFG 优先级） ----
Log '读取本地工蜂配置与身份凭据…'

# 1.1 环境变量优先级最高（符合 worker 内部 CFG 优先级）
$envToken = if ($env:WORKER_TOKEN) { $env:WORKER_TOKEN.Trim() } else { $null }
$envHandle = if ($env:WORKER_HANDLE) { $env:WORKER_HANDLE.Trim() } else { $null }

# 1.2 读取 worker.json
$cfgToken = $null
$cfgHandle = $null
$cfgUrl = $null
$cfgExecutor = $null

if (Test-Path -LiteralPath $ConfigFile) {
  try {
    $rawConfig = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8
    $cfg = $rawConfig | ConvertFrom-Json
    if ($cfg.token) { $cfgToken = [string]$cfg.token }
    if ($cfg.handle) { $cfgHandle = [string]$cfg.handle }
    if ($cfg.url) { $cfgUrl = [string]$cfg.url }
    if ($cfg.executor) { $cfgExecutor = [string]$cfg.executor }
  } catch {
    Die "读取本地配置文件失败 ($ConfigFile)：$($_.Exception.Message)"
  }
}

# 1.3 读取 token.txt（强制数组强转，防止单行无换行文件退化为标量字符导致索引修剪崩溃）
$fileToken = $null
$fileHandle = $null
if (Test-Path -LiteralPath $TokenFile) {
  try {
    $lines = @(Get-Content -LiteralPath $TokenFile -Encoding UTF8)
    if ($lines.Length -ge 1 -and -not [string]::IsNullOrWhiteSpace($lines[0])) { $fileToken = $lines[0].Trim() }
    if ($lines.Length -ge 2 -and -not [string]::IsNullOrWhiteSpace($lines[1])) { $fileHandle = $lines[1].Trim() }
  } catch {
    Die "读取工蜂凭据文件失败 ($TokenFile)：$($_.Exception.Message)"
  }
}

# 1.4 凭据冲突闭环阻断
if ($cfgToken -and $fileToken -and ($cfgToken -ne $fileToken)) {
  Die "本地工蜂凭据冲突：worker.json 中的 Token 与 token.txt 中的 Token 不一致。`n身份归属不确定，激活脚本严格拒绝继续执行以防止凭据损坏。"
}

# 1.5 解析生效 Token（按 CFG 优先级：env -> worker.json -> token.txt）
$resolvedToken = if ($envToken) {
  $envToken
} elseif ($cfgToken) {
  $cfgToken
} elseif ($fileToken) {
  $fileToken
} else {
  $null
}

if (-not $resolvedToken) {
  Die "未检测到本地工蜂身份凭据（环境变量 WORKER_TOKEN、worker.json 与 token.txt 均无有效 Token）。`n激活脚本仅用于已有工蜂设备的激活与服务修复，严禁发起新注册。如需全新注册，请执行 install-bee.ps1。"
}

# 1.6 解析生效 Handle（按 CFG 优先级：env -> token.txt 注册实际 handle -> worker.json handle）
$resolvedHandle = if ($envHandle) {
  $envHandle
} elseif ($fileHandle) {
  $fileHandle
} elseif ($cfgHandle) {
  $cfgHandle
} else {
  $null
}

# ---- 2. 解析与验证 Hive 服务器地址（禁止变更已配置 URL） ----
$inputUrl = $null
if ($env:ASTERHIVE_URL) { $inputUrl = $env:ASTERHIVE_URL }
elseif ($args.Count -gt 0 -and $args[0]) { $inputUrl = [string]$args[0] }
elseif ($InjectedHiveUrl -and $InjectedHiveUrl -notlike '*PLACEHOLDER*') { $inputUrl = $InjectedHiveUrl }

$HiveUrl = $null
if ($cfgUrl) {
  if ($inputUrl -and ($inputUrl.TrimEnd('/') -ne $cfgUrl.TrimEnd('/'))) {
    Die "检测到本地 worker.json 已绑定 Hive 实例 ($cfgUrl)，但请求传入了不同地址 ($inputUrl)。`n为防止身份凭据错乱及向非目标 Hive 泄露 Token，激活脚本严禁跨 Hive 实例切换身份。请在原 Hive 实例激活或使用安装脚本重新配置。"
  }
  $HiveUrl = $cfgUrl
} else {
  $HiveUrl = $inputUrl
}

if (-not $HiveUrl) {
  Die "未能确定 Hive 服务器地址（worker.json 中未配置 url 且无环境变量/参数传入）。"
}
if ($HiveUrl -notmatch '^https?://') {
  Die "Hive 服务器地址格式不合法（必须以 http:// 或 https:// 开头）：$HiveUrl"
}

# ---- 3. 服务器连通性与未污染心跳预采样 ----
Log "连接 Hive 服务器健康检查端点 ($HiveUrl/health)…"
try {
  $null = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/health" -TimeoutSec 10
  Log "Hive 服务器健康检查通过：$HiveUrl"
} catch {
  Die "无法连接 Hive 服务器 ($HiveUrl/health)：$($_.Exception.Message)"
}

# 3.1 预采样公开工蜂列表（绝不带 Bearer 头，防止 authByToken 中间件刷新 last_seen_at 污染启动前真实心跳状态）
$preAuthAgentsList = @()
try {
  $preAgentsResp = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents" -TimeoutSec 10
  if ($preAgentsResp -and $preAgentsResp.agents) {
    $preAuthAgentsList = @($preAgentsResp.agents)
  }
} catch {
  Warn "获取全局工蜂列表异常（$($_.Exception.Message)），预检心跳将标记为未知。"
}

# 3.2 向 Hive 验证工蜂身份凭据（GET /agents/me/profile）
Log '向 Hive 验证工蜂身份凭据（GET /agents/me/profile）…'
$profile = $null
try {
  $profile = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents/me/profile" `
    -Headers @{ Authorization = "Bearer $resolvedToken" } -TimeoutSec 10
} catch {
  $statusCode = 0
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
    $statusCode = [int]$_.Exception.Response.StatusCode
  }
  if ($statusCode -eq 401 -or $_.Exception.Message -like "*401*") {
    Die "【凭据无效】Hive 服务器返回 401 Unauthorized。`n本地 Token 已在服务器失效或已被注销/吊销。`n为杜绝意外创建幽灵工蜂，激活脚本严格禁止发起自动重新注册，已安全阻断并退出。"
  }
  Die "向 Hive 验证工蜂身份凭据失败：$($_.Exception.Message)"
}

if (-not $profile -or -not $profile.agentId) {
  Die "Hive 返回的工蜂档案结构异常（缺少 agentId），身份无法确证。"
}
$profileAgentId = [string]$profile.agentId.ToString().Trim().TrimStart('@')

# 3.3 严格比对 Profile Agent ID 与本地有效 Handle（杜绝身份冒用或凭据错位）
if ($resolvedHandle) {
  $normResolvedHandle = $resolvedHandle.Trim().TrimStart('@')
  if ($normResolvedHandle -and ($profileAgentId -ne $normResolvedHandle)) {
    $normCfgHandle = if ($cfgHandle) { $cfgHandle.Trim().TrimStart('@') } else { $null }
    $normFileHandle = if ($fileHandle) { $fileHandle.Trim().TrimStart('@') } else { $null }
    if ($normCfgHandle -ne $profileAgentId -and $normFileHandle -ne $profileAgentId) {
      Die "【身份不匹配】Hive 服务器返回的工蜂身份 (Agent ID: '$profileAgentId') 与本地有效配置句柄 (@$normResolvedHandle) 不一致！`n为防止以错误身份启动工蜂导致权限错乱或污染看板，激活脚本严格拒绝继续执行。"
    }
    $resolvedHandle = $profileAgentId
  }
} else {
  $resolvedHandle = $profileAgentId
}
$agentId = $profileAgentId
Log "工蜂 Token 验证通过（Hive agentId: $agentId，handle 校验匹配）"

# ---- 4. 查询服务端真实心跳与工蜂档案（Truthful Heartbeat Verification） ----
Log '查询服务端当前记录的工蜂心跳与档案状态…'
$agentRecord = $null
if ($preAuthAgentsList.Length -gt 0) {
  $agentRecord = $preAuthAgentsList | Where-Object { $_.id -eq $agentId } | Select-Object -First 1
}
if (-not $agentRecord) {
  try {
    $agentsResp = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents" -TimeoutSec 10
    if ($agentsResp -and $agentsResp.agents) {
      $agentRecord = $agentsResp.agents | Where-Object { $_.id -eq $agentId } | Select-Object -First 1
    }
  } catch {}
}

$preAuthLastSeenAt = $null
$serverHeartbeatAgeSec = $null
$serverEnabled = $true
$remoteHandle = if ($resolvedHandle) { $resolvedHandle } else { $agentId }

if ($agentRecord) {
  if ($agentRecord.handle) { $remoteHandle = [string]$agentRecord.handle }
  if ($null -ne $agentRecord.enabled) { $serverEnabled = [bool]$agentRecord.enabled }
  if ($null -ne $agentRecord.lastSeenAt) {
    $preAuthLastSeenAt = [int64]$agentRecord.lastSeenAt
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $serverHeartbeatAgeSec = [math]::Round([math]::Max(0, ($nowMs - $preAuthLastSeenAt) / 1000))
  }
}

# ---- 5. 探查运行中进程（避免重复拉起，绝不杀伤现有进程） ----
Log '检查本地工蜂运行进程…'
$runningProcs = @()
try {
  $wmiProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $wmiProcs) {
    if ($p.CommandLine -and (Test-IsTargetWorkerProcess -procName 'node.exe' -cmdLine $p.CommandLine)) {
      $runningProcs += $p
    }
  }
  # 同时也检查以 cmd.exe 宿主挂载当前工蜂 start-worker.cmd 的进程
  $cmdProcs = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue
  foreach ($cp in $cmdProcs) {
    if ($cp.CommandLine -and (Test-IsTargetWorkerProcess -procName 'cmd.exe' -cmdLine $cp.CommandLine)) {
      if (-not ($runningProcs | Where-Object { $_.ProcessId -eq $cp.ProcessId })) {
        $runningProcs += $cp
      }
    }
  }
} catch {
  Warn "进程探测出现警告：$($_.Exception.Message)"
}

if ($runningProcs.Count -gt 0) {
  $pids = ($runningProcs | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Host ''
  Warn '------------------------------------------------------------------------'
  Warn "检测到工蜂进程已在运行中（PID: $pids）。"
  Warn '【重要安全提示】该工蜂处于活跃运行状态，将持续接收并执行看板指派的任务！'
  Warn '【进程安全策略】为防止多实例并发冲突与工作区竞争，激活脚本绝不终止现有进程，亦不重复启动新进程。'
  Warn '------------------------------------------------------------------------'
  Write-Host ''
  Write-Host '=========================================='
  Write-Host '  工蜂状态汇总（活跃运行中）'
  Write-Host "  工蜂句柄：@$remoteHandle"
  Write-Host "  Agent ID：$agentId"
  Write-Host "  Hive 实例：$HiveUrl"
  Write-Host "  运行进程：PID: $pids"
  Write-Host "  服务状态：已启用=$serverEnabled"
  if ($null -ne $serverHeartbeatAgeSec) {
    if ($serverHeartbeatAgeSec -le 60) {
      Write-Host "  服务端心跳：新鲜在线（最近心跳于 ${serverHeartbeatAgeSec} 秒前）" -ForegroundColor Green
    } else {
      Write-Host "  服务端心跳：延迟/停滞（最近心跳于 ${serverHeartbeatAgeSec} 秒前，超过 60 秒阈值）" -ForegroundColor Yellow
    }
  } else {
    Write-Host '  服务端心跳：无心跳记录或暂未上报' -ForegroundColor Yellow
  }
  Write-Host '=========================================='
  exit 0
}

# ---- 6. 工蜂未运行时的安全门禁：防重注册硬安全确证与最小化修补 ----
Log '工蜂当前未在运行，准备检查本地执行环境与防重注册硬安全护栏…'

if (-not (Test-Path -LiteralPath $WorkerMain)) {
  Die "未找到工蜂源码入口文件 ($WorkerMain)。安装目录可能损坏，拒绝启动。"
}

$mainContent = $null
try {
  $mainContent = [System.IO.File]::ReadAllText($WorkerMain, [System.Text.Encoding]::UTF8)
} catch {
  Die "读取工蜂源码入口文件 ($WorkerMain) 失败：$($_.Exception.Message)"
}

# 确证函数：必须有实际代码逻辑证明，绝不信任无实据的字符串标记；支持不可达的注册语句（跨脚本兼容）
function Test-WorkerMainGuarded([string]$content) {
  if (-not $content) { return $false }

  # 护栏确证 1：401 处理块必须硬退出或抛出异常，且绝不能在退出前包含 needRegister = true 或 CFG.token = undefined
  $pattern401Strict = 'if\s*\(\s*err\s+instanceof\s+SdkError\s*&&\s*err\.status\s*===\s*401\s*\)\s*\{([\s\S]*?)\}'
  if ($content -match $pattern401Strict) {
    $block401 = $Matches[1]
    $exitMatches401 = [regex]::Matches($block401, 'process\.exit\(|throw\s+')
    if ($exitMatches401.Count -eq 0) { return $false }
    $firstExit401 = $exitMatches401[0].Index

    $regSetMatches = [regex]::Matches($block401, 'needRegister\s*=|CFG\.token\s*=\s*undefined')
    if ($regSetMatches.Count -gt 0 -and $regSetMatches[0].Index -lt $firstExit401) {
      return $false
    }
  } else {
    return $false
  }

  # 护栏确证 2：缺失 Token / needRegister 块必须硬退出；若含 registerWithRetry 必须在硬阻断之后（不可达死代码）或已被移除
  $patternNeedRegStrict = 'if\s*\(\s*needRegister\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{'
  if ($content -match $patternNeedRegStrict) {
    $blockNeedReg = $Matches[1]
    $exitMatchesNeedReg = [regex]::Matches($blockNeedReg, 'process\.exit\(|throw\s+')
    if ($exitMatchesNeedReg.Count -eq 0) { return $false }
    $firstExitNeedReg = $exitMatchesNeedReg[0].Index

    $regMatches = [regex]::Matches($blockNeedReg, 'registerWithRetry')
    if ($regMatches.Count -gt 0 -and $regMatches[0].Index -lt $firstExitNeedReg) {
      return $false
    }
  } else {
    return $false
  }

  return $true
}

$isGuarded = Test-WorkerMainGuarded -content $mainContent

if ($isGuarded) {
  Log '工蜂源码已具备防重注册安全硬护栏确证（401 与缺失 Token 均硬阻断，严禁自动注册）。'
} else {
  # 比较实际源码当前状态，匹配已知待修补版本的精确语法特征
  $patternKnown401 = 'if\s*\(\s*err\s+instanceof\s+SdkError\s*&&\s*err\.status\s*===\s*401\s*\)\s*\{[\s\S]*?needRegister\s*=\s*true;[\s\S]*?CFG\.token\s*=\s*undefined;[\s\S]*?\}'
  $patternKnownNeedReg = 'if\s*\(\s*needRegister\s*\)\s*\{[\s\S]*?registerWithRetry[\s\S]*?\}\s*else\s*\{'

  $isKnownUnpatched = ($mainContent -match $patternKnown401 -and $mainContent -match $patternKnownNeedReg)

  if ($isKnownUnpatched) {
    Log '检测到已安装工蜂为已知待修补版本（401 或缺失 Token 会自动发起新注册并改写本地 token.txt）。'
    Log '用户已授权：执行最小化防重注册安全硬修补（不升级全量代码，不修改 worker.json，保全工作区）…'

    # 1. 备份原始文件
    $backupFile = "$WorkerMain.bak"
    if (-not (Test-Path -LiteralPath $backupFile)) {
      try {
        Copy-Item -LiteralPath $WorkerMain -Destination $backupFile -Force
        Log "已备份原始工蜂代码至 $backupFile"
      } catch {
        Die "创建备份文件失败 ($backupFile)：$($_.Exception.Message)"
      }
    }

    # 2. 最小化语句级精准替换（只替换已知两处自动重注册语句）
    $replacement401 = "if (err instanceof SdkError && err.status === 401) {`r`n" +
      "        log('【安全阻断】检测到既有 Token 在当前服务器已失效（401 Unauthorized）。根据防重注册硬安全规范，严禁自动重新注册。工蜂立即退出。');`r`n" +
      "        process.exit(1);`r`n" +
      "      }"
    $replacementNeedReg = "if (needRegister) {`r`n" +
      "    log('【安全阻断】未检测到有效工蜂 Token。根据防重注册硬安全规范，严禁发起自动注册。工蜂立即退出。');`r`n" +
      "    process.exit(1);`r`n" +
      "  } else {"

    $patchedContent = [System.Text.RegularExpressions.Regex]::Replace($mainContent, $patternKnown401, $replacement401)
    $patchedContent = [System.Text.RegularExpressions.Regex]::Replace($patchedContent, $patternKnownNeedReg, $replacementNeedReg)

    # 3. 写入临时文件并通过确证校验
    $tempFile = "$WorkerMain.tmp.$([System.Guid]::NewGuid().ToString('N'))"
    try {
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($tempFile, $patchedContent, $utf8NoBom)
      $writtenContent = [System.IO.File]::ReadAllText($tempFile, [System.Text.Encoding]::UTF8)

      if (-not (Test-WorkerMainGuarded -content $writtenContent)) {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        Die "安全补丁应用后未能通过防重注册硬护栏确证，已安全丢弃临时修改。"
      }

      # 4. 原子替换
      Move-Item -LiteralPath $tempFile -Destination $WorkerMain -Force
      Log "防重注册安全硬补丁已成功应用（原子替换完成，已确证 401 与缺失 Token 硬阻断）。"
    } catch {
      if (Test-Path -LiteralPath $tempFile) {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
      }
      Die "应用防重注册安全补丁失败：$($_.Exception.Message)"
    }
  } else {
    # 既非受确证版本，亦非已知待修补版本：未知或已被第三方修改的代码，Fail-Closed 闭环阻断
    Write-Host ''
    Block '========================================================================'
    Block '【安全阻断】工蜂源码结构与已知版本不符，且未通过防重注册安全硬护栏确证：'
    Block "源码入口：$WorkerMain"
    Block '当前设备上已安装的工蜂源码结构已被自定义修改或版本未知，无法安全应用最小化补丁。'
    Block '依据安全规范，激活脚本坚决拒绝拉起缺乏防重注册硬保障或无法确证的工蜂进程。'
    Block ''
    Block '安全现状核实：'
    Block "  1. 本地身份凭据安全完好：Token 及配置已完整保留于 $ConfigFile 与 $TokenFile，未被修改；"
    Block "  2. 服务端 Token 状态：通过预检（Agent ID: $agentId, @$remoteHandle）；"
    Block '  3. 阻断原因：工蜂入口代码特征不匹配，拒绝盲目覆盖或修改。'
    Block '========================================================================'
    exit 2
  }
}

# ---- 7. 检查与确证本地自启服务归属与持久化启动器 ----
Log '检查本地自启服务配置与归属…'

# 7.1 定位 Node 执行环境（在生成启动脚本前确证，杜绝生成空可执行路径）
$NodeExe = 'node'
if (Test-Path -LiteralPath (Join-Path $NodeDir 'node.exe')) {
  $NodeExe = Join-Path $NodeDir 'node.exe'
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $NodeExe = (Get-Command node).Source
} else {
  Die "未找到 Node.exe 运行环境（无论是便携版 $NodeDir 还是系统 PATH），无法激活服务。"
}

$scheduledTaskName = 'AsterHive worker'
$existingTask = $null
try {
  $existingTask = Get-ScheduledTask -TaskName $scheduledTaskName -ErrorAction SilentlyContinue
} catch {}

$taskOwnershipVerified = $false
if ($existingTask) {
  $action = $existingTask.Actions | Select-Object -First 1
  $execCommand = "$($action.Execute) $($action.Arguments)"
  $normalizedStartCmd = [System.IO.Path]::GetFullPath($StartCmd)
  $normalizedBeeHome = [System.IO.Path]::GetFullPath($BeeHome)
  if ($execCommand -like "*$StartCmd*" -or $execCommand -like "*$normalizedStartCmd*" -or $execCommand -like "*$BeeHome*" -or $execCommand -like "*$normalizedBeeHome*") {
    $taskOwnershipVerified = $true
    Log "已存在计划任务 '$scheduledTaskName'，且执行路径确证严格指向本工蜂目录（保留既有计划任务高级配置、触发器与运行用户）。"
  } else {
    Die "计划任务 '$scheduledTaskName' 执行目标 ($execCommand) 未指向本工蜂启动器 ($StartCmd)。归属不匹配，激活脚本拒绝操作非本工蜂的计划任务。"
  }
}

# 验证并保全 start-worker.cmd
$normalizedAppDir = [System.IO.Path]::GetFullPath($AppDir)
$normalizedWorkerMain = [System.IO.Path]::GetFullPath($WorkerMain)

if (Test-Path -LiteralPath $StartCmd) {
  $cmdRaw = Get-Content -LiteralPath $StartCmd -Raw -ErrorAction SilentlyContinue
  if ($cmdRaw -notlike "*$AppDir*" -and $cmdRaw -notlike "*$normalizedAppDir*" -and $cmdRaw -notlike "*worker-zcode*") {
    Die "启动脚本 $StartCmd 存在但内容未指向当前工蜂应用目录，所有权不确定，拒绝执行。"
  }

  $hasGuardInCmd = ($cmdRaw -match 'ASTERHIVE_NO_REGISTER=1' -or $cmdRaw -match 'WORKER_NO_REGISTER=1')
  if ($hasGuardInCmd) {
    Log "启动脚本 $StartCmd 已包含防重注册环境变量锁定，保留既有配置与自定义参数。"
  } else {
    # 严格识别已知默认启动脚本模板；若包含用户自定义指令/环境变量，绝对不覆盖（Fail-Closed）
    $cmdLines = @($cmdRaw -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $isKnownGenerated = $true
    $preservedPathLine = $null

    foreach ($line in $cmdLines) {
      if ($line -eq '@echo off' -or $line -eq 'chcp 65001 >nul') { continue }
      if ($line -match '^set\s+["'']?PATH=') {
        $preservedPathLine = $line
        continue
      }
      if ($line -match '^cd\s+/d\s+') {
        if ($line -like "*$AppDir*" -or $line -like "*$normalizedAppDir*") { continue }
        $isKnownGenerated = $false; break
      }
      if ($line -match '--experimental-strip-types') {
        if ($line -like "*$WorkerMain*" -or $line -like "*$normalizedWorkerMain*" -or $line -like "*main.ts*") { continue }
        $isKnownGenerated = $false; break
      }
      $isKnownGenerated = $false
      break
    }

    if ($isKnownGenerated) {
      Log "检测到启动脚本 $StartCmd 为已知标准模板，安全注入防重注册环境变量锁与 UTF-8 编码设置（无 BOM）…"
      $pathPrefix = if ($preservedPathLine) { "$preservedPathLine`r`n" } else {
        $nodeBinDir = Split-Path $NodeExe
        $GitCmdDir = Join-Path $GitDir 'cmd'
        $extraDirs = @($nodeBinDir, $GitCmdDir) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
        if ($extraDirs.Count -gt 0) { "set `"PATH=$($extraDirs -join ';');%PATH%`"`r`n" } else { "" }
      }
      $cmdContent = "@echo off`r`n" +
        "chcp 65001 >nul`r`n" +
        "$pathPrefix" +
        "set `"ASTERHIVE_NO_REGISTER=1`"`r`n" +
        "set `"WORKER_NO_REGISTER=1`"`r`n" +
        "cd /d `"$AppDir`"`r`n" +
        "`"$NodeExe`" --experimental-strip-types `"$WorkerMain`" >> `"$LogFile`" 2>&1`r`n"
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($StartCmd, $cmdContent, $utf8NoBom)
    } else {
      Write-Host ''
      Block '========================================================================'
      Block "【安全阻断】启动脚本 $StartCmd 包含用户自定义或未识别的配置（环境变量/自定义启动参数）。"
      Block '依据安全原则，激活脚本绝不盲目覆盖或抹除用户的定制化环境配置（Fail-Closed）。'
      Block ''
      Block "处理建议：请在 $StartCmd 中手动添加如下防重注册环境变量锁定后重新运行激活："
      Block '  set "ASTERHIVE_NO_REGISTER=1"'
      Block '  set "WORKER_NO_REGISTER=1"'
      Block '========================================================================'
      exit 2
    }
  }
} else {
  # 启动脚本不存在时，受控生成标准常驻启动脚本（无 BOM UTF-8）
  Log "生成常驻启动脚本 $StartCmd（注入防重注册持久化环境变量与中文路径 UTF-8 编码锁定）…"
  $nodeBinDir = Split-Path $NodeExe
  $GitCmdDir = Join-Path $GitDir 'cmd'
  $extraDirs = @($nodeBinDir, $GitCmdDir) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $pathPrefix = if ($extraDirs.Count -gt 0) { "set `"PATH=$($extraDirs -join ';');%PATH%`"`r`n" } else { "" }
  $cmdContent = "@echo off`r`n" +
    "chcp 65001 >nul`r`n" +
    "$pathPrefix" +
    "set `"ASTERHIVE_NO_REGISTER=1`"`r`n" +
    "set `"WORKER_NO_REGISTER=1`"`r`n" +
    "cd /d `"$AppDir`"`r`n" +
    "`"$NodeExe`" --experimental-strip-types `"$WorkerMain`" >> `"$LogFile`" 2>&1`r`n"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($StartCmd, $cmdContent, $utf8NoBom)
}



# ---- 8. 捕获启动前心跳基准点并安全激活服务 ----
# 记录鉴权调用完成后的基准心跳点，确保 Step 9 轮询仅核认由本工蜂进程自身上报的真新心跳
$baselineLastSeenAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
  $postAuthResp = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents" -TimeoutSec 10
  if ($postAuthResp -and $postAuthResp.agents) {
    $currAgent = $postAuthResp.agents | Where-Object { $_.id -eq $agentId } | Select-Object -First 1
    if ($currAgent -and $null -ne $currAgent.lastSeenAt) {
      $baselineLastSeenAt = [int64]$currAgent.lastSeenAt
    }
  }
} catch {}

$activatedVia = $null
if ($existingTask -and $taskOwnershipVerified) {
  Log "通过计划任务 '$scheduledTaskName' 启动工蜂服务（保留用户自定义高级配置）…"
  try {
    Start-ScheduledTask -TaskName $scheduledTaskName -ErrorAction Stop
    $activatedVia = "计划任务 ($scheduledTaskName)"
  } catch {
    Warn "启动计划任务失败 ($($_.Exception.Message))，尝试备用启动方式…"
  }
}

if (-not $activatedVia) {
  # 降级尝试当前用户 Startup 目录（使用 Unicode 编码与 %COMSPEC% 显式调度；若已存在则绝对不覆盖）
  $startupDir = [Environment]::GetFolderPath('Startup')
  if ($startupDir -and (Test-Path -LiteralPath $startupDir)) {
    $vbsFile = Join-Path $startupDir 'AsterHive-worker.vbs'
    $normalizedStartCmd = [System.IO.Path]::GetFullPath($StartCmd)
    $normalizedBeeHome = [System.IO.Path]::GetFullPath($BeeHome)

    if (Test-Path -LiteralPath $vbsFile) {
      $existingVbs = Read-VbsContentSafely -filePath $vbsFile
      if ($existingVbs -and ($existingVbs -like "*$StartCmd*" -or $existingVbs -like "*$normalizedStartCmd*" -or $existingVbs -like "*$BeeHome*" -or $existingVbs -like "*$normalizedBeeHome*")) {
        Log "已存在当前用户自启脚本 ($vbsFile)，且确证指向本工蜂启动器。保留既有配置，绝不覆盖。"
      } else {
        Die "用户自启动目录中已存在非本工蜂的脚本 ($vbsFile)。归属不确定，为防止覆盖他人配置，激活脚本拒绝覆盖该启动项。"
      }
    } else {
      # 仅在文件不存在时安全创建
      $comspec = if ($env:COMSPEC) { $env:COMSPEC } else { 'cmd.exe' }
      $escapedComspec = $comspec.Replace('"', '""')
      $escapedCmd = $StartCmd.Replace('"', '""')
      $vbsContent = 'CreateObject("Wscript.Shell").Run """' + $escapedComspec + '"" /c """ & "' + $escapedCmd + '" & """", 0, False'
      [System.IO.File]::WriteAllText($vbsFile, $vbsContent, [System.Text.Encoding]::Unicode)
      Log "已配置当前用户登录自启脚本 ($vbsFile)。"
    }
  }
  Log "拉起后台守护进程：$StartCmd"
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$StartCmd`"" -WindowStyle Hidden
    $activatedVia = "后台独立进程 (cmd.exe - $StartCmd)"
  } catch {
    Die "启动后台进程失败：$($_.Exception.Message)"
  }
}

# ---- 9. 启动后真实状态与心跳确认（Truthful Heartbeat Verification） ----
Log '等待服务启动并向 Hive 服务器确证真实心跳…'
$freshHeartbeat = $false
$postRunningProcs = @()
$finalSeenAgeSec = $null

for ($attempt = 1; $attempt -le 5; $attempt++) {
  Start-Sleep -Seconds 3

  # 1. 检测本地进程（严格限定为本工蜂 target worker 代码与启动脚本，绝不误匹其他无关 node/main.ts 进程）
  $postRunningProcs = @()
  try {
    $wmiProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $wmiProcs) {
      if ($p.CommandLine -and (Test-IsTargetWorkerProcess -procName 'node.exe' -cmdLine $p.CommandLine)) {
        $postRunningProcs += $p
      }
    }
    $cmdProcs = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue
    foreach ($cp in $cmdProcs) {
      if ($cp.CommandLine -and (Test-IsTargetWorkerProcess -procName 'cmd.exe' -cmdLine $cp.CommandLine)) {
        if (-not ($postRunningProcs | Where-Object { $_.ProcessId -eq $cp.ProcessId })) {
          $postRunningProcs += $cp
        }
      }
    }
  } catch {}

  # 2. 查询远端新心跳（严格与启动前 baselineLastSeenAt 对比，杜绝预检鉴权调用伪造的假在线）
  try {
    $agentsResp = Invoke-RestMethod -Uri "$($HiveUrl.TrimEnd('/'))/agents" -TimeoutSec 10
    if ($agentsResp -and $agentsResp.agents) {
      $currentRecord = $agentsResp.agents | Where-Object { $_.id -eq $agentId } | Select-Object -First 1
      if ($currentRecord -and $null -ne $currentRecord.lastSeenAt) {
        $currentSeen = [int64]$currentRecord.lastSeenAt
        if ($currentSeen -gt $baselineLastSeenAt) {
          $freshHeartbeat = $true
          $finalSeenAgeSec = [math]::Round([math]::Max(0, ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $currentSeen) / 1000))
        }
      }
    }
  } catch {}

  # 只有在本地进程确证常驻且远端已观察到新心跳时，才提前完成确认
  if ($postRunningProcs.Count -gt 0 -and $freshHeartbeat) {
    break
  }
}

$isOnlineNow = $postRunningProcs.Count -gt 0
$activePids = if ($isOnlineNow) { ($postRunningProcs | ForEach-Object { $_.ProcessId }) -join ', ' } else { '无' }

Write-Host ''
Write-Host '=========================================='
if ($isOnlineNow -and $freshHeartbeat) {
  Write-Host '  ✅ 工蜂本地服务已成功激活并在服务端确证在线' -ForegroundColor Green
} elseif ($isOnlineNow) {
  Write-Host '  ⚠️ 工蜂本地服务已启动并常驻，但尚未在服务端观察到新心跳（请检查日志）' -ForegroundColor Yellow
} else {
  Write-Host '  ❌ 工蜂本地服务已触发激活，但进程未常驻（请检查日志）' -ForegroundColor Red
}
Write-Host "  工蜂句柄：@$remoteHandle"
Write-Host "  Agent ID：$agentId"
Write-Host "  Hive 服务器：$HiveUrl"
Write-Host "  激活方式：$activatedVia"
Write-Host "  进程 PID：$activePids"
Write-Host "  日志路径：$LogFile"
Write-Host "  服务端状态：已启用=$serverEnabled"
if ($freshHeartbeat) {
  Write-Host "  服务端最新心跳：✅ 刚收到新心跳（${finalSeenAgeSec} 秒前，确证在线）" -ForegroundColor Green
} elseif ($null -ne $serverHeartbeatAgeSec) {
  Write-Host "  启动前最新心跳：${serverHeartbeatAgeSec} 秒前（等待新心跳上报）" -ForegroundColor Yellow
} else {
  Write-Host '  服务端心跳：暂无心跳记录' -ForegroundColor Yellow
}
Write-Host '=========================================='
if (-not $isOnlineNow) {
  exit 1
}
