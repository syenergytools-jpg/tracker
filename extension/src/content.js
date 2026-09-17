// No imports on purpose — this is loaded as a plain content script (not a
// module), and it never needs Supabase: it only counts events and reports
// counts to the background script.
//
// What is captured: that an event of a given type happened, when, and (for
// mouse moves only) how far the cursor moved in pixels. What is never
// captured: which key was pressed (event.key/event.code are never read),
// page content, form values, or clipboard data.

const BATCH_INTERVAL_MS = 7000;

let keyCount = 0;
let mouseMoveCount = 0;
let mouseDownCount = 0;
let scrollCount = 0;

// Local-only scratch state for the anti-gaming timing/movement stats sent
// with each batch. Cleared every flush — never sent raw, never persisted.
let eventTimestamps = [];
let mouseMoveDeltas = [];
let lastMousePos = null;

function recordEventTiming() {
  eventTimestamps.push(performance.now());
}

function onKeyDown() {
  keyCount += 1;
  recordEventTiming();
}

function onMouseMove(event) {
  mouseMoveCount += 1;
  recordEventTiming();
  if (lastMousePos) {
    const dx = event.clientX - lastMousePos.x;
    const dy = event.clientY - lastMousePos.y;
    mouseMoveDeltas.push(Math.sqrt(dx * dx + dy * dy));
  }
  lastMousePos = { x: event.clientX, y: event.clientY };
}

function onMouseDown() {
  mouseDownCount += 1;
  recordEventTiming();
}

function onScrollLike() {
  scrollCount += 1;
  recordEventTiming();
}

document.addEventListener('keydown', onKeyDown, { passive: true, capture: true });
document.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
document.addEventListener('mousedown', onMouseDown, { passive: true, capture: true });
document.addEventListener('scroll', onScrollLike, { passive: true, capture: true });
document.addEventListener('wheel', onScrollLike, { passive: true, capture: true });

function intervalStats(timestamps) {
  if (timestamps.length < 2) return { avgIntervalMs: null, intervalStdDevMs: null };
  const intervals = [];
  for (let i = 1; i < timestamps.length; i += 1) intervals.push(timestamps[i] - timestamps[i - 1]);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  return { avgIntervalMs: mean, intervalStdDevMs: Math.sqrt(variance) };
}

let batchIntervalId = null;

function flushBatch() {
  // Reloading the extension orphans any content script already injected
  // into a still-open tab — its chrome.runtime connection is gone, and
  // chrome.runtime.id reads back undefined. Stop trying rather than
  // throwing "Extension context invalidated" every BATCH_INTERVAL_MS; the
  // page just needs a refresh to pick up the current content script.
  if (!chrome.runtime?.id) {
    clearInterval(batchIntervalId);
    return;
  }

  if (keyCount === 0 && mouseMoveCount === 0 && mouseDownCount === 0 && scrollCount === 0) return;

  const { avgIntervalMs, intervalStdDevMs } = intervalStats(eventTimestamps);
  const avgMouseMoveDeltaPx =
    mouseMoveDeltas.length > 0 ? mouseMoveDeltas.reduce((a, b) => a + b, 0) / mouseMoveDeltas.length : null;

  const payload = {
    keyCount,
    mouseMoveCount,
    mouseDownCount,
    scrollCount,
    avgIntervalMs,
    intervalStdDevMs,
    avgMouseMoveDeltaPx,
    batchEndedAt: Date.now(),
  };

  keyCount = 0;
  mouseMoveCount = 0;
  mouseDownCount = 0;
  scrollCount = 0;
  eventTimestamps = [];
  mouseMoveDeltas = [];

  try {
    chrome.runtime.sendMessage({ type: 'ACTIVITY_BATCH', payload }).catch(() => {
      // Background service worker not ready (e.g. mid-restart) — this batch
      // is dropped; the next one follows in BATCH_INTERVAL_MS.
    });
  } catch {
    // Context was invalidated between the check above and this call —
    // sendMessage can throw synchronously, not just reject. Same recovery:
    // stop, don't spam errors from a tab that needs a refresh anyway.
    clearInterval(batchIntervalId);
  }
}

batchIntervalId = setInterval(flushBatch, BATCH_INTERVAL_MS);
