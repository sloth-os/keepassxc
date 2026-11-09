/* KeePassXC Web — UI glue.
 *
 * All state lives in the wasm module's heap (a real KeePassXC Database
 * object). This file only renders what the kpx_* bridge returns. Heavy
 * operations (Argon2 KDF) are synchronous, so every call that can take
 * more than ~100ms runs through `busy()`, which paints an overlay first
 * and blocks on the next frame.
 *
 * Bridge calling convention (matches the exported runtime methods):
 *   Module['_kpx_*']  — direct C function pointers
 *   allocateUTF8 / UTF8ToString / _free — string marshalling
 * Every kpx_* function takes N string args and returns a JSON string
 * {"ok":true,...} or {"ok":false,"error":"..."}.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const CLIPBOARD_CLEAR_SECONDS = 30;

/* ------------------------------------------------------------------ state */
let Module = null; // emscripten module
let genTarget = null; // generator target: {input} | {entry} | null
const state = {
  open: false,
  tree: null, // last kpx_tree result
  selectedGroup: null, // uuid or null (= all entries)
  selectedEntry: null, // uuid
  dbPath: '', // path inside the module FS
  fileName: '', // display name
  uploaded: null, // /upload/<name> when the db came from a file picker
  keepCopy: false, // db lives under /keepassxc (the IDBFS mount)
  dirty: false,
  totpTimer: null,
  clipboardTimer: null,
};

/* ------------------------------------------------------------- busy/toast */
function busy(label, fn) {
  return new Promise((resolve, reject) => {
    $('overlay-label').textContent = label;
    $('overlay').hidden = false;
    // let the overlay paint before the (blocking) wasm call
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      } finally {
        $('overlay').hidden = true;
      }
    }));
  });
}

function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 2600);
}

/* ------------------------------------------------------------ bridge call */
function kpx(name, ...args) {
  const fn = Module[`_${name}`];
  if (typeof fn !== 'function') {
    return { ok: false, error: `bridge function _${name} is not exported` };
  }
  const ptrs = args.map((a) => Module.allocateUTF8(String(a ?? '')));
  try {
    const resultPtr = fn(...ptrs);
    return JSON.parse(Module.UTF8ToString(resultPtr));
  } catch (e) {
    console.error(`${name} failed`, e);
    return { ok: false, error: String(e) };
  } finally {
    ptrs.forEach((p) => Module._free(p));
  }
}

/* ------------------------------------------------------------ fs helpers */
function loadFileInto(path, file) {
  return file.arrayBuffer().then((buf) =>
    Module.FS.writeFile(path, new Uint8Array(buf), { flags: 'w' }));
}

/* Persist (or load) the IDBFS-mounted /keepassxc directory. */
function syncIdbfs(populate) {
  return new Promise((resolve) => {
    if (!Module.keepassxcIdbfs) return resolve();
    Module.FS.syncfs(populate, (err) => {
      if (err) console.warn('syncfs failed', err);
      resolve();
    });
  });
}

function persistDb() {
  if (state.dbPath.startsWith('/keepassxc/')) return syncIdbfs(false);
  return Promise.resolve();
}

/* -------------------------------------------------------------- rendering */
function qualityBar(barEl, textEl, health) {
  const q = Math.min(5, Math.max(1, health.quality + 1)); // 0..4 -> 1..5
  barEl.parentElement.className = `bar q${q}`;
  barEl.style.width = `${Math.min(100, Math.max(4, health.entropy * 2.4))}%`;
  textEl.textContent = `${health.entropy.toFixed(1)} bits — ${health.reason}`;
}

const QUALITY = ['Bad', 'Poor', 'Weak', 'Good', 'Excellent'];

const ICONS = ['🔑', '🌐', '📧', '🖥', '💬', '🪪', '🏦', '🎮', '🛒', '📷',
  '🧭', '☁️', '⭐', '📦', '✒️', '⚙️', '🗂', '🔒', '🔓', '📶', '✔️', '✖️',
  '⚠️', 'ℹ️', '♻️', '📄', '📝', '🎬', '🎵', '🖼', '📖', '💾', '💿', '🔌',
  '📱', '🖨', '🎞', '🔍', '📼', '💸', '🧾', '🕐', '🗓', '🧮', '🌍', '🐞',
  '🎯', '🛠', '🚀', '🧠', '🗞', '🏁', '🏷', '🎓', '🧩', '🪙', '🏰', '🌱',
  '☂️', '🕯', '🎈', '🎯', '🎁', '🎵', '🧊', '🔥', '💧', '🌈', '⚡', '🔮'];
const iconChar = (n) => ICONS[n % ICONS.length];

