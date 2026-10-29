# Makes every launch of Grok Bot use the shim, including the Start menu and
# the app's own relaunch after it updates itself:
#   - sets SAND_BACKEND_URL, SAND_DEV_LOGIN and SAND_DEV_LOGIN_EMAIL as user
#     environment variables (HKCU\Environment),
#   - registers a per-user logon task that starts the shim (and rebuilds the
#     schema after app updates) so it is up before the app opens.
# Nothing needs admin rights. Undo with: install-windows.ps1 -Uninstall
param(
  [int]$Port = 8444,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = "Grok Bot Codex shim"
$Vars = @("SAND_BACKEND_URL", "SAND_DEV_LOGIN", "SAND_DEV_LOGIN_EMAIL")

if ($Uninstall) {
  foreach ($v in $Vars) { [Environment]::SetEnvironmentVariable($v, $null, "User") }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Host "removed the user variables and the logon task; Grok Bot uses its own sign-in again"
  return
}

$email = (& node (Join-Path $Root "shim\secrets.mjs") desktop-login-email)
if ($LASTEXITCODE -ne 0 -or -not $email) { throw "could not read the sign-in address" }
# SetEnvironmentVariable(..., "User") also notifies Explorer, so apps started
# from the Start menu from now on see the values.
[Environment]::SetEnvironmentVariable("SAND_BACKEND_URL", "http://localhost:$Port", "User")
[Environment]::SetEnvironmentVariable("SAND_DEV_LOGIN", "Ultra", "User")
[Environment]::SetEnvironmentVariable("SAND_DEV_LOGIN_EMAIL", $email, "User")

$launcher = Join-Path $Root "scripts\grokbot-windows.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -ShimOnly -Port $Port" `
  -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Start it now too, so the app works without logging out first.
& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -ShimOnly -Port $Port
Write-Host "installed: Grok Bot now always signs in through the shim (logon task '$TaskName')"
Write-Host "close Grok Bot completely and open it again from the Start menu"
