#!/usr/bin/env bash
# Publish the site to the gh-pages branch and verify the live URL.
#
# Stages the committed web/ artifacts (no C++ toolchain needed), stamps
# the service worker's cache version from a content hash of everything
# it precaches, force-pushes a fresh orphan branch, then waits for the
# live site and checks the deployed worker is stamped.
#
# Shared by deploy.sh (local: build → tests → push main → this) and CI
# (.github/workflows/publish.yml: tests → this).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_URL="https://sloth-os.github.io/keepassxc/"
cd "$ROOT"

echo "=== stage site ==="
# Fresh orphan branch containing only the site.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git worktree add --detach "$WORK/site" >/dev/null 2>&1 || {
    echo "error: cannot create worktree" >&2; exit 1; }
cd "$WORK/site"
# A previous publish in this clone leaves a gh-pages ref behind (worktree
# remove does not delete it), and --orphan is fatal when the branch already
# exists — drop any stale ref first; no-op on a first publish.
git branch -D gh-pages >/dev/null 2>&1 || true
git checkout --orphan gh-pages
git rm -rf --quiet . 2>/dev/null || true

mkdir -p wasm icons
cp "$ROOT/web/index.html" "$ROOT/web/app.js" "$ROOT/web/styles.css" \
   "$ROOT/web/sw.js" "$ROOT/web/manifest.webmanifest" .
cp "$ROOT/web/icons/icon-192.png" "$ROOT/web/icons/icon-512.png" icons/
cp "$ROOT/web/wasm/keepassxc.js" "$ROOT/web/wasm/keepassxc.wasm" wasm/
if [ -f "$ROOT/web/wasm/keepassxc.data" ]; then
    cp "$ROOT/web/wasm/keepassxc.data" wasm/
fi
cp "$ROOT/LICENSE.GPL-3" LICENSE 2>/dev/null || cp "$ROOT/LICENSE.GPL-2" LICENSE 2>/dev/null || true

echo "=== stamp service worker cache version ==="
# The cache name must change whenever any precached file changes, or
# returning visitors would be pinned to the old engine. Hash every
# precache entry (sw.js in its placeholder form, so edits to the worker
# itself also roll the version) and substitute it into the published
# copy — web/sw.js in the repo keeps the placeholder.
FILES=(sw.js index.html app.js styles.css manifest.webmanifest
       icons/icon-192.png icons/icon-512.png
       wasm/keepassxc.js wasm/keepassxc.wasm)
if [ -f wasm/keepassxc.data ]; then
    FILES+=(wasm/keepassxc.data)
fi
VERSION="$(sha256sum "${FILES[@]}" | sha256sum | cut -c1-12)"
sed -i "s/__PRECACHE_VERSION__/$VERSION/" sw.js
node --check sw.js
if grep -q __PRECACHE_VERSION__ sw.js; then
    echo "error: published sw.js is still unstamped" >&2
    exit 1
fi
echo "cache version: $VERSION"

git add -A
# CI runners have no git identity; supply one for the publish commit.
if ! git config user.email >/dev/null 2>&1; then
    git config user.name "publish"
    git config user.email "publish@users.noreply.github.com"
fi
git commit -m "Publish site

Co-Authored-By: Claude Code <noreply@anthropic.com>" >/dev/null
git push --force origin gh-pages
cd "$ROOT"
git worktree remove --force "$WORK/site" >/dev/null 2>&1 || true

echo "=== enable GitHub Pages ==="
# Pages is already enabled for this repo; the guard exists so a fresh
# clone/fork publish does the right thing. Needs gh auth (local login or
# GH_TOKEN in CI); skipped silently otherwise.
if command -v gh >/dev/null 2>&1; then
    if gh api "repos/sloth-os/keepassxc/pages" >/dev/null 2>&1; then
        echo "pages already enabled"
    elif gh api --method POST "repos/sloth-os/keepassxc/pages" \
            -f source[branch]=gh-pages -f source[path]=/ >/dev/null 2>&1; then
        echo "pages enabled"
    else
        echo "gh cannot manage Pages — assuming already enabled"
    fi
fi

echo "=== verify ($SITE_URL) ==="
# The URL is already 200 from the previous publish, so a plain 200 check
# proves nothing — wait until THIS publish's cache version is live in
# sw.js. The CDN can serve the previous deploy for a few minutes after
# the push, so retry for up to 15 minutes.
live=""
for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL" || echo 000)"
    if [ "$code" = "200" ] && curl -s "$SITE_URL/sw.js" | grep -q "$VERSION"; then
        live=1
        echo "live: $SITE_URL (attempt $i, sw cache $VERSION)"
        break
    fi
    sleep 30
done
if [ -z "$live" ]; then
    echo "error: $SITE_URL did not serve cache version $VERSION within 15 minutes" >&2
    exit 1
fi
echo "publish complete"
