#!/usr/bin/env node
// Browser test for the published layout: serves web/ under a /keepassxc/
// prefix (exactly how GitHub Pages serves a project page) and drives the
// real UI in headless Chromium: boot → create → group/entry CRUD → TOTP →
// save → lock → reopen (wrong password, then correct) → search → recycle
// bin. Fails on any uncaught page error or console.error.
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
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE) candidates.push(process.env.PLAYWRIGHT_CORE);
  candidates.push(path.join(root, 'node_modules', 'playwright-core'));
  candidates.push(path.join(process.cwd(), 'node_modules', 'playwright-core'));
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  console.error('playwright-core not found — see the header comment of this script');
  process.exit(2);
}

/* --- static server: /keepassxc/<file> -> web/<file> --------------------- */
const PREFIX = '/keepassxc/';
const WEB = path.join(root, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
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
const port = server.address().port;
const site = `http://127.0.0.1:${port}/keepassxc/`;

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

const vis = (sel, timeout = 30000) => page.waitForSelector(sel, { state: 'visible', timeout });
// Closed <dialog>s stay in the DOM (they only lose [open]), so wait for
// "hidden" — which resolves both when the selector stops matching and when
// the element is no longer visible.
const gone = (sel) => page.waitForSelector(sel, { state: 'hidden', timeout: 30000 });
const text = (sel) => page.textContent(sel).then((t) => t.trim());
const count = (sel) => page.$$(sel).then((n) => n.length);

/* --- boot ---------------------------------------------------------------- */
console.log('boot');
await page.goto(site);
await vis('#landing');
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

/* --- hygiene ------------------------------------------------------------- */
console.log('hygiene');
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
