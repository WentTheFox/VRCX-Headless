#!/bin/bash
set -euo pipefail

# Generates a self-signed Windows Authenticode code-signing certificate for
# VRCX-Headless desktop releases (.github/workflows/desktop-release.yaml).
#
# Not issued by a real CA. This reduces some Windows SmartScreen friction (a
# real Authenticode signature is present) but does NOT eliminate the
# warning. Users will still see it on first launch.
#
# macOS builds ship UNSIGNED, deliberately -- not something this script
# covers. Found live (2026-08-18, see git history/CLAUDE.md for the full
# trail): a self-signed PKCS12 CAN be imported into a macOS keychain (after
# working around a real OpenSSL-3.x/Security-framework PBE-algorithm
# compatibility bug), but electron-builder's own identity-discovery
# preflight refuses to use it anyway, because macOS flags any cert with no
# trusted CA chain as CSSMERR_TP_NOT_TRUSTED -- which every self-signed cert
# always is. Fixing that means bypassing electron-builder's built-in mac
# signing entirely (manual keychain trust + codesign), out of scope for now.
#
# The PKCS#12 file is generated with an EMPTY passphrase, deliberately --
# electron-builder treats a missing WIN_CSC_KEY_PASSWORD as an empty
# password, confirmed live to work correctly for Windows signing. Since this
# cert is already self-signed (no CA trust to leverage regardless), the only
# thing a passphrase would protect is the .pfx file itself if it leaked
# outside GitHub's secret store -- accepted tradeoff for simpler secret
# management. Anyone with the raw file can use it to sign as WentTheFox, so
# still keep it out of git (already covered by .gitignore) and don't
# casually copy it around.
#
# Run this ONCE, locally, yourself -- it is never invoked by CI.

SUBJECT="/CN=WentTheFox/C=HU/ST=Pest/L=Budapest"
DAYS=3650
OUT_DIR="$(pwd)"
WIN_PFX="$OUT_DIR/codesign-windows.pfx"

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

echo
echo "Done. $WIN_PFX was produced (Windows Authenticode, self-signed, CN=WentTheFox)."
echo
echo "This file contains private key material with NO passphrase -- anyone"
echo "who gets a copy can sign as WentTheFox with it. Keep it OUT of git"
echo "(already covered by .gitignore's *.pfx pattern) and don't copy it"
echo "around casually."
echo
echo "To populate the required GitHub Actions secret (repo Settings ->"
echo "Secrets and variables -> Actions), run:"
echo
echo "  base64 -w0 '$WIN_PFX'   # -> paste as secret WIN_CSC_LINK"
echo
echo "No WIN_CSC_KEY_PASSWORD secret is needed -- Windows signing works"
echo "correctly with that variable left unset."
echo
echo "Reminder: this is a self-signed identity. It reduces some local"
echo "friction (Authenticode presence) but does NOT make Windows SmartScreen"
echo "trust the app the way a CA-issued certificate would."