function findGroup(uuid) {
  if (!uuid || !state.tree) return null;
  const walk = (g) => {
    if (g.uuid === uuid) return g;
    for (const c of g.children) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(state.tree.root);
}

function renderTree() {
  const tree = state.tree;
  const box = $('tree');
  box.textContent = '';

  const buildList = (groups, depth) => {
    const ul = el('ul');
    for (const g of groups) {
      const li = el('li');
      const row = el('div', 'tree-row');
      row.style.paddingLeft = `${depth * 14 + 8}px`;

      const tw = el('span', 'tw', g.children.length ? (g.isExpanded ? '▾' : '▸') : '');
      row.appendChild(tw);

      const label = el('span', '', g.name + (g.uuid === tree.recycleBinUuid ? ' 🗑' : ''));
      row.appendChild(label);
      if (g.uuid === state.selectedGroup) row.classList.add('sel');

      const actions = el('span', 'tree-actions');
      actions.appendChild(el('button', '', '✎')).onclick = (ev) => {
        ev.stopPropagation();
        openGroupDialog(g);
      };
      if (g.uuid !== tree.recycleBinUuid) {
        actions.appendChild(el('button', '', '＋')).onclick = (ev) => {
          ev.stopPropagation();
          openGroupDialog(null, g.uuid);
        };
        actions.appendChild(el('button', '', '🗑')).onclick = (ev) => {
          ev.stopPropagation();
          deleteGroup(g);
        };
      }
      row.appendChild(actions);

      if (g.children.length) {
        tw.onclick = (ev) => {
          ev.stopPropagation();
          kpx('kpx_update_group', JSON.stringify({
            uuid: g.uuid, isExpanded: !g.isExpanded,
          }));
          refreshTree();
        };
      }
      row.onclick = () => {
        state.selectedGroup = g.uuid;
        state.selectedEntry = null;
        renderTree();
        renderEntryList();
        renderDetail();
      };
      li.appendChild(row);
      if (g.isExpanded && g.children.length) {
        li.appendChild(buildList(g.children, depth + 1));
      }
      ul.appendChild(li);
    }
    return ul;
  };

  const allRow = el('div', 'tree-row' + (state.selectedGroup === null ? ' sel' : ''));
  allRow.appendChild(el('span', 'tw', ''));
  allRow.appendChild(el('span', '', '🔎 All entries'));
  allRow.onclick = () => {
    state.selectedGroup = null;
    state.selectedEntry = null;
    renderTree();
    renderEntryList();
    renderDetail();
  };
  box.appendChild(allRow);
  box.appendChild(buildList(tree.root.children, 0));

  const addRoot = el('button', 'btn small tree-add', '＋ group');
  addRoot.onclick = () => openGroupDialog(null, tree.root.uuid);
  box.appendChild(addRoot);
}

/* Entries shown in the list pane: the selected group's direct entries, or
 * (for "All entries") every entry outside the recycle bin subtree. The
 * core reports isRecycled per entry, so recycled items are badged either way. */
function visibleEntries() {
  const tree = state.tree;
  if (!tree) return [];
  if (state.selectedGroup) {
    const g = findGroup(state.selectedGroup);
    return g ? g.entries : [];
  }
  const out = [];
  const walk = (g) => {
    if (g.uuid === tree.recycleBinUuid) return;
    out.push(...g.entries);
    for (const c of g.children) walk(c);
  };
  walk(tree.root);
  return out;
}

function renderEntryList() {
  const list = $('entry-list');
  list.textContent = '';
  const q = $('search').value.trim();
  const oldBinBtn = $('btn-empty-bin');
  if (oldBinBtn) oldBinBtn.remove();

  let entries;
  if (q) {
    const r = kpx('kpx_search', q);
    entries = r.ok ? r.items : [];
    if (!r.ok) toast(r.error, 'err');
    $('list-title').textContent = `Search: “${q}”`;
  } else {
    entries = visibleEntries();
    const g = findGroup(state.selectedGroup);
    const bin = state.selectedGroup && g && g.uuid === state.tree.recycleBinUuid;
    $('list-title').textContent = bin ? `♻️ ${g.name}` : (g ? g.name : 'All entries');

    // "Empty recycle bin" affordance when the bin is selected
    if (bin && g.entries.length) {
      const empty = el('button', 'btn small warn', 'Empty bin');
      empty.id = 'btn-empty-bin';
      empty.onclick = emptyRecycleBin;
      $('btn-add-entry').before(empty);
    }
  }

  for (const e of entries) {
    const row = el('div', 'entry-row');
    if (e.uuid === state.selectedEntry) row.classList.add('sel');

    row.appendChild(el('span', 'ic', iconChar(e.icon)));
    const mid = el('div', 'mid');
    mid.appendChild(el('div', 't', e.title));
    mid.appendChild(el('div', 'u', e.username || e.url || ''));
    row.appendChild(mid);

    const badges = el('span', 'badges');
    if (e.hasTotp) badges.appendChild(el('span', 'badge totp', 'TOTP'));
    if (e.isExpired) badges.appendChild(el('span', 'badge expired', 'expired'));
    if (e.isRecycled) badges.appendChild(el('span', 'badge recycled', 'recycled'));
    row.appendChild(badges);

    row.onclick = () => {
      state.selectedEntry = e.uuid;
      renderEntryList();
      renderDetail();
    };
    list.appendChild(row);
  }
  if (!entries.length) {
    list.appendChild(el('p', 'hint', 'No entries.'));
  }
}

/* --------------------------------------------------------------- detail */
function renderDetail() {
  const box = $('detail');
  clearInterval(state.totpTimer);
  state.totpTimer = null;
  box.textContent = '';

  if (!state.selectedEntry) {
    box.appendChild(el('p', 'hint', 'Select an entry.'));
    return;
  }

  const r = kpx('kpx_entry_detail', state.selectedEntry);
  if (!r.ok) {
    box.appendChild(el('p', 'error', r.error));
    return;
  }

  const head = el('div', 'detail-head');
  head.appendChild(el('span', '', iconChar(r.icon)));
  head.appendChild(el('h2', '', r.title));
  const act = el('span', '');
  act.appendChild(el('button', 'btn small', '✎ Edit')).onclick = () => openEntryDialog(r);
  act.appendChild(el('button', 'btn small', '🚚 Move')).onclick = () => openMoveDialog('entry', r.uuid);
  act.appendChild(el('button', 'btn small', '🗑 Delete')).onclick = () => deleteEntry(r);
  head.appendChild(act);
  box.appendChild(head);

  const table = el('table');
  const row = (label, valueNode) => {
    const tr = el('tr');
    const td1 = el('td', '', label);
    const td2 = el('td');
    td2.appendChild(valueNode);
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
    return td2;
  };

  // username + copy
  if (r.username) {
    const uTd = row('Username', el('span', 'mono', r.username));
    uTd.appendChild(copyBtn(r.username));
  }

  // password + copy + health
  const pwLine = el('div', 'pw-line');
  const pwNode = el('span', 'mono', '••••••••••');
  pwNode.style.cursor = 'pointer';
  pwNode.title = 'click to reveal';
  pwNode.onclick = () => {
    pwNode.textContent = pwNode.textContent === '••••••••••' ? r.password : '••••••••••';
  };
  pwLine.appendChild(pwNode);
  pwLine.appendChild(copyBtn(r.password));
  pwLine.appendChild(el('button', 'btn small', '🎲 New…')).onclick = openGeneratorFromEntry;
  const pwTd = row('Password', pwLine);

  if (r.password) {
    const h = kpx('kpx_password_health', r.password);
    if (h.ok) {
      const pill = el('span', 'health-pill', `${QUALITY[h.quality]} · ${h.entropy.toFixed(1)} bits`);
      if (h.quality <= 1) pill.style.color = 'var(--danger)';
      else if (h.quality === 2) pill.style.color = 'var(--warn)';
      else pill.style.color = 'var(--ok)';
      pwTd.appendChild(pill);
    }
  }

  // url
  if (r.url) {
    const a = el('a', '', r.url);
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const urlTd = row('URL', a);
    urlTd.appendChild(copyBtn(r.url));
  }

  if (r.notes) row('Notes', el('div', '', r.notes));
  if (r.tags && r.tags.length) row('Tags', el('div', '', r.tags.join(', ')));
  box.appendChild(table);

  // TOTP
  box.appendChild(el('div', 'section-title', 'TOTP'));
  if (r.hasTotp) {
    const wrap = el('div', 'totp-code');
    const code = el('span', '', '······');
    const remain = el('small', '');
    wrap.appendChild(code);
    wrap.appendChild(remain);
    const totpAct = el('span', '');
    totpAct.appendChild(copyBtn('', 'code'));
    totpAct.appendChild(el('button', 'btn small', '✎ Setup')).onclick = () => openTotpDialog(r.uuid);
    const line = el('div', 'pw-line');
    line.appendChild(wrap);
    line.appendChild(totpAct);
    box.appendChild(line);

    const tick = () => {
      const t = kpx('kpx_entry_totp', r.uuid);
      if (t.ok && t.valid) {
        code.textContent = t.code;
        wrap.dataset.code = t.code;
        const step = t.step || 30;
        remain.textContent = ` ${step - (Math.floor(Date.now() / 1000) % step)}s`;
      }
    };
    tick();
    state.totpTimer = setInterval(tick, 1000);
  } else {
    const setup = el('button', 'btn small', 'Set up TOTP');
    setup.onclick = () => openTotpDialog(r.uuid);
    box.appendChild(setup);
  }

  // custom attributes
  if (r.customAttributes && r.customAttributes.length) {
    box.appendChild(el('div', 'section-title', 'Custom attributes'));
    for (const a of r.customAttributes) {
      const line = el('div', 'attr-row');
      line.appendChild(el('span', 'k', a.key + (a.isProtected ? ' 🔒' : '')));
      const v = el('span', 'v mono', a.isProtected ? '••••••' : a.value);
      if (a.isProtected) {
        v.style.cursor = 'pointer';
        v.title = 'click to reveal';
        v.onclick = () => {
          v.textContent = v.textContent === '••••••' ? a.value : '••••••';
        };
      }
      line.appendChild(v);
      line.appendChild(copyBtn(a.value));
      box.appendChild(line);
    }
  }

  // attachments
  box.appendChild(el('div', 'section-title', 'Attachments'));
  if (r.attachments && r.attachments.length) {
    for (const f of r.attachments) {
      const line = el('div', 'att-row');
      line.appendChild(el('span', '', '📎'));
      line.appendChild(el('span', 'grow mono', `${f.key} (${f.size} B)`));
      line.appendChild(el('button', 'btn small', '⬇')).onclick = () => downloadAttachment(r.uuid, f.key);
      line.appendChild(el('button', 'btn small warn', '✖')).onclick = () => {
        const res = kpx('kpx_remove_attachment', JSON.stringify({ uuid: r.uuid, name: f.key }));
        if (res.ok) { toast('Attachment removed'); markDirty(); refreshAll(); }
        else toast(res.error, 'err');
      };
      box.appendChild(line);
    }
  } else {
    box.appendChild(el('p', 'hint', 'None.'));
  }
  const addAtt = el('input');
  addAtt.type = 'file';
  addAtt.style.display = 'none';
  addAtt.onchange = async () => {
    if (!addAtt.files.length) return;
    const f = addAtt.files[0];
    const buf = new Uint8Array(await f.arrayBuffer());
    const res = kpx('kpx_add_attachment', JSON.stringify({
      uuid: r.uuid, name: f.name, data: b64(buf),
    }));
    if (res.ok) { toast('Attachment added'); markDirty(); refreshAll(); }
    else toast(res.error, 'err');
  };
  box.appendChild(el('button', 'btn small', '＋ attachment')).onclick = () => addAtt.click();
  box.appendChild(addAtt);

  // history
  if (r.historyCount > 0) {
    box.appendChild(el('div', 'section-title', `History (${r.historyCount})`));
    for (let i = 0; i < r.historyCount; i++) {
      const line = el('div', 'history-row');
      line.appendChild(el('span', 'grow', `revision ${r.historyCount - i}`));
      line.appendChild(el('button', 'btn small', 'Restore')).onclick = async () => {
        const res = await busy('Restoring…', () =>
          kpx('kpx_history_restore', JSON.stringify({ uuid: r.uuid, index: i })));
        if (!res.ok) { toast(res.error, 'err'); return; }
        toast('Restored from history');
        markDirty();
        refreshAll();
      };
      box.appendChild(line);
    }
  }

  // times
  box.appendChild(el('div', 'section-title', 'Times'));
  const times = r.times || {};
  for (const [k, v] of Object.entries(times)) {
    const line = el('div', 'kv');
    line.appendChild(el('span', 'k', k));
    line.appendChild(el('span', 'v', v === null || v === '' ? '—' : String(v)));
    box.appendChild(line);
  }
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 32768) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  }
  return btoa(s);
}

