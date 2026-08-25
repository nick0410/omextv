# Keep the tunnel alive without anyone watching it.
#
# The quick tunnel died at 19:12 and was still dead seven hours later. Nothing
# was broken enough to notice: cloudflared was running the whole time, happily
# retrying a tunnel Cloudflare had already torn down ("Unauthorized: Tunnel not
# found"), so every process check said the stack was fine while the live site
# talked to nothing. status.ps1 would have caught it, but only if someone ran
# it, and nobody runs a status script at two in the morning.
#
# So: check the way a visitor does — fetch through the public hostname — and
# restart the tunnel when that stops working.
#
#   powershell -File scripts/watch-tunnel.ps1
#
# Leave it running in its own window, or start it detached:
#
#   Start-Process powershell -ArgumentList '-File','scripts/watch-tunnel.ps1' -WindowStyle Hidden

param(
  # Long enough that a restart's DNS propagation has finished before the next
  # look, short enough that an outage is minutes rather than hours.
  [int]$IntervalSeconds = 120,
  # One failed probe is usually the network, not the tunnel. Two in a row,
  # spaced by the interval, is the tunnel.
  [int]$FailuresBeforeRestart = 2,
  # A restart publishes a new hostname and a commit. Flapping must not turn
  # into a restart every two minutes.
  [int]$CooldownSeconds = 600,
  # Otherwise a healthy tunnel writes nothing at all, and a silent log reads
  # exactly the same whether the watchdog is working or died hours ago — which
  # is the failure it was written to end.
  [int]$HeartbeatMinutes = 30,
  # Where tunnel.ps1 records the hostname it was given. A parameter so the
  # failure branch can be exercised against a log naming a host that is known
  # to be dead — cloudflared holds the real one open, so it cannot be edited
  # while the tunnel is up.
  [string]$TunnelLog = (Join-Path $env:TEMP 'omextv-tunnel.log')
)

$ErrorActionPreference = 'Continue'

$log = Join-Path $env:TEMP 'omextv-watchdog.log'

function Say($message, $colour = 'Gray') {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Host $line -ForegroundColor $colour
  Add-Content -Path $log -Value $line
}

  # Matching several hyphenated words, not just any trycloudflare host.
#
  # When cloudflared cannot start it prints the failure, and the failure names
  # its own endpoint: "failed to request quick Tunnel: Post
  # https://api.trycloudflare.com/tunnel". The looser pattern matched that, so a
  # tunnel that never existed was scraped out of an error message and published
  # as the live API — and because api.trycloudflare.com answers 200, every check
  # downstream agreed the site was healthy while it pointed at Cloudflare.
#
  # Quick tunnel names are always several words joined by hyphens, so requiring
  # three of them rules the endpoint out.
function Get-TunnelUrl {
  if (-not (Test-Path $TunnelLog)) { return $null }
  $m = Select-String -Path $TunnelLog -Pattern 'https://[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com' |
    Select-Object -First 1
  if ($m) { return $m.Matches[0].Value }
  return $null
}

