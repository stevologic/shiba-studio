# Native apps

Shiba Studio ships two compiled clients in addition to the source / Docker
install:

| App | Kind | Source | Artifact |
| --- | --- | --- | --- |
| **Shiba Studio for Windows** | Desktop host (WebView2) | `apps/windows` | `ShibaStudio-windows-x64.zip` |
| **Shiba Studio for iOS** | Companion (WKWebView) | `apps/ios` | `ShibaStudio-ios-simulator.zip` |

They are listed on the public [packages page](https://shiba-studio.io/packages.html).
`apps/catalog.json` is the source of truth for names, channels, and filenames.

## What each app does

The **Windows** app is a native host, not a rewrite of Studio. It can:

- open a running Studio at `http://127.0.0.1:3000` (or another origin you type);
- start `npm run start` from a checkout found via `SHIBA_STUDIO_ROOT`,
  `%LOCALAPPDATA%\ShibaStudio\checkout`, or a nearby `package.json` named
  `shiba-studio`;
- open `/companion` in the same window.

It needs the Evergreen WebView2 runtime (current Windows 11 already has it)
and Node.js ≥ 22.5 if you want it to start the server itself.

The **iOS** app is the official companion. The Next.js / `node:sqlite` /
`node-pty` host cannot run on iOS. Pair it with a Studio that has remote
Companion access enabled (`dev:lan` / `start:lan` or a public origin). CI
produces a **simulator** build; device or App Store signing is a human step
that uses the same Xcode project and an Apple certificate.

## Compile on every push

`.github/workflows/ci.yml` already runs on `main` and `development`. Two
required jobs sit on that same pipeline:

- `native-windows` — `dotnet publish` on `windows-latest`
- `native-ios` — `apps/ios/build.sh` (`xcodebuild`) on `macos-latest`

Both are part of **CI OK**, so a broken app project fails promotion the same
way a red `npm test` does. The Grok self-heal job on `development` also
watches those compiles.

After a green compile on a **push** or **workflow_dispatch** to `main` or
`development` (not on pull requests), `publish-packages` updates:

1. the rolling GitHub Release `packages-main` or `packages-development`;
2. `packages/manifest.json` and `packages.html` on the `gh-pages` site.

Promote re-dispatches CI on `main` after a bot merge so the stable channel
is not skipped. Tagged `v*` releases attach the same zips via
`.github/workflows/release.yml`.

## Local compile

```powershell
npm run build:windows
```

```bash
npm run build:ios
```

`scripts/verify-native-apps.ts` (part of `npm test`) checks the catalog, app
sources, packages page, and the CI/release/maintain wiring without needing
Windows or Xcode on the machine running the suite.

## Maintenance

Weekly Grok maintain is instructed to keep `apps/` compiling and the packages
page listed. It cannot edit `.github/workflows/` (`GITHUB_TOKEN` cannot push
workflow files); fix app sources or `site/packages.html` when the offering
drifts.
