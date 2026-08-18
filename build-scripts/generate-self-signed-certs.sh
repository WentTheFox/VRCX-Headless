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
# Both PKCS#12 files are generated with an EMPTY passphrase, deliberately --
# electron-builder treats a missing CSC_KEY_PASSWORD/WIN_CSC_KEY_PASSWORD as
# an empty password, so this needs only 2 GitHub Actions secrets instead of
# 4. Since these certs are already self-signed (no CA trust to leverage
# regardless), the only thing a passphrase would protect is the .pfx/.p12
# file itself if it leaked outside GitHub's secret store -- accepted
# tradeoff for simpler secret management. Anyone with the raw file can use
# it to sign as WentTheFox, so still keep it out of git (already covered by
# .gitignore) and don't casually copy it around.
#
# The macOS cert specifically is exported with `-legacy` (RC2-40-CBC/3DES +
# SHA-1 MAC) rather than OpenSSL 3.x's modern default (AES-256-CBC +
# SHA-256 MAC) -- found live (2026-08-17/18): macOS's `security import`
# (what electron-builder shells out to for codesign) fails every modern-
# format PKCS#12 with "MAC verification failed during PKCS12 import (wrong
# password?)", reproduced identically across two independently-generated
# certs from two different OpenSSL builds (3.5.7 and 3.0.20), so this is a
# genuine Apple Security-framework/OpenSSL-3.x incompatibility, not a
# one-off bad file. Windows' signtool has no such problem with the modern
# format, so only the macOS export needs `-legacy`.
#
# Run this ONCE, locally, yourself -- it is never invoked by CI.

SUBJECT="/CN=WentTheFox/C=HU/ST=Pest/L=Budapest"
DAYS=3650
OUT_DIR="$(pwd)"
WIN_PFX="$OUT_DIR/codesign-windows.pfx"
MAC_P12="$OUT_DIR/codesign-macos.p12"

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

openssl pkcs12 -export -legacy \
    -inkey "$workdir/mac-key.pem" \
    -in "$workdir/mac-cert.pem" \
    -out "$MAC_P12" \
    -passout "pass:"

echo
echo "Done. Two files were produced in $OUT_DIR:"
echo "  - $WIN_PFX  (Windows Authenticode, self-signed, CN=WentTheFox)"
echo "  - $MAC_P12  (macOS codesign, self-signed, CN=WentTheFox)"
echo
echo "These files contain private key material with NO passphrase -- anyone"
echo "who gets a copy can sign as WentTheFox with it. Keep them OUT of git"
echo "(already covered by .gitignore's *.pfx / *.p12 pattern) and don't copy"
echo "them around casually."
echo
echo "To populate the two required GitHub Actions secrets (repo Settings ->"
echo "Secrets and variables -> Actions), run:"
echo
echo "  base64 -w0 '$WIN_PFX'   # -> paste as secret WIN_CSC_LINK"
echo "  base64 -w0 '$MAC_P12'   # -> paste as secret CSC_LINK"
echo
echo "No WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD secrets are needed --"
echo "electron-builder treats a missing password as empty, matching how"
echo "these certs were generated."
echo
echo "Reminder: this is a self-signed identity. It reduces some local"
echo "friction (Authenticode presence, a real codesign signature) but does"
echo "NOT make Windows SmartScreen or macOS Gatekeeper trust the app the way"
echo "a CA-issued / Apple Developer ID certificate would."
