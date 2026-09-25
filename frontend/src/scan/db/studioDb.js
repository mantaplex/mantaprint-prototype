/**
 * MantaPageScan Studio - On-device document store (IndexedDB)
 *
 * Every scanned page and every edit lives in the browser's IndexedDB on this device.
 * Nothing here talks to the hub. The hub only acquires the raw image from the USB
 * scanner and shreds it as soon as the browser has downloaded it.
 *
 * Stores:
 *   documents  { id, title, createdAt, updatedAt, pageIds[], preset, paperSize, pinned, cover, pageCount, sizeBytes }
 *   pages      { id, docId, blob, mime, width, height, dpi, source, role, edits, thumb, createdAt }
 *   settings   { key, value }
 *
 * Edits are non-destructive: the original blob is never modified, only `edits` changes.
 */

const DB_NAME = 'mantaprint_scan_studio';
const DB_VERSION = 1;
const STORE_DOCS = 'documents';
const STORE_PAGES = 'pages';
const STORE_SETTINGS = 'settings';

let dbPromise = null;
const listeners = new Set();

export const DEFAULT_EDITS = Object.freeze({
  rotation: 0,        // 0 | 90 | 180 | 270 (applied first)
  deskew: 0,          // small angle in degrees, applied after rotation
  crop: null,         // { x, y, w, h } as fractions (0..1) of the rotated+deskewed frame
  brightness: 1.0,
  contrast: 1.0,
  bgClean: 0,         // 0..100
  filter: 'none'      // 'none' | 'clean' | 'bw' | 'gray' | 'color' | 'sauvola' | 'dual_layer'
});

export function uid(prefix = 'id') {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export async function ensurePersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      if (!persisted) await navigator.storage.persist();
    }
  } catch {}
}

