const { createClient } = require('@supabase/supabase-js');
const { fileStorageAdapter } = require('./fileStorageAdapter');

// Same Supabase project + env var names as the extension and the AMS.
// Unlike the extension (a service worker with no process.env at runtime),
// this is a normal Node process — dotenv loads .env directly, no build-time
// inlining needed.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: fileStorageAdapter,
    storageKey: 'evolut-productivity-agent-auth',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Same reasoning as the extension's ensureFreshSession: de-duplicate
// concurrent refresh attempts (the popup window's status polling and the
// main process's own periodic sync could both notice the token is stale at
// nearly the same moment) into one in-flight call, since two independent
// refreshSession() calls racing on the same refresh token can trip
// Supabase's reuse detection and invalidate the whole session.
let refreshInFlight = null;

async function ensureFreshSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  const nowSec = Date.now() / 1000;
  const expiresAt = session.expires_at ?? 0;
  if (expiresAt - nowSec > 60) return session;

  if (!refreshInFlight) {
    refreshInFlight = supabase.auth.refreshSession().finally(() => {
      refreshInFlight = null;
    });
  }

  const { data, error } = await refreshInFlight;
  if (error) {
    console.warn('[evolut-productivity-agent] session refresh failed:', error.message);
    return null;
  }
  return data.session;
}

async function fetchProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('id, role').eq('id', userId).single();
  if (error) throw error;
  return data;
}

module.exports = { supabase, ensureFreshSession, fetchProfile };
