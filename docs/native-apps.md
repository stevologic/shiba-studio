# Native apps

Shiba Studio ships two compiled desktop apps in addition to the source / Docker
install. They wrap the **same** production Studio UI — they are not a second
product.

| App | Kind | Source | Artifact |
| --- | --- | --- | --- |
| **Shiba Studio for Windows** | Desktop host (WebView2) | `apps/windows` | `ShibaStudio-windows-x64.zip` |
| **Shiba Studio for macOS** | Desktop host (WKWebView) | `apps/macos` | `ShibaStudio-macos.zip` |

They are listed on the public [packages page](https://shiba-studio.io/packages.html).
`apps/catalog.json` is the source of truth for names, channels, and filenames.

## What each app does

Double-click the downloaded app. It silently starts a bundled Studio on
loopback (`127.0.0.1:18765` when free) and fills a native window with that
same UI. There is no address bar, no “start the server” strip, and no need
to clone the repo or install Node.

The OS wrapper stays thin and native:

- **Windows** — dark DWM title bar, standard menu (Studio / View / Help),
  Evergreen WebView2 for the page.
- **macOS** — standard menu bar and Settings, thin title bar, WKWebView
  for the page. The zip is unsigned; first launch of a downloaded build
  may need right-click → Open. The bundled runtime is Apple Silicon.

Studio data lives in `%LOCALAPPDATA%\ShibaStudio\data` on Windows and
`~/Library/Application Support/ShibaStudio/data` on macOS, not inside the
app bundle. Each app checks
`https://shiba-studio.io/packages/manifest.json` and updates itself when
the channel you downloaded (`main` or `development`) publishes a new SHA.
It checks on launch, when the window is focused, and every 30 minutes while
running. Switch channels from Preferences / Settings.

`scripts/pack-desktop-runtime.mjs` embeds official Node 22, the production
`.next` tree, and `node_modules` (including `node-pty` built on that OS).
It walks the tree itself (no `fs.cpSync` dereference) so Windows junctions
and paths longer than `MAX_PATH` do not abort the package. CI must pack on
Windows and macOS — native addons are not portable.

## Compile on every push

`.github/workflows/ci.yml` already runs on `main` and `development`. Two
required jobs sit on that same pipeline:

- `native-windows` — `npm run build` + `scripts/ci/pack-windows-app.ps1`
- `native-macos` — `npm run build` + `scripts/ci/pack-macos-app.sh`

Both are part of **CI OK**, so a broken app project fails promotion the same
way a red `npm test` does. The Grok self-heal job on `development` also
watches those jobs.

After a green package on a **push** or **workflow_dispatch** to `main` or
`development` (not on pull requests), `publish-packages` updates:

1. the rolling GitHub Release `packages-main` or `packages-development`;
2. `packages/manifest.json` and `packages.html` on the `gh-pages` site.

Promote re-dispatches CI on `main` after a bot merge so the stable channel
is not skipped. Tagged `v*` releases attach the same zips via
`.github/workflows/release.yml`.

## Local compile

Shell only (no bundled Studio — useful while editing the host):

```powershell
npm run build:windows
```

```bash
npm run build:macos
```

Full package, same as CI (needs a production `npm run build` first):

```powershell
pwsh -File scripts/ci/pack-windows-app.ps1
```

```bash
bash scripts/ci/pack-macos-app.sh
```

`scripts/verify-native-apps.ts` (part of `npm test`) checks the catalog, app
sources, packer, packages page, and the CI/release/maintain wiring without
needing Windows or Xcode on the machine running the suite.

## Maintenance

Weekly Grok maintain is instructed to keep `apps/` packaging and the packages
page listed. It cannot edit `.github/workflows/` (`GITHUB_TOKEN` cannot push
workflow files); fix app sources or `site/packages.html` when the offering
drifts.
