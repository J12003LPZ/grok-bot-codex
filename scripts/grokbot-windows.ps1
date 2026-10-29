# Runs the installed Windows Grok Bot on your ChatGPT plan.
#   1. builds generated/ from the installed app if it is missing or from
#      another app version,
#   2. starts the shim (http://localhost:8444) if nothing listens there,
#   3. opens Grok Bot against the shim (skipped with -ShimOnly).
# The shim starts the box container (computerctl.sh) when the app asks for it.
# Run `npm run auth` once first. Usage: powershell -File scripts\grokbot-windows.ps1
# scripts\install-windows.ps1 makes every launch of Grok Bot use the shim.
param(
  [string]$App = "$env:LOCALAPPDATA\Programs\Grok Bot\Grok Bot.exe",
  # Empty: the app's default profile, the same one the Start menu and the
  # app's own post-update relaunch use.
  [string]$ProfileDir = "",
  [int]$Port = 8444,
  # Turns off Chromium's renderer sandbox. Only needed when the Computer preview
  # stays blank; leave it off otherwise.
  [switch]$NoSandbox,
  # Prepare the schema and start the shim, but do not open the app (logon task).
  [switch]$ShimOnly
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $App)) { throw "Grok Bot not found at $App (pass -App <path to Grok Bot.exe>)" }

# Rebuild the schema whenever the installed app version differs from the one
# it was built from (an update ships new messages). The installer keeps
# app.asar's build timestamp, so compare versions, not file times. A running
# shim keeps the old schema until it restarts, so restart it too.
$asar = Join-Path (Split-Path $App) "resources\app.asar"
$proto = Join-Path $Root "generated\app.proto"
$stamp = Join-Path $Root "generated\app-version.txt"
$appVersion = (Get-Item $App).VersionInfo.ProductVersion
$builtFor = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
$staleSchema = -not (Test-Path $proto) -or $builtFor -ne $appVersion
if ($staleSchema) {
  & node (Join-Path $Root "scripts\gen-proto.mjs") $asar (Join-Path $Root "generated")
  if ($LASTEXITCODE -ne 0) { throw "gen-proto failed" }
  Set-Content -Path $stamp -Value $appVersion -NoNewline
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" } |
    Where-Object { $_.CommandLine -like "*shim*server.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $log = Join-Path $Root "state\shim.log"
  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  # Win32_Process.Create, not Start-Process: a Start-Process child inherits this
  # console's handles and keeps a caller's output pipe open after we exit.
  $node = (Get-Command node -ErrorAction Stop).Source
  $cmd = "cmd.exe /c set HTTP_PORT=$Port&& `"$node`" `"$(Join-Path $Root 'shim\server.mjs')`" >> `"$log`" 2>&1"
  $made = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $Root }
  if ($made.ReturnValue -ne 0) { throw "could not start the shim (Win32_Process.Create returned $($made.ReturnValue))" }
  for ($i = 0; $i -lt 30 -and -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { throw "shim did not start; see $log" }
}

# The shim starts the box container itself when the app asks for it
# (EnsureSandBox), so it is not started here. It needs Git Bash for that.
$bash = @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) { throw "Git Bash not found; install Git for Windows" }
if ($ShimOnly) {
  Write-Host "shim ready on http://localhost:$Port (Grok Bot $appVersion)"
  return
}

# Dev sign-in against a localhost backend: no Grok Bot subscription is involved.
$env:SAND_BACKEND_URL = "http://localhost:$Port"
$env:SAND_DEV_LOGIN = "Ultra"
# The shim only accepts this per-install address (state/desktop-login.token).
$env:SAND_DEV_LOGIN_EMAIL = (& node (Join-Path $Root "shim\secrets.mjs") desktop-login-email)
if ($LASTEXITCODE -ne 0 -or -not $env:SAND_DEV_LOGIN_EMAIL) { throw "could not read the sign-in address" }
$appArgs = @()
if ($ProfileDir) {
  New-Item -ItemType Directory -Force $ProfileDir | Out-Null
  $appArgs += "--user-data-dir=`"$ProfileDir`""
}
if ($NoSandbox) {
  Write-Warning "starting with --no-sandbox: web content in the app runs without Chromium's sandbox"
  $appArgs += "--no-sandbox"
}
if ($appArgs.Count -gt 0) { Start-Process $App -ArgumentList $appArgs } else { Start-Process $App }
Write-Host "Grok Bot $appVersion started against http://localhost:$Port"
