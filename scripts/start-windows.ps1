$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 or newer is required. Install it from https://nodejs.org/'
}
if (-not $env:PORT) { $env:PORT = '8080' }
node server.mjs
