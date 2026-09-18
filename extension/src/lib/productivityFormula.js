// The (deliberately hidden-from-the-employee) formula that classifies one
// completed 3-minute window as productive or unproductive: real typing AND
// real mouse/scroll activity, both within the same window.
//
// Requiring both is a deliberate choice, but it's worth knowing it can
// misclassify legitimate keyboard-only work (e.g. writing code without
// touching the mouse) or mouse-only work (e.g. reviewing a design with
// little typing) as unproductive. Treat these two numbers as the tunable
// knobs — adjust them from observed false-positive/negative rates rather
// than changing the AND shape of the formula.
export const PRODUCTIVE_KEY_THRESHOLD = 30;
export const PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD = 3; // sum of move+click+scroll events

export function isWindowProductive({ keyCount, mouseActivityCount }) {
  return keyCount >= PRODUCTIVE_KEY_THRESHOLD && mouseActivityCount >= PRODUCTIVE_MOUSE_ACTIVITY_THRESHOLD;
}
