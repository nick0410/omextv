# Point Omextv's checkout at Razorpay, and prove it works.
#
# This is what makes coins arrive the moment a payment succeeds. A UPI QR tells
# the server nothing, so coins wait on a person; Razorpay signs a callback
# saying the payment happened, and the server can act on that by itself.
#
#   powershell -File scripts/set-razorpay.ps1 -KeyId "rzp_test_..." -KeySecret "..."
#
# The webhook secret is what makes crediting reliable rather than merely fast.
# Without it, only a buyer who stays on the page is credited - close the tab at
# the wrong moment and the payment is made but never applied:
#
#   -WebhookSecret "whatever you set in the Razorpay dashboard"
#
# Nothing here switches the live site over. That needs PAYMENT_PROVIDER, and it
# is a separate deliberate step - see the end of this script.

param(
  [Parameter(Mandatory = $true)][string]$KeyId,
  [Parameter(Mandatory = $true)][string]$KeySecret,
  [string]$WebhookSecret = "",
  # Switch the server over as well. Off by default: test keys are the normal
  # state of an account for as long as activation takes, and flipping to them
  # by accident hands real buyers a checkout that takes no money.
  [switch]$Activate
)

$ErrorActionPreference = 'Stop'

$id = $KeyId.Trim()
$secret = $KeySecret.Trim()

if ($id -notmatch '^rzp_(test|live)_[A-Za-z0-9]+$') {
  throw "That does not look like a Razorpay key id. Expected rzp_test_... or rzp_live_..."
}
if ($secret.Length -lt 16) { throw "That key secret looks too short." }

# The two are easy to swap, and swapping them fails in a way that reads as
# "Razorpay is down" rather than "you pasted them the wrong way round".
if ($secret -like 'rzp_*') { throw "The key secret looks like a key id. Check the order." }

$envPath = Join-Path $PSScriptRoot '..\server\.env'
if (-not (Test-Path $envPath)) { throw "server/.env not found at $envPath" }

$wanted = [ordered]@{
  'RAZORPAY_KEY_ID'         = $id
  'RAZORPAY_KEY_SECRET'     = $secret
  'RAZORPAY_WEBHOOK_SECRET' = $WebhookSecret
}
if ($Activate) { $wanted['PAYMENT_PROVIDER'] = 'razorpay' }

$lines = [System.Collections.Generic.List[string]](Get-Content $envPath)
foreach ($key in $wanted.Keys) {
  $line = "$key=`"$($wanted[$key])`""
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$key\s*=") { $idx = $i; break }
  }
  if ($idx -ge 0) { $lines[$idx] = $line } else { $lines.Add($line) }
}

Copy-Item $envPath "$envPath.bak" -Force
# WriteAllLines rather than Set-Content -Encoding UTF8, which prepends a
# byte-order mark that would become part of the first variable's name.
[System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote the Razorpay keys to server/.env (previous copy at .env.bak)" -ForegroundColor Green

if ($id -like 'rzp_test_*') {
  Write-Warning "These are TEST keys. No real money will move, and no real buyer can pay."
}
if (-not $WebhookSecret) {
  Write-Warning "No webhook secret. Only buyers who stay on the page will be credited."
}

# Check the keys against Razorpay before claiming anything works. Creating a
# one rupee order is the cheapest call that proves both halves of the pair.
Write-Host 'Checking the keys against Razorpay...'
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${id}:${secret}"))
$body = @{ amount = 100; currency = 'INR'; receipt = "keycheck-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" } | ConvertTo-Json

try {
  $order = Invoke-RestMethod 'https://api.razorpay.com/v1/orders' -Method Post `
    -Headers @{ Authorization = "Basic $pair" } -ContentType 'application/json' -Body $body
  Write-Host "Razorpay accepted the keys (test order $($order.id))." -ForegroundColor Green
} catch {
  throw "Razorpay rejected the keys: $($_.Exception.Message)"
}

Write-Host ''
if ($Activate) {
  Write-Host 'PAYMENT_PROVIDER is now razorpay. Restart the API:' -ForegroundColor Yellow
  Write-Host '  powershell -File scripts/start-stack.ps1'
} else {
  Write-Host 'The keys are stored but NOT in use yet. The site still collects over UPI.'
  Write-Host 'To switch the server over once you are ready:'
  Write-Host '  powershell -File scripts/set-razorpay.ps1 -KeyId "..." -KeySecret "..." -Activate'
}
Write-Host ''
Write-Host 'Webhook, once the tunnel is up - add this in the Razorpay dashboard'
Write-Host 'under Settings, Webhooks, with the event payment.captured:'
Write-Host '  <your tunnel URL>/api/coins/webhook/razorpay'
Write-Host 'The tunnel hostname changes on every restart, so this has to be updated'
Write-Host 'each time until the API has a permanent address.'
