# media-player · 独立验收脚本（退出码 0/1）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/acceptance.ps1
#   npm run accept
#
# 覆盖口径（需求专篇 = 验收标准的唯一权威）：
#   A. §7 验收清单 16 条 —— 逐条落地，标题里带 [§7-n]
#   B. 需求编号 28 条（MDP-CHN 5 / PLY 6 / MUL 5 / OVL 5 / DGR 4 / NFR 3）
#      —— 每条断言在打印时带 [MDP-XXX-nn]，末尾给"编号 → 判定"覆盖矩阵
#   C. 结构守卫（可机检）：业务名词零命中 / 跨仓 import 零命中（含动态 import）/ 具体通道名与
#      素材 URL 零命中 / 媒体格式白名单 / 演示数值零硬编码 / 零外网 / 零运行时依赖 / 分层
#   D. 构建与自测：typecheck（模块 + 示例 + 探针）→ lib → d.ts → 示例页 → 探针页；
#      node tests/unit-test.mjs --json（零依赖、零框架、注入假时钟，并导出机检证据）
#   E. 运行态：素材解码、6 路真播与故障隔离、示例页、运行态探针（headless）、
#      交互式探针（有头 + CDP 真实用户手势：全屏 / 帧率 / 拖动定位）
#
# 判定纪律：
#   · 断言只读两类可信来源 —— 结构守卫的检索结果，与机器可读输出
#     （自测 EVIDENCE JSON、探针读数 JSON）；MUST NOT 靠猜中文用例名。
#   · SKIP 只用于"当前环境物理上做不到"的项（无浏览器 / 无可测量图形界面），
#     且必须在总结里逐条列出，不冒充 PASS。
#   · 本文件以 UTF-8 BOM 保存 —— Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按
#     ANSI 解码，中文会乱码并引发语法错误。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:failed = 0
$script:passed = 0
$script:skipped = 0
$script:skipList = New-Object System.Collections.ArrayList
# 需求编号 → 判定（FAIL 优先于 PASS；未覆盖单列）
$script:reqVerdict = @{}
$script:reqIds = @(
  'MDP-CHN-01', 'MDP-CHN-02', 'MDP-CHN-03', 'MDP-CHN-04', 'MDP-CHN-05',
  'MDP-PLY-01', 'MDP-PLY-02', 'MDP-PLY-03', 'MDP-PLY-04', 'MDP-PLY-05', 'MDP-PLY-06',
  'MDP-MUL-01', 'MDP-MUL-02', 'MDP-MUL-03', 'MDP-MUL-04', 'MDP-MUL-05',
  'MDP-OVL-01', 'MDP-OVL-02', 'MDP-OVL-03', 'MDP-OVL-04', 'MDP-OVL-05',
  'MDP-DGR-01', 'MDP-DGR-02', 'MDP-DGR-03', 'MDP-DGR-04',
  'MDP-NFR-01', 'MDP-NFR-02', 'MDP-NFR-03'
)
foreach ($id in $script:reqIds) { $script:reqVerdict[$id] = 'UNCOVERED' }

function Section([string]$title) {
  Write-Host ''
  Write-Host ('-- ' + $title + ' ' + ('-' * [Math]::Max(0, 58 - $title.Length))) -ForegroundColor Cyan
}

# 记录需求编号判定：FAIL 不可被 PASS 覆盖
function Mark([string]$id, [bool]$ok) {
  if (-not $script:reqVerdict.ContainsKey($id)) { return }
  if (-not $ok) { $script:reqVerdict[$id] = 'FAIL'; return }
  if ($script:reqVerdict[$id] -eq 'FAIL') { return }
  $script:reqVerdict[$id] = 'PASS'
}

function Pass([string]$name, [string]$detail = '') {
  $script:passed++
  if ($detail) { Write-Host ('  [PASS] ' + $name + '  ' + $detail) -ForegroundColor Green }
  else { Write-Host ('  [PASS] ' + $name) -ForegroundColor Green }
}

function Fail([string]$name, [string]$detail = '') {
  $script:failed++
  if ($detail) { Write-Host ('  [FAIL] ' + $name + '  ' + $detail) -ForegroundColor Red }
  else { Write-Host ('  [FAIL] ' + $name) -ForegroundColor Red }
}

function Skip([string]$name, [string]$detail = '') {
  $script:skipped++
  [void]$script:skipList.Add(($name + $(if ($detail) { ' —— ' + $detail } else { '' })))
  if ($detail) { Write-Host ('  [SKIP] ' + $name + '  ' + $detail) -ForegroundColor Yellow }
  else { Write-Host ('  [SKIP] ' + $name) -ForegroundColor Yellow }
}

# 一条断言：name 里带 [§7-n] / [MDP-XXX-nn] 标记，据此回填覆盖矩阵
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Pass $name $detail } else { Fail $name $detail }
  foreach ($m in [regex]::Matches($name, 'MDP-(CHN|PLY|MUL|OVL|DGR|NFR)-\d{2}')) {
    Mark $m.Value $ok
  }
  # 不返回值：PowerShell 会把未消费的返回值（True/False）打到 stdout，污染验收日志
}

function Run([string]$exe, [string[]]$exeArgs, [string]$name) {
  Write-Host ('  > ' + $exe + ' ' + ($exeArgs -join ' ')) -ForegroundColor DarkGray
  $out = & $exe @exeArgs 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $out) { Write-Host ('    ' + $line) -ForegroundColor DarkGray }
  if ($code -eq 0) { Pass $name } else { Fail $name ('退出码 ' + $code) }
  return $code
}

# 跑一个 node 脚本并取回全部输出
function RunCapture([string]$exe, [string[]]$exeArgs) {
  Write-Host ('  > ' + $exe + ' ' + ($exeArgs -join ' ')) -ForegroundColor DarkGray
  $out = & $exe @exeArgs 2>&1
  $code = $LASTEXITCODE
  $text = ($out | Out-String)
  foreach ($line in $out) { Write-Host ('    ' + $line) -ForegroundColor DarkGray }
  return @{ code = $code; text = $text }
}

# 读探针写出的 JSON 报告文件（缺失/损坏回 null，判定自然失败）
function ReadJsonFile([string]$path) {
  if ([string]::IsNullOrEmpty($path)) { return $null }
  if (-not (Test-Path $path)) { return $null }
  try { return (Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json) } catch { return $null }
}

# 从一段输出里取"标记后的整行 JSON"（仅作文件缺失时的兜底）
function LiftJson([string]$text, [string]$marker) {
  if ([string]::IsNullOrEmpty($text)) { return $null }
  $m = [regex]::Match($text, $marker + '\s*(\{.*\})')
  if (-not $m.Success) { return $null }
  try { return ($m.Groups[1].Value | ConvertFrom-Json) } catch { return $null }
}