function copyBtn(value, kind = '') {
  const btn = el('button', 'btn small', '📋');
  btn.title = 'copy';
  btn.onclick = () => copyText(value, kind);
  return btn;
}

function copyText(value, kind = '') {
  if (kind === 'code') {
    // live TOTP code: read from the rendered node
    const line = document.querySelector('.totp-code');
    value = line ? (line.dataset.code || '') : value;
  }
  if (!value) { toast('Nothing to copy', 'err'); return; }
  navigator.clipboard.writeText(value).then(
    () => {
      toast('Copied — clipboard clears in 30s', 'ok');
      clearTimeout(state.clipboardTimer);
      state.clipboardTimer = setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, CLIPBOARD_CLEAR_SECONDS * 1000);
    },
    () => toast('Clipboard blocked by the browser', 'err'));
}

function downloadAttachment(entryUuid, name) {
  const r = kpx('kpx_attachment_data', entryUuid, name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  const bin = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bin]));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------ refresh */
function refreshTree() {
  const r = kpx('kpx_tree', '');
  if (!r.ok) { toast(r.error, 'err'); return; }
  state.tree = r;
  if (state.selectedGroup && !findGroup(state.selectedGroup)) {
    state.selectedGroup = null;
  }
  renderTree();
  renderEntryList();
}

