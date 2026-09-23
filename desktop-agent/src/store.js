// Electron's main process is a normal long-lived Node process — it doesn't
// get killed and cold-started the way an MV3 service worker does, so none
// of the extension's "persist everything, assume restarts" defensiveness
// is needed here. This just needs a simple place to persist state across
// the app being closed and reopened (and to survive a crash without losing
// today's counts), so a plain JSON file per key in Electron's per-user data
// directory is enough — no chrome.storage equivalent needed.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function filePathFor(key) {
  return path.join(app.getPath('userData'), `${key}.json`);
}

function readJSON(key, fallback) {
  try {
    const raw = fs.readFileSync(filePathFor(key), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(filePathFor(key), JSON.stringify(value), 'utf-8');
}

module.exports = { readJSON, writeJSON };
