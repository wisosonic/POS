# Starts the POS server and keeps it running. The scheduled task made by install-service.ps1 runs this at boot.
# It reads its settings from the env file (default C:\POS\service.env), frees the port if an old copy of the server is
# still holding it, then starts the server and restarts it a few seconds after it stops, for whatever reason.
# Logs: <data folder>\logs\api.log (normal) and api.err.log (errors).
param(
    [string]$EnvFile = 'C:\POS\service.env'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $EnvFile)) { throw "Settings file not found: $EnvFile. Run install-service.ps1 first." }

foreach ($line in Get-Content $EnvFile) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { continue }
    [Environment]::SetEnvironmentVariable($line.Substring(0, $i).Trim(), $line.Substring($i + 1).Trim(), 'Process')
}

foreach ($required in 'NODE_EXE', 'APP_DIR', 'DATABASE_PATH') {
    if (-not [Environment]::GetEnvironmentVariable($required, 'Process')) { throw "$required is missing from $EnvFile" }
}

$logDir = Join-Path (Split-Path $env:DATABASE_PATH -Parent) 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir 'api.log'
$err = Join-Path $logDir 'api.err.log'
$launcher = Join-Path $logDir 'launcher.log'
$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }

function Write-Launcher([string]$text) {
    Add-Content -Path $launcher -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text)
}

# A stopped task can leave its node process behind, still holding the port. Only ever stop node.exe here.
function Free-Port {
    $held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $held) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') {
            Write-Launcher "port $port is held by an old server (pid $($p.Id)); stopping it"
            Stop-Process -Id $p.Id -Force
            Start-Sleep -Seconds 2
        } elseif ($p) {
            Write-Launcher "port $port is held by $($p.ProcessName), which is not ours; the server will fail to start until it is closed"
        }
    }
}

# Keep each log from growing for ever: past 20 MB the old one is set aside (one generation is kept).
function Rotate([string]$path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt 20MB)) {
        Move-Item -Force $path "$path.old"
    }
}

Write-Launcher "launcher started (port $port)"
while ($true) {
    Free-Port
    Rotate $out
    Rotate $err
    Write-Launcher 'starting the server'
    $p = Start-Process -FilePath $env:NODE_EXE `
        -ArgumentList @('--import', 'tsx', 'apps/api/src/index.ts') `
        -WorkingDirectory $env:APP_DIR `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $p.WaitForExit()
    Write-Launcher "the server stopped (exit code $($p.ExitCode)); starting it again in 5 seconds"
    Start-Sleep -Seconds 5
}