# Ask a public resolver and connect to that address directly.
#
# This machine's resolver answers fresh trycloudflare names with NXDOMAIN,
# while 1.1.1.1 has both A and AAAA records for the same name. So a plain
# request fails here while the tunnel is serving everyone else perfectly well,
# and restarting on that would replace a working tunnel every two minutes
# forever.
function Test-Serving($url) {
  try {
    $name = ([Uri]$url).Host
    $a = Resolve-DnsName -Name $name -Type A -Server 1.1.1.1 -ErrorAction Stop |
      Where-Object { $_.IPAddress } | Select-Object -First 1
    if (-not $a) { return $false }
    $code = curl.exe -s -o NUL -w '%{http_code}' -m 25 `
      --resolve "${name}:443:$($a.IPAddress)" "$url/health"
    return ($code -eq '200')
  } catch {
    return $false
  }
}

<#
  Is there a publish that was made but never landed?

  tunnel.ps1 commits runtime-config.json and pushes it. When the push fails —
  and it does, on the same DNS unreliability that keeps killing the tunnel —
  the commit sits here and nothing retries it. The site then points at the
  previous address while every other check reports healthy, which is exactly
  how it stayed down for half an hour.

  Deliberately a local question. Asking GitHub what it currently serves needs
  the network, and the moments this matters are the moments the network is the
  problem: the first version of this check fetched raw.githubusercontent, timed
  out, and returned "fine" every time. A failed push leaves the local
  origin/main ref pointing at the old commit, so being ahead of it is
  answerable offline and is the same fact.
#>
function Get-UnpushedCount {
  $repo = Join-Path $PSScriptRoot '..'
  Push-Location $repo
  try {
    $count = git rev-list --count origin/main..HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { return 0 }
    return [int]($count | Select-Object -First 1)
  } catch {
    return 0
  } finally {
    Pop-Location
  }
}

function Publish-Pending {
  $repo = Join-Path $PSScriptRoot '..'
  Push-Location $repo
  try {
    git push -q origin main 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Test-ApiUp {
  try {
    Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 8 | Out-Null
    return $true
  } catch {
    return $false
  }
}

Say "watchdog started (every ${IntervalSeconds}s, restart after $FailuresBeforeRestart failures)" 'Cyan'

$failures = 0
$lastRestart = [DateTime]::MinValue
$lastHeartbeat = [DateTime]::MinValue

for (;;) {
  Start-Sleep -Seconds $IntervalSeconds

  # A dead API is a different problem, and restarting the tunnel cannot fix
  # it — tunnel.ps1 refuses to run without one anyway. Say so and wait, rather
  # than reporting a tunnel failure that is really a backend failure.
  if (-not (Test-ApiUp)) {
    Say 'the API on :3001 is not answering; not touching the tunnel' 'Yellow'
    $failures = 0
    continue
  }

  $url = Get-TunnelUrl
  if (-not $url) {
    # Counted like any other failure rather than jumping straight to a
    # restart. tunnel.ps1 deletes this log and writes it again, so there is a
    # window where a perfectly healthy restart looks exactly like this — and
    # reacting to it means launching a second tunnel on top of the first.
    $failures++
    Say "no tunnel hostname in the log ($failures/$FailuresBeforeRestart)" 'Yellow'
  } elseif (Test-Serving $url) {
    if ($failures -gt 0) { Say "recovered on its own: $url" 'Green' }

    # Serving, but is anyone being told about it?
    $unpushed = Get-UnpushedCount
    if ($unpushed -gt 0) {
      Say "$unpushed commit(s) not pushed - visitors may be on the old address" 'Yellow'
      if (Publish-Pending) {
        Say 'pushed; visitors will pick it up within a few minutes' 'Green'
      } else {
        Say 'push failed - run: git push origin main' 'Red'
      }
    }
    # MinValue means the first healthy check always prints, so the log shows
    # the watchdog working from the moment it starts.
    if (([DateTime]::UtcNow - $lastHeartbeat).TotalMinutes -ge $HeartbeatMinutes) {
      $lastHeartbeat = [DateTime]::UtcNow
      Say "serving: $url" 'Green'
    }
    $failures = 0
    continue
  } else {
    $failures++
    Say "$url did not serve ($failures/$FailuresBeforeRestart)" 'Yellow'
  }

  if ($failures -lt $FailuresBeforeRestart) { continue }

  $since = ([DateTime]::UtcNow - $lastRestart).TotalSeconds
  if ($since -lt $CooldownSeconds) {
    Say ("still in cooldown ({0:N0}s of {1}s)" -f $since, $CooldownSeconds)
    continue
  }

  Say 'restarting the tunnel' 'Cyan'
  $lastRestart = [DateTime]::UtcNow
  $failures = 0
  try {
    # Run it as a separate process and wait on the process, not on its output.
    #
    # Piping tunnel.ps1's output into ForEach-Object hung the watchdog forever
    # the first time it restarted anything. tunnel.ps1 launches cloudflared,
    # cloudflared inherits the output handles, and the pipeline only closes
    # when every holder of those handles exits — so the loop sat waiting on a
    # stream the long-lived tunnel was holding open. It was still doing that
    # fifteen hours later, having stopped checking anything at all: a watchdog
    # that works exactly once is worse than none, because the log looks calm.
    #
    # Redirecting to files and waiting on the process handle sidesteps it, and
    # the timeout means even a wedged tunnel.ps1 cannot stop the loop.
    $out = Join-Path $env:TEMP 'omextv-tunnel-restart.log'
    $proc = Start-Process powershell `
      -ArgumentList '-File', (Join-Path $PSScriptRoot 'tunnel.ps1') `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError "$out.err"

    if (-not $proc.WaitForExit(300000)) {
      $proc.Kill()
      Say 'tunnel.ps1 did not finish in five minutes; gave up on it' 'Red'
    } else {
      foreach ($file in @($out, "$out.err")) {
        if (Test-Path $file) {
          Get-Content $file | Where-Object { $_ -match '\S' } |
            ForEach-Object { Say "  tunnel.ps1: $_" }
        }
      }
      $fresh = Get-TunnelUrl
      Say "tunnel is now $fresh" 'Green'
    }
  } catch {
    Say "restart failed: $($_.Exception.Message)" 'Red'
  }
}
