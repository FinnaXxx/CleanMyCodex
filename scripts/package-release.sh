#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
DIST_DIR="$PROJECT_DIR/dist"
APP_PATH="$DIST_DIR/CleanMyCodex.app"
INFO_PLIST="$PROJECT_DIR/Support/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
DMG_NAME="CleanMyCodex-$VERSION-universal.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/CleanMyCodex-release.XXXXXX")"

cleanup() {
    rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

"$SCRIPT_DIR/build-app.sh" release universal

EXPECTED_DMG_PATH="$PROJECT_DIR/dist/CleanMyCodex-$VERSION-universal.dmg"
if [[ "$DMG_PATH" != "$EXPECTED_DMG_PATH" ]]; then
    print -u2 "Refusing to replace unexpected path: $DMG_PATH"
    exit 2
fi

ditto "$APP_PATH" "$STAGING_DIR/CleanMyCodex.app"
ln -s /Applications "$STAGING_DIR/Applications"

rm -f "$DMG_PATH"
hdiutil create \
    -volname "CleanMyCodex $VERSION" \
    -srcfolder "$STAGING_DIR" \
    -format UDZO \
    -ov \
    "$DMG_PATH"

print "$DMG_PATH"
