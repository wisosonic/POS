# Installs the POS print agent on a till PC whose receipt printer is NOT on the same PC as the POS server, so that it starts by
# itself when Windows starts and starts again if it stops. Skip this if the server and the printer are on the same PC.
# Run it once, in a PowerShell window opened as Administrator, on the till PC, after `npm install`:
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-print-agent.ps1 -Server http://192.168.1.10:3000 -Code XXXXX-XXXXX -Printer "POS-80"
#
# Where the code comes from: Menu > Settings > Tills, press "Use a print agent" on this till, then "Agent code" (valid 30 minutes,
# works once). -Printer is the printer's exact name in Windows (Printers and scanners). It must be installed for ALL users.
#
# -DryRun    shows every step and changes nothing
# -Uninstall removes the startup task (the agent file with its token is left; delete C:\POS\agent to remove it too)
#
# It runs the agent as a Windows scheduled task named "Darwish POS print agent" that starts at boot, as the SYSTEM account, with
# run-print-agent.ps1 restarting it whenever it stops. See docs/07-operations.md ("A print agent").
param(
    [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$DataDir = 'C:\POS\agent',
    [string]$Server,
    [string]$Code,
    [string]$Printer,
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Darwish POS print agent'
$ConfigFile = Join-Path $DataDir 'agent.json'

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
        # A stopped task can leave its node process behind. Only ever stop the node.exe that runs the print agent.
        foreach ($p in (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
            if ($p.CommandLine -like '*cli/print-agent.ts*') { Stop-Process -Id $p.ProcessId -Force }
        }
    }
    Write-Host "Done. The agent file in $DataDir was not touched."
    return
}

# ---------------------------------------------------------------- checks
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is not installed (or not on the PATH). Install Node.js 22 or newer for all users, then run this again.' }
# (Not `node -p "..."`: Windows PowerShell strips the quotes inside a command line passed to a program.)
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') { throw "Could not read the Node.js version (got '$nodeVersion')." }
if ([int]$Matches[1] -lt 22) { throw "Node.js 22 or newer is needed; this PC has $nodeVersion." }
if (-not (Test-Path (Join-Path $InstallDir 'node_modules'))) { throw "Run 'npm install' in $InstallDir first." }

$haveConfig = Test-Path $ConfigFile
if (-not $haveConfig) {
    if (-not $Server -or -not $Code -or -not $Printer) {
        throw 'The first time, give -Server (the POS server address), -Code (from Settings > Tills > Agent code) and -Printer (its name in Windows).'
    }
    if ($Server -notmatch '^https?://') { throw "-Server must start with http:// or https:// (got '$Server')." }
    if ($Code -notmatch '^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$') { throw "-Code looks wrong. It is ten letters and digits, like XXXXX-XXXXX (got '$Code')." }
} else {
    Write-Host "Keeping the existing agent file $ConfigFile (to enrol again, delete it and give a new -Code)."
}

# ---------------------------------------------------------------- enrol (the code becomes the agent's own token)
if (-not $haveConfig) {
    Step "Enrolling this PC as the print agent for $Server (printer '$Printer')" {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        Push-Location $InstallDir
        try {
            & $node.Source --import tsx apps/api/src/cli/print-agent.ts enrol --server $Server --code $Code --printer $Printer --config $ConfigFile
            if ($LASTEXITCODE -ne 0) { throw 'Enrolment failed (see the message above). Nothing was installed.' }
        } finally { Pop-Location }
        # The file holds the agent's token: only administrators and the agent itself (SYSTEM) may read it.
        & icacls $ConfigFile /inheritance:r /grant:r 'SYSTEM:(R)' 'BUILTIN\Administrators:(F)' | Out-Null
    }
}

# ---------------------------------------------------------------- the startup task
$launcher = Join-Path $InstallDir 'scripts\windows\run-print-agent.ps1'
Step "Registering the startup task '$TaskName'" {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -ConfigFile `"$ConfigFile`" -AppDir `"$InstallDir`" -NodeExe `"$($node.Source)`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Darwish Market POS print agent (starts at boot, restarts if it stops)' -Force | Out-Null
}

Step 'Starting it now' { Start-ScheduledTask -TaskName $TaskName }

if (-not $DryRun) {
    $log = Join-Path $DataDir 'logs\agent.log'
    $up = $false
    foreach ($i in 1..30) {
        Start-Sleep -Seconds 1
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Print agent running' -Quiet)) { $up = $true; break }
    }
    if ($up) {
        Write-Host ''
        Write-Host 'The print agent is running and will start by itself when this PC starts.' -ForegroundColor Green
        Write-Host 'Next: in the POS (Menu > Settings > Tills) the till should show "Print agent: online". Sell something and check the receipt prints and the drawer opens.'
    } else {
        Write-Host "The agent did not report that it was running within 30 seconds. Look at $DataDir\logs\agent.err.log and launcher.log." -ForegroundColor Red
        exit 1
    }
}