# ==================================================================
# 扫描范围（红线与结构守卫）
# ==================================================================
$scanFiles = @(Get-ChildItem -Recurse -File -Include *.ts, *.tsx, *.mjs, *.js -Path src, scripts, tests, examples, demo -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules' -and $_.FullName -notmatch '\\build\\' -and $_.FullName -notmatch '\\dist\\' })
$srcFiles = @($scanFiles | Where-Object { $_.FullName -match '\\src\\' })
$moduleFiles = @($scanFiles | Where-Object { $_.FullName -notmatch '\\tests\\' -and $_.FullName -notmatch '\\examples\\' -and $_.FullName -notmatch '\\demo\\' })

Write-Host ''
Write-Host 'media-player - 验收（独立、零外网、退出码 0/1）' -ForegroundColor White
Write-Host ('仓库：' + $root)
Write-Host ('扫描：' + $scanFiles.Count + ' 个源码文件（模块 ' + $moduleFiles.Count + ' / 全仓 ' + $scanFiles.Count + '）')
Write-Host '条款：需求专篇 §7 验收清单 16 条 + 需求编号 28 条'

$quote = [char]34

# ==================================================================
Section '1. 结构守卫：零业务耦合与零硬编码（§7-4、§7-15）'
# ==================================================================

$crossPattern = ("from\s+['" + $quote + "](@mapapp/)?(map-2d|ws-client|realtime-hub|device-ingest|telemetry-store|phase-engine|geo-data|entity-ledger|scoring|topology|report-engine|resource-alloc|alert-engine|llm-provider|assembly-host|view-composer)")
$crossImports = @($scanFiles | Select-String -Pattern $crossPattern -ErrorAction SilentlyContinue)
$crossDetail = ''
if ($crossImports.Count -gt 0) {
  $crossDetail = (($crossImports | Select-Object -First 3 | ForEach-Object { $_.Filename + ':' + $_.LineNumber }) -join ', ')
}
Check '[§7-15][MDP-NFR-02] 跨仓静态 import 零命中（map-2d / ws-client / 其它引擎）' ($crossImports.Count -eq 0) $crossDetail

$dynPattern = "(import|require)\s*\(\s*['" + $quote + "](@mapapp/)?(map-2d|ws-client)"
$crossDynamic = @($scanFiles | Select-String -Pattern $dynPattern -ErrorAction SilentlyContinue)
Check '[MDP-NFR-02] 跨仓动态 import / require 零命中' ($crossDynamic.Count -eq 0) (($crossDynamic | Select-Object -First 3 | ForEach-Object { $_.Filename + ':' + $_.LineNumber }) -join ', ')

$bizWords = @('任务', '方案', '目标', '场景', '阶段', '编组', '评估', '威胁', '毁伤', '集群')
$bizHits = @()
foreach ($f in $scanFiles) {
  $lines = @(Get-Content -Encoding UTF8 $f.FullName)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $trimmed = $line.TrimStart()
    if ($trimmed.StartsWith('//') -or $trimmed.StartsWith('*') -or $trimmed.StartsWith('/*')) { continue }
    foreach ($w in $bizWords) {
      if (($line.Contains("'" + $w)) -or ($line.Contains($quote + $w)) -or ($line -match ('[A-Za-z_]' + $w))) {
        $bizHits += ($f.Name + ':' + ($i + 1))
        break
      }
    }
  }
}
Check '[§7-15][MDP-NFR-02] 业务词零命中（任务/方案/目标/场景/阶段/编组/评估/威胁/毁伤/集群）' ($bizHits.Count -eq 0) (($bizHits | Select-Object -First 5) -join ', ')

# 通道名/来源枚举：模块源码内零硬编码（说明性注释不计）
$channelNamePattern = '光电|雷达|电子|集群|通道\s*[0-9]'
$nameHits = @()
foreach ($f in $srcFiles) {
  $hit = @(Select-String -Path $f.FullName -Pattern $channelNamePattern -ErrorAction SilentlyContinue)
  foreach ($h in $hit) {
    $line = $h.Line.TrimStart()
    if ($line.StartsWith('//') -or $line.StartsWith('*')) { continue }
    $nameHits += ($f.Name + ':' + $h.LineNumber)
  }
}
Check '[§7-4][MDP-CHN-02] 具体通道名/来源枚举零硬编码（模块源码）' ($nameHits.Count -eq 0) (($nameHits | Select-Object -First 3) -join ', ')

# 素材路径/文件名：模块源码内零硬编码
$mediaLiteralHits = @()
foreach ($f in $srcFiles) {
  # 只认"字面量用法"：以引号包裹的具体素材路径/文件名（注释里的名词不算硬编码）
  $hit = @(Select-String -Path $f.FullName -Pattern '[''"](/media/|[^''"\s]*\.(mp4|png|jpe?g|gif|webm))[''"]' -ErrorAction SilentlyContinue)
  foreach ($h in $hit) {
    $line = $h.Line.TrimStart()
    if ($line.StartsWith('//') -or $line.StartsWith('*')) { continue }
    $mediaLiteralHits += ($f.Name + ':' + $h.LineNumber)
  }
}
Check '[§7-4][MDP-CHN-02] 模块源码内零素材路径/文件名（引号包裹的 /media/、*.mp4、*.png …）' ($mediaLiteralHits.Count -eq 0) (($mediaLiteralHits | Select-Object -First 5) -join ', ')

# 媒体格式白名单：本期只支持 mp4（video）与 jpg/png（image-seq），其余格式出现即越界
$formatHits = @()
foreach ($f in $srcFiles) {
  $hit = @(Select-String -Path $f.FullName -Pattern '\.(avi|mkv|mov|flv|wmv|rmvb|m3u8|rtsp|rtmp|gb28181)\b' -ErrorAction SilentlyContinue)
  foreach ($h in $hit) {
    $line = $h.Line.TrimStart()
    if ($line.StartsWith('//') -or $line.StartsWith('*')) { continue }
    $formatHits += ($f.Name + ':' + $h.LineNumber)
  }
}
Check '[MDP-CHN-01] 媒体格式白名单：模块源码只出现 mp4/jpg/png 等本期格式' ($formatHits.Count -eq 0) (($formatHits | Select-Object -First 5) -join ', ')

# 演示数值零硬编码（成组演示数据不得进模块源码）
$demoValueHits = @()
foreach ($f in $srcFiles) {
  $hit = @(Select-String -Path $f.FullName -Pattern '(sample[-_]?\d|demo[-_]?\d|channel[-_]?[1-9]\b|test[-_]?channel|lorem)' -ErrorAction SilentlyContinue)
  foreach ($h in $hit) {
    $line = $h.Line.TrimStart()
    if ($line.StartsWith('//') -or $line.StartsWith('*')) { continue }
    $demoValueHits += ($f.Name + ':' + $h.LineNumber)
  }
}
Check '[§7-4][MDP-CHN-02] 演示数值/演示通道名零硬编码（sample-N、demo-N、channel-N …）' ($demoValueHits.Count -eq 0) (($demoValueHits | Select-Object -First 5) -join ', ')

# 零外网：源码内无外域地址（仅允许本机与 XML 命名空间）
$allowedHosts = @('localhost', '127.0.0.1', 'www.w3.org', 'example.com', 'schemas')
$urlHits = @()
foreach ($f in $scanFiles) {
  $lines = @(Get-Content -Encoding UTF8 $f.FullName)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch 'https?://') { continue }
    $allowed = $false
    foreach ($h in $allowedHosts) { if ($lines[$i].Contains($h)) { $allowed = $true } }
    if (-not $allowed) { $urlHits += ($f.Name + ':' + ($i + 1)) }
  }
}
Check '[§7-16][MDP-NFR-02] 源码内零外域地址（零外网）' ($urlHits.Count -eq 0) (($urlHits | Select-Object -First 5) -join ', ')

