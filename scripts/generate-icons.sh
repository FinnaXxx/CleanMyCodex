#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
SOURCE_ICON="$PROJECT_DIR/Assets/AppIcon.png"
OUTPUT_ICON="$PROJECT_DIR/Support/AppIcon.icns"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/CleanMyCodex-icons.XXXXXX")"
ICONSET_DIR="$TEMP_ROOT/AppIcon.iconset"

cleanup() {
    rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

if [[ ! -f "$SOURCE_ICON" ]]; then
    print -u2 "Missing icon source: $SOURCE_ICON"
    exit 2
fi

mkdir -p "$ICONSET_DIR"

render_icon() {
    local size="$1"
    local filename="$2"
    sips -z "$size" "$size" "$SOURCE_ICON" --out "$ICONSET_DIR/$filename" >/dev/null
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICON"
print "$OUTPUT_ICON"