function refreshAll() {
  refreshTree();
  renderDetail();
}

function markDirty() {
  state.dirty = true;
  $('dirty-dot').hidden = false;
}

function clearDirty() {
  state.dirty = false;
  $('dirty-dot').hidden = true;
}

/* ------------------------------------------------------------ actions */
async function saveDb() {
  const r = await busy('Saving …', () => kpx('kpx_save', ''));
  if (!r.ok) { toast('Save failed: ' + r.error, 'err'); return false; }
  clearDirty();
  await persistDb();
  toast('Saved', 'ok');
  return true;
}

async function downloadDb() {
  if (state.dirty) {
    const okSave = await saveDb();
    if (!okSave) return;
  }
  try {
    const data = Module.FS.readFile(state.dbPath);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.download = state.fileName || 'database.kdbx';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast('Download failed: ' + e, 'err');
  }
}

function deleteEntry(e) {
  const r = kpx('kpx_delete_entry', JSON.stringify({ uuid: e.uuid }));
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast(e.isRecycled ? 'Entry deleted' : 'Entry moved to recycle bin');
  state.selectedEntry = null;
  markDirty();
  refreshAll();
}

async function deleteGroup(g) {
  if (!confirm(`Delete group “${g.name}” and everything in it?`)) return;
  const r = kpx('kpx_delete_group', JSON.stringify({ uuid: g.uuid }));
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Group deleted');
  if (state.selectedGroup === g.uuid) state.selectedGroup = null;
  markDirty();
  refreshAll();
}

async function emptyRecycleBin() {
  if (!confirm('Permanently delete everything in the recycle bin?')) return;
  const r = kpx('kpx_empty_recycle_bin', '');
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Recycle bin emptied');
  markDirty();
  refreshAll();
}

/* ------------------------------------------------------------ dialogs
 *
 * Every dialog is a <form method="dialog"> with a Cancel submitter
 * (value="cancel") and an OK submitter (value="ok"). We always
 * preventDefault, run the (possibly async) action, and close the dialog
 * only on success — errors stay visible and the dialog stays open.
 * This is the single submission path: no close-event handler, so no
 * double application of an action.
 */
function wireForm(dlgId, onSubmit) {
  const d = $(dlgId);
  const form = d.querySelector('form');
  const errP = d.querySelector('.error');
  // Cancel becomes a plain close button so the form's only submit button
  // is OK — otherwise Enter in a field would submit the *first* submit
  // button (Cancel) and throw the user's input away.
  for (const b of d.querySelectorAll('button[value="cancel"]')) {
    b.type = 'button';
    b.onclick = () => d.close();
  }
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (ev.submitter?.value !== 'ok') {
      d.close();
      return;
    }
    if (errP) {
      errP.hidden = true;
      errP.textContent = '';
    }
    const error = await onSubmit();
    if (error) {
      if (errP) {
        errP.textContent = error;
        errP.hidden = false;
      } else {
        toast(error, 'err');
      }
      return; // keep the dialog open so the user can fix the input
    }
    d.close();
  };
  return d;
}

