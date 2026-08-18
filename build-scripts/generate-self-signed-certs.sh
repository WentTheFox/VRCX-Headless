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
# The two certs are NOT symmetric, found live (2026-08-18) after ruling out
# every other explanation:
#   - Windows genuinely works with an EMPTY passphrase -- signtool.exe
#     signed real installers fine with WIN_CSC_KEY_PASSWORD left unset.
#   - macOS does NOT. Its Keychain (`security import`, what electron-builder
#     shells out to) rejects a truly empty PKCS12 password outright with
#     "MAC verification failed during PKCS12 import" -- reproduced
#     identically across a modern-format cert, a `-legacy`-format cert, and
#     both unset and explicit-empty-string CSC_KEY_PASSWORD forms. Checked
#     electron-builder's own source (app-builder-lib's platformPackager.js)
#     to confirm it really does pass a literal empty string to the signer
#     in that case, not some other value -- this is a genuine macOS/
#     Keychain-side rejection of empty PKCS12 passwords, not an
#     electron-builder or OpenSSL bug. A real password is the only thing
#     that worked, so this script auto-generates one for the macOS cert
#     only (openssl rand, not user-entered -- there's nothing to remember,
#     it just needs to exist and match what's in the CSC_KEY_PASSWORD
#     secret).
#
# Run this ONCE, locally, yourself -- it is never invoked by CI.

SUBJECT="/CN=WentTheFox/C=HU/ST=Pest/L=Budapest"
DAYS=3650
OUT_DIR="$(pwd)"
WIN_PFX="$OUT_DIR/codesign-windows.pfx"
MAC_P12="$OUT_DIR/codesign-macos.p12"
MAC_PASSWORD="$(openssl rand -base64 24)"

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
    -passout "pass:"

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
    -passout "pass:$MAC_PASSWORD"

echo
echo "Done. Two files were produced in $OUT_DIR:"
echo "  - $WIN_PFX  (Windows Authenticode, self-signed, CN=WentTheFox)"
echo "  - $MAC_P12  (macOS codesign, self-signed, CN=WentTheFox)"
echo
echo "The Windows file has NO passphrase; the macOS file has an"
echo "auto-generated one (see below). Both contain private key material --"
echo "anyone with a copy can sign as WentTheFox with it. Keep them OUT of"
echo "git (already covered by .gitignore's *.pfx / *.p12 pattern) and don't"
echo "copy them around casually."
echo
echo "To populate the three required GitHub Actions secrets (repo Settings ->"
echo "Secrets and variables -> Actions), run:"
echo
echo "  base64 -w0 '$WIN_PFX'   # -> paste as secret WIN_CSC_LINK"
echo "  base64 -w0 '$MAC_P12'   # -> paste as secret CSC_LINK"
echo
echo "The macOS cert's password (paste as-is, not base64'd, into secret"
echo "CSC_KEY_PASSWORD):"
echo "  $MAC_PASSWORD"
echo
echo "No WIN_CSC_KEY_PASSWORD secret is needed -- Windows signing works"
echo "correctly with that variable left unset."
echo
echo "Reminder: this is a self-signed identity. It reduces some local"
echo "friction (Authenticode presence, a real codesign signature) but does"
echo "NOT make Windows SmartScreen or macOS Gatekeeper trust the app the way"
echo "a CA-issued / Apple Developer ID certificate would."
