import { supabase, ensureFreshSession } from './supabaseClient.js';
import { markSynced } from './dailyState.js';

// `state` always holds the full running total for the day (see
// dailyState.js) rather than a since-last-flush delta, so every upsert here
// overwrites with the current true total. That makes sync trivially safe to
// retry or double-run: a failed or repeated push can never double-count,
// unlike an additive "increment and reset" scheme would if a response was
// lost after the server had already committed it.
export async function syncState(state, userId) {
  if (!userId) return { ok: false, reason: 'not-authenticated' };

  const session = await ensureFreshSession();
  if (!session) return { ok: false, reason: 'not-authenticated' };

  const hostnames = Object.keys(state.sites);
  if (hostnames.length > 0) {
    const nowIso = new Date().toISOString();
    const rows = hostnames.map((hostname) => ({
      user_id: userId,
      work_date: state.workDate,
      hostname,
      category: state.sites[hostname].category,
      productive_seconds: state.sites[hostname].productiveSeconds,
      unproductive_seconds: state.sites[hostname].unproductiveSeconds,
      updated_at: nowIso,
    }));

    const { error: siteError } = await supabase
      .from('site_activity')
      .upsert(rows, { onConflict: 'user_id,work_date,hostname' });
    if (siteError) {
      console.warn('[evolut-productivity] site_activity sync failed:', siteError.message);
      return { ok: false, reason: siteError.message };
    }
  }

  const { error: sessionError } = await supabase.from('productivity_sessions').upsert(
    {
      user_id: userId,
      work_date: state.workDate,
      total_productive_seconds: state.totalProductiveSeconds,
      total_unproductive_seconds: state.totalUnproductiveSeconds,
      tab_switch_count: state.tabSwitchCount,
      flagged_suspicious: state.flagReasons.length > 0,
      flag_reason: state.flagReasons.length > 0 ? state.flagReasons.join(',') : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,work_date' }
  );
  if (sessionError) {
    console.warn('[evolut-productivity] productivity_sessions sync failed:', sessionError.message);
    return { ok: false, reason: sessionError.message };
  }

  await markSynced();
  return { ok: true };
}

export async function syncWithRetry(state, userId, attempts = 3) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await syncState(state, userId);
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  return result;
}
