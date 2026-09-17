// supabase-js's default storage adapter is `localStorage`, which doesn't
// exist in an MV3 service worker. chrome.storage.local is the replacement —
// it's async and survives the service worker being killed/restarted.
export const chromeStorageAdapter = {
  async getItem(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};
