#!/usr/bin/env bash
# Downloads a couple of freely licensed homebrew games into roms/local/ (gitignored),
# as something real to play and to sanity-check the emulator with.
#
#   Adjustris                    by Dave VanEe (tbsp), CC0-1.0     github.com/tbsp/Adjustris
#   Libbet and the Magic Floor   by Damian Yerrick, zlib licence   github.com/pinobatch/libbet
set -euo pipefail
cd "$(dirname "$0")/.."

DEST=roms/local
mkdir -p "$DEST"

fetch() { # url, file
  echo "fetch $1"
  curl -fsSL --retry 2 -o "$DEST/$2" "$1"
}

fetch https://github.com/tbsp/Adjustris/releases/download/v1.1/adjustris.gb adjustris.gb
fetch https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb libbet.gb

ls -l "$DEST"
