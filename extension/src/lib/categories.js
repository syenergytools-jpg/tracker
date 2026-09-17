import { supabase } from './supabaseClient.js';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let cache = new Map();
let lastLoadedAt = 0;

export async function refreshCategories() {
  const { data, error } = await supabase.from('site_categories').select('hostname, category');
  if (error) {
    console.warn('[ams-productivity] failed to load site categories:', error.message);
    return cache;
  }
  cache = new Map(data.map((row) => [row.hostname, row.category]));
  lastLoadedAt = Date.now();
  return cache;
}

// New/unseen hostnames fall back to UNCATEGORIZED — the admin dashboard
// surfaces those for an admin to categorize (see ams-integration).
export async function getCategory(hostname) {
  if (cache.size === 0 || Date.now() - lastLoadedAt > REFRESH_INTERVAL_MS) {
    await refreshCategories();
  }
  return cache.get(hostname) ?? 'UNCATEGORIZED';
}
