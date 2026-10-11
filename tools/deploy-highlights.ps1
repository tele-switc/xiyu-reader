<#
  把新构建的西语阅读器资源包部署到你日常使用的那份安装（%LOCALAPPDATA%\XiYuReader）。

  默认是 DryRun（只报告将要做什么，不动任何文件）；确认无误后加 -Apply 才真正执行。

  用法：
    powershell -File tools\deploy-highlights.ps1              # 只看计划
    powershell -File tools\deploy-highlights.ps1 -Apply       # 关应用 → 备份 → 替换 → 重新打开
    powershell -File tools\deploy-highlights.ps1 -Apply -NoRestart   # 替换后不自动重开
#>
[CmdletBinding()]
param(
  [switch]$Apply,          # 不加这个开关就只做检查与报告
  [switch]$NoRestart       # 部署后不自动重新打开应用
)

$ErrorActionPreference = 'Stop'
$src  = '<repo>\app-src\dist\spa-reader\resources.neu'
$dstDir = Join-Path $env:LOCALAPPDATA 'XiYuReader'
$dst  = Join-Path $dstDir 'resources.neu'
$exe  = Join-Path $dstDir 'XiYuReader.exe'

function Get-FileHash2($p) { (Get-FileHash -Algorithm SHA256 -Path $p).Hash }

Write-Host '=== 西语阅读器 高亮版 部署检查 ===' -ForegroundColor Cyan
foreach ($p in @($src, $dst, $exe)) {
  if (Test-Path $p) {
    $i = Get-Item $p
    Write-Host ("存在  {0,10:N0} KB  {1}" -f ($i.Length / 1KB), $p)
  } else {
    Write-Host ("缺失            {0}" -f $p) -ForegroundColor Yellow
  }
}
if (-not (Test-Path $src)) { throw "找不到新构建的资源包：$src（先在 app-src 里跑 npx neu build）" }
if (-not (Test-Path $dst)) { throw "找不到日常安装的资源包：$dst" }

$hSrc = Get-FileHash2 $src
$hDst = Get-FileHash2 $dst
if ($hSrc -eq $hDst) { Write-Host '两份资源包内容一致，无需部署。' -ForegroundColor Green; exit 0 }
Write-Host ('新包 SHA256 ' + $hSrc.Substring(0,16) + '  现用 ' + $hDst.Substring(0,16))

$running = Get-Process -Name 'XiYuReader' -ErrorAction SilentlyContinue
if ($running) { Write-Host ('应用正在运行（PID ' + ($running.Id -join ',') + '），部署需要先关闭它。') -ForegroundColor Yellow }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$dst.bak-$stamp"
Write-Host '将执行：' -ForegroundColor Cyan
Write-Host "  1) 关闭 XiYuReader 进程"
Write-Host "  2) 备份现用资源包 -> $bak"
Write-Host "  3) 复制新资源包 -> $dst"
Write-Host "  4) 重新打开应用（除非 -NoRestart）"

if (-not $Apply) {
  Write-Host ''
  Write-Host 'DryRun 结束：没有改动任何文件。确认以上步骤后加 -Apply 执行。' -ForegroundColor Magenta
  exit 0
}

if ($running) {
  Stop-Process -Name 'XiYuReader' -Force
  Start-Sleep -Milliseconds 800
}
Copy-Item -Path $dst -Destination $bak -Force
Copy-Item -Path $src -Destination $dst -Force

if ((Get-FileHash2 $dst) -ne $hSrc) { throw '替换后校验失败：目标文件哈希与新包不一致' }
Write-Host ('部署完成，已备份到 ' + $bak) -ForegroundColor Green

if (-not $NoRestart) {
  Start-Process -FilePath $exe -WorkingDirectory $dstDir
  Write-Host '应用已重新打开。' -ForegroundColor Green
}
Write-Host @'
接下来在应用里：
  · PDF 点一个词 = 写进文件的高亮（再点取消）；双击 = 查词
  · 老书第一次点高亮时会让你指认原 PDF 的位置，指认一次就记住
  · 第一次写入会在同目录留一份 原名.pdf.bak
'@