function hideDialogError(dlgId) {
  const errP = $(dlgId).querySelector('.error');
  if (errP) {
    errP.hidden = true;
    errP.textContent = '';
  }
}

function openGroupDialog(existing, parentUuid) {
  $('group-form-title').textContent = existing ? 'Edit group' : 'New group';
  $('g-name').value = existing ? existing.name : '';
  $('g-notes').value = existing ? (existing.notes || '') : '';
  $('g-icon').value = existing ? existing.icon : 48;
  hideDialogError('dlg-group');

  wireForm('dlg-group', () => {
    const args = {
      name: $('g-name').value.trim(),
      notes: $('g-notes').value,
      icon: Number($('g-icon').value) || 0,
    };
    if (!args.name) return 'A group name is required.';
    const r = existing
      ? kpx('kpx_update_group', JSON.stringify({ uuid: existing.uuid, ...args }))
      : kpx('kpx_add_group', JSON.stringify({ parentUuid: parentUuid || state.tree.root.uuid, ...args }));
    if (!r.ok) return r.error;
    markDirty();
    refreshAll();
    return null;
  }).showModal();
  setTimeout(() => $('g-name').focus(), 50);
}

/* one row of the custom-attributes editor */
function attrRow(key, value, isProtected) {
  const line = el('div', 'attr-row');
  const k = el('input');
  k.value = key || '';
  k.placeholder = 'name';
  k.className = 'k';
  const v = el('input');
  v.value = value || '';
  v.placeholder = 'value';
  v.className = 'v';
  const p = el('input');
  p.type = 'checkbox';
  p.checked = !!isProtected;
  p.title = 'protected';
  const del = el('button', 'btn small warn', '✖');
  del.type = 'button';
  del.onclick = () => line.remove();
  line.appendChild(k);
  line.appendChild(v);
  line.appendChild(p);
  line.appendChild(del);
  return line;
}

function readAttrRows() {
  const out = [];
  for (const line of $('e-attrs').children) {
    const [k, v, p] = line.children;
    if (k.value.trim()) out.push({ key: k.value.trim(), value: v.value, protect: p.checked });
  }
  return out;
}

/* apply the attribute editor's contents to an entry via the bridge */
function syncAttributes(entryUuid, wanted) {
  const current = kpx('kpx_entry_detail', entryUuid);
  if (!current.ok) return current;
  for (const x of current.customAttributes || []) {
    if (!wanted.some((w) => w.key === x.key)) {
      kpx('kpx_remove_attribute', JSON.stringify({ uuid: entryUuid, key: x.key }));
    }
  }
  for (const w of wanted) {
    kpx('kpx_set_attribute', JSON.stringify({
      uuid: entryUuid, key: w.key, value: w.value, protect: w.protect,
    }));
  }
  return { ok: true };
}

function openEntryDialog(detail, presetGroupUuid) {
  $('entry-form-title').textContent = detail ? 'Edit entry' : 'New entry';
  $('e-title').value = detail ? detail.title : '';
  $('e-username').value = detail ? detail.username : '';
  $('e-password').value = detail ? detail.password : '';
  $('e-password').type = 'password';
  $('e-url').value = detail ? detail.url : '';
  $('e-notes').value = detail ? detail.notes : '';
  $('e-tags').value = detail ? (detail.tags || []).join(',') : '';
  $('e-icon').value = detail ? detail.icon : 0;
  $('e-expires').checked = detail ? detail.times.expires : false;
  $('e-expiry').hidden = !$('e-expires').checked;
  if (detail && detail.times.expiry) {
    // render in UTC: Qt inside wasm parses ISO strings as local (= UTC)
    $('e-expiry').value = new Date(detail.times.expiry).toISOString().slice(0, 16);
  } else {
    $('e-expiry').value = '';
  }
  $('e-health').hidden = true;
  hideDialogError('dlg-entry');

  const attrsBox = $('e-attrs');
  attrsBox.textContent = '';
  for (const a of (detail ? detail.customAttributes : [])) {
    attrsBox.appendChild(attrRow(a.key, a.value, a.isProtected));
  }

  wireForm('dlg-entry', () => {
    const groupUuid = detail
      ? detail.groupUuid
      : (presetGroupUuid || state.selectedGroup || state.tree.root.uuid);
    const args = {
      title: $('e-title').value.trim() || 'Untitled',
      username: $('e-username').value,
      password: $('e-password').value,
      url: $('e-url').value.trim(),
      notes: $('e-notes').value,
      tags: $('e-tags').value,
      icon: Number($('e-icon').value) || 0,
      expires: $('e-expires').checked,
      expiry: $('e-expires').checked ? $('e-expiry').value : '',
    };
    let r;
    if (detail) {
      r = kpx('kpx_update_entry', JSON.stringify({ uuid: detail.uuid, ...args }));
    } else {
      r = kpx('kpx_add_entry', JSON.stringify({ groupUuid, ...args }));
      if (r.ok) state.selectedEntry = r.uuid;
    }
    if (!r.ok) return r.error;
    syncAttributes(detail ? detail.uuid : state.selectedEntry, readAttrRows());
    markDirty();
    refreshAll();
    return null;
  }).showModal();
  setTimeout(() => $('e-title').focus(), 50);
}

