#!/usr/bin/env bash
# Full deploy: build → node smoke test → push main → publish gh-pages →
# verify the live URL.
#
# GitHub Pages cannot send COOP/COEP headers, so the wasm build is
# single-threaded (wasm_singlethread Qt) and needs no shared memory — the
# published site works as plain static files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_URL="https://sloth-os.github.io/keepassxc/"
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

echo "=== publish gh-pages ==="
# Fresh orphan branch containing only the site.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git worktree add --detach "$WORK/site" >/dev/null 2>&1 || {
    echo "error: cannot create worktree" >&2; exit 1; }
cd "$WORK/site"
git checkout --orphan gh-pages
git rm -rf --quiet . 2>/dev/null || true

mkdir -p wasm
cp "$ROOT/web/index.html" .
cp "$ROOT/web/app.js" .
cp "$ROOT/web/styles.css" .
cp "$ROOT/web/wasm/keepassxc.js" wasm/
cp "$ROOT/web/wasm/keepassxc.wasm" wasm/
[ -f "$ROOT/web/wasm/keepassxc.data" ] && cp "$ROOT/web/wasm/keepassxc.data" wasm/
cp "$ROOT/LICENSE.GPL-3" LICENSE 2>/dev/null || cp "$ROOT/LICENSE.GPL-2" LICENSE 2>/dev/null || true

git add -A
git commit -m "Publish site

Co-Authored-By: Claude Code <noreply@anthropic.com>"
git push --force origin gh-pages
cd "$ROOT"
git worktree remove --force "$WORK/site" >/dev/null 2>&1 || true

echo "=== enable GitHub Pages ==="
# Enable Pages on gh-pages / (root) if not already enabled.
if gh api "repos/sloth-os/keepassxc/pages" >/dev/null 2>&1; then
    echo "pages already enabled"
else
    gh api --method POST "repos/sloth-os/keepassxc/pages" \
        -f source[branch]=gh-pages -f source[path]=/ >/dev/null
    echo "pages enabled"
fi

echo "=== verify ($SITE_URL) ==="
for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL" || echo 000)"
    if [ "$code" = "200" ]; then
        echo "live: $SITE_URL (attempt $i)"
        exit 0
    fi
    sleep 10
done
echo "error: $SITE_URL did not return 200 after 5 minutes" >&2
exit 1