# 示例页构建产物内亦无外域**请求目标**（CDN / 字体 / 图片 / fetch），断网可用。
# 说明：只查"会被浏览器主动请求的外链"（src/href 指向外域，或 fetch/XHR 传外域），
# 不把 React 错误解码说明串这类**仅出现在报错文案里的** URL 当外链（它不会产生请求）。
$demoBundleHits = @()
$demoBundleFiles = @(Get-ChildItem -Recurse -File -Path build\demo -Include *.html, *.js -ErrorAction SilentlyContinue)
foreach ($f in $demoBundleFiles) {
  foreach ($line in @(Get-Content -Encoding UTF8 $f.FullName)) {
    $isRequestNode = ($line -match '(src|href)\s*[:=]\s*[''"]https?://') -or
      ($line -match '(fetch|XMLHttpRequest|importScripts|EventSource|WebSocket)\s*\(?\s*[''"]https?://')
    if (-not $isRequestNode) { continue }
    foreach ($m in [regex]::Matches($line, 'https?://[^"''\s)]+')) {
      $u = $m.Value
      if ($u -match '(localhost|127\.0\.0\.1|www\.w3\.org)') { continue }
      $demoBundleHits += ($f.Name + ' -> ' + $u)
    }
  }
}
Check '[§7-16][MDP-NFR-02] 示例页产物零外域请求目标（CDN / 字体 / 图片 / fetch；断网可用）' ($demoBundleHits.Count -eq 0) (($demoBundleHits | Select-Object -First 3) -join ', ')

# 宿主 Range 义务：验收用静态服务 MUST 真正实现 Range（MDP-PLY-02 的前提）
$browserHelper = Join-Path $root 'examples\_browser.mjs'
$helperText = if (Test-Path $browserHelper) { Get-Content -Raw -Encoding UTF8 $browserHelper } else { '' }
Check '[MDP-PLY-02] 验收用静态服务实现 Range（206 / Content-Range / Accept-Ranges）' `
  (($helperText -match '206') -and ($helperText -match 'Content-Range') -and ($helperText -match 'Accept-Ranges'))

# ==================================================================
Section '2. 零运行时依赖与分层（MDP-NFR-03）'
# ==================================================================

$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json
$deps = @($pkg.dependencies.PSObject.Properties).Count
Check '[MDP-NFR-03] dependencies 为空（零运行时依赖）' ($deps -eq 0) ('dependencies=' + $deps)
$peerNames = (@($pkg.peerDependencies.PSObject.Properties | ForEach-Object { $_.Name }) -join ',')
Check '[MDP-NFR-03] peerDependencies 仅 react/react-dom' ($peerNames -eq 'react,react-dom') ('peer=' + $peerNames)

$coreFiles = @(Get-ChildItem -Recurse -File -Include *.ts -Path src\core -ErrorAction SilentlyContinue)
$corePattern = ("from\s+['" + $quote + "]react")
$coreReact = @($coreFiles | Select-String -Pattern $corePattern -ErrorAction SilentlyContinue)
Check '[MDP-NFR-03] core/** 零 react 依赖（node 可直接跑单测）' ($coreReact.Count -eq 0) ('' + $coreFiles.Count + ' 个文件')

$pureNames = @('geometry.ts', 'normalize.ts', 'frames.ts', 'audio.ts', 'constants.ts', 'errors.ts', 'status.ts', 'emitter.ts')
$pureReact = 0
foreach ($n in $pureNames) {
  $p = Join-Path $root ('src\core\' + $n)
  if (Test-Path $p) {
    $h = @(Select-String -Path $p -Pattern $corePattern -ErrorAction SilentlyContinue)
    $pureReact += $h.Count
  }
}
Check '[MDP-NFR-03] 纯函数/常量/状态文件零 react 依赖' ($pureReact -eq 0)

# ==================================================================
Section '3. 类型检查与构建（§7-1）'
# ==================================================================

$tsc = Join-Path $root 'node_modules\.bin\tsc.cmd'
$vite = Join-Path $root 'node_modules\.bin\vite.cmd'
$nodeModulesOk = (Test-Path $tsc) -and (Test-Path $vite)
if (-not $nodeModulesOk) {
  Fail '[§7-1][MDP-NFR-03] node_modules 缺失' '先运行 npm install'
} else {
  Run $tsc @('--noEmit', '-p', 'tsconfig.json') '[§7-1][MDP-NFR-03] 类型检查（模块源码，strict）' | Out-Null
  Run $tsc @('--noEmit', '-p', 'tsconfig.demo.json') '[§7-1] 类型检查（示例宿主 demo/**）' | Out-Null
  Run $tsc @('--noEmit', '-p', 'tsconfig.probe.json') '[§7-1] 类型检查（运行态探针页）' | Out-Null

  Section '4. 构建（一条命令：npm run build）'
  Run $vite @('build') '[§7-1] 库构建（vite lib → dist/index.js）' | Out-Null
  Run $tsc @('-p', 'tsconfig.build.json') '[§7-1] 类型声明（dist/index.d.ts）' | Out-Null
  Run $vite @('build', '--config', 'vite.demo.config.ts') '[§7-1] 示例页构建（build/demo/**）' | Out-Null
  Run $vite @('build', '--config', 'vite.probe.config.ts') '[§7-1] 运行态探针页构建（build/probe/**）' | Out-Null
}

Check '[§7-1] 库产物存在（dist/index.js）' (Test-Path (Join-Path $root 'dist\index.js'))
Check '[§7-1] 类型声明存在（dist/index.d.ts）' (Test-Path (Join-Path $root 'dist\index.d.ts'))
Check '[§7-1] 示例页产物存在（build/demo/index.html）' (Test-Path (Join-Path $root 'build\demo\index.html'))
Check '[§7-1] 探针页产物存在（build/probe/index.html + interactive.html）' `
  ((Test-Path (Join-Path $root 'build\probe\index.html')) -and (Test-Path (Join-Path $root 'build\probe\interactive.html')))

$distIndex = Join-Path $root 'dist\index.js'
if (Test-Path $distIndex) {
  $libText = Get-Content -Raw -Encoding UTF8 $distIndex
  $reactFrom = ("from\s*['" + $quote + "]react")
  Check '[MDP-NFR-03] 产物把 react 保持为外部依赖（未内联）' ($libText -match $reactFrom)
}

# ==================================================================
Section '5. 本地占位素材（§7-2、§7-16）'
# ==================================================================

if ($nodeModulesOk) {
  Run 'node' @('scripts/gen-placeholder-assets.mjs') '[§7-1] 生成本地占位素材（零外网、零外部二进制）' | Out-Null
}
$mediaDir = Join-Path $root 'demo\public\media'
$mp4 = @(Get-ChildItem -Path $mediaDir -Filter *.mp4 -ErrorAction SilentlyContinue)
$seqFrames = @(Get-ChildItem -Path (Join-Path $mediaDir 'seq') -Filter *.png -ErrorAction SilentlyContinue)
Check '[§7-2][MDP-NFR-03] 视频素材 ≥ 6 路（六路同屏前提，随模块交付）' ($mp4.Count -ge 6) ('mp4=' + $mp4.Count)
Check '[§7-2] 序列帧素材 ≥ 8 帧（image-seq 前提）' ($seqFrames.Count -ge 8) ('png=' + $seqFrames.Count)
Check '[§7-2] 静态图/动图素材存在' (Test-Path (Join-Path $mediaDir 'anim.gif'))

# ==================================================================
Section '6. 自测：node tests/unit-test.mjs --json（零依赖、注入假时钟）'
# ==================================================================