function openMoveDialog(kind, uuid) {
  const sel = $('m-group');
  sel.textContent = '';
  const walk = (g, depth) => {
    if (uuid && g.uuid === uuid && kind === 'group') return; // not into itself
    const opt = el('option', '', `${'— '.repeat(depth)}${g.name}`);
    opt.value = g.uuid;
    sel.appendChild(opt);
    for (const c of g.children) walk(c, depth + 1);
  };
  walk(state.tree.root, 0);
  hideDialogError('dlg-move');

  wireForm('dlg-move', () => {
    const r = kind === 'entry'
      ? kpx('kpx_move_entry', JSON.stringify({ uuid, groupUuid: sel.value }))
      : kpx('kpx_move_group', JSON.stringify({ uuid, parentUuid: sel.value }));
    if (!r.ok) return r.error;
    markDirty();
    refreshAll();
    return null;
  }).showModal();
}

function openTotpDialog(entryUuid) {
  $('t-key').value = '';
  hideDialogError('dlg-totp');

  wireForm('dlg-totp', () => {
    const r = kpx('kpx_set_totp', JSON.stringify({
      uuid: entryUuid,
      key: $('t-key').value.trim(),
      digits: Number($('t-digits').value),
      step: Number($('t-step').value),
      algorithm: Number($('t-algo').value),
    }));
    if (!r.ok) return r.error;
    markDirty();
    refreshAll();
    return null;
  }).showModal();
  setTimeout(() => $('t-key').focus(), 50);
}

function openCredentialsDialog() {
  $('c-password').value = '';
  $('c-keyfile').value = '';
  hideDialogError('dlg-credentials');

  wireForm('dlg-credentials', async () => {
    const pw = $('c-password').value;
    const kf = $('c-keyfile').files[0];
    if (!pw && !kf) return 'Enter a new password or choose a key file.';
    let keyfilePath = '';
    if (kf) {
      keyfilePath = `/upload/${kf.name}`;
      await loadFileInto(keyfilePath, kf);
    }
    const r = await busy('Re-encrypting master key …', () =>
      kpx('kpx_change_credentials', JSON.stringify({
        password: pw, keyfile: keyfilePath,
      })));
    if (!r.ok) return r.error;
    const saved = await saveDb();
    if (!saved) return 'Credentials changed, but saving failed — use Download to keep a copy.';
    toast('Credentials changed', 'ok');
    return null;
  }).showModal();
  setTimeout(() => $('c-password').focus(), 50);
}

/* ------------------------------------------------------------ generator */
function openGenerator(inputEl) {
  genTarget = inputEl ? { input: inputEl } : null;
  const d = $('dlg-generator');
  generateNow();
  d.showModal();
}

function openGeneratorFromEntry() {
  const entryForm = $('dlg-entry');
  if (entryForm.open) {
    openGenerator($('e-password'));
  } else {
    genTarget = { entry: state.selectedEntry };
    $('dlg-generator').showModal();
    generateNow();
  }
}

function generatorArgs() {
  let classes = 0;
  for (const cb of $('gen-classes').querySelectorAll('input')) {
    if (cb.checked) classes += Number(cb.value);
  }
  const flags = ($('gen-alike').checked ? 1 : 0) | ($('gen-every').checked ? 2 : 0);
  return {
    length: Number($('gen-len').value),
    charClasses: classes,
    flags,
    exclude: $('gen-exclude').value,
  };
}

function generateNow() {
  let r;
  if ($('gen-pw').hidden) {
    r = kpx('kpx_generate_passphrase', JSON.stringify({
      wordCount: Number($('gen-words').value),
      separator: $('gen-sep').value || ' ',
    }));
    if (r.ok) $('gen-result').value = r.passphrase;
  } else {
    r = kpx('kpx_generate_password', JSON.stringify(generatorArgs()));
    if (r.ok) $('gen-result').value = r.password;
  }
  if (!r.ok) {
    $('gen-result').value = '';
    toast(r.error, 'err');
    return;
  }
  const h = kpx('kpx_password_health', $('gen-result').value);
  if (h.ok) qualityBar($('gen-health-bar'), $('gen-health-text'), h);
}

/* ------------------------------------------------------------ open/create */
function showSection(id) {
  for (const s of ['landing', 'unlock', 'main']) {
    $(s).hidden = s !== id;
  }
}

function recentNames() {
  try {
    return JSON.parse(localStorage.getItem('kpxc-recent') || '[]');
  } catch (e) {
    return [];
  }
}

function showRecent() {
  // only list files that actually exist in the (synced) FS
  const names = recentNames().filter((n) => {
    try {
      return Module.FS.analyzePath(`/keepassxc/${n}`).exists;
    } catch (e) {
      return false;
    }
  });
  const box = $('recent');
  const list = $('recent-list');
  list.textContent = '';
  box.hidden = names.length === 0;
  for (const n of names) {
    const li = el('li');
    li.appendChild(el('span', '', '🗄'));
    li.appendChild(el('span', 'name mono', n));
    const open = el('button', 'btn small', 'Open');
    open.onclick = () => startUnlock(`/keepassxc/${n}`, n, null);
    li.appendChild(open);
    const del = el('button', 'btn small warn', '✖');
    del.onclick = () => {
      try { Module.FS.unlink(`/keepassxc/${n}`); } catch (e) { /* ignore */ }
      syncIdbfs(false);
      localStorage.setItem('kpxc-recent',
        JSON.stringify(recentNames().filter((x) => x !== n)));
      showRecent();
    };
    li.appendChild(del);
    list.appendChild(li);
  }
}

