# Native apps

Official **Windows** and **macOS** desktop apps for Shiba Studio. Windows is
packaged on every push to `main` and `development` by `.github/workflows/ci.yml`
and attached to rolling GitHub Releases (`packages-main`, `packages-development`).
macOS builds are local / Luigi (`scripts/ci/pack-macos-app.sh`), not a
GitHub-hosted macOS runner. Both are offered on the public
[packages page](../site/packages.html).

Each app is a thin native host around the **same** production Studio UI.
Double-click starts a bundled Node + `next start` on loopback. The window
chrome is OS-native; the page is identical to the web app. Channel builds
update themselves from `packages/manifest.json`.

| App | Project | What it is |
| --- | --- | --- |
| Windows | `apps/windows` | Self-contained .NET 8 WebView2 host + bundled Studio runtime. |
| macOS | `apps/macos` | Native SwiftUI + WKWebView host + bundled Studio runtime. |

`apps/catalog.json` is the source of truth for names, artifacts, and channels.
Do not list an app on the packages page that is not in that catalog.

## Compile locally

Host shell only:

```powershell
dotnet publish apps/windows/ShibaStudio.csproj -c Release -r win-x64 --self-contained true -o dist/native/windows/ShibaStudio
```

```bash
bash apps/macos/build.sh --no-zip
```

Full CI-shaped package (after `npm ci && npm run build && npm prune --omit=dev`):

```powershell
pwsh -File scripts/ci/pack-windows-app.ps1
```

```bash
bash scripts/ci/pack-macos-app.sh
```

Tagged `v*` releases attach the Windows zip via `.github/workflows/release.yml`.
The macOS zip is a local / Luigi attach.
