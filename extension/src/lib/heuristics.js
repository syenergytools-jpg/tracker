// Best-effort anti-gaming pattern detection (see README "What is and isn't
// tracked"). These are statistical flags for a human admin to review, NOT
// proof of misconduct — a training video with a static mouse looks exactly
// like a "minimal movement" flag but is genuinely fine. Never wire this to
// an automatic penalty.
//
// Inputs are the small per-batch summaries content.js already computes
// locally (see src/content.js) — never raw per-event logs. Nothing here
// receives key identity, page content, or anything beyond counts/timing.

const WINDOW_SIZE = 30;
const UNIFORM_STDDEV_MS_THRESHOLD = 150;
const UNIFORM_MIN_SAMPLES = 8;
const MIN_MOVEMENT_PX_THRESHOLD = 3;
const MIN_MOVEMENT_MIN_SAMPLES = 8;
const SINGLE_KEY_STREAK_BATCHES = 6;
const TAB_SWITCH_WINDOW_MS = 2 * 60 * 1000;
const TAB_SWITCH_COUNT_THRESHOLD = 12;
const TAB_SWITCH_MAX_DWELL_MS = 4000;

export function createHeuristicsEngine() {
  let batchWindow = [];
  let keyOnlyStreak = 0;
  let tabSwitchTimestamps = [];
  let tabDwellTimes = [];

  function recordBatch(batch) {
    batchWindow.push(batch);
    if (batchWindow.length > WINDOW_SIZE) batchWindow.shift();

    const isKeyOnly = batch.keyCount > 0 && batch.mouseMoveCount === 0 &&
      batch.mouseDownCount === 0 && batch.scrollCount === 0;
    keyOnlyStreak = isKeyOnly ? keyOnlyStreak + 1 : 0;

    return evaluate();
  }

  function recordTabSwitch(dwellMs) {
    const now = Date.now();
    tabSwitchTimestamps.push(now);
    tabSwitchTimestamps = tabSwitchTimestamps.filter((t) => now - t < TAB_SWITCH_WINDOW_MS);
    if (dwellMs != null) {
      tabDwellTimes.push(dwellMs);
      tabDwellTimes = tabDwellTimes.slice(-tabSwitchTimestamps.length);
    }

    return evaluate();
  }

  function evaluate() {
    const reasons = new Set();

    const uniformSamples = batchWindow.filter((b) => b.intervalStdDevMs != null);
    if (
      uniformSamples.length >= UNIFORM_MIN_SAMPLES &&
      uniformSamples.every((b) => b.intervalStdDevMs < UNIFORM_STDDEV_MS_THRESHOLD)
    ) {
      reasons.add('uniform_interval_pattern');
    }

    const moveSamples = batchWindow.filter((b) => b.mouseMoveCount > 0 && b.avgMouseMoveDeltaPx != null);
    if (
      moveSamples.length >= MIN_MOVEMENT_MIN_SAMPLES &&
      moveSamples.every((b) => b.avgMouseMoveDeltaPx < MIN_MOVEMENT_PX_THRESHOLD)
    ) {
      reasons.add('minimal_movement_pattern');
    }

    if (keyOnlyStreak >= SINGLE_KEY_STREAK_BATCHES) {
      reasons.add('single_key_repeat_pattern');
    }

    if (
      tabSwitchTimestamps.length >= TAB_SWITCH_COUNT_THRESHOLD &&
      tabDwellTimes.length > 0 &&
      tabDwellTimes.every((d) => d < TAB_SWITCH_MAX_DWELL_MS)
    ) {
      reasons.add('excessive_tab_switching');
    }

    return reasons.size > 0 ? Array.from(reasons) : [];
  }

  return { recordBatch, recordTabSwitch };
}
