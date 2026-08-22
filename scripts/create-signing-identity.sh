#!/bin/zsh
set -euo pipefail

# Creates a self-signed code signing certificate so rebuilds keep the same identity.
#
# macOS records permission grants (Documents access, Automation) against an app's code
# signing identity. An ad-hoc signature has no certificate, so the identity is the
# binary's cdhash: every rebuild produces a different one, macOS sees an app it has never
# met, and asks for everything again. A certificate — self-signed is fine, no Apple
# Developer account needed — gives the app a stable identity, and the grants stick.
#
# Run once. build-app.sh picks the certificate up automatically afterwards.

NAME="${1:-CleanMyCodex Local Signing}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
    print "Already present: $NAME"
    exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$WORK_DIR/key.pem" \
    -out "$WORK_DIR/cert.pem" \
    -subj "/CN=${NAME}" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

openssl pkcs12 -export \
    -inkey "$WORK_DIR/key.pem" \
    -in "$WORK_DIR/cert.pem" \
    -out "$WORK_DIR/identity.p12" \
    -passout pass: >/dev/null 2>&1

# -T /usr/bin/codesign lets codesign use the key without a password prompt every time.
security import "$WORK_DIR/identity.p12" -k "$KEYCHAIN" -P "" -T /usr/bin/codesign >/dev/null

if ! security find-identity -v -p codesigning | grep -q "$NAME"; then
    print -u2 "Imported, but codesign does not list it yet."
    print -u2 "Open Keychain Access, find \"$NAME\", and set its trust for Code Signing to \"Always Trust\"."
    exit 1
fi

print "Created: $NAME"
print
print "Next: rebuild with ./scripts/build-app.sh — it finds this certificate on its own."
print "The first launch after that still asks for permissions once; later rebuilds will not."
print
print "Gatekeeper still does not know this certificate, so the very first launch needs"
print "right-click → Open. That is unrelated to the permission prompts."
