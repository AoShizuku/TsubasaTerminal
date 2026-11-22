# 注册 Windows 计划任务 "Tsubasa Terminal Nightly Smoke"：每夜对真实 VPS 跑烟测（默认 03:30）。
# 前置：复制 scripts/smoke.config.example.json 为 scripts/smoke.config.json 并填写主机。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\register-nightly-smoke.ps1 [-Time 03:30]
param([string]$Time = '03:30')
$runner = Join-Path $PSScriptRoot 'nightly-smoke.ps1'
if (-not (Test-Path (Join-Path $PSScriptRoot 'smoke.config.json'))) {
  Write-Warning '尚未创建 scripts/smoke.config.json，计划任务将注册但运行会失败——请先填写配置'
}
schtasks /Create /F /TN 'Tsubasa Terminal Nightly Smoke' /SC DAILY /ST $Time `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$runner`""
Write-Host "已注册每夜 $Time 的烟测任务；日志见 test-results-smoke/nightly.log"
