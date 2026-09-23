const activeWin = require('active-win');
const path = require('node:path');

// Only the executable's basename (e.g. "EXCEL.EXE") is ever read from the
// result — never `.title`, which can contain a document name, a page
// title, an email subject line, or other content. Same "counts and
// identity only, never content" rule as the rest of this project.
async function getForegroundAppName() {
  try {
    const result = await activeWin();
    if (!result?.owner?.path) return null;
    return path.basename(result.owner.path);
  } catch (err) {
    console.warn('[evolut-productivity-agent] failed to read foreground window:', err.message);
    return null;
  }
}

module.exports = { getForegroundAppName };
