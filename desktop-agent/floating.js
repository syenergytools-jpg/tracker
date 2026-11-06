// Renderer for the floating launcher. Two responsibilities only:
//   1. Let the employee drag the bubble around, snapping to a screen edge.
//   2. Treat a press that didn't turn into a drag as a click -> open popup.
// Everything else (auth, tracking, the actual UI) lives in the popup window
// and main process; this just reflects pushed state onto the bubble colour.

const bubble = document.getElementById('bubble');

let dragging = false;
let moved = false;
let grabX = 0; // cursor offset inside the bubble's window at press time
let grabY = 0;
let startScreenX = 0;
let startScreenY = 0;

// A few px of slop so a normal click with a shaky hand still counts as a
// click, not a 2px "drag".
const DRAG_THRESHOLD = 4;

bubble.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  moved = false;
  grabX = event.clientX;
  grabY = event.clientY;
  startScreenX = event.screenX;
  startScreenY = event.screenY;
  // Capture keeps pointermove/up coming even if a fast drag outruns the
  // 56px bubble and the cursor leaves it mid-gesture.
  bubble.setPointerCapture(event.pointerId);
});

bubble.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  if (
    Math.abs(event.screenX - startScreenX) > DRAG_THRESHOLD ||
    Math.abs(event.screenY - startScreenY) > DRAG_THRESHOLD
  ) {
    moved = true;
  }
  if (moved) {
    // Top-left the window should move to so the same point under the cursor
    // stays under the cursor. Main clamps/validates before applying.
    window.floatingAPI.move(event.screenX - grabX, event.screenY - grabY);
  }
});

bubble.addEventListener('pointerup', (event) => {
  if (!dragging) return;
  dragging = false;
  try {
    bubble.releasePointerCapture(event.pointerId);
  } catch {
    /* capture may already be gone; harmless */
  }
  if (moved) {
    window.floatingAPI.dragEnd(event.screenX - grabX, event.screenY - grabY);
  } else {
    window.floatingAPI.click();
  }
});

// Never show a desktop context menu on the bubble.
window.addEventListener('contextmenu', (event) => event.preventDefault());

window.floatingAPI.onState((state) => {
  const authenticated = !!state?.authenticated;
  const running = !!state?.running;
  bubble.classList.toggle('running', authenticated && running);
  bubble.classList.toggle('ready', authenticated && !running);
  bubble.classList.toggle('signed-out', !authenticated);
  bubble.title = !authenticated
    ? 'Evolut Productivity — click to sign in'
    : running
    ? 'Evolut Productivity — tracking is ON · click to open'
    : 'Evolut Productivity — NOT tracking · click to Start';
});
