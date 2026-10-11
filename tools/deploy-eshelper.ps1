<#
 西语阅读器 生词本同步 —— 构建 + 部署 + 回滚
 用法：
   powershell -ExecutionPolicy Bypass -File tools\deploy-eshelper.ps1              # 只检查，不动任何东西（DryRun）
   powershell -ExecutionPolicy Bypass -File tools\deploy-eshelper.ps1 -Build        # 构建 1.0.x
   powershell -ExecutionPolicy Bypass -File tools\deploy-eshelper.ps1 -Deploy       # 构建 + 关闭应用 + 备份 + 覆盖
   powershell -ExecutionPolicy Bypass -File tools\deploy-eshelper.ps1 -Rollback     # 回滚到最近一次备份
 说明：部署会优雅关闭窗口（给 PDF 高亮落盘留时间），关不掉就中止，不强杀。
#>
param([switch]$Build, [switch]$Deploy, [switch]$Rollback)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$app  = Join-Path $env:LOCALAPPDATA 'XiYuReader'
$dist = Join-Path $repo 'app-src\dist\spa-reader\resources.neu'
$cur  = Join-Path $app  'resources.neu'
$node = (Get-Command node -ErrorAction Stop).Source
$neu  = Join-Path $repo 'app-src\node_modules\@neutralinojs\neu\bin\neu.js'

"仓库构建产物 = $dist"
if (Test-Path $dist) { "  现产物 $((Get-Item $dist).Length) B  $((Get-Item $dist).LastWriteTime)" } else { "  （还没有产物）" }
"安装目录产物 = $cur"
if (Test-Path $cur)  { "  在装机 $((Get-Item $cur).Length) B  $((Get-Item $cur).LastWriteTime)" } else { "  （未安装）" }
$baks = Get-ChildItem (Join-Path $app 'resources.neu.bak-*') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
"备份数量 = $($baks.Count)"
$baks | Select-Object -First 3 | ForEach-Object { "  $($_.Name)  $($_.Length) B" }
$run = Get-Process -Name 'XiYuReader' -ErrorAction SilentlyContinue
if ($run) { "应用正在运行 PID=$($run.Id)（Deploy 会先优雅关闭）" } else { "应用未运行" }
if (-not $Build -and -not $Deploy -and -not $Rollback) { "`nDryRun：只读检查，什么都没改。要动手请加 -Build / -Deploy / -Rollback"; exit 0 }

if ($Rollback) {
  if (-not $baks) { "没有可回滚的备份"; exit 1 }
  $t = $baks[0]
  "回滚目标 = $($t.Name)"
  Copy-Item $cur (Join-Path $app ("resources.neu.beforerollback-" + (Get-Date -Format 'yyyyMMdd-HHmmss')))
  Copy-Item $t.FullName $cur -Force
  "已回滚：$((Get-Item $cur).Length) B"
  exit 0
}

if ($Build -or $Deploy) {
  Push-Location (Join-Path $repo 'app-src')
  & $node $neu build
  Pop-Location
  "构建完成 $((Get-Item $dist).Length) B"
}
if (-not $Deploy) { "只构建，未部署"; exit 0 }

if ($run) {
  [void]$run.CloseMainWindow()
  $w = 0
  while ($w -lt 60) { Start-Sleep -Milliseconds 500; $w++; if (-not (Get-Process -Id $run.Id -ErrorAction SilentlyContinue)) { break } }
  if (Get-Process -Id $run.Id -ErrorAction SilentlyContinue) { "窗口 30 秒没关（可能等高亮落盘），中止部署，不强杀"; exit 2 }
  "应用已优雅退出（$([Math]::Round($w/2,1)) 秒）"
}
Start-Sleep -Seconds 1
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $app "resources.neu.bak-$ts-beforedeploy"
Copy-Item $cur $bak
"备份 = $bak ($((Get-Item $bak).Length) B)"
Copy-Item $dist $cur -Force
$ok = (Get-FileHash $cur -Algorithm SHA256).Hash -eq (Get-FileHash $dist -Algorithm SHA256).Hash
"部署完成，SHA256 与产物一致 = $ok"
if (-not $ok) { "回滚命令：powershell -ExecutionPolicy Bypass -File tools\deploy-eshelper.ps1 -Rollback"; exit 3 }
