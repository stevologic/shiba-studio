# Native apps

Official **Windows** and **iOS** clients for Shiba Studio. They are compiled on
every push to `main` and `development` by `.github/workflows/ci.yml`, attached
to rolling GitHub Releases (`packages-main`, `packages-development`), and
offered on the public [packages page](../site/packages.html).

| App | Project | What it is |
| --- | --- | --- |
| Windows | `apps/windows` | Self-contained .NET 8 WebView2 host. Can start `npm run start` from a local checkout or attach to a running Studio. |
| iOS | `apps/ios` | SwiftUI + WKWebView companion. The full Node/Next host cannot run on iOS; this app is the paired remote client. |

`apps/catalog.json` is the source of truth for names, artifacts, and channels.
Do not list an app on the packages page that is not in that catalog.

## Compile locally

Windows (PowerShell, .NET 8 SDK):

```powershell
dotnet publish apps/windows/ShibaStudio.csproj -c Release -r win-x64 --self-contained true -o dist/native/windows
```

iOS (macOS + Xcode):

```bash
bash apps/ios/build.sh
```

CI uses the same commands. Tagged `v*` releases also attach these artifacts
via `.github/workflows/release.yml`.