$selftestText = ''
$ev = $null
$selfCases = 0
$selfAsserts = 0
$selfFails = -1
if ($nodeModulesOk) {
  $self = RunCapture 'node' @('tests/unit-test.mjs', '--json')
  $selftestText = $self.text
  $m = [regex]::Match($selftestText, '用例：(\d+)\s*断言：(\d+)\s*失败：(\d+)')
  if ($m.Success) {
    $selfCases = [int]$m.Groups[1].Value
    $selfAsserts = [int]$m.Groups[2].Value
    $selfFails = [int]$m.Groups[3].Value
    Pass '[§7-1][MDP-NFR-03] 独立自测（零依赖、零框架、node 直跑）' ('用例 ' + $selfCases + ' / 断言 ' + $selfAsserts + ' / 失败 ' + $selfFails)
    Check '[MDP-NFR-03] 自测用例数 ≥ 70（覆盖六个域的边界：拒绝/幂等/并发/超时/缺省）' ($selfCases -ge 70) ('用例=' + $selfCases)
    Check '[MDP-NFR-03] 自测断言数 ≥ 550' ($selfAsserts -ge 550) ('断言=' + $selfAsserts)
  } else {
    Fail '[§7-1] 自测输出无法解析（缺少统计行）' (($selftestText -split "`n" | Select-Object -Last 3) -join ' ')
  }
  $ev = LiftJson $selftestText 'EVIDENCE:'
  Check '[MDP-NFR-03] 自测导出机检证据（--json → EVIDENCE，验收不猜中文用例名）' ($null -ne $ev)
}

# 证据读取（缺失即 $null；判定自然失败，定位信息里能看到键名）
# 是否**存在**该证据键（值为 null 与键缺失必须区分：来源标识的"未传"就是 null）
function HasEv {
  param([string]$key)
  if ($null -eq $ev) { return $false }
  return ($ev.evidence.PSObject.Properties.Name -contains $key)
}
function Ev {
  param([string]$key)
  if (-not (HasEv $key)) { return $null }
  return $ev.evidence.$key
}
function EvText {
  param([string]$key)
  if (-not (HasEv $key)) { return ($key + '=缺失') }
  $v = Ev $key
  if ($null -eq $v) { return ($key + '=null') }
  return ($key + '=' + ($v | ConvertTo-Json -Compress -Depth 4))
}
function EvIs {
  param([string]$key, [string]$json)
  if (-not (HasEv $key)) { return $false }
  $v = Ev $key
  if ($null -eq $v) { return $false }
  return (($v | ConvertTo-Json -Compress -Depth 4) -eq $json)
}

# ==================================================================
Section '7. 运行态：素材解码 / 6 路真播 / 示例页 / 运行态探针 / 交互式探针'
# ==================================================================

$chrome = $env:CHROME_PATH
if (-not $chrome) {
  $cands = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  )
  foreach ($c in $cands) { if ((-not $chrome) -and (Test-Path $c)) { $chrome = $c } }
}

$runtimeText = ''
$interactiveText = ''
if ($chrome -and $nodeModulesOk) {
  $decode = RunCapture 'node' @('examples/decode-probe.mjs', '--require')
  Check '[§7-2] 素材解码抽样（video + jpg/png 序列帧真实可解码）' ($decode.code -eq 0)

  Run 'node' @('examples/playback-probe.mjs', '--require') '[§7-2][MDP-MUL-01] 6 路真播 + 单路失败隔离（直接驱动 <video>）' | Out-Null
  Run 'node' @('examples/demo-check.mjs', '--require') '[§7-2][MDP-DGR-02] 示例页验收（6 路同屏 / 上限拒绝 / 空面板隐藏）' | Out-Null

  $runtimeJsonPath = Join-Path $env:TEMP 'media-player-runtime-probe.json'
  Remove-Item -Force -ErrorAction SilentlyContinue $runtimeJsonPath
  $runtime = RunCapture 'node' @('examples/runtime-probe.mjs', '--require', '--out', $runtimeJsonPath)
  $runtimeText = $runtime.text
  $rt = ReadJsonFile $runtimeJsonPath
  Check '[§7-5][§7-7][§7-9][§7-10][§7-11][§7-12][§7-13] 运行态探针（headless，27 项）' ($runtime.code -eq 0) ('退出码 ' + $runtime.code)

  $interactiveJsonPath = Join-Path $env:TEMP 'media-player-interactive-probe.json'
  Remove-Item -Force -ErrorAction SilentlyContinue $interactiveJsonPath
  $interactive = RunCapture 'node' @('examples/interactive-probe.mjs', '--require', '--out', $interactiveJsonPath)
  $interactiveText = $interactive.text
  $it = ReadJsonFile $interactiveJsonPath
  if ($interactive.code -eq 0 -and ($interactiveText -match '通过：(\d+) 项交互式')) {
    Pass '[§7-6][§7-8][§7-14] 交互式探针（真实手势全屏 / 六路帧率 / 拖动定位）' ($matches[1] + ' 项')
  } elseif ($interactive.code -eq 2) {
    # 退出码 2：窗口被遮挡/不可见 → rAF 被降频，帧率**不可测**；
    # 全屏与拖动定位的结论仍然有效（它们不依赖 rAF），故本项记 SKIP 而由 §7/§9 单独判定
    Skip '[§7-14] 交互式探针的帧率采样' '浏览器窗口被遮挡/不可见时 rAF 被降频，帧率不可测；请让窗口保持可见后重跑'
  } elseif ($interactiveText -match '本环境无法完成交互式验收') {
    Skip '[§7-6][§7-8][§7-14] 交互式探针（全屏 / 帧率 / 拖动定位）' '本机无可用图形界面，需在有头环境重跑'
  } else {
    Fail '[§7-6][§7-8][§7-14] 交互式探针（真实手势全屏 / 六路帧率 / 拖动定位）' ('退出码 ' + $interactive.code)
  }
} else {
  Skip '[§7-2] 素材解码 + 6 路真播 + 示例页' '未找到 Chrome/Edge（设置 CHROME_PATH 可启用）'
  Skip '[§7-5][§7-7][§7-9][§7-10][§7-11][§7-12][§7-13] 运行态探针' '未找到 Chrome/Edge'
  Skip '[§7-6][§7-8][§7-14] 交互式探针' '未找到 Chrome/Edge'
}

# 探针读数（机器可读；验收据此判定）
if ($null -eq $rt) { $rt = LiftJson $runtimeText '页面读数（完整）：' }
if ($null -eq $it) { $it = LiftJson $interactiveText '页面读数：' }
$interactiveRan = $null -ne $it

function GetRt {
  param([string]$key)
  if ($null -eq $rt) { return $null }
  return $rt.$key
}
function GetIt {
  param([string]$key)
  if ($null -eq $it) { return $null }
  return $it.$key
}
function Num {
  param($v)
  if ($null -eq $v) { return 'n/a' }
  return ([math]::Round([double]$v, 3))
}

# ==================================================================
Section '8. §7 验收清单逐条判定（16 条，机检口径）'
# ==================================================================

Check '[§7-1] 一条命令构建 + 一条命令验收（package.json 脚本齐备）' `
  (($null -ne $pkg.scripts.build) -and ($null -ne $pkg.scripts.accept) -and ($null -ne $pkg.scripts.test)) `
  ('build / test / accept = ' + $pkg.scripts.build + ' | ' + $pkg.scripts.test + ' | ' + $pkg.scripts.accept)

Check '[§7-2][MDP-CHN-01] 独立宿主内 video 与 image-seq 两类通道均可播放' `
  ((EvIs 'channelKinds' '["video","image-seq"]') -and ((Ev 'videoPlayable') -eq $true) -and ((Ev 'imageSeqPlayable') -eq $true) -and ($null -ne $rt) -and ((GetRt 'tileCount') -eq 6) -and ((GetRt 'seqDistinctFrames') -ge 4)) `
  ((EvText 'channelKinds') + ' 探针 tiles=' + (GetRt 'tileCount') + ' 序列帧=' + (GetRt 'seqDistinctFrames'))

