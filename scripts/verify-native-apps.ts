import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NATIVE_APP_CATALOG_PATH,
  NATIVE_APP_CHANNELS,
  PACKAGES_MANIFEST_PATH,
  PACKAGES_PAGE_PATH,
  loadNativeAppCatalog,
  mergePackagesManifest,
  parseNativeAppCatalog,
  releaseTagForChannel,
} from '../lib/native-apps';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

async function assertPackerPathGuards() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'scripts/pack-desktop-runtime.mjs')).href) as {
    normalizePath: (value: string) => string;
    isDriveRoot: (value: string) => boolean;
    isVolumeRoot: (value: string) => boolean;
    isOutsideRoot: (src: string, root: string) => boolean;
    shouldSkip: (src: string, root: string) => boolean;
    copyFiltered: (from: string, to: string, root: string) => void;
  };
  assert.equal(mod.normalizePath('C:'), 'C:\\');
  assert.equal(mod.normalizePath('\\\\?\\C:'), 'C:\\');
  assert.equal(mod.isDriveRoot('C:'), true);
  assert.equal(mod.isDriveRoot('C:\\'), true);
  assert.equal(mod.isDriveRoot('c:\\'), true);
  assert.equal(mod.isDriveRoot('C:\\Users'), false);
  assert.equal(mod.isDriveRoot('D:\\a\\shiba-studio\\shiba-studio'), false);
  assert.equal(mod.isVolumeRoot('C:'), true);
  assert.equal(mod.isVolumeRoot('C:\\'), true);
  assert.equal(mod.isVolumeRoot('\\\\?\\C:\\'), true);
  assert.equal(mod.isVolumeRoot('/'), true);
  assert.equal(mod.isVolumeRoot('\\\\server\\share'), true);
  assert.equal(mod.isVolumeRoot('\\\\server\\share\\pkg'), false);
  assert.equal(mod.isVolumeRoot('D:\\a\\shiba-studio\\shiba-studio'), false);
  assert.equal(mod.isOutsideRoot('C:\\Windows', 'D:\\a\\shiba-studio\\shiba-studio'), true);
  assert.equal(mod.shouldSkip('C:\\', 'D:\\a\\shiba-studio\\shiba-studio'), true);
  assert.equal(mod.shouldSkip('C:\\Windows', 'D:\\a\\shiba-studio\\shiba-studio'), true);

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'shiba-packer-'));
  try {
    const root = path.join(scratch, 'project');
    const dest = path.join(scratch, 'out');
    const keep = path.join(root, 'keep');
    const realPkg = path.join(root, 'node_modules', 'real-pkg');
    const alias = path.join(root, 'node_modules', 'alias');
    const outside = path.join(scratch, 'outside');
    mkdirSync(keep, { recursive: true });
    mkdirSync(realPkg, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(keep, 'ok.txt'), 'ok\n');
    writeFileSync(path.join(realPkg, 'index.js'), 'module.exports = 1;\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(realPkg, alias, linkType);
      symlinkSync(outside, path.join(root, 'trap'), linkType);
    } catch (error) {
      if (process.platform === 'win32') throw error;
      // Some CI images refuse privileged symlink creation; the path guards above still run.
      return;
    }
    mod.copyFiltered(root, dest, root);
    assert.equal(existsSync(path.join(dest, 'keep', 'ok.txt')), true);
    assert.equal(existsSync(path.join(dest, 'node_modules', 'real-pkg', 'index.js')), true);
    assert.equal(existsSync(path.join(dest, 'node_modules', 'alias', 'index.js')), true);
    assert.equal(existsSync(path.join(dest, 'trap', 'secret.txt')), false);
    assert.equal(existsSync(path.join(dest, 'secret.txt')), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const catalog = loadNativeAppCatalog(ROOT);
  assert.equal(catalog.apps.length, 2);
  assert.deepEqual(catalog.channels, [...NATIVE_APP_CHANNELS]);
  assert.equal(releaseTagForChannel('main'), 'packages-main');
  assert.equal(releaseTagForChannel('development'), 'packages-development');
  assert.equal(parseNativeAppCatalog(JSON.parse(read(NATIVE_APP_CATALOG_PATH))).page, PACKAGES_PAGE_PATH);

  for (const app of catalog.apps) {
    assert.equal(existsSync(path.join(ROOT, app.project)), true, `${app.project} must exist`);
    assert.match(app.name, /Shiba Studio for (Windows|macOS)/);
    assert.match(app.summary, /Double-click/);
  }

  const packer = read('scripts/pack-desktop-runtime.mjs');
  assert.match(packer, /pack-desktop-runtime/);
  assert.match(packer, /preferredPort: 18765/);
  assert.match(packer, /https:\/\/shiba-studio\.io\/packages\/manifest\.json/);
  assert.match(packer, /'next', 'dist', 'bin', 'next'/);
  assert.match(packer, /app\.json/);
  assert.match(packer, /copyTree/);
  assert.match(packer, /const stack = new Set/);
  assert.match(packer, /lstatSync/);
  assert.match(packer, /parts\.includes\('\.bin'\)/);
  assert.match(packer, /function fsPath/);
  assert.match(packer, /function normalizePath/);
  assert.match(packer, /function isDriveRoot/);
  assert.match(packer, /function isVolumeRoot/);
  assert.match(packer, /function isOutsideRoot/);
  assert.match(packer, /function readLinkTarget/);
  assert.match(packer, /EISDIR/);
  assert.match(packer, /\[A-Za-z\]:\$/);
  assert.match(packer, /copyThroughLink/);
  assert.match(packer, /win32/);
  assert.equal(existsSync(path.join(ROOT, 'scripts/ci/pack-windows-app.ps1')), true);
  assert.equal(existsSync(path.join(ROOT, 'scripts/ci/pack-macos-app.sh')), true);
  assert.match(read('scripts/ci/pack-windows-app.ps1'), /pack-desktop-runtime\.mjs/);
  assert.match(read('scripts/ci/pack-windows-app.ps1'), /apps\\windows\\ShibaStudio\.csproj/);
  assert.match(read('scripts/ci/pack-macos-app.sh'), /pack-desktop-runtime\.mjs/);
  assert.match(read('scripts/ci/pack-macos-app.sh'), /build\.sh/);

  const windowsCsproj = read('apps/windows/ShibaStudio.csproj');
  assert.match(windowsCsproj, /Microsoft\.Web\.WebView2/);
  assert.match(windowsCsproj, /net8\.0-windows/);
  assert.match(read('apps/windows/Program.cs'), /MainForm/);
  assert.match(read('apps/windows/Program.cs'), /Local\\ShibaStudio\.Desktop/);
  const windowsHost = read('apps/windows/StudioHost.cs');
  assert.match(windowsHost, /next start/);
  assert.match(read('apps/windows/AppIdentity.cs'), /18765/);
  assert.match(windowsHost, /PreferredPort/);
  assert.doesNotMatch(windowsHost, /npm run start/);
  assert.match(read('apps/windows/AppIdentity.cs'), /https:\/\/shiba-studio\.io\/packages\/manifest\.json/);
  assert.match(read('apps/windows/AppUpdater.cs'), /ShibaStudio-Desktop/);
  assert.match(read('apps/windows/AppUpdater.cs'), /NoCache/);
  assert.match(read('apps/windows/AppUpdater.cs'), /channel=/);
  assert.match(read('apps/windows/MainForm.cs'), /30 \* 60 \* 1000/);
  const mainForm = read('apps/windows/MainForm.cs');
  assert.match(mainForm, /WebView2/);
  assert.match(mainForm, /MenuStrip/);
  assert.match(mainForm, /Check for &Updates/);
  assert.match(mainForm, /NativeWindowChrome/);
  assert.match(mainForm, /var titleLabel = title/);
  assert.match(mainForm, /var detailLabel = detail/);
  assert.doesNotMatch(mainForm, /Start local Studio/);
  assert.doesNotMatch(mainForm, /class TextBox|new TextBox/);
  assert.doesNotMatch(mainForm, /static readonly Color Text/, 'Form.Text must not be shadowed by a color field');
  assert.equal(existsSync(path.join(ROOT, 'apps/windows/shiba.ico')), true, 'Windows app icon');

  const pbx = read('apps/macos/ShibaStudio.xcodeproj/project.pbxproj');
  assert.match(pbx, /PRODUCT_BUNDLE_IDENTIFIER = "io\.shiba-studio\.macos"/);
  assert.match(pbx, /SDKROOT = macosx/);
  assert.match(pbx, /CODE_SIGNING_ALLOWED = NO/);
  assert.match(pbx, /AppIdentity\.swift/);
  assert.match(pbx, /AppUpdater\.swift/);
  assert.match(pbx, /PreferencesView\.swift/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /ShibaStudioApp/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /Check for Updates/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /Starting Shiba Studio/);
  assert.match(read('apps/macos/ShibaStudio/ContentView.swift'), /StudioWebView/);
  assert.doesNotMatch(read('apps/macos/ShibaStudio/ContentView.swift'), /Start local Studio/);
  assert.doesNotMatch(read('apps/macos/ShibaStudio/ContentView.swift'), /TextField/);
  assert.match(read('apps/macos/ShibaStudio/StudioWebView.swift'), /WKWebView/);
  assert.match(read('apps/macos/ShibaStudio/StudioWebView.swift'), /NSViewRepresentable/);
  const macHost = read('apps/macos/ShibaStudio/StudioHost.swift');
  assert.match(macHost, /--port/);
  assert.match(read('apps/macos/ShibaStudio/AppIdentity.swift'), /18765/);
  assert.match(macHost, /preferredPort/);
  assert.doesNotMatch(macHost, /npm run start/);
  assert.match(read('apps/macos/ShibaStudio/AppIdentity.swift'), /https:\/\/shiba-studio\.io\/packages\/manifest\.json/);
  assert.match(read('apps/macos/ShibaStudio/AppUpdater.swift'), /ShibaStudio-Desktop/);
  assert.match(read('apps/macos/ShibaStudio/AppUpdater.swift'), /reloadIgnoringLocalCacheData/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /30 \* 60/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /applicationDidBecomeActive/);
  assert.match(read('apps/macos/build.sh'), /xcodebuild/);
  assert.match(read('apps/macos/build.sh'), /generic\/platform=macOS/);
  assert.match(read('apps/macos/build.sh'), /--no-zip/);
  assert.doesNotMatch(read('apps/macos/build.sh'), /iphonesimulator/);
  assert.equal(
    existsSync(path.join(ROOT, 'apps/macos/ShibaStudio/Assets.xcassets/Contents.json')),
    true,
    'macOS asset catalog',
  );

  const page = read(PACKAGES_PAGE_PATH);
  assert.match(page, /id="packages"/);
  for (const app of catalog.apps) {
    assert(page.includes(app.name), `packages page must offer ${app.name}`);
    assert(page.includes(app.artifact), `packages page must name ${app.artifact}`);
  }
  assert.doesNotMatch(page, /Shiba Studio for iOS/);
  assert.doesNotMatch(page, /iphonesimulator/);
  assert.doesNotMatch(page, /npm run start/);
  assert.match(page, /Double-click/);
  assert.match(page, /updates itself/);
  assert.match(page, /packages-main/);
  assert.match(page, /packages-development/);
  assert.match(page, /channel-main/);
  assert.match(page, /channel-development/);

  const seedManifest = JSON.parse(read(PACKAGES_MANIFEST_PATH)) as { version?: unknown; channels?: Record<string, unknown> };
  assert.equal(seedManifest.version, 1);
  assert(seedManifest.channels && 'main' in seedManifest.channels && 'development' in seedManifest.channels);

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /branches: \[main, development\]/);
  assert.match(ci, /native-windows:/);
  assert.match(ci, /native-macos:/);
  assert.doesNotMatch(ci, /native-ios:/);
  assert.match(ci, /publish-packages:/);
  assert.match(ci, /scripts\/ci\/pack-windows-app\.ps1/);
  assert.match(ci, /scripts\/ci\/pack-macos-app\.sh/);
  assert.match(ci, /native-windows:[\s\S]*?actions\/setup-node/);
  assert.match(ci, /native-macos:[\s\S]*?actions\/setup-node/);
  assert.match(ci, /native-windows:[\s\S]*?npm run build/);
  assert.match(ci, /native-macos:[\s\S]*?npm run build/);
  assert.match(ci, /needs: \[verify, audit, e2e, docker, native-windows, native-macos\]/);
  assert.match(ci, /Publish packages page/);
  assert.match(
    ci,
    /secrets\.REPOSITORY_TRAFFIC_TOKEN \|\| github\.token/,
    'packages publish must reuse the established gh-pages write token',
  );
  assert.match(
    ci,
    /github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/development'/,
  );
  assert.match(
    ci,
    /publish-packages:[\s\S]*?github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/,
    'packages must republish after self-heal and weekly maintain re-dispatch CI',
  );
  assert.match(
    ci,
    /Promote development[\s\S]*?actions\/workflows\/ci\.yml\/dispatches/,
    'promote must dispatch main CI after a github-actions merge so packages-main still compiles',
  );

  const release = read('.github/workflows/release.yml');
  assert.match(release, /native-windows:/);
  assert.match(release, /native-macos:/);
  assert.match(release, /scripts\/ci\/pack-windows-app\.ps1/);
  assert.match(release, /scripts\/ci\/pack-macos-app\.sh/);
  assert.match(release, /ShibaStudio-windows-x64\.zip/);
  assert.match(release, /ShibaStudio-macos\.zip/);
  assert.doesNotMatch(release, /ShibaStudio-ios-simulator\.zip/);

  const weekly = read('scripts/ci/scheduled-maintain-lib.mjs');
  assert.match(weekly, /Windows and macOS/);
  assert.match(weekly, /packages page/);
  assert.match(weekly, /auto-updating/);
  assert.match(weekly, /apps\//);

  const verifyAll = read('scripts/verify-all.ts');
  assert.match(verifyAll, /verify-native-apps\.ts/);

  assert.match(read('components/shiba-studio.tsx'), /shiba-studio\.io\/packages\.html/);
  const siteIndex = read('site/index.html');
  assert.match(siteIndex, /packages\.html/);
  const publicDocs = read('site/docs.html');
  assert.match(publicDocs, /packages\.html/);

  const merged = mergePackagesManifest(null, 'development', {
    sha: 'abc',
    runUrl: 'https://example.test/run',
    releaseUrl: 'https://github.com/stevologic/shiba-studio/releases/tag/packages-development',
    apps: {
      windows: {
        name: 'Shiba Studio for Windows',
        file: 'ShibaStudio-windows-x64.zip',
        url: 'https://github.com/stevologic/shiba-studio/releases/download/packages-development/ShibaStudio-windows-x64.zip',
      },
      macos: {
        name: 'Shiba Studio for macOS',
        file: 'ShibaStudio-macos.zip',
        url: 'https://github.com/stevologic/shiba-studio/releases/download/packages-development/ShibaStudio-macos.zip',
      },
    },
  });
  assert.equal(merged.channels.development?.sha, 'abc');
  assert.equal(merged.channels.main, undefined);

  await assertPackerPathGuards();
  console.log('verify-native-apps: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
