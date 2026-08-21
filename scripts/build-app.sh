#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
CONFIGURATION="${1:-release}"
ARCHITECTURES="${2:-}"
DIST_DIR="$PROJECT_DIR/dist"
APP_PATH="$DIST_DIR/CleanMyCodex.app"

if [[ "$CONFIGURATION" != "debug" && "$CONFIGURATION" != "release" ]]; then
    print -u2 "Usage: $0 [debug|release] [native|universal]"
    exit 2
fi

if [[ -z "$ARCHITECTURES" ]]; then
    if [[ "$CONFIGURATION" == "release" ]]; then
        ARCHITECTURES="universal"
    else
        ARCHITECTURES="native"
    fi
fi

if [[ "$ARCHITECTURES" != "native" && "$ARCHITECTURES" != "universal" ]]; then
    print -u2 "Usage: $0 [debug|release] [native|universal]"
    exit 2
fi

BUILD_ARGUMENTS=(-c "$CONFIGURATION")
if [[ "$ARCHITECTURES" == "universal" ]]; then
    BUILD_ARGUMENTS+=(--arch arm64 --arch x86_64)
fi

cd "$PROJECT_DIR"
swift build "${BUILD_ARGUMENTS[@]}"
BIN_DIR="$(swift build "${BUILD_ARGUMENTS[@]}" --show-bin-path)"
EXPECTED_APP="$PROJECT_DIR/dist/CleanMyCodex.app"
if [[ "$APP_PATH" != "$EXPECTED_APP" ]]; then
    print -u2 "Refusing to replace unexpected path: $APP_PATH"
    exit 3
fi

mkdir -p "$DIST_DIR"
rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp "$BIN_DIR/CleanMyCodex" "$APP_PATH/Contents/MacOS/CleanMyCodex"
cp "$PROJECT_DIR/Support/Info.plist" "$APP_PATH/Contents/Info.plist"
cp "$PROJECT_DIR/Support/AppIcon.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"
codesign --force --sign - --timestamp=none "$APP_PATH"

if [[ "$ARCHITECTURES" == "universal" ]]; then
    BINARY_ARCHITECTURES="$(lipo -archs "$APP_PATH/Contents/MacOS/CleanMyCodex")"
    if [[ "$BINARY_ARCHITECTURES" != *"arm64"* || "$BINARY_ARCHITECTURES" != *"x86_64"* ]]; then
        print -u2 "Universal build is missing an architecture: $BINARY_ARCHITECTURES"
        exit 4
    fi
fi

print "$APP_PATH"
