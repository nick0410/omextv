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
  # Ask a public resolver and connect to that address directly.
  #
  # This machine's resolver answers fresh trycloudflare names with NXDOMAIN —
  # "does not exist" — while 1.1.1.1 has both A and AAAA records for the same
  # name, measured minutes apart. So a plain request fails here while the
  # tunnel serves everyone else perfectly well, and failing this probe has to
  # mean the tunnel is dead rather than that DNS is being unhelpful.
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
  # What visitors will actually dial.
  #
  # This used to grep the deployed JS bundle for the hostname, which stopped
  # meaning anything once the client started reading runtime-config.json at
  # boot: the bundle only carries a build-time fallback now, so the check
  # passed or failed on a value nobody uses. The published document is the
  # authority, so ask it.
  Probe 'published config' {
    $raw = 'https://raw.githubusercontent.com/nick0410/omextv/main/runtime-config.json'
    # ConvertFrom-Json explicitly: raw.githubusercontent.com serves .json as
    # text/plain, and Invoke-RestMethod only parses when the content type says
    # JSON. Left to itself it hands back the raw string, every property reads
    # as empty, and the comparison below fails no matter what was published.
    $body = Invoke-RestMethod "${raw}?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -TimeoutSec 20
    # TrimStart the BOM: copies published before tunnel.ps1 stopped writing
    # one still carry it, and it is not valid JSON to a strict parser.
    $doc = $body.TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($doc.apiUrl -ne $url) {
      # raw.githubusercontent.com leaves the query string out of its cache key,
      # so for up to five minutes after a tunnel restart this genuinely still
      # serves the old hostname. Worth saying plainly rather than reporting it
      # as a mismatch someone needs to fix.
      throw "names $($doc.apiUrl); if the tunnel just restarted, give the CDN five minutes"
    }
    'matches the live tunnel'
  }
}

Write-Host ''
if ($bad -eq 0) {
  Write-Host 'Everything is live.' -ForegroundColor Green
} else {
  Write-Host "$bad component(s) down. Fix with: powershell -File scripts/tunnel.ps1" -ForegroundColor Yellow
}
exit $bad
