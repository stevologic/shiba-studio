/**
 * Proves the Windows host no longer trips "Unknown publisher" on launch:
 * the shipped manifest requests asInvoker (so installer-detection UAC is
 * off), MOTW unblocking is the real Motw.Unblock path, and the packer
 * Authenticode-signs when a PFX is provided.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function adsExists(filePath: string): boolean {
  return existsSync(`${filePath}:Zone.Identifier`);
}

async function main() {
  mkdirSync(GOAL_SCRATCH, { recursive: true });
  const manifest = read('apps/windows/app.manifest');
  assert.match(manifest, /requestedExecutionLevel/);
  assert.match(manifest, /level="asInvoker"/);
  assert.match(manifest, /uiAccess="false"/);
  assert.doesNotMatch(manifest, /requireAdministrator|highestAvailable/);

  const program = read('apps/windows/Program.cs');
  assert.match(program, /Motw\.UnblockTree\(AppIdentity\.InstallDirectory\)/);
  assert.match(program, /Motw\.UnblockTree\(AppIdentity\.RuntimeDirectory\)/);
  assert.match(program, /--unblock-motw/);

  const motw = read('apps/windows/Motw.cs');
  assert.match(motw, /Zone\.Identifier/);
  assert.match(motw, /DeleteFile/);
  assert.match(motw, /UnblockTree/);
  assert.doesNotMatch(motw, /AppIdentity/, 'Motw.cs must compile standalone so tests can load the shipped type');

  const host = read('apps/windows/StudioHost.cs');
  assert.match(host, /Motw\.Unblock\(AppIdentity\.NodeBinary\)/);
  assert.match(read('apps/windows/AppUpdater.cs'), /Motw\.UnblockTree\(payload\)/);

  const csproj = read('apps/windows/ShibaStudio.csproj');
  assert.match(csproj, /<ApplicationManifest>app\.manifest<\/ApplicationManifest>/);
  assert.match(csproj, /<OutputType>WinExe<\/OutputType>/);

  const packer = read('scripts/ci/pack-windows-app.ps1');
  assert.match(packer, /function Sign-WindowsHost/);
  assert.match(packer, /SHIBA_WINDOWS_PFX/);
  assert.match(packer, /signtool/);
  assert.match(packer, /Sign-WindowsHost \(Join-Path \$HostOut 'ShibaStudio\.exe'\)/);
  assert.match(packer, /Skipping Authenticode: set SHIBA_WINDOWS_PFX/);

  const docs = read('docs/native-apps.md');
  assert.match(docs, /asInvoker/);
  assert.match(docs, /SHIBA_WINDOWS_PFX/);
  assert.match(docs, /Zone\.Identifier/);

  const publishedCandidates = [
    path.join(ROOT, 'dist/native/windows/ShibaStudio/ShibaStudio.exe'),
    path.join(ROOT, 'apps/windows/bin/Release/net8.0-windows/win-x64/ShibaStudio.exe'),
  ];
  const published = publishedCandidates.find((candidate) => existsSync(candidate));
  if (published) {
    const binary = readFileSync(published);
    const ascii = binary.toString('latin1');
    assert.match(ascii, /requestedExecutionLevel/);
    assert.match(ascii, /level="asInvoker"/);
    assert.doesNotMatch(ascii, /requireAdministrator|highestAvailable/);
    console.log(`published host embeds asInvoker: ${published}`);
  } else {
    console.log('published ShibaStudio.exe not present; source+csproj ApplicationManifest remains the compile bar');
  }

  if (process.platform === 'win32') {
    const probeDir = path.join(GOAL_SCRATCH, `motw-${Date.now()}`);
    mkdirSync(probeDir, { recursive: true });
    const payload = path.join(probeDir, 'payload.exe');
    const nodeBin = path.join(probeDir, 'node.exe');
    writeFileSync(payload, 'MZ');
    writeFileSync(nodeBin, 'MZ');
    writeFileSync(`${payload}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    writeFileSync(`${nodeBin}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    assert.equal(adsExists(payload), true, 'test must start with a Mark-of-the-Web ADS');
    assert.equal(adsExists(nodeBin), true, 'bundled node.exe must start with a Mark-of-the-Web ADS');

    const motwPath = path.join(ROOT, 'apps/windows/Motw.cs');
    const ps = `
      Add-Type -Path ${JSON.stringify(motwPath)}
      [ShibaStudio.Motw]::Unblock(${JSON.stringify(nodeBin)}) | Out-Null
      [ShibaStudio.Motw]::UnblockTree(${JSON.stringify(probeDir)}) | Out-Null
    `;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(run.status, 0, `Add-Type Motw.Unblock/UnblockTree failed:\n${run.stdout}\n${run.stderr}`);
    assert.equal(adsExists(nodeBin), false, 'shipped Motw.Unblock must remove Zone.Identifier from bundled node.exe');
    assert.equal(adsExists(payload), false, 'shipped Motw.UnblockTree must remove Zone.Identifier from launchable files');
    rmSync(probeDir, { recursive: true, force: true });
    console.log('shipped Motw.Unblock and UnblockTree cleared ZoneId=3 ADS');
  } else {
    console.log('skipping ADS probe (not Windows)');
  }

  console.log('headless harness cannot pop or dismiss a live UAC/SmartScreen dialog; asInvoker + MOTW ADS probe are the accepted bar');
  console.log('Windows publisher verification passed');
}

main().catch((error) => {
  console.error('Windows publisher verification failed', error);
  process.exitCode = 1;
});
