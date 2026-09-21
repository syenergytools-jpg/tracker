import { createClient } from '@supabase/supabase-js';
import { chromeStorageAdapter } from './chromeStorageAdapter.js';

// Same Supabase project + env var names as the AMS (see .env.example),
// inlined at build time by esbuild's `define` — a service worker has no
// process.env at runtime.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeStorageAdapter,
    storageKey: 'evolut-productivity-auth',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// supabase-js normally schedules its own refresh via an in-memory timer,
// which does not survive an MV3 service worker being killed. Call this
// before any authenticated request from the background script instead of
// trusting the timer.
let refreshInFlight = null;

export async function ensureFreshSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const nowSec = Date.now() / 1000;
  const expiresAt = session.expires_at ?? 0;
  if (expiresAt - nowSec > 60) return session;

  // This gets called from both the popup's status polling (every ~3s while
  // open) and the background sync alarm (every 3 minutes) — if both land
  // near the token's expiry at the same time, two concurrent calls to
  // refreshSession() would race on the same refresh token. Supabase's
  // rotation treats a reused refresh token as possible theft and
  // invalidates the whole session as a precaution, which presents as an
  // unexplained forced logout. De-duplicating into a single in-flight
  // promise means every near-simultaneous caller shares one outcome
  // instead of racing.
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth.refreshSession().finally(() => {
      refreshInFlight = null;
    });
  }

  const { data, error } = await refreshInFlight;
  if (error) {
    console.warn('[evolut-productivity] session refresh failed:', error.message);
    return null;
  }
  return data.session;
}

export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}
