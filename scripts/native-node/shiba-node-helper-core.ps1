[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$HostUrl,
  [string]$PairingId,
  [string]$PairingCode,
  [string]$NodeName = $env:COMPUTERNAME,
  [string]$KeyFile = "$env:LOCALAPPDATA\ShibaNode\node-key.bin",
  [Parameter(Mandatory=$true)][string]$ManifestPayloadBase64,
  [Parameter(Mandatory=$true)][string]$ManifestSignature
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The bundled native helper currently supports Windows only.' }
$HostUrl = $HostUrl.TrimEnd('/')
$hostUri = [Uri]$HostUrl
if ($hostUri.Scheme -ne 'https' -and $hostUri.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'Native-node transport must use HTTPS or loopback.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ShibaNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
}
'@

$sensitiveApp = '(?i)(1password|bitwarden|keepass|lastpass|dashlane|password|credential|wallet|bank|windows security|securityhealth|regedit|keychain|authenticator|secrets? manager)'

function ConvertFrom-Base64Url([string]$Value) {
  $text = $Value.Replace('-', '+').Replace('_', '/')
  $text += '=' * ((4 - $text.Length % 4) % 4)
  return [Convert]::FromBase64String($text)
}

function Get-KeyHashBytes([string]$NodeKey) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("shiba-native-node`0$NodeKey")) }
  finally { $sha.Dispose() }
}

function Protect-Key([string]$Value, [string]$Path) {
  $parent = Split-Path -Parent $Path
  if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
  $plain = [Text.Encoding]::UTF8.GetBytes($Value)
  $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($Path, $protected)
}

function Unprotect-Key([string]$Path) {
  $protected = [IO.File]::ReadAllBytes($Path)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Invoke-ShibaJson([string]$Method, [string]$Path, $Body, [string]$NodeKey) {
  $params = @{ Uri = "$HostUrl$Path"; Method = $Method; UseBasicParsing = $true; ContentType = 'application/json'; TimeoutSec = 30 }
  if ($NodeKey) { $params.Headers = @{ Authorization = "Bearer $NodeKey" } }
  if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 12 -Compress) }
  return Invoke-RestMethod @params
}

function New-Envelope([string]$PayloadBase64, [byte[]]$KeyHashBytes) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = $KeyHashBytes
    return [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($PayloadBase64)))
  } finally { $hmac.Dispose() }
}

function Test-Envelope([string]$PayloadBase64, [string]$Signature, [byte[]]$KeyHashBytes) {
  $expected = [Convert]::FromBase64String((New-Envelope $PayloadBase64 $KeyHashBytes))
  try { $actual = [Convert]::FromBase64String($Signature) } catch { return $false }
  if ($expected.Length -ne $actual.Length) { return $false }
  $difference = 0
  for ($i = 0; $i -lt $expected.Length; $i++) { $difference = $difference -bor ($expected[$i] -bxor $actual[$i]) }
  return $difference -eq 0
}

function Get-AppRevision([Diagnostics.Process]$Process) {
  try {
    $file = $Process.MainModule.FileName
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
    $stamp = [IO.File]::GetLastWriteTimeUtc($file).ToString('o')
    return "$($info.FileVersion)|$stamp"
  } catch { return "unknown|$($Process.StartTime.ToUniversalTime().ToString('o'))" }
}

