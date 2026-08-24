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
#
# Read from server/.env rather than written down again here. The port lived in
# both places once and they drifted, which is a silent failure: whichever one
# is wrong still starts a perfectly healthy Redis, just not the one the API
# dials.
$envFile = Join-Path $PSScriptRoot '..\server\.env'
$redisPort = 6380
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*REDIS_URL\s*=\s*"?redis://[^:]+:(\d+)' |
    Select-Object -First 1
  if ($m) { $redisPort = [int]$m.Matches[0].Groups[1].Value }
}
$redisData = Join-Path $redisDir 'omextv-data'

$mine = Get-Process -Name 'redis-server' -ErrorAction SilentlyContinue
$listening = Test-NetConnection -ComputerName 'localhost' -Port $redisPort `
  -InformationLevel Quiet -WarningAction SilentlyContinue

if (-not $listening) {
  if (-not (Test-Path "$redisDir\redis-server.exe")) {
    throw "Redis not found at $redisDir. Unset REDIS_URL in server/.env to run without it."
  }
  Write-Host "Starting Redis on $redisPort..."
  # Every one of these has to name the port explicitly. Defaulting anywhere
  # here is what the port move was undoing: an unqualified start or ping talks
  # to 6379, which is the *other* application's instance. The script then
  # reports a healthy PONG from a server the API never connects to, leaves
  # 6380 empty, and the API refuses to boot a step later — the confusing,
  # blames-the-wrong-component failure this file exists to prevent.
  New-Item -ItemType Directory -Path $redisData -Force | Out-Null
  # --save keeps a periodic snapshot so a restart does not start from nothing,
  # and --dir keeps that snapshot in Omextv's own folder rather than shared.
  Start-Process -FilePath "$redisDir\redis-server.exe" `
    -ArgumentList '--port', $redisPort, '--dir', $redisData,
                  '--save', '60', '1', '--appendonly', 'no',
                  '--maxmemory', '256mb', '--maxmemory-policy', 'noeviction' `
    -WorkingDirectory $redisDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
$pong = & "$redisDir\redis-cli.exe" -p $redisPort ping
if ($pong -ne 'PONG') { throw "Redis did not answer on $redisPort (got '$pong')" }
Write-Host "Redis: PONG on $redisPort" -ForegroundColor Green

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

  # Launched through cmd, because Start-Process cannot run npm directly.
  #
  # Start-Process does not apply PATHEXT, so the bare name "npm" finds nothing;
  # and Get-Command resolves it to the extension-less shell script, which
  # Windows refuses with "%1 is not a valid Win32 application". Only npm.cmd is
  # executable here, and letting cmd do the lookup is the version that does not
  # depend on which npm shim happens to be first on PATH.
  #
  # This branch had never actually run: every earlier invocation found the API
  # already up and skipped it, so a script whose whole job is bringing the
  # stack up could not do it.
  #
  # Output goes to a log, so "it did not come up" can be diagnosed.
  $apiLog = Join-Path $env:TEMP 'omextv-api.log'
  Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'npm', 'run', 'dev' `
    -WorkingDirectory (Join-Path $PSScriptRoot '..\server') -WindowStyle Hidden `
    -RedirectStandardOutput $apiLog -RedirectStandardError "$apiLog.err"

  foreach ($i in 1..25) {
    Start-Sleep -Seconds 2
    try {
      $h = Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 4
      Write-Host "API: $($h.status), store=$($h.store)" -ForegroundColor Green
      $apiUp = $true
      break
    } catch { }
  }
  if (-not $apiUp) { throw "The API did not come up. See $apiLog and $apiLog.err" }
}

Write-Host ''
Write-Host 'Next: powershell -File scripts/tunnel.ps1   (expose it and redeploy)'
