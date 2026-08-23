# Is the whole stack actually live right now?
#
# Written after a failure that looked like nothing was wrong: cloudflared was
# still running, but Cloudflare had torn the quick tunnel down, so every
# request got a 530 and the deployed site was silently dead. "The process is
# up" is not the same as "it serves", so each layer is checked by using it.
#
#   powershell -File scripts/status.ps1

$ErrorActionPreference = 'Continue'
$bad = 0

function Probe($label, $block) {
  try {
    $detail = & $block
    Write-Host ("  OK    {0,-22} {1}" -f $label, $detail) -ForegroundColor Green
  } catch {
    Write-Host ("  DOWN  {0,-22} {1}" -f $label, $_.Exception.Message) -ForegroundColor Red
    $script:bad++
  }
}

Write-Host ''
Probe 'API (localhost)' { (Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 8).store }
Probe 'database' {
  # The API reports this itself now. It used to answer "ok" with Postgres
  # stopped, because /health only pinged Redis — so every login returned a 500
  # while the health check said the instance was fine.
  $s = Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 10
  if (-not $s.dbOk) { throw 'the API cannot reach Postgres' }
  'reachable'
}
Probe 'redis' {
  # The API refuses to boot when REDIS_URL is set and Redis is not answering —
  # deliberately, since a silent fall back to per-process memory would split
  # the queue across instances. That makes "is Redis up" a thing to check
  # before wondering why the API will not start.
  $s = Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 8
  if ($s.store -ne 'redis') { throw "API is using the $($s.store) store" }
  if (-not $s.storeOk) { throw 'store is not answering' }
  'connected'
}
Probe 'gender model' {
  $s = Invoke-RestMethod 'http://localhost:3001/api/stats' -TimeoutSec 8
  if (-not $s.genderReady) { throw "not ready ($($s.genderProvider))" }
  $s.genderProvider
}

$log = Join-Path $env:TEMP 'omextv-tunnel.log'
$url = $null
if (Test-Path $log) {
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value }
}

if (-not $url) {
  Write-Host '  DOWN  tunnel                 no hostname in the log' -ForegroundColor Red
  $bad++
} else {
  # This machine's resolver hands back an unroutable AAAA for fresh
  # trycloudflare names, so ask a public resolver for the A record and go
  # straight to it. Failing here means the tunnel is genuinely dead, not that
  # DNS is being unhelpful.
  Probe 'tunnel' {
    $host_ = ([Uri]$url).Host
    $a = Resolve-DnsName -Name $host_ -Type A -Server 1.1.1.1 -ErrorAction Stop |
      Where-Object { $_.IPAddress } | Select-Object -First 1
    if (-not $a) { throw 'no A record' }
    $r = curl.exe -s -o NUL -w '%{http_code}' -m 30 --resolve "${host_}:443:$($a.IPAddress)" "$url/health"
    if ($r -ne '200') { throw "HTTP $r (530 = tunnel torn down; re-run tunnel.ps1)" }
    $url
  }
}

Probe 'site' {
  $r = Invoke-WebRequest 'https://omextv.vercel.app/register' -TimeoutSec 30 -UseBasicParsing
  "HTTP $($r.StatusCode)"
}

if ($url) {
  Probe 'site -> tunnel match' {
    $html = Invoke-WebRequest 'https://omextv.vercel.app' -TimeoutSec 30 -UseBasicParsing
    $asset = [regex]::Match($html.Content, '/assets/index-[A-Za-z0-9_-]+\.js').Value
    $js = Invoke-WebRequest "https://omextv.vercel.app$asset" -TimeoutSec 45 -UseBasicParsing
    if ($js.Content -notlike "*$url*") { throw 'deployed bundle points at a different tunnel' }
    'current'
  }
}

Write-Host ''
if ($bad -eq 0) {
  Write-Host 'Everything is live.' -ForegroundColor Green
} else {
  Write-Host "$bad component(s) down. Fix with: powershell -File scripts/tunnel.ps1" -ForegroundColor Yellow
}
exit $bad
