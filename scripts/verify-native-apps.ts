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
    assert.match(app.name, /Shiba Studio for (Windows|macOS)/);
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

  const pbx = read('apps/macos/ShibaStudio.xcodeproj/project.pbxproj');
  assert.match(pbx, /PRODUCT_BUNDLE_IDENTIFIER = "io\.shiba-studio\.macos"/);
  assert.match(pbx, /SDKROOT = macosx/);
  assert.match(pbx, /CODE_SIGNING_ALLOWED = NO/);
  assert.match(read('apps/macos/ShibaStudio/App.swift'), /ShibaStudioApp/);
  assert.match(read('apps/macos/ShibaStudio/ContentView.swift'), /Start local Studio/);
  assert.match(read('apps/macos/ShibaStudio/StudioWebView.swift'), /WKWebView/);
  assert.match(read('apps/macos/ShibaStudio/StudioWebView.swift'), /NSViewRepresentable/);
  assert.match(read('apps/macos/ShibaStudio/StudioHost.swift'), /npm run start/);
  assert.match(read('apps/macos/build.sh'), /xcodebuild/);
  assert.match(read('apps/macos/build.sh'), /generic\/platform=macOS/);
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
  assert.match(ci, /dotnet publish apps\/windows\/ShibaStudio\.csproj/);
  assert.match(ci, /bash apps\/macos\/build\.sh/);
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
  assert.match(release, /ShibaStudio-windows-x64\.zip/);
  assert.match(release, /ShibaStudio-macos\.zip/);
  assert.doesNotMatch(release, /ShibaStudio-ios-simulator\.zip/);

  const weekly = read('scripts/ci/scheduled-maintain-lib.mjs');
  assert.match(weekly, /Windows and macOS/);
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
      macos: {
        name: 'Shiba Studio for macOS',
        file: 'ShibaStudio-macos.zip',
        url: 'https://github.com/stevologic/shiba-studio/releases/download/packages-development/ShibaStudio-macos.zip',
      },
    },
  });
  assert.equal(merged.channels.development?.sha, 'abc');
  assert.equal(merged.channels.main, undefined);

  console.log('verify-native-apps: OK');
}

main();