function rememberRecent(name) {
  const names = [name, ...recentNames().filter((n) => n !== name)].slice(0, 10);
  localStorage.setItem('kpxc-recent', JSON.stringify(names));
  showRecent();
}

function startUnlock(fsPath, displayName, uploadedPath) {
  state.dbPath = fsPath;
  state.fileName = displayName;
  state.uploaded = uploadedPath || null;
  $('unlock-filename').textContent = displayName;
  $('unlock-password').value = '';
  $('unlock-keyfile').value = '';
  $('unlock-error').hidden = true;
  $('unlock-keep').checked = !!Module.keepassxcIdbfs;
  $('unlock-keep').disabled = !Module.keepassxcIdbfs;
  showSection('unlock');
  setTimeout(() => $('unlock-password').focus(), 60);
}

/* KeePassXC reports a wrong master password as "Invalid credentials were
 * provided" (and several near-variants); surface those as one message. */
function unlockErrorMessage(error) {
  if (/invalid credentials|credentials were provided|wrong key|hmac|not a keepass|corrupt/i.test(error)) {
    return 'Wrong password or key file — the database could not be decrypted.';
  }
  return error;
}

async function doUnlock() {
  const pw = $('unlock-password').value;
  const kf = $('unlock-keyfile').files[0];
  let keyfilePath = '';
  if (kf) {
    keyfilePath = `/upload/${kf.name}`;
    await loadFileInto(keyfilePath, kf);
  }
  state.keepCopy = $('unlock-keep').checked && !!Module.keepassxcIdbfs;

  // If the user wants a kept copy, work directly on the copy under
  // /keepassxc (the IDBFS mount) so every later save persists too.
  let path = state.uploaded || state.dbPath;
  const keptPath = `/keepassxc/${state.fileName}`;
  if (state.keepCopy && path !== keptPath) {
    try {
      Module.FS.writeFile(keptPath, Module.FS.readFile(path));
      path = keptPath;
    } catch (e) {
      console.warn('copying to /keepassxc failed; opening the upload', e);
    }
  }

  const r = await busy('Unlocking — deriving key (Argon2) …', () =>
    kpx('kpx_open', JSON.stringify({ path, password: pw, keyfile: keyfilePath })));

  if (!r.ok) {
    $('unlock-error').textContent = unlockErrorMessage(r.error);
    $('unlock-error').hidden = false;
    return;
  }
  state.dbPath = path;
  if (state.keepCopy) {
    rememberRecent(state.fileName);
    await syncIdbfs(false);
  }
  await enterMain();
}

function kdfParamsFor(preset) {
  switch (preset) {
    case 'fast': return { name: 'argon2id', rounds: 2, memoryKiB: 8192, parallelism: 1 };
    case 'strong': return { name: 'argon2id', rounds: 4, memoryKiB: 262144, parallelism: 1 };
    case 'aes': return { name: 'aes', rounds: 100000 };
    default: return { name: 'argon2id', rounds: 3, memoryKiB: 65536, parallelism: 1 };
  }
}

async function doCreate() {
  const pw = $('create-password').value;
  if (pw !== $('create-password2').value) {
    return 'Passwords do not match.';
  }
  if (!pw && !$('create-keyfile').files.length) {
    return 'A password or key file is required.';
  }
  const kf = $('create-keyfile').files[0];
  let keyfilePath = '';
  if (kf) {
    keyfilePath = `/upload/${kf.name}`;
    await loadFileInto(keyfilePath, kf);
  }
  state.keepCopy = true;
  const displayName = `${($('create-name').value.trim() || 'vault').replace(/[^\w.-]+/g, '_')}.kdbx`;
  const path = `/keepassxc/${displayName}`;

  const r = await busy('Creating — deriving key (Argon2) …', () =>
    kpx('kpx_create_database', JSON.stringify({
      path,
      password: pw,
      keyfile: keyfilePath,
      kdf: kdfParamsFor($('create-kdf').value),
      name: $('create-name').value.trim() || 'My Vault',
    })));
  if (!r.ok) return r.error;

  state.dbPath = path;
  state.fileName = displayName;
  state.uploaded = null;
  await syncIdbfs(false);
  rememberRecent(displayName);
  await enterMain();
  return null;
}

async function enterMain() {
  state.open = true;
  state.selectedGroup = null;
  state.selectedEntry = null;
  const info = kpx('kpx_db_info', '');
  $('db-title').textContent = info.ok ? info.name : 'Database';
  $('db-title').title = info.ok
    ? `${info.kdf} · ${info.cipher} · kdbx ${info.formatVersion}` : '';
  clearDirty();
  refreshTree();
  renderDetail();
  showSection('main');
}

async function lockDb() {
  if (state.dirty && !confirm('There are unsaved changes. Lock anyway?')) return;
  kpx('kpx_close', '');
  state.open = false;
  state.tree = null;
  state.selectedEntry = null;
  state.selectedGroup = null;
  state.dbPath = '';
  state.uploaded = null;
  clearInterval(state.totpTimer);
  state.totpTimer = null;
  await persistDb();
  showRecent();
  showSection('landing');
}

