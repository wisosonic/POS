# Starts the POS print agent and keeps it running. The scheduled task made by install-print-agent.ps1 runs this at boot.
# The agent connects OUT to the POS server, asks for this till's receipts and prints them on the local USB printer.
# It is restarted a few seconds after it stops, for whatever reason, EXCEPT when the server says it is no longer accepted
# (exit code 2: the admin disconnected it): then it stays stopped until it is enrolled again, because retrying cannot help.
# Logs: <agent folder>\logs\agent.log
param(
    [string]$ConfigFile = 'C:\POS\agent\agent.json',
    [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigFile)) { throw "Agent file not found: $ConfigFile. Run install-print-agent.ps1 first." }
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }

$logDir = Join-Path (Split-Path $ConfigFile -Parent) 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir 'agent.log'
$err = Join-Path $logDir 'agent.err.log'
$launcher = Join-Path $logDir 'launcher.log'

function Write-Launcher([string]$text) {
    Add-Content -Path $launcher -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text)
}

# Keep each log from growing for ever: past 20 MB the old one is set aside (one generation is kept).
function Rotate([string]$path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt 20MB)) {
        Move-Item -Force $path "$path.old"
    }
}

Write-Launcher 'launcher started'
while ($true) {
    Rotate $out
    Rotate $err
    Write-Launcher 'starting the print agent'
    $p = Start-Process -FilePath $NodeExe `
        -ArgumentList @('--import', 'tsx', 'apps/api/src/cli/print-agent.ts', 'run', '--config', $ConfigFile) `
        -WorkingDirectory $AppDir `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $p.WaitForExit()
    if ($p.ExitCode -eq 2) {
        Write-Launcher 'the server no longer accepts this print agent (it was disconnected). Not restarting: ask the admin for a new code and run install-print-agent.ps1 again.'
        exit 2
    }
    Write-Launcher "the print agent stopped (exit code $($p.ExitCode)); starting it again in 5 seconds"
    Start-Sleep -Seconds 5
}
