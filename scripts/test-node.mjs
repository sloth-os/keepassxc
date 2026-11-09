#!/usr/bin/env node
// Node smoke test for the keepassxc-web wasm module.
// Exercises the full bridge surface: create → unlock → CRUD → TOTP →
// attachments → history → recycle → save → reopen (wrong password, then
// correct) → search → generators → health.
//
// Usage: node scripts/test-node.mjs [path-to-build-dir]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// resolve() so a relative build-dir argument works (require() would
// treat a bare relative path as a package name)
const buildDir = path.resolve(process.argv[2] || path.join(root, 'build-wasm'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// The module factory reads keepassxc.wasm / keepassxc.data relative to the
// script's own location; run it from the build directory.
const factoryPath = path.join(buildDir, 'keepassxc.js');
const factory = require(factoryPath);

const Module = await factory({
  print: () => {},
  printErr: () => {},
  // The emscripten package loader resolves 'keepassxc.data' against the
  // process CWD unless told otherwise; point it at the build directory so
  // the test runs from anywhere.
  locateFile: (p) => path.join(buildDir, p),
});

const UTF8 = (p) => Module.UTF8ToString(p);
const alloc = (s) => Module.allocateUTF8(s);
const call = (name, ...args) => {
  const fn = Module[`_${name}`];
  if (!fn) throw new Error(`export _${name} not found`);
  const ptrs = args.map(alloc);
  const resultPtr = fn(...ptrs);
  const json = UTF8(resultPtr);
  ptrs.forEach((p) => Module._free(p));
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`${name}: non-JSON result: ${json}`);
  }
};

// --- init -----------------------------------------------------------------
console.log('init');
let r = call('kpx_init');
check('kpx_init', r.ok, r.error);

r = call('kpx_version');
check('kpx_version reports a version', r.ok && r.version.length > 0, r.error);

// --- create ---------------------------------------------------------------
console.log('create database');
const DB = '/tmp/test.kdbx';
const KDF_FAST = { name: 'argon2id', rounds: 2, memoryKiB: 8192, parallelism: 1 };
r = call('kpx_create_database', JSON.stringify({
  path: DB,
  password: 'correct horse battery staple',
  keyfile: '',
  kdf: KDF_FAST,
  name: 'Test Vault',
}));
check('kpx_create_database', r.ok, r.error);

r = call('kpx_is_open', '');
check('database is open', r.ok && r.open === true, JSON.stringify(r));

r = call('kpx_db_info', '');
check('db_info name', r.ok && r.name === 'Test Vault', JSON.stringify(r));
check('db_info kdf argon2id', r.ok && r.kdf === 'argon2id', JSON.stringify(r));
check('db_info formatVersion', r.ok && r.formatVersion.startsWith('4.'), JSON.stringify(r));

// --- tree / groups --------------------------------------------------------
console.log('tree');
r = call('kpx_tree', '');
check('tree has root', r.ok && r.root && r.root.name, r.error);
const rootUuid = r.root.uuid;
check('root has no children initially', r.ok && r.root.children.length === 0, JSON.stringify(r.root));

r = call('kpx_add_group', JSON.stringify({ parentUuid: rootUuid, name: 'Internet', icon: 1 }));
check('kpx_add_group', r.ok, r.error);

r = call('kpx_add_group', JSON.stringify({ parentUuid: rootUuid, name: 'Email', icon: 2 }));
check('second group', r.ok, r.error);

r = call('kpx_tree', '');
const internet = r.root.children.find((g) => g.name === 'Internet');
check('two child groups in tree', !!internet && r.root.children.length === 2, JSON.stringify(r.root.children));

// --- entries --------------------------------------------------------------
console.log('entries');
r = call('kpx_add_entry', JSON.stringify({
  groupUuid: internet.uuid,
  title: 'Example',
  username: 'alice',
  password: 's3cret-Example',
  url: 'https://example.com',
  notes: 'first entry',
}));
check('kpx_add_entry', r.ok, r.error);
const entryUuid = r.uuid;

r = call('kpx_entry_detail', entryUuid);
check('entry_detail title', r.ok && r.title === 'Example', JSON.stringify(r));
check('entry_detail password (secret)', r.ok && r.password === 's3cret-Example', JSON.stringify(r));
check('entry_detail times present', r.ok && r.times && r.times.created, JSON.stringify(r));

r = call('kpx_update_entry', JSON.stringify({ uuid: entryUuid, password: 'new-s3cret!' }));
check('kpx_update_entry', r.ok, r.error);
r = call('kpx_entry_detail', entryUuid);
check('password updated', r.ok && r.password === 'new-s3cret!', JSON.stringify(r));
check('history recorded', r.ok && r.historyCount === 1, JSON.stringify(r));

r = call('kpx_history_restore', JSON.stringify({ uuid: entryUuid, index: 0 }));
check('kpx_history_restore', r.ok, r.error);
r = call('kpx_entry_detail', entryUuid);
check('password restored from history', r.ok && r.password === 's3cret-Example', JSON.stringify(r));

// --- totp -----------------------------------------------------------------
console.log('totp');
r = call('kpx_set_totp', JSON.stringify({ uuid: entryUuid, key: 'JBSWY3DPEHPK3PXP', digits: 6, step: 30 }));
check('kpx_set_totp', r.ok, r.error);

r = call('kpx_entry_totp', entryUuid);
check('totp generated', r.ok && r.valid === true, JSON.stringify(r));
check('totp is 6 digits', r.ok && /^\d{6}$/.test(r.code), JSON.stringify(r));
const totpCode = r.code;

r = call('kpx_entry_detail', entryUuid);
check('detail sees hasTotp', r.ok && r.hasTotp === true, JSON.stringify(r));

