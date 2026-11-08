# keepassxc-web

The KeePassXC password manager core, compiled to WebAssembly and driven from
a static web page. Everything — KDBX parsing, Argon2/AES key derivation,
entry CRUD, TOTP, search, generators — runs locally in the browser tab.
No server, no account, no network calls: open the page, open your `.kdbx`,
use your passwords.

Live site: <https://sloth-os.github.io/keepassxc/>

## What it is

- **`app/`** — the wasm bridge. `app/wasm/bridge.cpp` exposes a flat C API
  (`kpx_init`, `kpx_open`, `kpx_tree`, …) over the KeePassXC core, with
  JSON in and JSON out. `app/config-keepassx.h` is a static stand-in for
  upstream's generated config header.
- **`src/`** — the KeePassXC headless core (data model, crypto, keys,
  streams, KDBX readers/writers), vendored by `scripts/vendor.sh` from an
  upstream clone. GUI, CLI, autotype, network, browser integration, and
  hardware key drivers are deliberately excluded.
- **`patches/`** — portability patches applied on top of the vendored
  sources at vendor time (sequential execution instead of QtConcurrent,
  YubiKey stubs, missing direct includes, `openAttachment` stub).
- **`web/`** — the static site (`index.html`, `app.js`, `styles.css`).
  Settings and the opt-in encrypted autosave persist in IndexedDB via
  IDBFS; everything else lives in wasm memory for the session.
- **`scripts/`** — `vendor.sh` (source vendoring), `build.sh` (compile),
  `test-node.mjs` (bridge smoke test), `test-browser.mjs` (in-browser UI
  test), `deploy.sh` (publish to GitHub Pages).

## Quick start

```sh
# once: vendor the sources (needs a KeePassXC clone, see below)
scripts/vendor.sh

# build the wasm module into web/wasm/
scripts/build.sh

# smoke-test the module in node (create → unlock → CRUD → TOTP → save → reopen)
node scripts/test-node.mjs

# serve the site locally
cd web && python3 -m http.server 8000
```

The build needs the prebuilt toolchain described next, all under `~/wasm`.

## Prerequisites

| Path | What |
|---|---|
| `~/wasm/emsdk` | Emscripten SDK **3.1.50** |
| `~/wasm/qt-wasm-dl/q673/6.7.3/wasm_singlethread` | Qt 6.7.3 wasm (single-threaded) |
| `~/wasm/qt-desktop/6.7.3/gcc_64` | Qt 6.7.3 host install (only `moc` is used) |
| `~/wasm/build/botan-wasm` | Botan 3.6.1 static wasm |
| `~/wasm/build/zlib-wasm` | zlib 1.3.1 static wasm |
| `~/wasm/venv` | cmake + ninja (no system cmake needed) |

Override the locations with `EMSDK`, `QT_WASM`, `QT_HOST`, `BOTAN`, `ZLIB`
environment variables (see `scripts/build.sh`).

The build is deliberately **single-threaded**: GitHub Pages cannot send the
COOP/COEP headers that threaded wasm (SharedArrayBuffer) requires, so the
site works as plain static files anywhere.

### Recipes

**Emscripten 3.1.50** (pinned; newer majors change JS-eh flag defaults):

```sh
git clone https://github.com/emscripten-core/emsdk ~/wasm/emsdk
~/wasm/emsdk/emsdk install 3.1.50
~/wasm/emsdk/emsdk activate 3.1.50
```

**cmake + ninja** (system cmake is not required):

```sh
python3 -m venv ~/wasm/venv
~/wasm/venv/bin/pip install cmake ninja
```

