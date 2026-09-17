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
    storageKey: 'ams-productivity-auth',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// supabase-js normally schedules its own refresh via an in-memory timer,
// which does not survive an MV3 service worker being killed. Call this
// before any authenticated request from the background script instead of
// trusting the timer.
export async function ensureFreshSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const nowSec = Date.now() / 1000;
  const expiresAt = session.expires_at ?? 0;
  if (expiresAt - nowSec > 60) return session;

  const { data, error } = await supabase.auth.refreshSession();
  if (error) {
    console.warn('[ams-productivity] session refresh failed:', error.message);
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
