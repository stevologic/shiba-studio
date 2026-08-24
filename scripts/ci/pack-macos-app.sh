#!/usr/bin/env bash
# Compile the macOS host and embed a production Studio runtime.
# Requires: npm ci, npm run build, and (ideally) npm prune --omit=dev already ran.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNEL="${CHANNEL:-}"
if [ "$CHANNEL" != "main" ] && [ "$CHANNEL" != "development" ]; then
  CHANNEL="development"
fi
SHA="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"

OUT="$ROOT/dist/native/macos"
PACKAGES="$ROOT/dist/native/packages"
mkdir -p "$PACKAGES"

bash "$ROOT/apps/macos/build.sh" --no-zip

APP="$OUT/ShibaStudio.app"
if [ ! -d "$APP" ]; then
  echo "Compiled ShibaStudio.app was not found at $APP" >&2
  exit 1
fi

node "$ROOT/scripts/pack-desktop-runtime.mjs" \
  --root "$ROOT" \
  --out "$APP/Contents/Resources/runtime" \
  --platform macos \
  --channel "$CHANNEL" \
  --sha "$SHA"

ZIP="$PACKAGES/ShibaStudio-macos.zip"
rm -f "$ZIP" "$OUT/ShibaStudio-macos.zip"
(
  cd "$OUT"
  zip -qry "$ZIP" ShibaStudio.app
  cp "$ZIP" ShibaStudio-macos.zip
)
echo "Wrote $ZIP"