**Qt 6.7.3** — via [aqtinstall](https://github.com/miurahr/aqtinstall),
wasm build for the target and a host build for `moc`:

```sh
pip install aqtinstall
aqt install-qt linux desktop 6.7.3 wasm_singlethread --outputdir ~/wasm/qt-wasm-dl/aqt
aqt install-qt linux desktop 6.7.3 gcc_64 --outputdir ~/wasm/qt-desktop/aqt
```

Unpack/move so the trees sit at the paths above (`.../6.7.3/wasm_singlethread`
and `.../6.7.3/gcc_64`). The wasm prebuilt ships no host tools — that is why
`moc` comes from the host install (`scripts/build.sh` passes its path to
CMake, which re-runs it on every vendored `Q_OBJECT` header).

**Botan 3.6.1** — configure for emscripten, static, exceptions on (both
Botan and libQt6Core contain real throw/catch code, so `-fexceptions` must
be baked in here and passed again at project link time):

```sh
mkdir -p ~/wasm/build && cd ~/wasm/build
tar xf<botan-3.6.1.tar.xz> && cd Botan-3.6.1
source ~/wasm/emsdk/emsdk_env.sh
python3 configure.py --os=emscripten --cpu=wasm \
    --build-targets=static --disable-shared --enable-static \
    --cxxflags="-fexceptions -O2" \
    --prefix="$HOME/wasm/build/botan-wasm"
make -j"$(nproc)" && make install
```

**zlib 1.3.1** — plain cmake build with the emscripten toolchain:

```sh
cd ~/wasm/build && tar xf <zlib-1.3.1.tar.gz> && cd zlib-1.3.1
source ~/wasm/emsdk/emsdk_env.sh
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$HOME/wasm/build/zlib-wasm"
cmake --build build-wasm -j"$(nproc)" && cmake --install build-wasm
```

Note the project links **two** zlib flavors on purpose: Qt6Core's
`qresource.cpp` references `z_`-prefixed symbols supplied by the Qt
prebuilt's own `libQt6BundledZLIB.a`, while the vendored `qtiocompressor`
uses plain `deflate`/`inflate` from this build. The archives define
disjoint symbol sets, so they do not collide.

### KeePassXC source clone

`scripts/vendor.sh` copies from a local clone (never modified), by default
`~/Downloads/keepassxc`, override with `KEEPASSXC_SRC`:

```sh
git clone https://github.com/keepassxreboot/keepassxc ~/Downloads/keepassxc
git -C ~/Downloads/keepassxc checkout 6bcb901a   # pinned commit
```

Vendoring is wipe-and-redo: `rm -rf src/ data/`, copy, apply patches in
`patches/` order, then stamp `src/.vendored`. A partial (failed) run leaves
no stamp, so the next build re-vendors from scratch instead of configuring
against a broken tree.

## Building

`scripts/build.sh` runs `emcmake cmake -G Ninja` once into `build-wasm/`,
then ninja. The project compiles as **C++20** — Botan 3.6's `secmem.h`
contains a `requires` clause that is not valid C++17 — and links:

- Qt6Core (with embind for the `emscripten::val` calls its wasm port uses)
- Qt's bundled PCRE2 and zlib, our zlib, and Botan, in dependency order
- exceptions enabled at compile and link time
  (`-fexceptions -sDISABLE_EXCEPTION_CATCHING=0`), IDBFS for persistence,
  the EFF wordlist preloaded at `/data`

Results land in `web/wasm/` (`keepassxc.js`, `keepassxc.wasm`,
`keepassxc.data`).

## Testing

```sh
node scripts/test-node.mjs [build-dir] # default: build-wasm
```

Exercises the full bridge surface: init, create, unlock (wrong password,
then correct), group/entry CRUD, history restore, TOTP set/generate/remove,
attachments, search, recycle bin, generators, password health, and a
keyfile-only database. The test is CWD-independent.

The browser test covers what node cannot — asset loading under the
`/keepassxc/` subdirectory prefix GitHub Pages serves from, the real UI
flows (create → groups/entries → TOTP → edit → save → lock → reopen →
search → recycle bin), and console/page-error hygiene:

```sh
# needs playwright-core with its chromium; any existing install works:
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/test-browser.mjs
```

## Deploying

`scripts/deploy.sh` does the full cycle: build → node smoke test →
browser UI test (when playwright-core is available) → push `main` →
publish a fresh orphan `gh-pages` branch (site files only) → verify the
live URL. Requires `gh` authenticated and push access to
`sloth-os/keepassxc`.

## License

GPL-2 / GPL-3, as KeePassXC (see `LICENSE.GPL-2`, `LICENSE.GPL-3`).
Derived from [KeePassXC](https://keepassxc.org), © KeePassXC Team and
contributors.
