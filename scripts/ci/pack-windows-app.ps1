# Publish the Windows host and embed a production Studio runtime.
# Requires: npm ci, npm run build, and (ideally) npm prune --omit=dev already ran.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root 'apps\windows\ShibaStudio.csproj'))) {
  $Root = (Get-Location).Path
}

$Channel = $env:CHANNEL
if ($Channel -ne 'main' -and $Channel -ne 'development') { $Channel = 'development' }
$Sha = $env:GITHUB_SHA
if (-not $Sha) { $Sha = (git -C $Root rev-parse HEAD).Trim() }

$HostOut = Join-Path $Root 'dist\native\windows\ShibaStudio'
$Packages = Join-Path $Root 'dist\native\packages'
New-Item -ItemType Directory -Force -Path $Packages | Out-Null
if (Test-Path $HostOut) { Remove-Item -Recurse -Force $HostOut }

dotnet publish (Join-Path $Root 'apps\windows\ShibaStudio.csproj') `
  -c Release -r win-x64 --self-contained true -o $HostOut
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit $LASTEXITCODE" }

function Sign-WindowsHost([string]$PathToSign) {
  if (-not (Test-Path -LiteralPath $PathToSign)) { return }
  $pfx = $env:SHIBA_WINDOWS_PFX
  if (-not $pfx -or -not (Test-Path -LiteralPath $pfx)) {
    Write-Host "Skipping Authenticode: set SHIBA_WINDOWS_PFX to sign $PathToSign"
    return
  }
  $signtoolPath = $null
  $found = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($found) { $signtoolPath = $found.Source }
  if (-not $signtoolPath) {
    $signtoolPath = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
  }
  if (-not $signtoolPath) { throw "signtool.exe is required to sign with SHIBA_WINDOWS_PFX" }
  $timestamp = if ($env:SHIBA_WINDOWS_TIMESTAMP_URL) { $env:SHIBA_WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
  $signArgs = @(
    'sign', '/fd', 'SHA256', '/td', 'SHA256', '/tr', $timestamp,
    '/f', $pfx, '/d', 'Shiba Studio'
  )
  if ($env:SHIBA_WINDOWS_PFX_PASSWORD) { $signArgs += @('/p', $env:SHIBA_WINDOWS_PFX_PASSWORD) }
  $signArgs += $PathToSign
  & $signtoolPath @signArgs
  if ($LASTEXITCODE -ne 0) { throw "Authenticode sign failed for $PathToSign" }
  Write-Host "Signed $PathToSign"
}

Sign-WindowsHost (Join-Path $HostOut 'ShibaStudio.exe')

node (Join-Path $Root 'scripts\pack-desktop-runtime.mjs') `
  --root $Root `
  --out (Join-Path $HostOut 'runtime') `
  --platform windows `
  --channel $Channel `
  --sha $Sha
if ($LASTEXITCODE -ne 0) { throw "pack-desktop-runtime failed with exit $LASTEXITCODE" }

$Zip = Join-Path $Packages 'ShibaStudio-windows-x64.zip'
if (Test-Path $Zip) { Remove-Item -Force $Zip }
Push-Location (Join-Path $Root 'dist\native\windows')
try {
  tar.exe -a -c -f $Zip ShibaStudio
  if ($LASTEXITCODE -ne 0) { throw "tar zip failed with exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host "Wrote $Zip"
