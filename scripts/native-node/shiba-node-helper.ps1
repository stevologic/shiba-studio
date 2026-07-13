[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$HostUrl,
  [string]$PairingId,
  [string]$PairingCode,
  [string]$NodeName = $env:COMPUTERNAME,
  [string]$KeyFile = "$env:LOCALAPPDATA\ShibaNode\node-key.bin"
)

$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $releaseRoot 'release-manifest.json'
$signaturePath = Join-Path $releaseRoot 'release-manifest.sig'
$publicKeyPath = Join-Path $releaseRoot 'release-public.json'
$corePath = Join-Path $releaseRoot 'shiba-node-helper-core.ps1'
$expectedPublicKeySha256 = '36e92801c6d27ec9fc75e951cb2d728eebcc1d95329449b115a44f1605e3e617'

function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

foreach ($required in @($manifestPath, $signaturePath, $publicKeyPath, $corePath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Signed release file is missing: $required" }
}

$publicBytes = [IO.File]::ReadAllBytes($publicKeyPath)
if ((Get-Sha256Hex $publicBytes) -ne $expectedPublicKeySha256) { throw 'Native helper public key fingerprint mismatch.' }
$public = Get-Content -LiteralPath $publicKeyPath -Raw | ConvertFrom-Json
$rsaParams = New-Object System.Security.Cryptography.RSAParameters
$rsaParams.Modulus = [Convert]::FromBase64String(($public.n.Replace('-', '+').Replace('_', '/') + ('=' * ((4 - $public.n.Length % 4) % 4))))
$rsaParams.Exponent = [Convert]::FromBase64String(($public.e.Replace('-', '+').Replace('_', '/') + ('=' * ((4 - $public.e.Length % 4) % 4))))
$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
$rsa.ImportParameters($rsaParams)
$manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
$signature = [Convert]::FromBase64String((Get-Content -LiteralPath $signaturePath -Raw).Trim())
try {
  if (-not $rsa.VerifyData($manifestBytes, [System.Security.Cryptography.SHA256]::Create(), $signature)) {
    throw 'Native helper release manifest signature is invalid.'
  }
} finally { $rsa.Dispose() }

$manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
if ([int]$manifest.protocolVersion -ne 1) { throw 'Unsupported native helper protocol.' }
foreach ($name in @('shiba-node-helper.ps1', 'shiba-node-helper-core.ps1')) {
  $entry = $manifest.files.$name
  if (-not $entry) { throw "Signed manifest does not cover $name" }
  $actual = Get-Sha256Hex ([IO.File]::ReadAllBytes((Join-Path $releaseRoot $name)))
  if ($actual -ne $entry.sha256) { throw "Native helper integrity check failed for $name" }
}

$coreArgs = @{
  HostUrl = $HostUrl
  NodeName = $NodeName
  KeyFile = $KeyFile
  ManifestPayloadBase64 = [Convert]::ToBase64String($manifestBytes)
  ManifestSignature = [Convert]::ToBase64String($signature)
}
if ($PairingId) { $coreArgs.PairingId = $PairingId }
if ($PairingCode) { $coreArgs.PairingCode = $PairingCode }
& $corePath @coreArgs
