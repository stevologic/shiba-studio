#!/usr/bin/env bash
# Compile the macOS desktop host as a universal (arm64 + x86_64) .app.
# CI does not notarize; first launch on a downloaded zip may need
# right-click → Open until a Developer ID certificate is added.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DERIVED=""
OUT=""
NO_ZIP=0
for arg in "$@"; do
  case "$arg" in
    --no-zip) NO_ZIP=1 ;;
    *)
      if [ -z "$DERIVED" ]; then DERIVED="$arg"
      elif [ -z "$OUT" ]; then OUT="$arg"
      fi
      ;;
  esac
done
DERIVED="${DERIVED:-$ROOT/dist/native/macos-derived}"
OUT="${OUT:-$ROOT/dist/native/macos}"
PROJECT="$ROOT/apps/macos/ShibaStudio.xcodeproj"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is required (macOS + Xcode)." >&2
  exit 1
fi

mkdir -p "$DERIVED" "$OUT"

xcodebuild \
  -project "$PROJECT" \
  -scheme ShibaStudio \
  -configuration Release \
  -sdk macosx \
  -destination 'generic/platform=macOS' \
  -derivedDataPath "$DERIVED" \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=- \
  build

APP="$(find "$DERIVED/Build/Products" -name 'ShibaStudio.app' -type d | head -n 1)"
if [ -z "$APP" ]; then
  echo "Compiled ShibaStudio.app was not found under $DERIVED" >&2
  exit 1
fi

rm -rf "$OUT/ShibaStudio.app"
cp -R "$APP" "$OUT/ShibaStudio.app"
if [ "$NO_ZIP" -eq 1 ]; then
  echo "Wrote $OUT/ShibaStudio.app"
  exit 0
fi
rm -f "$OUT/ShibaStudio-macos.zip"
(
  cd "$OUT"
  zip -qry ShibaStudio-macos.zip ShibaStudio.app
)
echo "Wrote $OUT/ShibaStudio-macos.zip"
