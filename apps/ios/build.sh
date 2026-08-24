#!/usr/bin/env bash
# Compile the iOS companion for the generic iOS Simulator SDK.
# Device-signed App Store / TestFlight binaries need an Apple certificate
# and are not produced in CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DERIVED="${1:-$ROOT/dist/native/ios-derived}"
OUT="${2:-$ROOT/dist/native/ios}"
PROJECT="$ROOT/apps/ios/ShibaStudio.xcodeproj"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is required (macOS + Xcode)." >&2
  exit 1
fi

mkdir -p "$DERIVED" "$OUT"

xcodebuild \
  -project "$PROJECT" \
  -scheme ShibaStudio \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  build

APP="$(find "$DERIVED/Build/Products" -name 'ShibaStudio.app' -type d | head -n 1)"
if [ -z "$APP" ]; then
  echo "Compiled ShibaStudio.app was not found under $DERIVED" >&2
  exit 1
fi

rm -rf "$OUT/ShibaStudio.app"
cp -R "$APP" "$OUT/ShibaStudio.app"
rm -f "$OUT/ShibaStudio-ios-simulator.zip"
(
  cd "$OUT"
  zip -qry ShibaStudio-ios-simulator.zip ShibaStudio.app
)
echo "Wrote $OUT/ShibaStudio-ios-simulator.zip"
