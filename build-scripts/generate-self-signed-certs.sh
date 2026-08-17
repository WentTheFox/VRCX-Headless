#!/bin/bash
set -euo pipefail

# Generates two SEPARATE self-signed code-signing certificates for
# VRCX-Headless desktop releases (.github/workflows/desktop-release.yaml):
#   1. codesign-windows.pfx -- Authenticode (Windows/NSIS), PKCS#12
#   2. codesign-macos.p12   -- Apple codesign, PKCS#12
# Both use the same subject identity but are otherwise fully independent key
# pairs -- two distinct certs, one per platform, not one cert reused for both.
#
# Neither is issued by a real CA. This reduces some Windows SmartScreen /
# macOS Gatekeeper friction (a real Authenticode signature / codesign
# signature is present) but does NOT eliminate it, and does NOT satisfy
# Apple notarization, which requires an actual Apple Developer ID
# certificate. Users will still see "unidentified developer" / SmartScreen
# warnings on first launch.
#
# Run this ONCE, locally, yourself -- it is never invoked by CI. Keep the two
# .pfx/.p12 files OUT of git (already covered by .gitignore's `*.pfx`/`*.p12`
# pattern) -- only their base64 form, pasted into GitHub Actions secrets,
# should ever leave this machine.

SUBJECT="/CN=WentTheFox/C=HU/ST=Pest/L=Budapest"
DAYS=3650
OUT_DIR="$(pwd)"
WIN_PFX="$OUT_DIR/codesign-windows.pfx"
MAC_P12="$OUT_DIR/codesign-macos.p12"

read -r -s -p "Enter a password to protect BOTH generated files (used for WIN_CSC_KEY_PASSWORD and CSC_KEY_PASSWORD): " CERT_PASSWORD
echo
read -r -s -p "Confirm password: " CERT_PASSWORD_CONFIRM
echo
if [ "$CERT_PASSWORD" != "$CERT_PASSWORD_CONFIRM" ]; then
    echo "Passwords did not match." >&2
    exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "== Generating Windows Authenticode code-signing certificate =="
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
    -keyout "$workdir/win-key.pem" \
    -out "$workdir/win-cert.pem" \
    -subj "$SUBJECT" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "keyUsage=digitalSignature"

openssl pkcs12 -export \
    -inkey "$workdir/win-key.pem" \
    -in "$workdir/win-cert.pem" \
    -out "$WIN_PFX" \
    -passout "pass:$CERT_PASSWORD"

echo "== Generating macOS codesign certificate =="
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
    -keyout "$workdir/mac-key.pem" \
    -out "$workdir/mac-cert.pem" \
    -subj "$SUBJECT" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "keyUsage=digitalSignature"

openssl pkcs12 -export \
    -inkey "$workdir/mac-key.pem" \
    -in "$workdir/mac-cert.pem" \
    -out "$MAC_P12" \
    -passout "pass:$CERT_PASSWORD"

echo
echo "Done. Two files were produced in $OUT_DIR:"
echo "  - $WIN_PFX  (Windows Authenticode, self-signed, CN=WentTheFox)"
echo "  - $MAC_P12  (macOS codesign, self-signed, CN=WentTheFox)"
echo
echo "These files contain private key material. Keep them OUT of git"
echo "(already covered by .gitignore's *.pfx / *.p12 pattern) -- copy them"
echo "somewhere safe outside the repo if you want a backup."
echo
echo "To populate the four required GitHub Actions secrets (repo Settings ->"
echo "Secrets and variables -> Actions), run:"
echo
echo "  base64 -w0 '$WIN_PFX'   # -> paste as secret WIN_CSC_LINK"
echo "  base64 -w0 '$MAC_P12'   # -> paste as secret CSC_LINK"
echo
echo "The password you entered above goes into these two secrets AS-IS"
echo "(not base64'd):"
echo "  WIN_CSC_KEY_PASSWORD"
echo "  CSC_KEY_PASSWORD"
echo
echo "Reminder: this is a self-signed identity. It reduces some local"
echo "friction (Authenticode presence, a real codesign signature) but does"
echo "NOT make Windows SmartScreen or macOS Gatekeeper trust the app the way"
echo "a CA-issued / Apple Developer ID certificate would."
