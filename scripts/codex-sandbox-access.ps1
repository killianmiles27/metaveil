# Keeps Codex's elevated Windows sandbox (group CodexSandboxUsers) able to run per-user tools
# that Orca workers need. Read/execute only; nothing is made writable.
#
# Why it is needed:
#   - Codex's sandbox can't read per-user installs under %LOCALAPPDATA%\Programs, so `orca`
#     and `python` are "not recognized" inside it.
#   - An Orca update reinstalls %LOCALAPPDATA%\Programs\orca, dropping any grant on it.
#   - Orca recreates %APPDATA%\orca\orca-runtime.json on every start, dropping its grant.
#     The rest of %APPDATA%\orca holds Orca's keys, so only that one file is granted.
#
# Usage (normal PowerShell, no admin needed; you own these paths):
#   powershell -ExecutionPolicy Bypass -File codex-sandbox-access.ps1 -Install    # watcher at logon, starts now
#   powershell -ExecutionPolicy Bypass -File codex-sandbox-access.ps1 -Once       # apply once and exit
#   powershell -ExecutionPolicy Bypass -File codex-sandbox-access.ps1 -Uninstall  # remove the watcher
param([switch]$Install, [switch]$Uninstall, [switch]$Once, [switch]$Watch)

$ErrorActionPreference = 'Stop'
$Group = "$env:COMPUTERNAME\CodexSandboxUsers"
$TaskName = 'Codex sandbox access for Orca'
$Folders = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\orca'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python')
)
$RuntimeDir = Join-Path $env:APPDATA 'orca'
$RuntimeFile = Join-Path $RuntimeDir 'orca-runtime.json'
$Log = Join-Path $env:LOCALAPPDATA 'metaveil\codex-sandbox-access.log'

function Write-Log($msg) {
  try {
    New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
    Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format o), $msg)
  } catch {}
}

function Test-Grant($path, $rights) {
  $acl = (& icacls.exe $path 2>$null) -join "`n"
  return $acl -match [regex]::Escape("${Group}:$rights") -or $acl -match [regex]::Escape("CodexSandboxUsers:$rights")
}

function Ensure-Access {
  if (-not (Get-LocalGroup -Name CodexSandboxUsers -ErrorAction SilentlyContinue)) { Write-Log 'CodexSandboxUsers group not found; nothing to do'; return }
  foreach ($folder in $Folders) {
    if (-not (Test-Path $folder)) { continue }
    if (Test-Grant $folder '(OI)(CI)(RX)') { continue }
    & icacls.exe $folder /grant "${Group}:(OI)(CI)(RX)" /T /C /Q | Out-Null
    Write-Log "granted read/execute on $folder (exit $LASTEXITCODE)"
  }
  if ((Test-Path $RuntimeFile) -and -not (Test-Grant $RuntimeFile '(R)')) {
    & icacls.exe $RuntimeFile /grant "${Group}:(R)" | Out-Null
    Write-Log "granted read on orca-runtime.json (exit $LASTEXITCODE)"
  }
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'codex-sandbox-access\.ps1.*-Watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  'Removed the watcher. Existing grants were left in place.'
  return
}

if ($Install) {
  $self = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Watch"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Ensure-Access
  Start-ScheduledTask -TaskName $TaskName
  "Installed '$TaskName' (runs at logon, now running). Log: $Log"
  return
}

Ensure-Access
if ($Once) { 'Codex sandbox access checked.'; return }

if ($Watch) {
  # React within a second when Orca recreates its runtime file; recheck everything every
  # 10 minutes in case an Orca update replaced the program folder.
  $watcher = New-Object IO.FileSystemWatcher $RuntimeDir, 'orca-runtime.json'
  $watcher.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, CreationTime'
  $watcher.EnableRaisingEvents = $true
  Write-Log 'watcher started'
  $last = Get-Date
  while ($true) {
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, 60000)
    if (-not $change.TimedOut) { Start-Sleep -Milliseconds 300; Ensure-Access; continue }
    if (((Get-Date) - $last).TotalMinutes -ge 10) { Ensure-Access; $last = Get-Date }
  }
}
