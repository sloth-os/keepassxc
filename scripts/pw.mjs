// Shared playwright-core loader for the scripts that drive a browser
// (test-browser.mjs, make-icons.mjs). Resolution order: PLAYWRIGHT_CORE
// env var, the repo's node_modules, the CWD's node_modules — first hit
// wins. This lets any existing playwright-core install (whose chromium
// is already in ~/.cache/ms-playwright) be reused without a download.
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

export function loadPlaywright() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE) candidates.push(process.env.PLAYWRIGHT_CORE);
  candidates.push(path.join(root, 'node_modules', 'playwright-core'));
  candidates.push(path.join(process.cwd(), 'node_modules', 'playwright-core'));
  for (const c of candidates) {
    try { return createRequire(import.meta.url)(c); } catch { /* try next */ }
  }
  console.error('playwright-core not found — set PLAYWRIGHT_CORE or run: npm i playwright-core && npx playwright-core install chromium');
  process.exit(2);
}
