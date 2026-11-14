#!/usr/bin/env bash
# Downloads the open-source hardware-conformance test ROMs used by
# `npm run test:conformance` into test-roms/ (gitignored; none of it is committed).
#
# Source: https://github.com/c-sp/game-boy-test-roms, one release zip that bundles
# Blargg's tests, the Mooneye Test Suite, dmg-acid2, Mealybug Tearoom, SameSuite,
# Gambatte, GBMicrotest, rtc3test, MBC3 Tester and others, each with a howto that
# documents its exit condition and pass/fail signal.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${GB_TEST_ROMS_VERSION:-v7.0}"
URL="https://github.com/c-sp/game-boy-test-roms/releases/download/${VERSION}/game-boy-test-roms-${VERSION}.zip"
DEST=test-roms

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetch $URL"
curl -fsSL --retry 2 -o "$TMP/roms.zip" "$URL"

rm -rf "$DEST"
mkdir -p "$DEST"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP/roms.zip" -d "$DEST"
else
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/roms.zip" "$DEST"
fi
echo "$VERSION" > "$DEST/VERSION"

echo "done: $(find "$DEST" \( -name '*.gb' -o -name '*.gbc' \) | wc -l) ROMs in $DEST/ ($VERSION)"