export async function getStorageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    }
  } catch {}
  return { usage: 0, quota: 0 };
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const docs = db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
        docs.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const pages = db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
        pages.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    try {
      const maybe = fn(t);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((r) => { result = r; }).catch(reject);
      } else {
        result = maybe;
      }
    } catch (err) {
      reject(err);
    }
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(event) {
  for (const l of listeners) {
    try { l(event); } catch (e) { console.error('[StudioDB] listener error', e); }
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listDocuments() {
  const docs = await tx(STORE_DOCS, 'readonly', (t) => reqToPromise(t.objectStore(STORE_DOCS).getAll()));
  return (docs || []).sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export async function getDocument(id) {
  return tx(STORE_DOCS, 'readonly', (t) => reqToPromise(t.objectStore(STORE_DOCS).get(id)));
}

export async function createDocument({ title, preset = 'office', paperSize = 'A4' } = {}) {
  await ensurePersistentStorage();
  const now = Date.now();
  const doc = {
    id: uid('doc'),
    title: title || defaultTitle(now),
    createdAt: now,
    updatedAt: now,
    pageIds: [],
    preset,
    paperSize,
    pinned: false,
    cover: null,
    pageCount: 0,
    sizeBytes: 0
  };
  await tx(STORE_DOCS, 'readwrite', (t) => reqToPromise(t.objectStore(STORE_DOCS).put(doc)));
  notify({ type: 'document', id: doc.id });
  return doc;
}

export function defaultTitle(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function updateDocument(id, patch) {
  const updated = await tx(STORE_DOCS, 'readwrite', async (t) => {
    const store = t.objectStore(STORE_DOCS);
    const current = await reqToPromise(store.get(id));
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    store.put(next);
    return next;
  });
  if (updated) notify({ type: 'document', id });
  return updated;
}

export async function deleteDocument(id) {
  await tx([STORE_DOCS, STORE_PAGES], 'readwrite', async (t) => {
    t.objectStore(STORE_DOCS).delete(id);
    const idx = t.objectStore(STORE_PAGES).index('docId');
    const keys = await reqToPromise(idx.getAllKeys(id));
    for (const k of keys) t.objectStore(STORE_PAGES).delete(k);
  });
  notify({ type: 'document', id, deleted: true });
}

export async function duplicateDocument(id) {
  const source = await getDocument(id);
  if (!source) return null;
  const pages = await getPagesForDocument(id);
  const now = Date.now();
  const newDoc = {
    ...source,
    id: uid('doc'),
    title: `${source.title} (copy)`,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    pageIds: []
  };
  const newPages = pages.map((p) => ({ ...p, id: uid('pg'), docId: newDoc.id }));
  newDoc.pageIds = newPages.map((p) => p.id);
  await tx([STORE_DOCS, STORE_PAGES], 'readwrite', (t) => {
    t.objectStore(STORE_DOCS).put(newDoc);
    for (const p of newPages) t.objectStore(STORE_PAGES).put(p);
  });
  notify({ type: 'document', id: newDoc.id });
  return newDoc;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function getPagesForDocument(docId) {
  const doc = await getDocument(docId);
  const pages = await tx(STORE_PAGES, 'readonly', (t) =>
    reqToPromise(t.objectStore(STORE_PAGES).index('docId').getAll(docId))
  );
  if (!doc) return pages;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ordered = doc.pageIds.map((pid) => byId.get(pid)).filter(Boolean);
  // Pages missing from the order list (should not happen) are appended.
  for (const p of pages) if (!doc.pageIds.includes(p.id)) ordered.push(p);
  return ordered;
}

export async function getPage(id) {
  return tx(STORE_PAGES, 'readonly', (t) => reqToPromise(t.objectStore(STORE_PAGES).get(id)));
}

/**
 * Adds a page to a document. `page` must carry `blob`, `mime`, `width`, `height`.
 * Returns the stored page and the updated document.
 */
export async function addPage(docId, page, { index = null } = {}) {
  const stored = {
    id: uid('pg'),
    docId,
    createdAt: Date.now(),
    source: 'import',
    role: 'normal',
    dpi: 300,
    edits: { ...DEFAULT_EDITS },
    thumb: null,
    ...page
  };
  const doc = await tx([STORE_DOCS, STORE_PAGES], 'readwrite', async (t) => {
    t.objectStore(STORE_PAGES).put(stored);
    const docs = t.objectStore(STORE_DOCS);
    const current = await reqToPromise(docs.get(docId));
    if (!current) throw new Error('Document not found');
    const pageIds = [...current.pageIds];
    if (index === null || index < 0 || index > pageIds.length) pageIds.push(stored.id);
    else pageIds.splice(index, 0, stored.id);
    const next = {
      ...current,
      pageIds,
      pageCount: pageIds.length,
      sizeBytes: (current.sizeBytes || 0) + (stored.blob?.size || 0),
      cover: current.cover || stored.thumb || null,
      updatedAt: Date.now()
    };
    docs.put(next);
    return next;
  });
  notify({ type: 'page', docId, id: stored.id });
  return { page: stored, doc };
}

export async function updatePage(id, patch) {
  const result = await tx(STORE_PAGES, 'readwrite', async (t) => {
    const store = t.objectStore(STORE_PAGES);
    const current = await reqToPromise(store.get(id));
    if (!current) return null;
    const next = { ...current, ...patch };
    store.put(next);
    return next;
  });
  if (result) {
    await touchDocument(result.docId);
    notify({ type: 'page', docId: result.docId, id });
  }
  return result;
}

/** Bulk update of several pages' edits/roles in one transaction. */
export async function updatePages(patches) {
  let docId = null;
  await tx(STORE_PAGES, 'readwrite', async (t) => {
    const store = t.objectStore(STORE_PAGES);
    for (const { id, patch } of patches) {
      const current = await reqToPromise(store.get(id));
      if (!current) continue;
      docId = current.docId;
      store.put({ ...current, ...patch });
    }
  });
  if (docId) {
    await touchDocument(docId);
    notify({ type: 'page', docId });
  }
}

export async function deletePages(docId, ids) {
  const idSet = new Set(ids);
  const doc = await tx([STORE_DOCS, STORE_PAGES], 'readwrite', async (t) => {
    const pages = t.objectStore(STORE_PAGES);
    let removedBytes = 0;
    for (const id of ids) {
      const p = await reqToPromise(pages.get(id));
      if (p) removedBytes += p.blob?.size || 0;
      pages.delete(id);
    }
    const docs = t.objectStore(STORE_DOCS);
    const current = await reqToPromise(docs.get(docId));
    if (!current) return null;
    const pageIds = current.pageIds.filter((pid) => !idSet.has(pid));
    const next = {
      ...current,
      pageIds,
      pageCount: pageIds.length,
      sizeBytes: Math.max(0, (current.sizeBytes || 0) - removedBytes),
      updatedAt: Date.now()
    };
    docs.put(next);
    return next;
  });
  await refreshCover(docId);
  notify({ type: 'page', docId });
  return doc;
}

export async function reorderPages(docId, pageIds) {
  const doc = await updateDocument(docId, { pageIds: [...pageIds], pageCount: pageIds.length });
  await refreshCover(docId);
  return doc;
}

export async function duplicatePage(docId, pageId) {
  const src = await getPage(pageId);
  if (!src) return null;
  const doc = await getDocument(docId);
  const idx = doc ? doc.pageIds.indexOf(pageId) : -1;
  const copy = { ...src, id: undefined, createdAt: undefined };
  delete copy.id;
  delete copy.createdAt;
  return addPage(docId, copy, { index: idx >= 0 ? idx + 1 : null });
}

async function touchDocument(docId) {
  await tx(STORE_DOCS, 'readwrite', async (t) => {
    const store = t.objectStore(STORE_DOCS);
    const current = await reqToPromise(store.get(docId));
    if (current) store.put({ ...current, updatedAt: Date.now() });
  });
}

/** Keeps the document cover in sync with its first page thumbnail. */
export async function refreshCover(docId) {
  const doc = await getDocument(docId);
  if (!doc) return;
  const firstId = doc.pageIds[0];
  const first = firstId ? await getPage(firstId) : null;
  const cover = first?.thumb || null;
  if (cover !== doc.cover) {
    await tx(STORE_DOCS, 'readwrite', (t) => t.objectStore(STORE_DOCS).put({ ...doc, cover }));
    notify({ type: 'document', id: docId });
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting(key, fallback = null) {
  try {
    const row = await tx(STORE_SETTINGS, 'readonly', (t) => reqToPromise(t.objectStore(STORE_SETTINGS).get(key)));
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  try {
    await tx(STORE_SETTINGS, 'readwrite', (t) => t.objectStore(STORE_SETTINGS).put({ key, value }));
  } catch {}
}

export async function clearAllDocuments() {
  await tx([STORE_DOCS, STORE_PAGES], 'readwrite', (t) => {
    t.objectStore(STORE_DOCS).clear();
    t.objectStore(STORE_PAGES).clear();
  });
  notify({ type: 'document', cleared: true });
}
