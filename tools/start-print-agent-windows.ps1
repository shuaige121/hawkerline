Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$EnvFile = Join-Path $Root ".print-agent.env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $parts = $_ -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

if (-not $env:HL_PRINT_MODE) { $env:HL_PRINT_MODE = "tspl" }
if (-not $env:HL_PRINT_PRINTER) { $env:HL_PRINT_PRINTER = "GP-3120TN" }
if (-not $env:HL_TSPL_WIDTH_MM) { $env:HL_TSPL_WIDTH_MM = "76" }
if (-not $env:HL_TSPL_HEIGHT_MM) { $env:HL_TSPL_HEIGHT_MM = "120" }
if (-not $env:HL_TSPL_GAP_MM) { $env:HL_TSPL_GAP_MM = "0" }
if (-not $env:HL_TSPL_COLS) { $env:HL_TSPL_COLS = "32" }

if (-not $env:HL_KITCHEN_URL -and (-not $env:HL_PRINT_BASE_URL -or (-not $env:HL_PRINT_TOKEN -and -not $env:HL_KITCHEN_PASSWORD))) {
  throw "Missing HL_KITCHEN_URL, or HL_PRINT_BASE_URL + HL_PRINT_TOKEN, or HL_PRINT_BASE_URL + HL_KITCHEN_PASSWORD. Create .print-agent.env from .print-agent.env.example first."
}

if ($args -contains "-DisableSleep") {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change monitor-timeout-ac 0 | Out-Null
  Write-Host "AC sleep and monitor timeout disabled. Restore in Windows Power settings when needed."
}

Write-Host "Starting Hawkerline print agent. Press Ctrl-C to stop."
npm run print-agent
