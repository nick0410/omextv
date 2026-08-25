# Is the whole stack actually live right now?
#
# Written after a failure that looked like nothing was wrong: cloudflared was
# still running, but Cloudflare had torn the quick tunnel down, so every
# request got a 530 and the deployed site was silently dead. "The process is
# up" is not the same as "it serves", so each layer is checked by using it.
#
#   powershell -File scripts/status.ps1

# Which API to ask about.
#
# Empty means the laptop setup: localhost plus whatever tunnel is in front of
# it. Given a URL, that whole layer is skipped — a hosted API has one address
# and none of the tunnel checks mean anything against it.
param([string]$ApiUrl = "")

$ErrorActionPreference = 'Continue'
$bad = 0

$hosted = -not [string]::IsNullOrWhiteSpace($ApiUrl)
$apiBase = if ($hosted) { $ApiUrl.TrimEnd('/') } else { 'http://localhost:3001' }

# Read the published config, whichever way it comes back.
#
# Invoke-RestMethod parses JSON only when the content type says so, and
# raw.githubusercontent serves .json as text/plain — but not every PowerShell
# version agrees, so this returns a string on one host and a parsed object on
# another. Handling only one of those is how the check ends up failing on a
# perfectly good config: as a raw string every property reads empty, and as an
# object TrimStart does not exist.
#
# The BOM strip matters for the string case: copies published before
# tunnel.ps1 stopped writing one still carry it, and a strict parser rejects it.
function Read-PublishedConfig($url) {
  $body = Invoke-RestMethod $url -TimeoutSec 20
  if ($body -is [string]) { return $body.TrimStart([char]0xFEFF) | ConvertFrom-Json }
  return $body
}


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
$apiLabel = if ($hosted) { 'API (hosted)' } else { 'API (localhost)' }
# A free instance may be asleep and this request is what wakes it, which takes
# about a minute. Reporting that as "down" would be wrong every first check.
$apiTimeout = if ($hosted) { 90 } else { 8 }
Probe $apiLabel { (Invoke-RestMethod "$apiBase/health" -TimeoutSec $apiTimeout).store }
Probe 'database' {
  # The API reports this itself now. It used to answer "ok" with Postgres
  # stopped, because /health only pinged Redis — so every login returned a 500
  # while the health check said the instance was fine.
  $s = Invoke-RestMethod "$apiBase/health" -TimeoutSec $apiTimeout
  if (-not $s.dbOk) { throw 'the API cannot reach Postgres' }
  'reachable'
}
# Only meaningful for the laptop setup. A single hosted instance runs on the
# memory store deliberately: two instances would each keep their own queue, so
# Redis arrives with the second instance, not before.
if (-not $hosted) {
Probe 'redis' {
  # The API refuses to boot when REDIS_URL is set and Redis is not answering —
  # deliberately, since a silent fall back to per-process memory would split
  # the queue across instances. That makes "is Redis up" a thing to check
  # before wondering why the API will not start.
  $s = Invoke-RestMethod "$apiBase/health" -TimeoutSec $apiTimeout
  if ($s.store -ne 'redis') { throw "API is using the $($s.store) store" }
  if (-not $s.storeOk) { throw 'store is not answering' }
  'connected'
}
}
Probe 'gender model' {
  $s = Invoke-RestMethod "$apiBase/api/stats" -TimeoutSec $apiTimeout
  if (-not $s.genderReady) { throw "not ready ($($s.genderProvider))" }
  $s.genderProvider
}

# The tunnel only exists for the laptop setup.
$url = $null
if (-not $hosted) {
$log = Join-Path $env:TEMP 'omextv-tunnel.log'
if (Test-Path $log) {
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com' | Select-Object -First 1
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

}

Probe 'site' {
  $r = Invoke-WebRequest 'https://omextv.vercel.app/register' -TimeoutSec 30 -UseBasicParsing
  "HTTP $($r.StatusCode)"
}

$expected = if ($hosted) { $apiBase } else { $url }
if ($expected) {
  # What visitors will actually dial.
  #
  # This used to grep the deployed JS bundle for the hostname, which stopped
  # meaning anything once the client started reading runtime-config.json at
  # boot: the bundle only carries a build-time fallback now, so the check
  # passed or failed on a value nobody uses. The published document is the
  # authority, so ask it.
  Probe 'published config' {
    $raw = 'https://raw.githubusercontent.com/nick0410/omextv/main/runtime-config.json'
    $doc = Read-PublishedConfig "${raw}?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    if ($doc.apiUrl -ne $expected) {
      # raw.githubusercontent.com leaves the query string out of its cache key,
      # so for up to five minutes after a tunnel restart this genuinely still
      # serves the old hostname. Worth saying plainly rather than reporting it
      # as a mismatch someone needs to fix.
      throw "names $($doc.apiUrl), expected $expected; the CDN caches this for five minutes"
    }
    if ($hosted) { 'matches the hosted API' } else { 'matches the live tunnel' }
  }
}

Write-Host ''
if ($bad -eq 0) {
  Write-Host 'Everything is live.' -ForegroundColor Green
} else {
  $fix = if ($hosted) { 'check the Render dashboard' } else { 'powershell -File scripts/tunnel.ps1' }
  Write-Host "$bad component(s) down. Fix with: $fix" -ForegroundColor Yellow
}
exit $bad
