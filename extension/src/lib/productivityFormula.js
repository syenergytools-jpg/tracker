// The (deliberately hidden-from-the-employee) formula that classifies one
// completed 3-minute window as productive or unproductive: real typing OR
// real mouse/scroll activity within the same window (either is enough).
//
// OR means keyboard-only work (e.g. writing code without touching the
// mouse) and mouse-only work (e.g. reviewing a design with little typing)
// both count as productive on their own. Treat these two numbers as the
// tunable knobs — adjust them from observed false-positive/negative rates
// rather than changing the OR shape of the formula.
export const PRODUCTIVE_KEY_THRESHOLD = 30;
export const PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD = 10; // sum of move+click+scroll events

export function isWindowProductive({ keyCount, mouseActivityCount }) {
  return keyCount >= PRODUCTIVE_KEY_THRESHOLD || mouseActivityCount >= PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD;
}
