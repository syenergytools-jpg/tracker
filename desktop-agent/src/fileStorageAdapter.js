// supabase-js's default storage is `localStorage`, which doesn't exist in
// an Electron main process. Backs auth session persistence with the same
// JSON-file store used elsewhere (see store.js).

const { readJSON, writeJSON } = require('./store');

const KEY = 'auth-storage';

function readAll() {
  return readJSON(KEY, {});
}

const fileStorageAdapter = {
  async getItem(storageKey) {
    const all = readAll();
    return all[storageKey] ?? null;
  },
  async setItem(storageKey, value) {
    const all = readAll();
    all[storageKey] = value;
    writeJSON(KEY, all);
  },
  async removeItem(storageKey) {
    const all = readAll();
    delete all[storageKey];
    writeJSON(KEY, all);
  },
};

module.exports = { fileStorageAdapter };
