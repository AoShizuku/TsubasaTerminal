# Tsubasa Terminal 每夜烟测 runner：读取 scripts/smoke.config.json（不入库，
# 参照 smoke.config.example.json 复制填写），设置环境变量后运行 npm run test:smoke，
# 输出追加到 test-results-smoke/nightly.log。由 register-nightly-smoke.ps1 注册计划任务调用。
$appRoot = Split-Path $PSScriptRoot -Parent
$configPath = Join-Path $PSScriptRoot 'smoke.config.json'
if (-not (Test-Path $configPath)) {
  Write-Error "缺少 $configPath —— 请复制 smoke.config.example.json 为 smoke.config.json 并填写目标主机"
  exit 1
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$env:TSUBASATERMINAL_SMOKE_HOST = $config.host
if ($config.user) { $env:TSUBASATERMINAL_SMOKE_USER = $config.user }
if ($config.port) { $env:TSUBASATERMINAL_SMOKE_PORT = "$($config.port)" }
if ($config.key) { $env:TSUBASATERMINAL_SMOKE_KEY = $config.key }

$logDir = Join-Path $appRoot 'test-results-smoke'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'nightly.log'

Set-Location $appRoot
"===== $(Get-Date -Format o) nightly smoke =====" | Add-Content $log
npm run test:smoke 2>&1 | Add-Content $log
"===== exit $LASTEXITCODE =====" | Add-Content $log
exit $LASTEXITCODE
