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

$exe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\cloudflared\cloudflared.exe" }
if (-not (Test-Path $exe)) { throw "cloudflared not found. winget install Cloudflare.cloudflared" }

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
$ok = $false
foreach ($i in 1..10) {
  try {
    Invoke-RestMethod -Uri "$url/health" -TimeoutSec 10 | Out-Null
    $ok = $true
    break
  } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) { throw "Tunnel is up but not serving. See $log" }

Push-Location (Join-Path $PSScriptRoot '..\client')
try {
  foreach ($name in 'VITE_API_URL', 'VITE_SOCKET_URL') {
    npx vercel env rm $name production --yes 2>&1 | Out-Null
    $url | npx vercel env add $name production 2>&1 | Out-Null
  }
  Write-Host 'Rebuilding the frontend against the new tunnel...'
  # --force because only the environment changed; Vercel would otherwise reuse
  # the cached build and ship the previous, now-dead URL.
  npx vercel deploy --prod --yes --force 2>&1 | Select-String 'ready' | Select-Object -Last 1
} finally {
  Pop-Location
}

Write-Host ''
Write-Host "Live:   https://omextv.vercel.app"
Write-Host "API:    $url"
Write-Host "Log:    $log"