r = call('kpx_set_totp', JSON.stringify({ uuid: entryUuid, key: '' }));
check('totp removed', r.ok, r.error);
r = call('kpx_entry_detail', entryUuid);
check('detail sees hasTotp=false', r.ok && r.hasTotp === false, JSON.stringify(r));
call('kpx_set_totp', JSON.stringify({ uuid: entryUuid, key: 'JBSWY3DPEHPK3PXP', digits: 6, step: 30 }));

// --- attachments ----------------------------------------------------------
console.log('attachments');
const bin = Buffer.from('hello attachment', 'utf8').toString('base64');
r = call('kpx_add_attachment', JSON.stringify({ uuid: entryUuid, name: 'note.txt', data: bin }));
check('kpx_add_attachment', r.ok, r.error);

r = call('kpx_attachment_data', entryUuid, 'note.txt');
check('attachment round-trip', r.ok && r.data === bin, JSON.stringify(r).slice(0, 120));

r = call('kpx_remove_attachment', JSON.stringify({ uuid: entryUuid, name: 'note.txt' }));
check('kpx_remove_attachment', r.ok, r.error);

// --- search ---------------------------------------------------------------
console.log('search');
r = call('kpx_search', 'example');
check('search finds entry', r.ok && r.items.length === 1 && r.items[0].uuid === entryUuid, JSON.stringify(r));

r = call('kpx_search', 'zzz-no-such-thing');
check('search miss is empty', r.ok && r.items.length === 0, JSON.stringify(r));

// --- save / lock / reopen -------------------------------------------------
console.log('save & reopen');
r = call('kpx_save', '');
check('kpx_save', r.ok, r.error);

r = call('kpx_close', '');
check('kpx_close', r.ok);
r = call('kpx_is_open', '');
check('closed', r.ok && r.open === false, JSON.stringify(r));

r = call('kpx_tree', '');
check('tree on closed db fails', r.ok === false, JSON.stringify(r));

r = call('kpx_open', JSON.stringify({ path: DB, password: 'wrong-password', keyfile: '' }));
check('wrong password rejected', r.ok === false && r.error.length > 0, JSON.stringify(r));

r = call('kpx_open', JSON.stringify({ path: DB, password: 'correct horse battery staple', keyfile: '' }));
check('reopen with correct password', r.ok, r.error);

r = call('kpx_tree', '');
const reopened = r.root.children.find((g) => g.name === 'Internet');
check('reopened tree intact', !!reopened && reopened.entries.length === 1, JSON.stringify(r.root));
const reopenedEntry = reopened.entries[0];
check('reopened entry title', reopenedEntry.title === 'Example', reopenedEntry.title);

r = call('kpx_entry_detail', reopenedEntry.uuid);
check('reopened totp settings survive', r.ok && r.hasTotp === true, JSON.stringify(r));
r = call('kpx_entry_totp', reopenedEntry.uuid);
check('reopened totp code stable', r.ok && r.valid && r.code === totpCode, JSON.stringify(r));

// --- recycle bin ----------------------------------------------------------
console.log('recycle bin');
r = call('kpx_delete_entry', JSON.stringify({ uuid: reopenedEntry.uuid }));
check('kpx_delete_entry recycles', r.ok, r.error);
r = call('kpx_tree', '');
let recycled = false;
for (const child of r.root.children) {
  for (const e of child.entries) {
    if (e.uuid === reopenedEntry.uuid) recycled = e.isRecycled;
  }
}
check('entry is in recycle bin', recycled, JSON.stringify(r.root.children.map((g) => g.name)));

r = call('kpx_empty_recycle_bin', '');
check('kpx_empty_recycle_bin', r.ok, r.error);
r = call('kpx_search', 'Example');
check('recycled entry gone after empty', r.ok && r.items.length === 0, JSON.stringify(r));

// --- generators / health --------------------------------------------------
console.log('generators');
r = call('kpx_generate_password', JSON.stringify({ length: 24, charClasses: 7, flags: 3 }));
check('generate_password', r.ok && r.password.length === 24, JSON.stringify(r));
r = call('kpx_generate_passphrase', JSON.stringify({ wordCount: 5, separator: '-' }));
check('generate_passphrase', r.ok && r.passphrase.split('-').length === 5, JSON.stringify(r));

r = call('kpx_password_health', 'correct horse battery staple');
check('password_health strong', r.ok && r.entropy > 40, JSON.stringify(r));
r = call('kpx_password_health', 'password');
check('password_health weak', r.ok && r.entropy < 20, JSON.stringify(r));

// --- keyfile database -----------------------------------------------------
console.log('keyfile');
// The bridge does not expose FileKey::create; write a hex keyfile directly
// (64 hex chars = 32 bytes, recognized as a FixedBinaryHex key).
const KF = '/tmp/test.key';
Module.FS.writeFile(KF, new TextEncoder().encode(
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'));
r = call('kpx_create_database', JSON.stringify({
  path: '/tmp/test-keyfile.kdbx',
  password: '',
  keyfile: KF,
  kdf: KDF_FAST,
  name: 'Keyfile Vault',
}));
check('create with keyfile only', r.ok, r.error);
r = call('kpx_close', '');
r = call('kpx_open', JSON.stringify({ path: '/tmp/test-keyfile.kdbx', password: '', keyfile: KF }));
check('reopen with keyfile', r.ok, r.error);
r = call('kpx_open', JSON.stringify({ path: '/tmp/test-keyfile.kdbx', password: '', keyfile: '' }));
check('keyfile required', r.ok === false, JSON.stringify(r));

// --- summary --------------------------------------------------------------
console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
