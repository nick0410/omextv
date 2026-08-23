# Bring the whole local backend up in the right order.
#
# The pieces have a dependency order that is easy to get wrong by hand: the API
# refuses to boot when REDIS_URL is set and Redis is not answering, and Prisma
# fails on a database that is not accepting connections yet. Starting them out
# of order produces an error about the wrong component.
#
#   powershell -File scripts/start-stack.ps1

$ErrorActionPreference = 'Stop'

$redisDir = Join-Path $env:USERPROFILE 'redislocal'
$pgDir    = Join-Path $env:USERPROFILE 'pglocal\pgsql\bin'
$pgData   = Join-Path $env:USERPROFILE 'pglocal\data'

function Running($name) {
  return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue)
}

# --- Postgres ---
if (Test-Path $pgDir) {
  & "$pgDir\pg_isready.exe" -h localhost -p 5432 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Starting Postgres...'
    & "$pgDir\pg_ctl.exe" -D $pgData -l (Join-Path $env:USERPROFILE 'pglocal\pg.log') start
    Start-Sleep -Seconds 3
  }
  & "$pgDir\pg_isready.exe" -h localhost -p 5432
} else {
  Write-Warning "Postgres not found at $pgDir"
}

# --- Redis ---
# Port 6380, not the default.
#
# Something else on this machine already wanted Redis on 6379 and quietly
# started writing its own job queue into the instance Omextv was using. They
# would then share one 256 MB noeviction budget, so the other app filling it
# would make Omextv's writes start failing — a failure that looks like
# matchmaking randomly breaking rather than like a full database.
$redisPort = 6380
$redisData = Join-Path $redisDir 'omextv-data'

$mine = Get-Process -Name 'redis-server' -ErrorAction SilentlyContinue
$listening = Test-NetConnection -ComputerName 'localhost' -Port $redisPort `
  -InformationLevel Quiet -WarningAction SilentlyContinue

if (-not $listening) {
  if (-not (Test-Path "$redisDir\redis-server.exe")) {
    throw "Redis not found at $redisDir. Unset REDIS_URL in server/.env to run without it."
  }
  Write-Host 'Starting Redis...'
  # --save keeps a periodic snapshot so a restart does not start from nothing.
  Start-Process -FilePath "$redisDir\redis-server.exe" `
    -ArgumentList '--port', '6379', '--save', '60', '1', '--appendonly', 'no',
                  '--maxmemory', '256mb', '--maxmemory-policy', 'noeviction' `
    -WorkingDirectory $redisDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
$pong = & "$redisDir\redis-cli.exe" ping
if ($pong -ne 'PONG') { throw "Redis did not answer (got '$pong')" }
Write-Host 'Redis: PONG' -ForegroundColor Green

# --- API ---
$apiUp = $false
try {
  Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 4 | Out-Null
  $apiUp = $true
} catch { }

if ($apiUp) {
  Write-Host 'API is already running.' -ForegroundColor Green
} else {
  Write-Host 'Starting the API...'
  Start-Process -FilePath 'npm' -ArgumentList 'run', 'dev' `
    -WorkingDirectory (Join-Path $PSScriptRoot '..\server') -WindowStyle Hidden
  foreach ($i in 1..25) {
    Start-Sleep -Seconds 2
    try {
      $h = Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 4
      Write-Host "API: $($h.status), store=$($h.store)" -ForegroundColor Green
      $apiUp = $true
      break
    } catch { }
  }
  if (-not $apiUp) { throw 'The API did not come up. See server output.' }
}

Write-Host ''
Write-Host 'Next: powershell -File scripts/tunnel.ps1   (expose it and redeploy)'
