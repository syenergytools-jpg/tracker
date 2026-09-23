const { supabase, ensureFreshSession } = require('./supabaseClient');
const { markSynced } = require('./dailyState');

// This agent is now the sole tracking source (see README — no separate
// browser extension in the deployed setup), so unlike an earlier design
// here, it writes both the per-app breakdown (app_activity) AND the daily
// rollup (productivity_sessions) directly — there's only one writer, so
// the two-independent-clients conflict that used to require keeping them
// separate no longer applies. If a Chrome-extension-based setup is ever
// reintroduced alongside this agent, productivity_sessions would need to
// go back to being extension-only, with agent totals combined at query
// time instead (see daily_productivity_totals in supabase/schema.sql).
//
// Same overwrite-upsert reasoning as before: `state` always holds the
// day's true running total, so every push overwrites with that total
// rather than sending a delta — trivially safe to retry.
async function syncState(state, userId) {
  if (!userId) return { ok: false, reason: 'not-authenticated' };

  const session = await ensureFreshSession();
  if (!session) return { ok: false, reason: 'not-authenticated' };

  const nowIso = new Date().toISOString();

  const appNames = Object.keys(state.apps);
  if (appNames.length > 0) {
    const rows = appNames.map((appName) => ({
      user_id: userId,
      work_date: state.workDate,
      app_name: appName,
      productive_seconds: state.apps[appName].productiveSeconds,
      unproductive_seconds: state.apps[appName].unproductiveSeconds,
      updated_at: nowIso,
    }));

    const { error: appError } = await supabase.from('app_activity').upsert(rows, { onConflict: 'user_id,work_date,app_name' });
    if (appError) {
      console.warn('[evolut-productivity-agent] app_activity sync failed:', appError.message);
      return { ok: false, reason: appError.message };
    }
  }

  const { error: sessionError } = await supabase.from('productivity_sessions').upsert(
    {
      user_id: userId,
      work_date: state.workDate,
      total_productive_seconds: state.totalProductiveSeconds,
      total_unproductive_seconds: state.totalUnproductiveSeconds,
      app_switch_count: state.appSwitchCount,
      updated_at: nowIso,
    },
    { onConflict: 'user_id,work_date' }
  );
  if (sessionError) {
    console.warn('[evolut-productivity-agent] productivity_sessions sync failed:', sessionError.message);
    return { ok: false, reason: sessionError.message };
  }

  markSynced();
  return { ok: true };
}

async function syncWithRetry(state, userId, attempts = 3) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await syncState(state, userId);
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  return result;
}

module.exports = { syncState, syncWithRetry };