function Get-WindowInfo([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { throw 'No foreground window is available.' }
  [uint32]$pid = 0
  [void][ShibaNative]::GetWindowThreadProcessId($Handle, [ref]$pid)
  $process = [Diagnostics.Process]::GetProcessById($pid)
  $title = New-Object Text.StringBuilder 1024
  [void][ShibaNative]::GetWindowText($Handle, $title, $title.Capacity)
  try { $appId = [IO.Path]::GetFullPath($process.MainModule.FileName).ToLowerInvariant() } catch { $appId = "pid:$pid" }
  return [ordered]@{
    handle = $Handle.ToInt64()
    pid = $pid
    title = $title.ToString()
    appId = $appId
    appLabel = $process.ProcessName
    appRevision = Get-AppRevision $process
  }
}

function Assert-SafeApp($Job, $Info) {
  if ("$($Info.appId) $($Info.appLabel) $($Info.title)" -match $sensitiveApp) { throw 'Sensitive application is blocked by the native helper.' }
  if (-not $Job.targetAppId -or -not $Job.targetAppRevision -or -not $Job.grantId) { throw 'Exact per-app grant is missing.' }
  if ($Info.appId -ne ([string]$Job.targetAppId).ToLowerInvariant()) { throw 'Foreground app identity no longer matches the grant.' }
  if ($Info.appRevision -ne [string]$Job.targetAppRevision) { throw 'Foreground app revision no longer matches the grant.' }
  if ([DateTime]::Parse([string]$Job.grantExpiresAt).ToUniversalTime() -le [DateTime]::UtcNow) { throw 'Per-app grant expired before execution.' }
}

function Show-CaptureIndicator([string]$Action) {
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Shiba native access active'
  $form.FormBorderStyle = 'FixedToolWindow'
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.BackColor = [Drawing.Color]::FromArgb(135, 24, 24)
  $form.ForeColor = [Drawing.Color]::White
  $form.Size = New-Object Drawing.Size 330, 78
  $form.StartPosition = 'Manual'
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object Drawing.Point ($bounds.Right - 340), ($bounds.Bottom - 88)
  $label = New-Object Windows.Forms.Label
  $label.Dock = 'Fill'; $label.TextAlign = 'MiddleCenter'; $label.Text = "Shiba is performing: $Action`nClose Studio or revoke the grant to stop access."
  $form.Controls.Add($label); $form.Show(); [Windows.Forms.Application]::DoEvents()
  return $form
}

function Get-AccessibilityText([IntPtr]$Handle) {
  try {
    $root = [Windows.Automation.AutomationElement]::FromHandle($Handle)
    $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    $lines = New-Object Collections.Generic.List[string]
    for ($i = 0; $i -lt [Math]::Min($all.Count, 300); $i++) {
      $name = $all.Item($i).Current.Name
      if ($name -and -not $lines.Contains($name)) { $lines.Add($name) }
    }
    return (($lines -join "`n").Substring(0, [Math]::Min(30000, ($lines -join "`n").Length)))
  } catch { return '' }
}

function Capture-ActiveWindow([IntPtr]$Handle) {
  $rect = New-Object ShibaNative+RECT
  if (-not [ShibaNative]::GetWindowRect($Handle, [ref]$rect)) { throw 'Could not read active-window bounds.' }
  $width = [Math]::Max(1, $rect.Right - $rect.Left); $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object Drawing.Bitmap $width, $height
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object Drawing.Size $width, $height))
    $stream = New-Object IO.MemoryStream
    try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png); return [Convert]::ToBase64String($stream.ToArray()) }
    finally { $stream.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

function Get-WindowInventory {
  $items = New-Object Collections.Generic.List[object]
  $seen = @{}
  $callback = [ShibaNative+EnumWindowsProc]{ param($handle, $unused)
    if (-not [ShibaNative]::IsWindowVisible($handle)) { return $true }
    try {
      $info = Get-WindowInfo $handle
      if ($info.title -and -not $seen.ContainsKey($info.handle)) { $seen[$info.handle] = $true; $items.Add($info) }
    } catch { }
    return $true
  }
  [void][ShibaNative]::EnumWindows($callback, [IntPtr]::Zero)
  return @($items | Select-Object -First 200)
}

function Invoke-NativeAction($Job) {
  $indicator = $null
  if ($Job.visibleCapture) { $indicator = Show-CaptureIndicator ([string]$Job.action) }
  try {
    switch ([string]$Job.action) {
      'list_apps' { return @{ windows = @(Get-WindowInventory); capturedAt = [DateTime]::UtcNow.ToString('o') } }
      'notify' {
        $icon = New-Object Windows.Forms.NotifyIcon
        try { $icon.Icon = [Drawing.SystemIcons]::Information; $icon.Visible = $true; $icon.BalloonTipTitle = [string]$Job.args.title; $icon.BalloonTipText = [string]$Job.args.body; $icon.ShowBalloonTip(5000); Start-Sleep -Milliseconds 250 }
        finally { $icon.Dispose() }
        return @{ shown = $true }
      }
      'clipboard_read' { return @{ text = [Windows.Forms.Clipboard]::GetText(); capturedAt = [DateTime]::UtcNow.ToString('o') } }
      'clipboard_write' { [Windows.Forms.Clipboard]::SetText([string]$Job.args.text); return @{ written = $true } }
      'file_open' { Start-Process -FilePath ([string]$Job.args.path); return @{ opened = [string]$Job.args.path } }
    }
    $handle = [ShibaNative]::GetForegroundWindow()
    $info = Get-WindowInfo $handle
    Assert-SafeApp $Job $info
    switch ([string]$Job.action) {
      'capture' { return @{ app = $info; screenshotBase64 = Capture-ActiveWindow $handle; accessibilityText = Get-AccessibilityText $handle; capturedAt = [DateTime]::UtcNow.ToString('o') } }
      'click' {
        [void][ShibaNative]::SetCursorPos([int]$Job.args.x, [int]$Job.args.y)
        $down = if ($Job.args.button -eq 'right') { 0x0008 } else { 0x0002 }; $up = if ($Job.args.button -eq 'right') { 0x0010 } else { 0x0004 }
        [ShibaNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [ShibaNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
        return @{ clicked = $true; app = $info }
      }
      'type' {
        $literal = [Text.RegularExpressions.Regex]::Replace([string]$Job.args.text, '([+^%~(){}])', '{$1}')
        [Windows.Forms.SendKeys]::SendWait($literal)
        return @{ typed = $true; app = $info }
      }
      default { throw 'Unsupported native action.' }
    }
  } finally { if ($indicator) { $indicator.Close(); $indicator.Dispose() } }
}

function Send-Event([string]$Type, [string]$Text, [string[]]$Paths, [string]$NodeKey, [byte[]]$KeyHashBytes) {
  $event = [ordered]@{ eventId = [Guid]::NewGuid().ToString(); type = $Type; text = $Text; paths = @($Paths); createdAt = [DateTime]::UtcNow.ToString('o') }
  $json = $event | ConvertTo-Json -Depth 5 -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [void](Invoke-ShibaJson 'POST' '/api/native-nodes/events' @{ payloadBase64 = $payload; signature = New-Envelope $payload $KeyHashBytes } $NodeKey)
}

function Show-QuickEntry([string]$NodeKey, [byte[]]$KeyHashBytes) {
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Send to Shiba'; $form.TopMost = $true; $form.Size = New-Object Drawing.Size 520, 230; $form.AllowDrop = $true
  $box = New-Object Windows.Forms.TextBox; $box.Multiline = $true; $box.Dock = 'Fill'; $box.ScrollBars = 'Vertical'
  $button = New-Object Windows.Forms.Button; $button.Text = 'Create task'; $button.Dock = 'Bottom'; $button.Height = 38
  $paths = New-Object Collections.Generic.List[string]
  $form.add_DragEnter({ param($sender, $eventArgs) if ($eventArgs.Data.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)) { $eventArgs.Effect = 'Copy' } })
  $form.add_DragDrop({ param($sender, $eventArgs) foreach ($item in $eventArgs.Data.GetData([Windows.Forms.DataFormats]::FileDrop)) { if ($paths.Count -lt 20) { $paths.Add([string]$item) } }; $box.Text += "`r`nDropped $($paths.Count) path(s)." })
  $button.Add_Click({ $form.DialogResult = 'OK'; $form.Close() })
  $form.Controls.Add($box); $form.Controls.Add($button); [void]$form.ShowDialog()
  if ($form.DialogResult -eq 'OK' -and ($box.Text.Trim() -or $paths.Count)) {
    Send-Event $(if ($paths.Count) { 'file_drop' } else { 'quick_entry' }) $box.Text.Trim() @($paths) $NodeKey $KeyHashBytes
  }
  $form.Dispose()
}

if (-not (Test-Path -LiteralPath $KeyFile)) {
  if (-not $PairingId -or -not $PairingCode) { throw 'Pairing id and code are required on first run.' }
  $pair = Invoke-ShibaJson 'POST' '/api/native-nodes/pair' @{
    pairingId = $PairingId; code = $PairingCode; name = $NodeName; platform = "windows/$([Environment]::OSVersion.Version)"
    manifestPayloadBase64 = $ManifestPayloadBase64; manifestSignature = $ManifestSignature
  } $null
  Protect-Key ([string]$pair.nodeKey) $KeyFile
}

$nodeKey = Unprotect-Key $KeyFile
$keyHashBytes = Get-KeyHashBytes $nodeKey
$hotkeyDown = $false
Write-Host 'Shiba native node is running. Ctrl+Shift+Space opens quick entry. No screen is captured except for an approved one-shot job.'
while ($true) {
  try {
    $quick = (([ShibaNative]::GetAsyncKeyState(0x11) -band 0x8000) -and ([ShibaNative]::GetAsyncKeyState(0x10) -band 0x8000) -and ([ShibaNative]::GetAsyncKeyState(0x20) -band 0x8000))
    if ($quick -and -not $hotkeyDown) { Show-QuickEntry $nodeKey $keyHashBytes }
    $hotkeyDown = $quick
    $poll = Invoke-ShibaJson 'GET' '/api/native-nodes/poll' $null $nodeKey
    if ($poll.job) {
      if (-not (Test-Envelope $poll.job.payloadBase64 $poll.job.signature $keyHashBytes)) { throw 'Host job signature is invalid.' }
      $job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($poll.job.payloadBase64)) | ConvertFrom-Json
      if ([int]$job.protocolVersion -ne 1) { throw 'Unsupported job protocol.' }
      try { $result = Invoke-NativeAction $job; $success = $true; $message = $null }
      catch { $result = @{}; $success = $false; $message = $_.Exception.Message }
      $completion = [ordered]@{ jobId = $job.jobId; leaseToken = $job.leaseToken; actionDigest = $job.actionDigest; success = $success; result = $result; error = $message }
      $completionJson = $completion | ConvertTo-Json -Depth 12 -Compress
      $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($completionJson))
      [void](Invoke-ShibaJson 'POST' '/api/native-nodes/complete' @{ payloadBase64 = $payload; signature = New-Envelope $payload $keyHashBytes } $nodeKey)
    }
  } catch {
    Write-Warning $_.Exception.Message
    Start-Sleep -Seconds 3
  }
  [Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 750
}
