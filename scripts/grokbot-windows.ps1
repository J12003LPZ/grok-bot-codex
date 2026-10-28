# Runs the installed Windows Grok Bot on your ChatGPT plan.
#   1. builds generated/ from the installed app if it is missing,
#   2. starts the shim (http://localhost:8444) if nothing listens there,
#   3. starts the local box container (computerctl.sh),
#   4. opens Grok Bot in its own profile against the shim.
# Run `npm run auth` once first. Usage: powershell -File scripts\grokbot-windows.ps1
param(
  [string]$App = "$env:LOCALAPPDATA\Programs\Grok Bot\Grok Bot.exe",
  [string]$ProfileDir = "$env:LOCALAPPDATA\grokbot-shim\profile",
  [int]$Port = 8444,
  # Turns off Chromium's renderer sandbox. Only needed when the Computer preview
  # stays blank; leave it off otherwise.
  [switch]$NoSandbox
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $App)) { throw "Grok Bot not found at $App (pass -App <path to Grok Bot.exe>)" }

if (-not (Test-Path (Join-Path $Root "generated\app.proto"))) {
  & node (Join-Path $Root "scripts\gen-proto.mjs") (Join-Path (Split-Path $App) "resources\app.asar") (Join-Path $Root "generated")
  if ($LASTEXITCODE -ne 0) { throw "gen-proto failed" }
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $log = Join-Path $Root "state\shim.log"
  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  $env:HTTP_PORT = "$Port"
  Start-Process node -ArgumentList "`"$(Join-Path $Root 'shim\server.mjs')`"" -WorkingDirectory $Root `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  for ($i = 0; $i -lt 30 -and -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { throw "shim did not start; see $log.err" }
}

# Git Bash, not WSL's bash.exe: computerctl.sh drives Docker Desktop from Windows.
$bash = @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) { throw "Git Bash not found; install Git for Windows" }
$env:HTTP_PORT = "$Port"
& $bash (Join-Path $Root "computerctl.sh") start
if ($LASTEXITCODE -ne 0) { Write-Warning "box not ready yet; the app keeps retrying while it boots" }

# Dev sign-in against a localhost backend: no Grok Bot subscription is involved.
$env:SAND_BACKEND_URL = "http://localhost:$Port"
$env:SAND_DEV_LOGIN = "Ultra"
$env:SAND_DEV_LOGIN_EMAIL = "shim@local"
New-Item -ItemType Directory -Force $ProfileDir | Out-Null
$appArgs = @("--user-data-dir=`"$ProfileDir`"")
if ($NoSandbox) {
  Write-Warning "starting with --no-sandbox: web content in the app runs without Chromium's sandbox"
  $appArgs += "--no-sandbox"
}
Start-Process $App -ArgumentList $appArgs
Write-Host "Grok Bot started against http://localhost:$Port (profile $ProfileDir)"
