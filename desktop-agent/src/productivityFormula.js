// Level 2 "active-seconds" model. Productivity is no longer an all-or-nothing
// verdict on a whole 3-minute window; instead each 15-second sub-block is
// judged active or idle, and the day's productive/unproductive split is the
// sum of those blocks (see trackingEngine.js). This is what makes scores
// spread out realistically instead of everyone sitting at ~100%.
//
// Two deliberate changes from the old formula, both aimed at "make it harder":
//   1. Raw mouse MOVEMENT no longer counts at all. It used to, and because a
//      moving mouse fires 60-120 events/sec against a threshold of 10, any
//      stray twitch marked a full window productive — i.e. mere presence
//      scored ~100%. Only real intent counts now: keystrokes, clicks, scroll.
//   2. The unit is a 15s block, so idle stretches become unproductive time at
//      fine granularity rather than being masked by one burst of activity.
//
// NOTE: the Chrome extension once shared this formula. Only the desktop agent
// is deployed, so this is intentionally the agent's own model now; if an
// extension is ever revived, port these same rules to it.

// Per 15-second sub-block:
const PRODUCTIVE_KEY_THRESHOLD = 5; // >= 5 keystrokes in the block, OR...
const PRODUCTIVE_CLICK_SCROLL_THRESHOLD = 2; // >= 2 clicks/scroll ticks in the block

// A block counts toward productive time if there was real interaction in it.
// Either signal alone is enough, so reading-heavy work still earns credit
// from scrolling/clicking, while an untouched machine does not.
function isSubBlockActive({ keyCount, clickScrollCount }) {
  return (
    keyCount >= PRODUCTIVE_KEY_THRESHOLD ||
    clickScrollCount >= PRODUCTIVE_CLICK_SCROLL_THRESHOLD
  );
}

module.exports = {
  PRODUCTIVE_KEY_THRESHOLD,
  PRODUCTIVE_CLICK_SCROLL_THRESHOLD,
  isSubBlockActive,
};
