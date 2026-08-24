import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

function main() {
  const catalog = loadNativeAppCatalog(ROOT);
  assert.equal(catalog.apps.length, 2);
  assert.deepEqual(catalog.channels, [...NATIVE_APP_CHANNELS]);
  assert.equal(releaseTagForChannel('main'), 'packages-main');
  assert.equal(releaseTagForChannel('development'), 'packages-development');
  assert.equal(parseNativeAppCatalog(JSON.parse(read(NATIVE_APP_CATALOG_PATH))).page, PACKAGES_PAGE_PATH);

  for (const app of catalog.apps) {
    assert.equal(existsSync(path.join(ROOT, app.project)), true, `${app.project} must exist`);
    assert.match(app.name, /Shiba Studio for (Windows|iOS)/);
  }

  const windowsCsproj = read('apps/windows/ShibaStudio.csproj');
  assert.match(windowsCsproj, /Microsoft\.Web\.WebView2/);
  assert.match(windowsCsproj, /net8\.0-windows/);
  assert.match(read('apps/windows/Program.cs'), /MainForm/);
  assert.match(read('apps/windows/StudioHost.cs'), /npm run start/);
  const mainForm = read('apps/windows/MainForm.cs');
  assert.match(mainForm, /WebView2/);
  assert.doesNotMatch(mainForm, /static readonly Color Text/, 'Form.Text must not be shadowed by a color field');
  assert.equal(existsSync(path.join(ROOT, 'apps/windows/shiba.ico')), true, 'Windows app icon');

  const pbx = read('apps/ios/ShibaStudio.xcodeproj/project.pbxproj');
  assert.match(pbx, /PRODUCT_BUNDLE_IDENTIFIER = "io\.shiba-studio\.app"/);
  assert.match(pbx, /CODE_SIGNING_ALLOWED = NO/);
  assert.match(read('apps/ios/ShibaStudio/App.swift'), /ShibaStudioApp/);
  assert.match(read('apps/ios/ShibaStudio/ContentView.swift'), /Open companion/);
  assert.match(read('apps/ios/ShibaStudio/StudioWebView.swift'), /WKWebView/);
  assert.match(read('apps/ios/build.sh'), /xcodebuild/);
  assert.match(read('apps/ios/build.sh'), /iphonesimulator/);
  assert.equal(
    existsSync(path.join(ROOT, 'apps/ios/ShibaStudio/Assets.xcassets/Contents.json')),
    true,
    'iOS asset catalog',
  );

  const page = read(PACKAGES_PAGE_PATH);
  assert.match(page, /id="packages"/);
  for (const app of catalog.apps) {
    assert(page.includes(app.name), `packages page must offer ${app.name}`);
    assert(page.includes(app.artifact), `packages page must name ${app.artifact}`);
  }
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
  assert.match(ci, /native-ios:/);
  assert.match(ci, /publish-packages:/);
  assert.match(ci, /dotnet publish apps\/windows\/ShibaStudio\.csproj/);
  assert.match(ci, /bash apps\/ios\/build\.sh/);
  assert.match(ci, /needs: \[verify, audit, e2e, docker, native-windows, native-ios\]/);
  assert.match(ci, /Publish packages page/);
  assert.match(
    ci,
    /github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/development'/,
  );

  const release = read('.github/workflows/release.yml');
  assert.match(release, /native-windows:/);
  assert.match(release, /native-ios:/);
  assert.match(release, /ShibaStudio-windows-x64\.zip/);
  assert.match(release, /ShibaStudio-ios-simulator\.zip/);

  const weekly = read('scripts/ci/scheduled-maintain-lib.mjs');
  assert.match(weekly, /Windows and iOS/);
  assert.match(weekly, /packages page/);
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
      ios: {
        name: 'Shiba Studio for iOS',
        file: 'ShibaStudio-ios-simulator.zip',
        url: 'https://github.com/stevologic/shiba-studio/releases/download/packages-development/ShibaStudio-ios-simulator.zip',
      },
    },
  });
  assert.equal(merged.channels.development?.sha, 'abc');
  assert.equal(merged.channels.main, undefined);

  console.log('verify-native-apps: OK');
}

main();
