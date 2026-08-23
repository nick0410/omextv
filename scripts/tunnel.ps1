# Expose the local API through a Cloudflare quick tunnel and point the
# deployed frontend at it.
#
# Quick tunnels hand out a new hostname every time they start, and Vite bakes
# the API URL in at build time — so a restart means updating the Vercel
# environment and rebuilding. Doing that by hand is three commands and easy to
# half-finish, which leaves the live site pointing at a dead tunnel.
#
#   powershell -File scripts/tunnel.ps1
#
# Note: --protocol http2 is deliberate. The default (QUIC over UDP) is blocked
# on many networks and produces a tunnel that connects, serves a few requests,
# then drops into an endless retry loop.

$ErrorActionPreference = 'Stop'

# cloudflared may be on PATH, installed by winget, or just a downloaded exe
# sitting in a folder — check all three rather than assuming one.
$candidates = @(
  (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
  "C:\Program Files (x86)\cloudflared\cloudflared.exe",
  "C:\Program Files\cloudflared\cloudflared.exe",
  (Join-Path $env:USERPROFILE 'checker\cloudflared.exe'),
  (Join-Path $env:USERPROFILE 'cloudflared.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw "cloudflared not found. winget install Cloudflare.cloudflared" }

# The API has to be up first, or the tunnel serves 502s.
try {
  Invoke-RestMethod -Uri 'http://localhost:3001/health' -TimeoutSec 5 | Out-Null
} catch {
  throw "The API is not responding on :3001. Start it with: cd server; npm run dev"
}

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$log = Join-Path $env:TEMP 'omextv-tunnel.log'
Remove-Item $log -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $exe `
  -ArgumentList 'tunnel', '--url', 'http://localhost:3001', '--protocol', 'http2', '--no-autoupdate' `
  -RedirectStandardError $log -WindowStyle Hidden

Write-Host 'Waiting for the tunnel hostname...'
$url = $null
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  $match = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($match) { $url = $match.Matches[0].Value; break }
}
if (-not $url) { throw "Tunnel did not come up. See $log" }

Write-Host "Tunnel: $url"

# Confirm it actually serves before rebuilding against it.
#
# This is a warning, not a gate. A brand-new hostname takes a moment to
# propagate, and some resolvers hand back only an unroutable AAAA record for
# trycloudflare.com — in both cases the tunnel is fine for everyone else while
# being unreachable from here. Aborting on that used to leave the deployed
# site pointing at the *previous*, genuinely dead tunnel, which is far worse
# than deploying one this machine merely cannot see.
$ok = $false
foreach ($i in 1..20) {
  try {
    Invoke-RestMethod -Uri "$url/health" -TimeoutSec 10 | Out-Null
    $ok = $true
    break
  } catch { Start-Sleep -Seconds 5 }
}
if ($ok) {
  Write-Host 'Tunnel is serving.' -ForegroundColor Green
} else {
  Write-Warning "Could not reach $url from this machine (likely local DNS). Deploying anyway."
}

# Publish the new hostname where the deployed client will look for it.
#
# This used to rewrite the Vercel environment and force a rebuild, which took
# minutes and shipped a hostname baked into the bundle — so the site was dead
# for the whole build every time the tunnel restarted. The client now reads
# runtime-config.json at boot, so a push is enough and the next page load
# picks it up.
$repo = Join-Path $PSScriptRoot '..'
$configPath = Join-Path $repo 'runtime-config.json'

$config = [ordered]@{
  _comment  = 'Where the live API is. Rewritten by scripts/tunnel.ps1; the deployed client reads it at boot so a new tunnel needs no rebuild.'
  updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  apiUrl    = $url
  socketUrl = $url
}
# Written without a byte-order mark. Set-Content -Encoding UTF8 adds one, and
# GitHub serves this file as text/plain, so every consumer that parses the text
# itself hits an invalid leading character. Browsers happen to strip it during
# their UTF-8 decode; PowerShell's ConvertFrom-Json does not, which is how it
# was found. WriteAllText with an explicit encoding behaves the same on
# PowerShell 5.1 and 7.
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $repo
try {
  git add runtime-config.json
  # Nothing to do if the tunnel came back on the same hostname.
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'Hostname unchanged; nothing to publish.'
  } else {
    git commit -q -m "Point the client at $url"
    git push -q origin main
    Write-Host 'Published the new hostname.' -ForegroundColor Green
  }
} finally {
  Pop-Location
}

# Confirm the document really reflects the change before claiming the site is
# fixed.
#
# The push landing is not the same as visitors seeing it: raw.githubusercontent
# caches for five minutes and ignores query strings when deciding what to serve,
# so the cache-buster the client sends does not shorten this at all. The wait
# below is the real propagation delay, not a formality.
$raw = 'https://raw.githubusercontent.com/nick0410/omextv/main/runtime-config.json'
$published = $false
foreach ($i in 1..10) {
  Start-Sleep -Seconds 3
  try {
    # ConvertFrom-Json explicitly — see status.ps1. Without it this compared
    # a property of a plain string against $url, which is never equal, so the
    # loop always ran out and always warned that publishing had not caught up.
    # A warning that fires every single time is one nobody can act on, and it
    # would have hidden a push that genuinely failed.
    $body = Invoke-RestMethod "${raw}?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -TimeoutSec 15
    $doc = $body.TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($doc.apiUrl -eq $url) { $published = $true; break }
  } catch { }
}
if ($published) {
  Write-Host 'The published config now points at this tunnel.' -ForegroundColor Green
} else {
  Write-Warning 'The published config has not caught up yet. Give it a minute and reload.'
}

Write-Host ''
Write-Host "Live:   https://omextv.vercel.app"
Write-Host "API:    $url"
Write-Host "Log:    $log"
