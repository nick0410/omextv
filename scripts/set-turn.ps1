# Point Omextv at a TURN relay, then prove it actually works.
#
# Without a relay, two people behind symmetric NAT — which is most mobile
# networks and a lot of campus and office Wi-Fi — can never exchange media, no
# matter how well everything else works. STUN alone only helps when at least
# one side's NAT is predictable.
#
# Every free TURN provider requires an account, so the credentials have to come
# from you. This script only stores them and checks them; it never prints them
# back out.
#
#   powershell -File scripts/set-turn.ps1 `
#       -Url "turn:relay.example.com:80" `
#       -Username "..." -Credential "..."
#
# Or, for providers that hand out a shared secret instead of a fixed login
# (coturn's use-auth-secret / REST API):
#
#   powershell -File scripts/set-turn.ps1 -Url "turn:host:3478" -Secret "..."
#
# Add -Urls to list more transports; a TLS variant on 443 is the one that gets
# through restrictive firewalls, so include it when the provider offers one:
#
#   -Urls "turn:relay.example.com:443,turns:relay.example.com:443?transport=tcp"

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Username,
  [string]$Credential,
  [string]$Secret,
  [string]$Urls = ""
)

$ErrorActionPreference = 'Stop'

if (-not $Secret -and -not ($Username -and $Credential)) {
  throw "Supply either -Secret, or both -Username and -Credential."
}

$envPath = Join-Path $PSScriptRoot '..\server\.env'
if (-not (Test-Path $envPath)) { throw "server/.env not found at $envPath" }

# Rewrite in place, preserving every other line and its order — this file also
# holds the database URL and the JWT secret, and losing those is a much worse
# outcome than a missing relay.
$wanted = @{
  'TURN_SERVER_URL'        = $Url
  'TURN_URLS'              = $Urls
  'TURN_SERVER_USERNAME'   = $Username
  'TURN_SERVER_CREDENTIAL' = $Credential
  'TURN_SECRET'            = $Secret
}

$lines = [System.Collections.Generic.List[string]](Get-Content $envPath)
foreach ($key in $wanted.Keys) {
  $value = $wanted[$key]
  if ($null -eq $value) { $value = '' }
  $line = "$key=`"$value`""
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$key\s*=") { $idx = $i; break }
  }
  if ($idx -ge 0) { $lines[$idx] = $line } else { $lines.Add($line) }
}

# Back up before overwriting, so a bad run is recoverable.
Copy-Item $envPath "$envPath.bak" -Force
# WriteAllLines rather than Set-Content -Encoding UTF8, which prepends a
# byte-order mark. .env is read as plain text, so that mark becomes part of the
# first variable's name and it quietly stops being found.
[System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote TURN settings to server/.env (previous copy at .env.bak)" -ForegroundColor Green

Write-Host 'Waiting for the API to reload...'
$ok = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  try {
    Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 5 | Out-Null
    $ok = $true
    break
  } catch { }
}
if (-not $ok) { throw "The API did not come back. Start it with: cd server; npm run dev" }

# Ask the API what it now hands to browsers. hasTurn is computed from the same
# settings the client will receive, so this catches a half-filled config.
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$body = @{
  email = "turncheck$stamp@local.test"; password = 'turncheck12345'
  username = "turncheck$stamp"; gender = 'male'; country = 'IN'
} | ConvertTo-Json

$reg = Invoke-RestMethod 'http://localhost:3001/api/auth/register' -Method Post `
  -ContentType 'application/json' -Body $body
$ice = Invoke-RestMethod 'http://localhost:3001/api/rtc/ice-servers' `
  -Headers @{ Authorization = "Bearer $($reg.token)" }

if (-not $ice.hasTurn) {
  throw "The API still reports no TURN. Check the values in server/.env."
}
Write-Host 'The API is now handing out relay credentials.' -ForegroundColor Green

# The API believing it has a relay is not the same as the relay answering.
# Do the real RFC 5766 exchange before claiming this works.
Push-Location (Join-Path $PSScriptRoot '..\server')
try {
  $args = @('scripts/turn-check.mjs', $Url)
  if ($Username -and $Credential) { $args += @($Username, $Credential) }
  & node @args
  $allocated = ($LASTEXITCODE -eq 0)
} finally {
  Pop-Location
}

Write-Host ''
if ($allocated) {
  Write-Host 'Relay allocation succeeded.' -ForegroundColor Green
} else {
  Write-Warning 'The relay did not allocate. The credentials may be wrong, or UDP may be blocked here.'
}
Write-Host 'Confirm from a browser: open https://omextv.vercel.app/diagnostics and run the test.'
Write-Host 'Network path should now report at least 1 relay candidate.'
Write-Host ''
Write-Host 'Then redeploy so the site picks it up: powershell -File scripts/tunnel.ps1'
