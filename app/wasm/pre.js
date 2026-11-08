// pre.js — runs inside the module factory before runtime initialization.
// Mounts an IDBFS volume at /keepassxc so settings and the opt-in encrypted
// autosave survive page reloads. Node (used for tests) has no IndexedDB; the
// mount is skipped there and the directory stays in MEMFS.

Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  FS.mkdir('/keepassxc');
  if (typeof indexedDB !== 'undefined') {
    try {
      FS.mount(IDBFS, {}, '/keepassxc');
      Module.keepassxcIdbfs = true;
    } catch (e) {
      console.warn('IDBFS mount failed, persistence disabled:', e);
    }
  }
  FS.mkdir('/keepassxc/config');
  FS.mkdir('/upload');
});
