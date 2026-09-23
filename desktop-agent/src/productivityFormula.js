// Identical formula/thresholds to extension/src/lib/productivityFormula.js
// — kept in sync deliberately so "productive" means the same thing
// regardless of whether the signal came from the browser extension or this
// agent. If you tune one, tune both.
//
// Classifies one completed 3-minute window as productive or unproductive:
// real typing OR real mouse/scroll activity within the same window (either
// is enough). Deliberately hidden from the employee — see main.js.
const PRODUCTIVE_KEY_THRESHOLD = 30;
const PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD = 3; // sum of move+click+scroll events

function isWindowProductive({ keyCount, mouseActivityCount }) {
  return keyCount >= PRODUCTIVE_KEY_THRESHOLD || mouseActivityCount >= PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD;
}

module.exports = { PRODUCTIVE_KEY_THRESHOLD, PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD, isWindowProductive };
