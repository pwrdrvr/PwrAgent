#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
out="$root/.local/remote-window/datagrams"
webp_prefix="${PWRWIN_WEBP_PREFIX:-/opt/homebrew}"
test -f "$webp_prefix/include/webp/encode.h"
mkdir -p "$out"
cp "$root/scripts/remote-window-prototype/LiveFixture.swift" "$out/main.swift"
clang -O2 -c "$root/scripts/remote-window-prototype/datagrams/webp.c" \
  -I "$webp_prefix/include" -o "$out/webp.o"
swiftc -O -D PWRWIN_DATAGRAMS -import-objc-header "$root/scripts/remote-window-prototype/datagrams/webp.h" \
  "$out/main.swift" \
  "$root/scripts/remote-window-prototype/datagrams/TileEncoder.swift" \
  "$out/webp.o" -L "$webp_prefix/lib" -lwebp -o "$out/tile-fixture"
