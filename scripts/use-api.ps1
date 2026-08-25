# Point the deployed client at a fixed API address.
#
# The tunnel version of this had to run every time the hostname changed, which
# was every restart. A hosted API keeps one address, so this is meant to be run
# once and then forgotten.
#
#   powershell -File scripts/use-api.ps1 -Url "https://omextv-api.onrender.com"
#
# It checks the address actually serves before publishing it. Publishing first
# and checking afterwards is how the live site ended up pointing at Cloudflare's
# own API for an evening.

param(
  [Parameter(Mandatory = $true)][string]$Url,
  # Publish even if the address is not answering yet. For the gap right after
  # a first deploy, when the service exists but is still building.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$api = $Url.TrimEnd('/')
if ($api -notmatch '^https://[a-zA-Z0-9.-]+(:\d+)?$') {
  throw "Expected something like https://omextv-api.onrender.com, got '$Url'"
}

# A free instance may be asleep, and waking it is exactly what this request is
# for. Ninety seconds is longer than that takes.
Write-Host "Checking $api/health (a sleeping instance takes about a minute)..."
$healthy = $false
try {
  $health = Invoke-RestMethod "$api/health" -TimeoutSec 90
  $healthy = ($health.status -eq 'ok')
  if ($healthy) {
    Write-Host "  answering: store=$($health.store) db=$($health.dbOk)" -ForegroundColor Green
  } else {
    Write-Warning "  answered but reports '$($health.status)' (store=$($health.storeOk) db=$($health.dbOk))"
  }
} catch {
  Write-Warning "  no answer: $($_.Exception.Message)"
}

if (-not $healthy -and -not $Force) {
  throw "Not publishing an address that is not serving. Re-run with -Force if you are sure."
}

$repo = Join-Path $PSScriptRoot '..'
$configPath = Join-Path $repo 'runtime-config.json'

$config = [ordered]@{
  _comment  = 'Where the live API is. The deployed client reads this at boot, so moving the API needs no rebuild.'
  updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  apiUrl    = $api
  socketUrl = $api
}

# No byte-order mark: this is read as plain text by anything that parses it
# itself, and a mark in front of the first brace is not valid JSON.
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $repo
try {
  git add runtime-config.json
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'Already pointing there; nothing to publish.'
  } else {
    git commit -q -m "Point the client at $api"
    git push -q origin main
    Write-Host 'Published.' -ForegroundColor Green
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'raw.githubusercontent caches for five minutes and ignores query strings,'
Write-Host 'so the site can keep using the old address for a few minutes. That is'
Write-Host 'the propagation delay, not a failure.'
Write-Host ''
Write-Host "Live:  https://omextv.vercel.app"
Write-Host "API:   $api"
Write-Host "Admin: https://omextv.vercel.app/admin"
