# Installs the POS server on the shop PC so that it starts by itself when Windows starts and starts again if it stops.
# Run it once, in a PowerShell window opened as Administrator, after `npm install` and `npm run build`:
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -BackupDir D:\POS-backups -BackupCopyDir E:\POS-backups
#
# -DryRun    shows every step and changes nothing
# -Uninstall removes the startup task (the data and the backups are left alone)
#
# It runs the server as a Windows scheduled task named "Darwish POS" that starts at boot (before anyone signs in), as the
# SYSTEM account, with run-server.ps1 restarting the server whenever it stops. See docs/07-operations.md.
param(
    [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$DataDir = 'C:\POS',
    [string]$BackupDir,
    [string]$BackupCopyDir,
    [string]$BackupAt = '02:00',
    [int]$Port = 3000,
    [string]$TlsCert,
    [string]$TlsKey,
    [switch]$NoBackupEncryption,
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Darwish POS'
$EnvFile = Join-Path $DataDir 'service.env'

function Step([string]$text, [scriptblock]$action) {
    if ($DryRun) { Write-Host "[dry run] $text" -ForegroundColor Cyan; return }
    Write-Host $text
    & $action
}

if (-not $DryRun) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw 'Open PowerShell as Administrator (right-click, Run as administrator) and run this again.' }
}

# ---------------------------------------------------------------- remove
if ($Uninstall) {
    Step "Stopping and removing the task '$TaskName'" {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        foreach ($c in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
            $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force }
        }
    }
    Write-Host "Done. The data in $DataDir and your backups were not touched."
    return
}

# ---------------------------------------------------------------- checks
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is not installed (or not on the PATH). Install Node.js 22 or newer for all users, then run this again.' }
# (Not `node -p "..."`: Windows PowerShell strips the quotes inside a command line passed to a program.)
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') { throw "Could not read the Node.js version (got '$nodeVersion')." }
if ([int]$Matches[1] -lt 22) { throw "Node.js 22 or newer is needed; this PC has $nodeVersion." }

$dist = Join-Path $InstallDir 'apps\web\dist\index.html'
if (-not (Test-Path $dist)) { throw "The web app is not built. Run 'npm run build' in $InstallDir first." }
if (-not (Test-Path (Join-Path $InstallDir 'node_modules'))) { throw "Run 'npm install' in $InstallDir first." }
if ($BackupAt -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "-BackupAt must be a time such as 02:00." }
if ($BackupCopyDir -and -not $BackupDir) { throw '-BackupCopyDir needs -BackupDir as well.' }

# ---------------------------------------------------------------- settings file
if (Test-Path $EnvFile) {
    Write-Host "Keeping the existing settings in $EnvFile (edit that file to change them)."
} else {
    $passphrase = ''
    if ($BackupDir -and -not $NoBackupEncryption) {
        if ($DryRun) {
            $passphrase = '(you would be asked for a backup passphrase here)'
        } else {
            Write-Host ''
            Write-Host 'Backups are encrypted with a passphrase. WRITE IT DOWN and keep it somewhere safe and away from this PC:'
            Write-Host 'without it a backup cannot be restored, and nobody can recover it for you.'
            $a = Read-Host 'Backup passphrase (at least 12 characters)' -AsSecureString
            $b = Read-Host 'Type it again' -AsSecureString
            $pa = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
            $pb = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
            if ($pa -ne $pb) { throw 'The two passphrases are different. Nothing was installed.' }
            if ($pa.Length -lt 12) { throw 'The passphrase must be at least 12 characters. Nothing was installed.' }
            $passphrase = $pa
        }
    }

    if (($TlsCert -and -not $TlsKey) -or ($TlsKey -and -not $TlsCert)) { throw 'Give both -TlsCert and -TlsKey, or neither. Nothing was installed.' }
    if ($TlsCert -and -not ((Test-Path $TlsCert) -and (Test-Path $TlsKey))) { throw 'The certificate or key file was not found. Nothing was installed.' }

    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'

    $lines = @(
        '# Settings for the POS server. Read by run-server.ps1 each time the server starts.',
        'NODE_ENV=production',
        "NODE_EXE=$($node.Source)",
        "APP_DIR=$InstallDir",
        "DATABASE_PATH=$(Join-Path $DataDir 'pos.db')",
        "WEB_DIST=$(Join-Path $InstallDir 'apps\web\dist')",
        "PORT=$Port",
        "JWT_SECRET=$secret"
    )
    if ($TlsCert) {
        $lines += "TLS_CERT=$TlsCert"
        $lines += "TLS_KEY=$TlsKey"
    }
    if ($BackupDir) {
        $lines += "BACKUP_DIR=$BackupDir"
        $lines += "BACKUP_AT=$BackupAt"
        if ($BackupCopyDir) { $lines += "BACKUP_COPY_DIR=$BackupCopyDir" }
        if ($passphrase) { $lines += "BACKUP_PASSPHRASE=$passphrase" }
    }

    Step "Creating $DataDir and the settings file $EnvFile" {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
        # The file holds the login secret and the backup passphrase: only administrators and the service itself may read it.
        & icacls $EnvFile /inheritance:r /grant:r 'SYSTEM:(R)' 'BUILTIN\Administrators:(F)' | Out-Null
    }
    if (-not $BackupDir) { Write-Host 'WARNING: no -BackupDir was given, so there will be NO backups. Run this again with -BackupDir, or edit the settings file.' -ForegroundColor Yellow }
    if ($BackupDir -and $NoBackupEncryption) { Write-Host 'WARNING: backups will NOT be encrypted.' -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- the startup task
$launcher = Join-Path $InstallDir 'scripts\windows\run-server.ps1'
Step "Registering the startup task '$TaskName'" {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -EnvFile `"$EnvFile`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Darwish Market POS server (starts at boot, restarts if it stops)' -Force | Out-Null
}

Step "Starting it now" { Start-ScheduledTask -TaskName $TaskName }

if (-not $DryRun) {
    $up = $false
    $scheme = 'http'
    if ($TlsCert) {
        $scheme = 'https'
        # The certificate is the shop's own, not one a browser already trusts: accept it for this one check on this PC.
        [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }
    foreach ($i in 1..40) {
        Start-Sleep -Seconds 1
        try { if ((Invoke-WebRequest -UseBasicParsing "$($scheme)://127.0.0.1:$Port/api/v1/healthz" -TimeoutSec 2).StatusCode -eq 200) { $up = $true; break } } catch { }
    }
    if ($up) {
        Write-Host ''
        Write-Host "The POS is running at $($scheme)://localhost:$Port and will start by itself when the PC starts." -ForegroundColor Green
        Write-Host "Next: create the first admin account (see docs/07-operations.md), then open the address above in the browser."
    } else {
        Write-Host "The server did not answer within 40 seconds. Look at $(Join-Path $DataDir 'logs')\api.err.log and launcher.log." -ForegroundColor Red
        exit 1
    }
}
