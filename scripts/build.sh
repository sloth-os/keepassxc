#!/usr/bin/env bash
# Build the keepassxc-web wasm module.
#
# Prerequisites (all prebuilt once; see README.md for the recipes):
#   ~/wasm/emsdk             Emscripten SDK 3.1.50
#   ~/wasm/qt-wasm-dl/q673/6.7.3/wasm_singlethread   Qt 6.7.3 wasm prebuilt
#   ~/wasm/qt-desktop/6.7.3/gcc_64                    Qt 6.7.3 host (moc only)
#   ~/wasm/build/botan-wasm                           Botan 3.6.1 wasm static
#   ~/wasm/build/zlib-wasm                            zlib 1.3.1 wasm static
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK="${EMSDK:-$HOME/wasm/emsdk}"
QT_WASM="${QT_WASM:-$HOME/wasm/qt-wasm-dl/q673/6.7.3/wasm_singlethread}"
QT_HOST="${QT_HOST:-$HOME/wasm/qt-desktop/6.7.3/gcc_64}"
BOTAN="${BOTAN:-$HOME/wasm/build/botan-wasm}"
ZLIB="${ZLIB:-$HOME/wasm/build/zlib-wasm}"
BUILD="$ROOT/build-wasm"

# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null

# cmake + ninja are installed in a venv shared by the wasm toolchains
if [ -d "$HOME/wasm/venv/bin" ]; then
    export PATH="$HOME/wasm/venv/bin:$PATH"
fi

# src/.vendored is touched only at the very end of a successful vendor.sh;
# a partial tree (failed mid-copy) has no stamp and gets re-vendored.
if [ ! -f "$ROOT/src/.vendored" ]; then
    echo "src/ missing or incomplete — running vendor.sh first ..."
    "$ROOT/scripts/vendor.sh"
fi

cd "$ROOT"
if [ ! -f "$BUILD/build.ninja" ]; then
    emcmake cmake -G Ninja -B "$BUILD" \
        -DQT_WASM="$QT_WASM" \
        -DQT_HOST="$QT_HOST" \
        -DBOTAN="$BOTAN" \
        -DZLIB="$ZLIB"
fi
cmake --build "$BUILD" -j"$(nproc)"

mkdir -p "$ROOT/web/wasm"
cp -f "$BUILD/keepassxc.js" "$ROOT/web/wasm/"
cp -f "$BUILD/keepassxc.wasm" "$ROOT/web/wasm/"
cp -f "$BUILD/keepassxc.data" "$ROOT/web/wasm/" 2>/dev/null || true

echo "Built: $(du -h "$ROOT/web/wasm/keepassxc.wasm" | cut -f1) wasm"
