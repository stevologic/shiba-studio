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
  Evergreen WebView2 for the page. Minimize or close sends the window to the
  system tray (notification area) so Studio keeps running; click the tray icon
  or launch the app again to restore, and use **Exit** to quit. Preferences
  can turn that off. The host manifest requests `asInvoker` so Windows
  installer-detection does not flash an Unknown-publisher UAC prompt on the
  large self-contained exe. Launch also clears Mark-of-the-Web
  (`Zone.Identifier`) from the host and bundled `node.exe` so a GitHub zip
  does not re-prompt for every child process. Luigi can Authenticode-sign
  `ShibaStudio.exe` by setting `SHIBA_WINDOWS_PFX` (optional
  `SHIBA_WINDOWS_PFX_PASSWORD`) when packing.
- **macOS** — standard menu bar and Settings, thin title bar, WKWebView
  for the page. Dark Aqua so Studio / View / Help menus stay light-on-dark.
  Closing the window keeps the app in the menu bar (same idea as the Windows
  tray); click the extra or the Dock icon to restore, and Quit to exit.
  Preferences can turn that off. The zip is unsigned; first launch of a
  downloaded build may need right-click → Open. The bundled runtime is
  Apple Silicon.

Studio data lives in `%LOCALAPPDATA%\ShibaStudio\data` on Windows and
`~/Library/Application Support/ShibaStudio/data` on macOS, not inside the
app bundle. Each app checks
`https://shiba-studio.io/packages/manifest.json` and updates itself when
the channel you downloaded (`main` or `development`) publishes a new SHA.
It checks on launch, when the window is focused, and every 30 minutes while
running. Switch channels from Preferences / Settings.

`scripts/pack-desktop-runtime.mjs` embeds official Node 22, the production
`.next` tree, and `node_modules` (including `node-pty` built on that OS).
It copies through Windows junctions with a manual walk (macOS still prefers
native `cpSync`, then the same walk) and uses `\\?\` only at the filesystem
boundary so skip rules and cycle detection still see normal paths. Junctions
that resolve to a volume root (`C:\`, `/`, a UNC share root) are skipped so
a GitHub runner workspace on `D:` cannot pack the system drive. Windows
and macOS packages are local / Luigi — native addons are not portable,
and those zips cannot be produced on Ubuntu (no wine pack, no
`xcodebuild` on Actions).

## Packages page, not CI packaging

GitHub Actions is Ubuntu-only. It does not package desktop apps and must
not grow a wine pack or Ubuntu `xcodebuild` job. Windows and macOS zips
are built locally / Luigi (commands below).

After a **push** or **workflow_dispatch** to `main` or `development` (not
on pull requests), `publish-packages` refreshes `packages.html` on the
`gh-pages` site. It does not require a CI-built zip. Luigi attaches
`ShibaStudio-windows-x64.zip` and `ShibaStudio-macos.zip` to the rolling
`packages-main` / `packages-development` releases when those builds are
cut.

Promote re-dispatches CI on `main` after a bot merge so the packages page
on the stable channel is not skipped. Tagged `v*` releases publish notes
via `.github/workflows/release.yml`; desktop zips are a local / Luigi
attach.

## Local compile

Shell only (no bundled Studio — useful while editing the host):

```powershell
npm run build:windows
```

```bash
npm run build:macos
```

Full package (needs a production `npm run build` first). Both are the
local / Luigi path:

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
