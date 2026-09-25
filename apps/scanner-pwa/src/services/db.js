import { get, set, del, keys } from 'idb-keyval';

const CREDS_KEY = 'mantaprint_pwa_credentials';
const SCANS_PREFIX = 'mantaprint_scan_';

// Request persistent storage to bypass Safari 7-day ITP
export async function ensurePersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        await navigator.storage.persist();
      }
    } catch (e) {
      console.warn('Storage persistence request failed:', e);
    }
  }
}

export async function getHubCredentials() {
  await ensurePersistentStorage();
  return (await get(CREDS_KEY)) || null;
}

export async function setHubCredentials(creds) {
  await ensurePersistentStorage();
  await set(CREDS_KEY, {
    ...creds,
    updated_at: new Date().toISOString()
  });
}

export async function clearHubCredentials() {
  await del(CREDS_KEY);
}

export async function saveOfflineScan(scanItem) {
  await ensurePersistentStorage();
  const id = scanItem.id || `scan_${Date.now()}`;
  await set(`${SCANS_PREFIX}${id}`, {
    ...scanItem,
    id,
    saved_at: new Date().toISOString()
  });
  return id;
}

export async function getOfflineScans() {
  await ensurePersistentStorage();
  const allKeys = await keys();
  const scanKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(SCANS_PREFIX));
  const scans = [];
  for (const k of scanKeys) {
    const item = await get(k);
    if (item) scans.push(item);
  }
  return scans.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
}

export async function deleteOfflineScan(id) {
  await del(`${SCANS_PREFIX}${id}`);
}