/* ------------------------------------------------------------ boot */
async function boot() {
  try {
    Module = await createKeePassXCModule({
      print: () => {},
      printErr: (m) => console.warn('[wasm]', m),
      // The .data package loader (unlike the .wasm fetch) has no
      // scriptDirectory fallback — without this it resolves
      // 'keepassxc.data' against the page URL and 404s whenever the site
      // lives under a subdirectory (GitHub Pages serves /keepassxc/).
      locateFile: (p) => new URL(`wasm/${p}`, document.baseURI).href,
    });
    const init = kpx('kpx_init', '');
    if (!init.ok) throw new Error(init.error);
  } catch (e) {
    $('boot-msg').textContent = `Failed to load the KeePassXC engine: ${e}`;
    return;
  }

  // pull any previously saved databases from IndexedDB into MEMFS
  await syncIdbfs(true);

  $('boot').hidden = true;
  showRecent();
  showSection('landing');

  // landing actions
  $('btn-open').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.kdbx';
    inp.onchange = async () => {
      if (!inp.files.length) return;
      const f = inp.files[0];
      await loadFileInto(`/upload/${f.name}`, f);
      startUnlock(`/upload/${f.name}`, f.name, `/upload/${f.name}`);
    };
    inp.click();
  };
  $('btn-create').onclick = () => {
    $('create-password').value = '';
    $('create-password2').value = '';
    $('create-keyfile').value = '';
    $('create-health').hidden = true;
    hideDialogError('dlg-create');
    wireForm('dlg-create', doCreate).showModal();
    setTimeout(() => $('create-name').focus(), 50);
  };

  // drag & drop anywhere on the landing page
  document.addEventListener('dragover', (ev) => ev.preventDefault());
  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    if (state.open) return;
    const f = ev.dataTransfer?.files?.[0];
    if (!f) return;
    loadFileInto(`/upload/${f.name}`, f).then(() =>
      startUnlock(`/upload/${f.name}`, f.name, `/upload/${f.name}`));
  });

  // unlock
  $('unlock-form').onsubmit = (ev) => {
    ev.preventDefault();
    doUnlock();
  };
  $('unlock-back').onclick = () => {
    state.uploaded = null;
    showSection('landing');
  };

  // create: live password quality
  $('create-password').oninput = () => {
    const pw = $('create-password').value;
    if (!pw) { $('create-health').hidden = true; return; }
    const h = kpx('kpx_password_health', pw);
    if (h.ok) {
      $('create-health').hidden = false;
      qualityBar($('create-health-bar'), $('create-health-text'), h);
    }
  };

  // main toolbar
  $('btn-save').onclick = saveDb;
  $('btn-download').onclick = downloadDb;
  $('btn-credentials').onclick = openCredentialsDialog;
  $('btn-lock').onclick = lockDb;
  $('btn-add-entry').onclick = () => {
    const g = state.selectedGroup || state.tree?.root?.uuid;
    openEntryDialog(null, g);
  };

  // search (debounced; the bridge does the matching)
  let searchTimer = null;
  $('search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderEntryList, 180);
  };

  // entry dialog interactions
  $('e-toggle-pw').onclick = () => {
    const p = $('e-password');
    p.type = p.type === 'password' ? 'text' : 'password';
  };
  $('e-gen').onclick = () => openGenerator($('e-password'));
  $('e-password').oninput = () => {
    const pw = $('e-password').value;
    if (!pw) { $('e-health').hidden = true; return; }
    const h = kpx('kpx_password_health', pw);
    if (h.ok) {
      $('e-health').hidden = false;
      qualityBar($('e-health-bar'), $('e-health-text'), h);
    }
  };
  $('e-attr-add').onclick = () => $('e-attrs').appendChild(attrRow('', '', false));
  $('e-expires').onchange = () => { $('e-expiry').hidden = !$('e-expires').checked; };

  // generator dialog
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      $('gen-pw').hidden = t.dataset.tab !== 'pw';
      $('gen-phrase').hidden = t.dataset.tab !== 'phrase';
      generateNow();
    };
  }
  $('gen-len').oninput = () => { $('gen-len-v').textContent = $('gen-len').value; generateNow(); };
  $('gen-words').oninput = () => { $('gen-words-v').textContent = $('gen-words').value; generateNow(); };
  $('gen-sep').onchange = generateNow;
  $('gen-exclude').oninput = generateNow;
  for (const cb of $('gen-classes').querySelectorAll('input')) cb.onchange = generateNow;
  $('gen-alike').onchange = generateNow;
  $('gen-every').onchange = generateNow;
  $('gen-refresh').onclick = generateNow;
  $('gen-close').onclick = () => $('dlg-generator').close();
  $('gen-copy').onclick = () => copyText($('gen-result').value);
  $('gen-use').onclick = () => {
    const value = $('gen-result').value;
    if (genTarget?.input) {
      genTarget.input.value = value;
      genTarget.input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (genTarget?.entry) {
      const r = kpx('kpx_update_entry', JSON.stringify({
        uuid: genTarget.entry, password: value,
      }));
      if (r.ok) { markDirty(); refreshAll(); toast('Password set', 'ok'); }
      else { toast(r.error, 'err'); return; }
    }
    $('dlg-generator').close();
  };

  // keyboard shortcuts
  document.addEventListener('keydown', (ev) => {
    if (!state.open) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
      ev.preventDefault();
      saveDb();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'l') {
      ev.preventDefault();
      lockDb();
    }
  });

  // warn before leaving with unsaved changes
  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
}

/* ------------------------------------------------------------ offline */
/* Register the service worker (offline app shell — see sw.js). It serves
 * network-first, so an open tab picks up publishes on its next reload by
 * itself; nothing to signal here. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch((e) => console.warn('[sw] registration failed:', e.message));
}

boot();
