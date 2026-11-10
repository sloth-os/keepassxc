#!/usr/bin/env node
// Browser test for the published layout: serves web/ under a /keepassxc/
// prefix (exactly how GitHub Pages serves a project page) and drives the
// real UI in headless Chromium: boot → create → group/entry CRUD → TOTP →
// save → lock → reopen (wrong password, then correct) → search → recycle
// bin → PWA (manifest, icons, service worker precache, offline reload)
// → file handling (picker, drag & drop, OS launches via launchQueue).
// Fails on any uncaught page error or console.error.
//
// Usage: node scripts/test-browser.mjs
//
// Requires playwright-core with its chromium available. Either:
//   npm i playwright-core && npx playwright install chromium
// or point PLAYWRIGHT_CORE at an existing playwright-core install whose
// chromium is already in ~/.cache/ms-playwright. CHROME_BIN overrides the
// browser executable outright.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPlaywright } from './pw.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/* --- static server: /keepassxc/<file> -> web/<file> --------------------- */
// With SITE_URL set, the suite runs against that URL directly (post-deploy
// verification) and no local server is started.
const SITE_URL = process.env.SITE_URL || null;
const PREFIX = '/keepassxc/';
const WEB = path.join(root, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
let server = null;
let site = SITE_URL;
if (!site) {
  server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400).end('bad url'); return; }
    if (p === '/keepassxc') p = PREFIX;
    if (!p.startsWith(PREFIX)) { res.writeHead(404).end('not found'); return; }
    let rel = p.slice(PREFIX.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404).end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${server.address().port}/keepassxc/`;
}

/* --- harness ------------------------------------------------------------ */
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const { chromium } = loadPlaywright();
const launchOpts = { headless: true };
if (process.env.CHROME_BIN) launchOpts.executablePath = process.env.CHROME_BIN;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
// confirm() dialogs (group delete, empty bin) are accepted automatically
page.on('dialog', (d) => d.accept().catch(() => {}));

/* --- os launch channel (PWA file handling) ---------------------------
 * Real launchQueue delivery needs an *installed* PWA launched by the OS,
 * which headless Chromium cannot do. Fake the channel instead: Chromium
 * ships a native window.launchQueue that is LegacyUnforgeable (assigning
 * to the property is silently ignored), so the fake patches setConsumer
 * on its prototype — an ordinary writable method — and our shim runs
 * when app.js registers its consumer. Browsers with no launchQueue get
 * a plain fake object (the property is assignable there). Arming
 * 'kpxc-test-autolaunch' in sessionStorage delivers a file at
 * setConsumer time — before the engine has finished booting — to
 * exercise the early-launch queue. */
await page.addInitScript(() => {
  const capture = (fn) => {
    window.__kpxcLaunchConsumer = fn;
    if (window.__kpxcAutoLaunch) {
      const f = window.__kpxcAutoLaunch;
      window.__kpxcAutoLaunch = null;
      fn({ files: [{ getFile: () => Promise.resolve(f) }] });
    }
  };
  if (window.launchQueue) {
    Object.getPrototypeOf(window.launchQueue).setConsumer = capture;
  } else {
    window.launchQueue = { setConsumer: capture };
  }
  const armed = sessionStorage.getItem('kpxc-test-autolaunch');
  if (armed) {
    sessionStorage.removeItem('kpxc-test-autolaunch');
    window.__kpxcAutoLaunch = new File([new Uint8Array(24)], armed);
  }
});

// Waits bounded by the network scale up against the live site: the
// ~10 MB engine download (plus the service worker's parallel precache
// of the same bytes) can take many minutes on a slow link — the local
// server and CI's runners never notice. Everything after boot runs on
// the in-memory engine, so only the boot and worker waits use this.
const NET = SITE_URL ? 30 * 60_000 : 60_000;

const vis = (sel, timeout = 30000) => page.waitForSelector(sel, { state: 'visible', timeout });
// Closed <dialog>s stay in the DOM (they only lose [open]), so wait for
// "hidden" — which resolves both when the selector stops matching and when
// the element is no longer visible.
const gone = (sel) => page.waitForSelector(sel, { state: 'hidden', timeout: 30000 });
const text = (sel) => page.textContent(sel).then((t) => t.trim());
const count = (sel) => page.$$(sel).then((n) => n.length);

/* --- boot ---------------------------------------------------------------- */
console.log('boot');
await page.goto(site, { timeout: NET });
await vis('#landing', NET);
check('landing visible after boot', true);
check('boot screen hidden', await page.isHidden('#boot'));
check('busy overlay starts hidden', await page.isHidden('#overlay'),
  'overlay covers the page until the first busy() call — see index.html');

/* --- create -------------------------------------------------------------- */
console.log('create database');
await page.click('#btn-create');
await vis('#dlg-create[open]');
await page.fill('#create-name', 'Test Vault');
await page.fill('#create-password', 'correct horse battery staple');
await page.fill('#create-password2', 'correct horse battery staple');
await page.selectOption('#create-kdf', 'fast');
await page.click('#create-go');
await vis('#main');
check('db title', (await text('#db-title')) === 'Test Vault', await text('#db-title'));
check('create dialog closed', !(await page.$('#dlg-create[open]')));
check('idbfs mounted (keep-copy enabled)', await page.isEnabled('#unlock-keep'));

/* --- group + entry ------------------------------------------------------- */
console.log('groups & entries');
await page.click('button.tree-add');
await vis('#dlg-group[open]');
await page.fill('#g-name', 'Internet');
await page.click('#group-go');
await page.waitForFunction(() =>
  [...document.querySelectorAll('#tree .tree-row')].some((r) => r.textContent.includes('Internet')));
check('group appears in tree', true);

await page.click('#btn-add-entry');
await vis('#dlg-entry[open]');
await page.fill('#e-title', 'Example Site');
await page.fill('#e-username', 'alice');
await page.fill('#e-password', 's3cret-Example');
await page.click('#entry-go');
await page.waitForFunction(() =>
  document.querySelectorAll('#entry-list .entry-row').length === 1);
check('entry appears in list', true);

await page.click('#entry-list .entry-row');
await vis('#detail table');
check('detail shows username', (await text('#detail')).includes('alice'));

/* --- totp ---------------------------------------------------------------- */
console.log('totp');
await page.click('#detail button:has-text("Set up TOTP")');
await vis('#dlg-totp[open]');
await page.fill('#t-key', 'JBSWY3DPEHPK3PXP');
await page.click('#dlg-totp button[value="ok"]');
await page.waitForFunction(() =>
  /^\d{6}$/.test(document.querySelector('.totp-code span')?.textContent || ''));
check('totp code renders', true);

/* --- edit ---------------------------------------------------------------- */
console.log('edit entry');
await page.click('#detail button:has-text("✎ Edit")');
await vis('#dlg-entry[open]');
await page.fill('#e-password', 'new-s3cret!');
await page.click('#entry-go');
await gone('#dlg-entry[open]');
await page.click('#detail .pw-line span.mono'); // click-to-reveal
check('password updated and revealed', (await text('#detail .pw-line span.mono')) === 'new-s3cret!',
  await text('#detail .pw-line span.mono'));

/* --- save / lock --------------------------------------------------------- */
console.log('save & lock');
await page.click('#btn-save');
await page.waitForFunction(() =>
  [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Saved')));
check('save toast', true);
check('dirty marker cleared', await page.isHidden('#dirty-dot'));

await page.click('#btn-lock');
await vis('#landing');
await vis('#recent');
check('recent lists the saved vault',
  (await text('#recent-list')).includes('Test_Vault.kdbx'), await text('#recent-list'));

/* --- reopen -------------------------------------------------------------- */
console.log('reopen');
await page.click('#recent-list button:has-text("Open")');
await vis('#unlock');
await page.fill('#unlock-password', 'wrong-password');
await page.click('#unlock-go');
await vis('#unlock-error');
check('wrong password rejected', (await text('#unlock-error')).length > 0);

await page.fill('#unlock-password', 'correct horse battery staple');
await page.click('#unlock-go');
await vis('#main');
await page.waitForFunction(() =>
  document.querySelectorAll('#entry-list .entry-row').length === 1);
check('entry survives reopen', true);
check('totp badge on reopen', (await text('#entry-list .entry-row .badges')).includes('TOTP'));

/* --- search -------------------------------------------------------------- */
console.log('search');
await page.fill('#search', 'example');
await page.waitForFunction(() =>
  document.querySelector('#list-title').textContent.includes('Search'));
check('search hit', (await count('#entry-list .entry-row')) === 1);
await page.fill('#search', 'zzz-nothing');
await page.waitForFunction(() =>
  document.querySelector('#entry-list .hint')?.textContent.includes('No entries'));
check('search miss is empty', true);
await page.fill('#search', '');

/* --- recycle bin --------------------------------------------------------- */
console.log('recycle bin');
await page.click('#entry-list .entry-row');
await vis('#detail');
await page.click('#detail button:has-text("🗑 Delete")');
await page.waitForFunction(() =>
  document.querySelectorAll('#entry-list .entry-row').length === 0);
check('entry removed from list', true);
await page.click('#tree .tree-row:has-text("Recycle Bin")');
await page.waitForFunction(() =>
  document.querySelectorAll('#entry-list .entry-row').length === 1);
check('entry sits in the bin', (await text('#entry-list .entry-row .badges')).includes('recycled'));
await vis('#btn-empty-bin');
await page.click('#btn-empty-bin');
await page.waitForFunction(() =>
  document.querySelector('#entry-list .hint')?.textContent.includes('No entries'));
check('bin emptied', true);

/* --- pwa / offline -------------------------------------------------------- */
console.log('pwa & offline');

// manifest fetches and parses; both icons are declared any+maskable
const manifest = await page.evaluate(async () => {
  const r = await fetch('manifest.webmanifest');
  return r.ok ? await r.json() : null;
});
check('manifest.webmanifest parses', manifest?.name === 'KeePassXC Web');
check('manifest declares any+maskable icons',
  manifest?.icons?.length === 2
    && manifest.icons.every((i) => i.purpose === 'any maskable' && /192|512/.test(i.sizes)),
  JSON.stringify(manifest?.icons));

// the icon files decode at their declared sizes
const dims = await page.evaluate(async () => {
  const out = {};
  for (const s of [192, 512]) {
    const blob = await (await fetch(`icons/icon-${s}.png`)).blob();
    const bmp = await createImageBitmap(blob);
    out[s] = `${bmp.width}×${bmp.height}`;
  }
  return out;
});
check('icon-192.png is 192×192', dims[192] === '192×192', dims[192]);
check('icon-512.png is 512×512', dims[512] === '512×512', dims[512]);

// against the live site: the published worker must carry a real cache
// version (publish-site.sh stamps the placeholder at publish time)
if (SITE_URL) {
  const swText = await page.evaluate(() => fetch('sw.js').then((r) => r.text()));
  check('live sw.js is version-stamped', !swText.includes('__PRECACHE_VERSION__'));
}

// the service worker registers, activates and claims this page
await page.waitForFunction(() => navigator.serviceWorker.controller !== null,
  null, { timeout: NET });
check('service worker controls the page', true);

// one versioned cache holds the whole app shell — engine included
const precache = await page.evaluate(async () => {
  const names = (await caches.keys()).filter((n) => n.startsWith('kpxc-'));
  if (names.length !== 1) return { missing: [`caches: ${names.join(', ')}`] };
  const have = new Set((await (await caches.open(names[0])).keys()).map((r) => r.url));
  const want = ['', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest',
    'icons/icon-192.png', 'icons/icon-512.png',
    'wasm/keepassxc.js', 'wasm/keepassxc.wasm', 'wasm/keepassxc.data']
    .map((p) => new URL(p, location).href);
  return { missing: want.filter((w) => !have.has(w)) };
});
check('precache holds the full app shell', precache.missing.length === 0,
  precache.missing.join(' '));

// offline: lock the vault, cut the network, reload — the entire app
// (page, UI, ~10 MB engine) must come back from the service worker cache
await page.click('#btn-lock');
await vis('#landing');
await page.context().setOffline(true);
await page.reload();
await vis('#landing');
check('offline reload boots the app', true);
check('saved vault available offline',
  (await text('#recent-list')).includes('Test_Vault.kdbx'), await text('#recent-list'));
await page.context().setOffline(false);

/* --- file handling ------------------------------------------------------ */
console.log('file handling');

// the manifest registers the installed app as an OS handler for .kdbx
check('manifest declares a focus-existing .kdbx file handler',
  manifest?.file_handlers?.length === 1
    && manifest.file_handlers[0].action === './'
    && manifest.file_handlers[0].launch_type === 'focus-existing'
    && Object.values(manifest.file_handlers[0].accept || {}).flat().includes('.kdbx'),
  JSON.stringify(manifest?.file_handlers));

// real vault bytes to launch at the app: reopen the saved vault and
// pull the file out via the Download button
await page.click('#recent-list button:has-text("Open")');
await vis('#unlock');
await page.fill('#unlock-password', 'correct horse battery staple');
await page.click('#unlock-go');
await vis('#main');
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-download'),
]);
const vaultBytes = fs.readFileSync(await dl.path());

// push a file through the (faked) OS launch channel
const launch = (name, bytes) => page.evaluate(({ name, b64 }) => {
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  window.__kpxcLaunchConsumer({
    files: [{ getFile: () => Promise.resolve(new File([data], name)) }],
  });
}, { name, b64: bytes.toString('base64') });

// an OS launch while a vault is open closes it and offers the new file
await launch('Second.kdbx', vaultBytes);
await vis('#unlock');
check('launch switches from the open vault',
  (await text('#unlock-filename')) === 'Second.kdbx', await text('#unlock-filename'));
await page.fill('#unlock-password', 'correct horse battery staple');
await page.click('#unlock-go');
await vis('#main');
check('launched vault unlocks', (await text('#db-title')) === 'Test Vault', await text('#db-title'));

// back to the landing for the picker/drop tests (the vault just unlocked
// from the launch is clean — no unsaved-changes prompt)
await page.click('#btn-lock');
await vis('#landing');

// the file picker goes through the same openFile path
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('#btn-open'),
]);
await chooser.setFiles({
  name: 'Picked.kdbx', mimeType: 'application/octet-stream', buffer: vaultBytes,
});
await vis('#unlock');
check('picker offers the chosen file',
  (await text('#unlock-filename')) === 'Picked.kdbx', await text('#unlock-filename'));
await page.click('#unlock-back');
await vis('#landing');

// so does drag & drop
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(8)], 'Dropped.kdbx'));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }));
});
await vis('#unlock');
check('drop offers the dropped file',
  (await text('#unlock-filename')) === 'Dropped.kdbx', await text('#unlock-filename'));
await page.click('#unlock-back');
await vis('#landing');

// a launch that arrives before the engine finishes booting is queued
// and opened once boot completes
await page.evaluate(() => sessionStorage.setItem('kpxc-test-autolaunch', 'Early.kdbx'));
await page.reload({ timeout: NET });
await vis('#unlock', NET);
check('pre-boot launch queued until the engine is ready',
  (await text('#unlock-filename')) === 'Early.kdbx', await text('#unlock-filename'));
await page.fill('#unlock-password', 'nope');
await page.click('#unlock-go');
await vis('#unlock-error');
check('queued file is a real unlock target', (await text('#unlock-error')).length > 0);
await page.click('#unlock-back');
await vis('#landing');

/* --- hygiene ------------------------------------------------------------- */
console.log('hygiene');
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
if (server) server.close();
console.log(failures === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
