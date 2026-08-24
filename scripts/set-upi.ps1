# Point Omextv's checkout at your UPI account, and prove it works.
#
# Two settings decide whether the store can take money:
#
#   UPI_ID        the VPA the QR pays, e.g. "yourname@paytm"
#   ADMIN_EMAILS  who may approve payments once they arrive
#
# Both have to come from you. A wrong VPA is the worst failure this app can
# have — the QR renders, the buyer pays, and the money goes to a stranger with
# no way back — so the value is checked for shape here and never printed back
# out.
#
#   powershell -File scripts/set-upi.ps1 -UpiId "yourname@paytm" -AdminEmail "you@example.com"
#
# The payee name shown in the buyer's UPI app before they confirm:
#
#   -PayeeName "Omextv"
#
# ADMIN_EMAILS must name an account that has signed up on the site — approval
# is checked against the email on the account, not against the token.

param(
  [Parameter(Mandatory = $true)][string]$UpiId,
  [Parameter(Mandatory = $true)][string]$AdminEmail,
  [string]$PayeeName = "Omextv"
)

$ErrorActionPreference = 'Stop'

$upi = $UpiId.Trim()
# handle@provider. Checked because the cost of a typo is unrecoverable, and
# nothing downstream can tell a wrong-but-valid VPA from a right one.
if ($upi -notmatch '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,32}$') {
  throw "That does not look like a UPI ID. Expected something like yourname@paytm."
}

$admins = ($AdminEmail -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ','
if ($admins -notmatch '@') { throw "ADMIN_EMAILS needs at least one email address." }

$envPath = Join-Path $PSScriptRoot '..\server\.env'
if (-not (Test-Path $envPath)) { throw "server/.env not found at $envPath" }

# Rewrite in place, preserving every other line and its order — this file also
# holds the database URL and the JWT secret, and losing those is a much worse
# outcome than a missing payee.
$wanted = [ordered]@{
  'UPI_ID'         = $upi
  'UPI_PAYEE_NAME' = $PayeeName
  'ADMIN_EMAILS'   = $admins
}

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
Set-Content -Path $envPath -Value $lines -Encoding UTF8
Write-Host "Wrote the payee to server/.env (previous copy at .env.bak)" -ForegroundColor Green

# The API reads .env once, at boot.
Write-Host 'Restarting the API so it picks this up...'
$listening = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $listening) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

& powershell -File (Join-Path $PSScriptRoot 'start-stack.ps1')

# Ask the API what it would actually hand a buyer. This is computed from the
# same settings the checkout uses, so it catches a half-filled config.
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$body = @{
  email = "upicheck$stamp@local.test"; password = 'upicheck12345'
  username = "upicheck$stamp"; gender = 'male'; country = 'IN'
} | ConvertTo-Json

$reg = Invoke-RestMethod 'http://localhost:3001/api/auth/register' -Method Post `
  -ContentType 'application/json' -Body $body
$me = Invoke-RestMethod 'http://localhost:3001/api/coins/me' `
  -Headers @{ Authorization = "Bearer $($reg.token)" }

if (-not $me.upiEnabled) { throw "The API still reports UPI as off. Check server/.env." }
Write-Host 'The checkout is live and will collect to your UPI ID.' -ForegroundColor Green

Write-Host ''
Write-Host 'Check the whole flow end to end:'
Write-Host '  cd server; npm run coins:check'
Write-Host ''
Write-Host 'Approve payments at https://omextv.vercel.app/review'
Write-Host "  (sign in as $($admins.Split(',')[0]) — it must be an account that exists)"
Write-Host ''
Write-Host 'Scan the QR with your own phone once and pay 1 rupee before telling'
Write-Host 'anyone about it. That is the only way to be certain the money arrives.'
