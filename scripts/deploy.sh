#!/usr/bin/env bash
# Local full deploy: build → node smoke test → browser test → push main
# → publish gh-pages → verify the live URL.
#
# Publishing itself lives in scripts/publish-site.sh, shared with the CI
# workflow (.github/workflows/publish.yml) — this script is just the
# local front door: it also rebuilds the wasm artifacts and pushes main.
#
# GitHub Pages cannot send COOP/COEP headers, so the wasm build is
# single-threaded (wasm_singlethread Qt) and needs no shared memory — the
# published site works as plain static files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== build ==="
"$ROOT/scripts/build.sh"

echo "=== node smoke test ==="
node "$ROOT/scripts/test-node.mjs" "$ROOT/build-wasm"

echo "=== browser test ==="
# Drives the real UI in headless Chromium under the /keepassxc/ prefix
# Pages will use. Runs when playwright-core (and its chromium) is
# resolvable — from node_modules or via PLAYWRIGHT_CORE — else skipped.
if [ -n "${PLAYWRIGHT_CORE:-}" ] || node -e "require.resolve('playwright-core')" >/dev/null 2>&1; then
    node "$ROOT/scripts/test-browser.mjs"
else
    echo "playwright-core unavailable — skipping browser test (see scripts/test-browser.mjs header)"
fi

echo "=== push main ==="
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "Update sources and web UI

Co-Authored-By: Claude Code <noreply@anthropic.com>"
fi
git push origin main

echo "=== publish ==="
"$ROOT/scripts/publish-site.sh"