Check '[§7-3][MDP-CHN-03] 用既有接口原样 [{name,url}] 即可播放（无需宿主改接口）' `
  (EvIs 'legacyShape' '{"kind":"video","available":true,"id":"legacy-1"}') `
  (EvText 'legacyShape')

Check '[§7-4][MDP-CHN-02] 换一份宿主清单即换通道（源码零通道名/素材 URL/演示数值）' `
  ((EvIs 'channelListFromHost' '["a1","b1"]') -and ($nameHits.Count -eq 0) -and ($mediaLiteralHits.Count -eq 0) -and ($demoValueHits.Count -eq 0) -and ($formatHits.Count -eq 0)) `
  ('守卫命中：通道名 ' + $nameHits.Count + ' / 素材路径 ' + $mediaLiteralHits.Count + ' / 演示数值 ' + $demoValueHits.Count + ' / 越界格式 ' + $formatHits.Count)

Check '[§7-5][MDP-CHN-04] 连续切换通道 20 次：无媒体元素残留、无声音残留' `
  (($null -ne $rt) -and ((GetRt 'switch20MaxVideoElements') -le 1) -and ((GetRt 'switch20AudibleCount') -le 1) -and ((GetRt 'switch20ChannelCount') -eq 1)) `
  ('maxVideoEls=' + (GetRt 'switch20MaxVideoElements') + ' audible=' + (GetRt 'switch20AudibleCount') + ' channels=' + (GetRt 'switch20ChannelCount'))

$noRangeOk = ((Ev 'seekWithoutRangeHint') -eq $true)
$seekWorst = if ($interactiveRan) { (GetIt 'seekWorstMs') } else { (GetRt 'seekWorstMs') }
$seekOk = if ($interactiveRan) {
  (((GetIt 'seekWorstMs') -ge 0) -and ((GetIt 'seekWorstMs') -le 500) -and ((GetIt 'seekDegradedRange') -eq $false))
} else {
  (($null -ne $rt) -and ((GetRt 'seekWorstMs') -ge 0) -and ((GetRt 'seekDegradedRange') -eq $false))
}
Check '[§7-6][MDP-PLY-02] 拖动定位依赖 Range 生效；无 Range 给可读降级提示（非静默失败）' `
  ($seekOk -and $noRangeOk) `
  ('定位 ' + $seekWorst + 'ms（' + $(if ($interactiveRan) { '真实时钟' } else { 'headless 虚拟时间' }) + '）; 无 Range 降级=' + $noRangeOk)

# 出声仲裁读数：探针落盘的是可机检的两个计数（audibleCountV1 / audibleCountAfterMainSwitch）
$audCounts = @((GetRt 'audibleCountV1'), (GetRt 'audibleCountAfterMainSwitch'))
Check '[§7-7][MDP-PLY-03] 六路同屏只有一路出声；切换主路声音跟随' `
  (($null -ne (GetRt 'audibleCountV1')) -and ((GetRt 'audibleCountV1') -le 1) -and ((GetRt 'audibleCountAfterMainSwitch') -le 1) -and ((GetRt 'audibleIdV1') -eq 'v1') -and ((GetRt 'audibleIdAfterMainSwitch') -eq 'v3')) `
  ('audible 计数=' + ($audCounts -join ',') + '；出声路 ' + (GetRt 'audibleIdV1') + '→' + (GetRt 'audibleIdAfterMainSwitch'))

$fsOk = $false
if ($interactiveRan) {
  $fsr = GetIt 'fullscreenResult'
  $fsOk = ($null -ne $fsr) -and ($fsr.ok -eq $true) -and ((GetIt 'fullscreenSettled') -eq $true) -and
    ((GetIt 'elementReusedAfterExit') -eq $true) -and
    ((GetIt 'progressAfterFullscreen') -ge (GetIt 'progressBeforeFullscreen')) -and
    ((GetIt 'alignAfterFullscreenWorst') -le 1)
}
if ($fsOk) {
  Check '[§7-8][MDP-PLY-05] 全屏 ↔ 退出后播放进度连续、布局一致、元素复用' $true `
    ('全屏成功；进度 ' + (GetIt 'progressBeforeFullscreen') + '→' + (GetIt 'progressAfterFullscreen') + '；退出后对齐误差 ' + (Num (GetIt 'alignAfterFullscreenWorst')) + 'px')
} elseif ($interactiveRan) {
  Fail '[§7-8][MDP-PLY-05] 全屏 ↔ 退出后播放进度连续、布局一致、元素复用' ('页面读数异常：' + ($it | ConvertTo-Json -Compress -Depth 3))
} else {
  Skip '[§7-8][MDP-PLY-05] 全屏 ↔ 退出后播放进度连续、布局一致、元素复用' '需要真实用户手势（有头窗口 + CDP），本环境不可测'
}

Check '[§7-9][MDP-PLY-06] 序列帧通道按配置间隔轮播、可暂停' `
  (($null -ne $rt) -and ((GetRt 'seqDistinctFrames') -ge 4) -and ((GetRt 'seqPausedStable') -eq $true)) `
  ('1s 内不同帧=' + (GetRt 'seqDistinctFrames') + '（间隔 ' + (GetRt 'seqFrameIntervalMs') + 'ms） 暂停稳定=' + (GetRt 'seqPausedStable'))

$me = (GetRt 'mediaElements')
$hb = (GetRt 'heapBytes')
Check '[§7-10][MDP-MUL-03] 隐藏多路后解码活动下降；长时间运行资源有界' `
  (($null -ne $rt) -and ((GetRt 'playingAfterHide') -lt (GetRt 'playingBeforeHide')) -and ((GetRt 'pausedByPolicyCount') -ge 1) -and ($null -ne $me) -and ($me.after -le ($me.channels + 1)) -and (($null -eq $hb.growth) -or ($hb.growth -lt 16777216))) `
  ('playing ' + (GetRt 'playingBeforeHide') + '→' + (GetRt 'playingAfterHide') + ' pausedByPolicy=' + (GetRt 'pausedByPolicyCount') + ' 元素=' + $me.after + '/' + $me.channels + ' 堆增长=' + $hb.growth + 'B')

$aw = (GetRt 'alignWorst')
$fsAlign = if ($interactiveRan) { (GetIt 'alignInFullscreenWorst') } else { $aw[2] }
Check '[§7-11][MDP-OVL-01/03/04] 叠加项逐项开关生效；锁定框比例一致，resize/全屏后不错位（≤1px）' `
  (($null -ne $aw) -and ($aw.Count -ge 4) -and ($aw[0] -le 1) -and ($aw[1] -le 1) -and ($aw[3] -le 1) -and ($null -ne $fsAlign) -and ($fsAlign -le 1) -and ($null -ne (Ev 'overlayToggle')) -and ((Ev 'normRoundTripMaxErr') -lt 1e-9)) `
  ('最大对齐误差 基准/resize/全屏 = ' + (Num $aw[0]) + '/' + (Num $aw[1]) + '/' + (Num $fsAlign) + ' px')

Check '[§7-12][MDP-DGR-02] 清单为空时入口隐藏、无空面板、原因可读' `
  (($null -ne $rt) -and ((GetRt 'emptyRendersPlayer') -eq $false) -and ((GetRt 'emptyTileCount') -eq 0) -and ($null -ne (GetRt 'emptySummary').emptyReason) -and ((Ev 'emptyReason') -eq 'no-channels')) `
  ('面板渲染=' + (GetRt 'emptyRendersPlayer') + ' 空面板块=' + (GetRt 'emptyTileCount') + ' 原因=' + (GetRt 'emptySummary').emptyReason + '/' + (Ev 'emptyReason'))

$iso = Ev 'faultIsolation'
Check '[§7-13][MDP-DGR-03] 一路 url 无效不影响其余路（失败路可读错误态）' `
  (($null -ne $rt) -and ((GetRt 'isolatedErrorCount') -eq 1) -and ((GetRt 'isolatedOkCount') -ge 5) -and ((GetRt 'errorReadable') -eq $true) -and ($null -ne $iso) -and ($iso[0] -eq 'playing') -and ($iso[1] -eq 'error')) `
  ('探针 error=' + (GetRt 'isolatedErrorCount') + ' ok=' + (GetRt 'isolatedOkCount') + '; 自测 ' + (EvText 'faultIsolation'))

$firstFrameOk = ($null -ne $rt) -and ((GetRt 'firstFrameMs') -le 1000)
$fpsMeasurable = $interactiveRan -and ((GetIt 'fpsMeasurable') -eq $true)
$fpsOk = $fpsMeasurable -and ((GetIt 'fpsMedian') -ge 25) -and ((GetIt 'fpsMin') -ge 25)
$seekPerfOk = $interactiveRan -and ((GetIt 'seekWorstMs') -ge 0) -and ((GetIt 'seekWorstMs') -le 500)
if ($fpsMeasurable) {
  Check '[§7-14][MDP-NFR-01] 6 路同屏帧率 ≥ 25 fps；首帧 ≤ 1s；拖动定位 ≤ 500ms' `
    ($fpsOk -and $firstFrameOk -and $seekPerfOk) `
    ('fps 中位/最小=' + (GetIt 'fpsMedian') + '/' + (GetIt 'fpsMin') + '（采样 ' + ((GetIt 'fpsSamples') -join ',') + '） 首帧=' + (GetRt 'firstFrameMs') + 'ms 定位=' + (GetIt 'seekWorstMs') + 'ms')
} else {
  # 帧率不可测（无头 / 窗口被遮挡）时，只对"可测项"判定，并显式记 SKIP，绝不当成通过
  Check '[§7-14][MDP-NFR-01] 首帧 ≤ 1s；拖动定位 ≤ 500ms（帧率另列）' `
    ($firstFrameOk -and $seekPerfOk) `
    ('首帧=' + (GetRt 'firstFrameMs') + 'ms 定位=' + $(if ($interactiveRan) { (GetIt 'seekWorstMs') } else { 'n/a' }) + 'ms')
  Skip '[§7-14][MDP-NFR-01] 六路同屏帧率 ≥ 25 fps' $(if ($interactiveRan) { '窗口被遮挡/不可见 → rAF 被降频，帧率不可测（fps 采样 ' + ((GetIt 'fpsSamples') -join ',') + '）' } else { '无头环境不驱动 rAF，需有头且窗口可见' })
}

Check '[§7-15][MDP-NFR-02] 全仓业务词零命中；map-2d / ws-client 跨仓 import 零命中' `
  (($bizHits.Count -eq 0) -and ($crossImports.Count -eq 0) -and ($crossDynamic.Count -eq 0) -and ((Ev 'externalProbeSkipped') -eq $true) -and ((Ev 'relativeProbeAllowed') -eq $true) -and ((Ev 'protocolRelativeSkipped') -eq $true)) `
  ('业务词 ' + $bizHits.Count + ' / 静态跨仓 ' + $crossImports.Count + ' / 动态跨仓 ' + $crossDynamic.Count)

Check '[§7-16][MDP-NFR-02] 断外网时全部功能可用（素材与探测目标全本地）' `
  (($urlHits.Count -eq 0) -and ($demoBundleHits.Count -eq 0) -and ($mp4.Count -ge 6) -and ($seqFrames.Count -ge 8) -and ((Ev 'externalProbeSkipped') -eq $true) -and ((Ev 'relativeProbeAllowed') -eq $true) -and ((Ev 'protocolRelativeSkipped') -eq $true)) `
  ('外域地址 ' + $urlHits.Count + ' / 产物外链 ' + $demoBundleHits.Count + ' / 外域探测已跳过')

# ==================================================================
Section '9. 需求编号逐条判定（28 条）'
# ==================================================================

Check '[MDP-CHN-01] 通道模型两类 + 字段缺省有定义行为且不报错' `
  ((EvIs 'channelKinds' '["video","image-seq"]') -and ((Ev 'missingFieldDefaultKind') -eq 'video') -and ((Ev 'missingFieldNoThrow') -eq $true)) `
  ((EvText 'channelKinds') + ' ' + (EvText 'missingFieldDefaultKind') + ' ' + (EvText 'missingFieldNoThrow'))

Check '[MDP-CHN-02] 清单由宿主注入；换清单即换通道；模块源码零通道名与 URL' `
  ((EvIs 'channelListFromHost' '["a1","b1"]') -and ($nameHits.Count -eq 0) -and ($mediaLiteralHits.Count -eq 0) -and ($demoValueHits.Count -eq 0)) `
  (EvText 'channelListFromHost')

Check '[MDP-CHN-03] 既有 [{name,url}] 直接可消费（缺字段按默认类型处理）' `
  (EvIs 'legacyShape' '{"kind":"video","available":true,"id":"legacy-1"}') `
  (EvText 'legacyShape')

Check '[MDP-CHN-04] 运行时切换通道：旧通道被正确释放，无残留播放/声音' `
  (($null -ne $rt) -and ((GetRt 'switch20MaxVideoElements') -le 1) -and ((GetRt 'switch20AudibleCount') -le 1) -and ((GetRt 'switch20ChannelCount') -eq 1)) `
  ('20 次切换后 maxVideoEls=' + (GetRt 'switch20MaxVideoElements') + ' audible=' + (GetRt 'switch20AudibleCount'))

Check '[MDP-CHN-05] 来源标识：不传不显示且不报错；任意字符串原样保留' `
  (($null -eq (Ev 'sourceLabelAbsent')) -and ((Ev 'sourceLabelArbitrary') -eq '任意串-9')) `
  ((EvText 'sourceLabelAbsent') + ' ' + (EvText 'sourceLabelArbitrary'))

$tt = Ev 'playPauseStop'
$idem = Ev 'idempotent'
$rej = Ev 'rejects'
Check '[MDP-PLY-01] 播放/暂停/停止三个动作可由接口触发，状态可查询且幂等' `
  (($null -ne $tt) -and ($tt[0] -eq $true) -and ($tt[1] -eq 'loading') -and ($tt[2] -eq $true) -and ($tt[3] -eq 'paused') -and ($tt[4] -eq $true) -and ($tt[5] -eq 'idle') -and ($null -ne $idem) -and ($idem[0] -eq 0) -and ($idem[3] -eq $true) -and ($null -ne $rej) -and ($rej.unknownChannel -eq 1004)) `
  ((EvText 'playPauseStop') + ' ' + (EvText 'idempotent') + ' ' + (EvText 'rejects'))

Check '[MDP-PLY-02] 进度控制：拖拽定位生效；无 Range / 定位超时给可读降级提示' `
  (((Ev 'seekWithoutRangeHint') -eq $true) -and $seekOk) `
  ((EvText 'seekWithoutRangeHint') + ' 定位=' + $seekWorst + 'ms')

Check '[MDP-PLY-03] 音量/静音；多路同屏默认至多一路出声；切主路声音跟随' `
  (($null -ne (GetRt 'audibleCountV1')) -and ((GetRt 'audibleCountV1') -le 1) -and ((GetRt 'audibleCountAfterMainSwitch') -le 1) -and ($null -ne (Ev 'pointerEventsDefault'))) `
  ('audible 计数=' + ($audCounts -join ',') + '；出声路 ' + (GetRt 'audibleIdV1') + '→' + (GetRt 'audibleIdAfterMainSwitch'))

$rate = Ev 'ratePolicy'
Check '[MDP-PLY-04] 倍速（0.5×/1×/2×）与单帧步进；非法倍率被拒绝' `
  (($null -ne $rate) -and ((($rate.options | ConvertTo-Json -Compress) -eq '[0.5,1,2]')) -and ($rate.ok -eq $true) -and ($rate.applied -eq 0.5) -and ($rate.reject -eq 1000) -and ($rate.stepOk -eq $true)) `
  (EvText 'ratePolicy')

Check '[MDP-PLY-05] 全屏：单通道可放大到全屏；退出后回到原布局且进度不丢' `
  ($fsOk) `
  $(if ($interactiveRan) { ('全屏=' + (GetIt 'fullscreenResult').ok + ' 进度 ' + (GetIt 'progressBeforeFullscreen') + '→' + (GetIt 'progressAfterFullscreen') + ' 元素复用=' + (GetIt 'elementReusedAfterExit')) } else { '本环境不可测（需真实手势）' })

Check '[MDP-PLY-06] 循环与帧间隔：图像流按固定间隔轮播，可暂停' `
  (($null -ne $rt) -and ((GetRt 'seqDistinctFrames') -ge 4) -and ((GetRt 'seqPausedStable') -eq $true) -and ((GetRt 'seqFrameIntervalMs') -ge 100)) `
  ('1s 内不同帧=' + (GetRt 'seqDistinctFrames') + ' 间隔=' + (GetRt 'seqFrameIntervalMs') + 'ms 暂停稳定=' + (GetRt 'seqPausedStable'))

$mulUp = Ev 'sixUp'
Check '[MDP-MUL-01] 多路同屏：至少 6 路同时播放不崩、不互相顶掉' `
  (($null -ne $rt) -and ((GetRt 'tileCount') -eq 6) -and ((GetRt 'playingCount') -ge 5) -and ($null -ne $mulUp) -and ($mulUp[0] -eq 6)) `
  ('tiles=' + (GetRt 'tileCount') + ' playing=' + (GetRt 'playingCount') + '; ' + (EvText 'sixUp'))

Check '[MDP-MUL-02] 每类通道最多路数可配 + 上限保护（拒绝有可读原因，不静默丢）' `
  (($null -ne $mulUp) -and ($mulUp[1] -ge 1) -and ((GetRt 'policyRejections') -ge 1) -and (($null -ne (GetRt 'channelIds')) -and ((GetRt 'channelIds') -notcontains 'v7')) -and ($null -ne (Ev 'maxByKindConfigured'))) `
  ((EvText 'sixUp') + ' 探针拒绝=' + (GetRt 'policyRejections') + ' ' + (EvText 'maxByKindConfigured'))

Check '[MDP-MUL-03] 按需加载与有界缓存：不可见路暂停解码；资源有界' `
  (($null -ne $rt) -and ((GetRt 'playingAfterHide') -lt (GetRt 'playingBeforeHide')) -and ((GetRt 'pausedByPolicyCount') -ge 1) -and ($me.after -le ($me.channels + 1)) -and (($null -eq $hb.growth) -or ($hb.growth -lt 16777216))) `
  ('playing ' + (GetRt 'playingBeforeHide') + '→' + (GetRt 'playingAfterHide') + ' pausedByPolicy=' + (GetRt 'pausedByPolicyCount') + ' 元素=' + $me.after + '/' + $me.channels)

$mainSw = Ev 'mainSwitch'
$laySw = Ev 'layoutSwitch'
Check '[MDP-MUL-04] 布局与主路：可指定主路（放大、出声）；取消主路回到网格' `
  (($null -ne $mainSw) -and ($mainSw[0] -eq $true) -and ($mainSw[1] -eq 'c2') -and ($mainSw[2] -eq $true) -and ($null -eq $mainSw[3]) -and ($null -ne $laySw) -and ($laySw[1] -eq $true) -and ($laySw[2] -eq 'focus') -and ($laySw[3] -eq 1000)) `
  ((EvText 'mainSwitch') + ' ' + (EvText 'layoutSwitch'))

Check '[MDP-MUL-05] 节流：高频图像流可配置最小刷新间隔（合并窗口）' `
  (($null -ne $rt) -and ((GetRt 'seqFrameIntervalMs') -ge 100) -and ((Ev 'throttleMs') -eq 100) -and ((GetRt 'seqDistinctFrames') -ge 4)) `
  ('throttleMs=' + (Ev 'throttleMs') + ' 轮播间隔=' + (GetRt 'seqFrameIntervalMs') + 'ms')

$ovlT = Ev 'overlayToggle'
Check '[MDP-OVL-01] 可开关的叠加项（实时/回放、倍率、时间戳、通道名、来源徽标）' `
  (($null -ne $ovlT) -and ($ovlT[1] -eq $true) -and ($ovlT[3] -eq $true) -and ($ovlT[4] -eq 'live,boxes') -and ($ovlT[5] -eq 1000) -and ($null -ne (GetRt 'alignAfterResize')) -and ((GetRt 'alignAfterResize').Count -eq 4)) `
  (EvText 'overlayToggle')

Check '[MDP-OVL-02] 叠加内容由宿主注入，模块不产生业务语义（不注入不显示、不报错）' `
  (((Ev 'overlayInjectedAbsent') -eq '{}') -and (HasEv 'sourceLabelAbsent') -and ($null -eq (Ev 'sourceLabelAbsent'))) `
  ((EvText 'overlayInjectedAbsent') + ' ' + (EvText 'sourceLabelAbsent'))

Check '[MDP-OVL-03] 锁定框以归一化坐标（0–1）表达；不同分辨率下比例一致' `
  (($null -ne (Ev 'normRoundTripMaxErr')) -and ((Ev 'normRoundTripMaxErr') -lt 1e-9) -and (EvIs 'resizeProportional' '[true,true]')) `
  ((EvText 'normRoundTripMaxErr') + ' ' + (EvText 'resizeProportional'))

Check '[MDP-OVL-04] 叠加层与画面帧对齐：缩放/全屏/resize 均不错位（≤1px）' `
  (($null -ne $aw) -and ($aw.Count -ge 4) -and ($aw[0] -le 1) -and ($aw[1] -le 1) -and ($aw[3] -le 1) -and ($null -ne $fsAlign) -and ($fsAlign -le 1)) `
  ('最大误差 基准/resize/全屏 = ' + (Num $aw[0]) + '/' + (Num $aw[1]) + '/' + (Num $fsAlign) + ' px')

$ovlSw = Ev 'pointerEventsSwitch'
Check '[MDP-OVL-05] 叠加层不干扰控制：缺省穿透，可配置为可命中' `
  (((Ev 'pointerEventsDefault') -eq 'none') -and ($null -ne $ovlSw) -and ($ovlSw[1] -eq 'auto') -and ($ovlSw[2] -eq 1000) -and ($ovlSw[3] -eq 'auto')) `
  ((EvText 'pointerEventsDefault') + ' ' + (EvText 'pointerEventsSwitch'))

$stObs = Ev 'stateObservable'
Check '[MDP-DGR-01] 状态可观测（六态闭集 + 错误原因），迁移可复现' `
  (($null -ne $stObs) -and ($stObs[0] -eq 'ready') -and ($stObs[1] -eq $true) -and ($stObs[2] -eq 'idle,loading,ready,playing,paused,error') -and ($null -ne $tt) -and ($tt[1] -eq 'loading') -and ($iso[1] -eq 'error')) `
  (EvText 'stateObservable')

Check '[MDP-DGR-02] 无素材降级：清单为空/全不可用 → 隐藏入口，原因可读，无空白黑框' `
  (($null -ne $rt) -and ((GetRt 'emptyRendersPlayer') -eq $false) -and ((GetRt 'emptyTileCount') -eq 0) -and ((Ev 'emptyReason') -eq 'no-channels') -and ($null -ne (GetRt 'emptySummary').emptyReason)) `
  ('面板=' + (GetRt 'emptyRendersPlayer') + ' 块=' + (GetRt 'emptyTileCount') + ' 原因=' + (GetRt 'emptySummary').emptyReason + '/' + (Ev 'emptyReason'))

Check '[MDP-DGR-03] 单路失败不影响其它路：失败路可读错误态，其余路继续' `
  (($null -ne $iso) -and ($iso[0] -eq 'playing') -and ($iso[1] -eq 'error') -and ($iso[2] -eq $true) -and ($iso[3] -eq $true) -and ((GetRt 'isolatedErrorCount') -eq 1) -and ((GetRt 'isolatedOkCount') -ge 5)) `
  ('探针 error=' + (GetRt 'isolatedErrorCount') + ' ok=' + (GetRt 'isolatedOkCount') + '; ' + (EvText 'faultIsolation'))

$diagF = Ev 'diagnosticsFields'
Check '[MDP-DGR-04] 诊断信息可读（加载耗时 / 实际分辨率 / 缓冲次数 / 丢帧次数）' `
  (($null -ne $diagF) -and ($diagF[0] -eq $true) -and ($diagF[1] -eq 320) -and ($diagF[2] -ge 1) -and ($diagF[3] -eq 'number')) `
  (EvText 'diagnosticsFields')

$nfr1Ok = $firstFrameOk -and $seekPerfOk -and (($fpsMeasurable -eq $false) -or $fpsOk)
Check '[MDP-NFR-01] 性能：6 路 ≥ 25 fps；首帧 ≤ 1s；拖动定位 ≤ 500ms' `
  $nfr1Ok `
  ('首帧=' + (GetRt 'firstFrameMs') + 'ms' + $(if ($fpsMeasurable) { ' fps 中位/最小=' + (GetIt 'fpsMedian') + '/' + (GetIt 'fpsMin') } else { ' fps=不可测（记为 SKIP）' }) + ' 定位=' + $(if ($interactiveRan) { (GetIt 'seekWorstMs') } else { 'n/a' }) + 'ms')
if (-not $fpsMeasurable) {
  Skip '[MDP-NFR-01] 六路同屏帧率 ≥ 25 fps（窗口可见时才有意义）' $(if ($interactiveRan) { '窗口被遮挡/不可见 → rAF 降频' } else { '无头环境不驱动 rAF' })
}

Check '[MDP-NFR-02] 零业务耦合：业务词零命中；MUST NOT import map-2d / ws-client' `
  (($bizHits.Count -eq 0) -and ($crossImports.Count -eq 0) -and ($crossDynamic.Count -eq 0) -and ($urlHits.Count -eq 0) -and ($demoBundleHits.Count -eq 0) -and ((Ev 'externalProbeSkipped') -eq $true) -and ((Ev 'relativeProbeAllowed') -eq $true) -and ((Ev 'protocolRelativeSkipped') -eq $true)) `
  ('业务词 ' + $bizHits.Count + ' / 跨仓 ' + $crossImports.Count + ' / 外域 ' + $urlHits.Count)

Check '[MDP-NFR-03] 独立交付：独立构建、独立示例、独立测试、独立验收脚本（退出码 0/1）' `
  ((Test-Path (Join-Path $root 'dist\index.js')) -and (Test-Path (Join-Path $root 'build\demo\index.html')) -and ($selfCases -ge 70) -and ($selfFails -eq 0) -and ($deps -eq 0) -and ($pureReact -eq 0)) `
  ('用例=' + $selfCases + ' 断言=' + $selfAsserts + ' 失败=' + $selfFails + ' deps=' + $deps)

# ==================================================================
Section '10. 需求编号覆盖矩阵（28 条）'
# ==================================================================

$groups = @(
  @{ Prefix = 'MDP-CHN'; Title = '通道与源' },
  @{ Prefix = 'MDP-PLY'; Title = '播放控制' },
  @{ Prefix = 'MDP-MUL'; Title = '多路同屏' },
  @{ Prefix = 'MDP-OVL'; Title = '叠加层' },
  @{ Prefix = 'MDP-DGR'; Title = '降级与状态' },
  @{ Prefix = 'MDP-NFR'; Title = '非功能性' }
)
$passIds = 0
$failIds = 0
$uncovered = 0
foreach ($g in $groups) {
  $ids = @($script:reqIds | Where-Object { $_ -like ($g.Prefix + '-*') })
  $cells = @()
  foreach ($id in $ids) {
    $v = $script:reqVerdict[$id]
    if ($v -eq 'PASS') { $passIds++ }
    elseif ($v -eq 'FAIL') { $failIds++ }
    else { $uncovered++ }
    $mark = switch ($v) { 'PASS' { '✓' } 'FAIL' { '✗' } default { '?' } }
    $cells += ($id.Substring($id.Length - 2) + ':' + $mark)
  }
  Write-Host ('  ' + $g.Prefix.PadRight(9) + $g.Title.PadRight(8) + ' ' + ($cells -join '  ')) -ForegroundColor DarkGray
}
Write-Host ('  合计：PASS ' + $passIds + ' / FAIL ' + $failIds + ' / 未覆盖 ' + $uncovered + '（共 ' + $script:reqIds.Count + '）') -ForegroundColor White
if ($failIds -gt 0) {
  $failedIds = @($script:reqIds | Where-Object { $script:reqVerdict[$_] -eq 'FAIL' })
  Write-Host ('  未通过编号：' + ($failedIds -join ', ')) -ForegroundColor Red
}
if ($uncovered -gt 0) {
  $uncoveredIds = @($script:reqIds | Where-Object { $script:reqVerdict[$_] -eq 'UNCOVERED' })
  Write-Host ('  未覆盖编号：' + ($uncoveredIds -join ', ')) -ForegroundColor Yellow
}

Check '[MDP-NFR-03] 28 条需求编号全部被断言覆盖（无 UNCOVERED）' ($uncovered -eq 0) ('未覆盖=' + $uncovered)
Check '[§7-15] 28 条编号判定全为 PASS' ($failIds -eq 0) ('FAIL=' + $failIds)

# ==================================================================
Write-Host ''
Write-Host ('-' * 68) -ForegroundColor DarkGray
$total = $script:passed + $script:failed
$tail = ''
if ($script:skipped -gt 0) { $tail = '，跳过 ' + $script:skipped }
Write-Host ('验收：通过 ' + $script:passed + ' / ' + $total + $tail) -ForegroundColor White
if ($script:skipped -gt 0) {
  Write-Host '跳过项（需在其它环境补测，不得当作通过）：' -ForegroundColor Yellow
  foreach ($s in $script:skipList) { Write-Host ('  - ' + $s) -ForegroundColor Yellow }
}
if ($script:failed -gt 0) {
  Write-Host ('结果：失败 ' + $script:failed + ' 项（退出码 1）') -ForegroundColor Red
  exit 1
}
Write-Host '结果：全部通过（退出码 0）' -ForegroundColor Green
exit 0
