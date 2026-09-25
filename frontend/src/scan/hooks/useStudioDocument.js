/**
 * Loads one document with its pages from IndexedDB and exposes mutations that
 * autosave, keep thumbnails fresh and feed an undo/redo history.
 *
 * Deleting a page only removes it from the document's order (so it can be undone);
 * pages no longer referenced are purged when the document is closed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as db from '../db/studioDb.js';
import { renderThumbnail } from '../engine/renderClient.js';
import { decodeBlob } from '../engine/render.js';
import { rotateCropRect } from '../engine/render.js';
import { remapAnnotations } from '../engine/annotations.js';

function layoutChanged(a, b) {
  const ca = a?.crop || null; const cb = b?.crop || null;
  const sameCrop = (!ca && !cb) || (ca && cb && ca.x === cb.x && ca.y === cb.y && ca.w === cb.w && ca.h === cb.h);
  return (a?.rotation || 0) !== (b?.rotation || 0) || !sameCrop;
}

const HISTORY_LIMIT = 60;

function snapshotOf(doc, pages) {
  const byId = {};
  for (const p of pages) byId[p.id] = { edits: { ...p.edits }, role: p.role, annotations: p.annotations || [] };
  return { pageIds: [...doc.pageIds], byId };
}

export function useStudioDocument(docId) {
  const [doc, setDocState] = useState(null);
  // Latest document, readable synchronously (history snapshots must not wait for a render).
  const docRef = useRef(null);
  const setDoc = useCallback((next) => { docRef.current = next; setDocState(next); }, []);
  const [pages, setPages] = useState([]); // ordered, each with thumbUrl
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('saved'); // 'saved' | 'saving' | 'error'
  const [history, setHistory] = useState({ past: [], future: [] });

  const urlCache = useRef(new Map()); // pageId -> { blob, url }
  const thumbTimers = useRef(new Map());
  const editTimers = useRef(new Map());
  const allPagesRef = useRef(new Map()); // pageId -> page record (incl. unreferenced)

  const urlFor = useCallback((pageId, blob) => {
    if (!blob) return null;
    const cached = urlCache.current.get(pageId);
    if (cached && cached.blob === blob) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(blob);
    urlCache.current.set(pageId, { blob, url });
    return url;
  }, []);

  const decorate = useCallback((p) => ({ ...p, thumbUrl: urlFor(p.id, p.thumb) }), [urlFor]);

  const applyOrder = useCallback((d) => {
    const ordered = d.pageIds.map((id) => allPagesRef.current.get(id)).filter(Boolean).map(decorate);
    setPages(ordered);
  }, [decorate]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const d = await db.getDocument(docId);
      if (!d) { if (!cancelled) { setDoc(null); setLoading(false); } return; }
      const list = await db.getPagesForDocument(docId);
      if (cancelled) return;
      allPagesRef.current = new Map(list.map((p) => [p.id, p]));
      setDoc(d);
      applyOrder(d);
      setHistory({ past: [], future: [] });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [docId, applyOrder]);

  // Cleanup: revoke URLs and purge unreferenced pages
  useEffect(() => {
    const cache = urlCache.current;
    return () => {
      for (const { url } of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
      (async () => {
        const d = await db.getDocument(docId);
        if (!d) return;
        const all = await db.getPagesForDocument(docId);
        const orphan = all.filter((p) => !d.pageIds.includes(p.id)).map((p) => p.id);
        if (orphan.length) {
          // deletePages() also updates counts; the ids are already absent from pageIds
          await db.deletePages(docId, orphan);
        }
      })();
    };
  }, [docId]);

  // Snapshot taken now, from refs, so it records the state before the change that follows.
  const pushHistory = useCallback(() => {
    const d = docRef.current;
    if (!d) return;
    const snap = snapshotOf(d, [...allPagesRef.current.values()]);
    setHistory((h) => ({ past: [...h.past.slice(-HISTORY_LIMIT + 1), snap], future: [] }));
  }, []);

  const persist = useCallback(async (fn) => {
    setSaveState('saving');
    try {
      await fn();
      setSaveState('saved');
    } catch (err) {
      console.error('[Studio] save failed', err);
      setSaveState('error');
    }
  }, []);

  const scheduleThumb = useCallback((pageId) => {
    const timers = thumbTimers.current;
    if (timers.has(pageId)) clearTimeout(timers.get(pageId));
    timers.set(pageId, setTimeout(async () => {
      timers.delete(pageId);
      const p = allPagesRef.current.get(pageId);
      if (!p) return;
      try {
        const thumb = await renderThumbnail(p, 360);
        const next = { ...p, thumb };
        allPagesRef.current.set(pageId, next);
        await db.updatePage(pageId, { thumb });
        setPages((prev) => prev.map((x) => (x.id === pageId ? decorate(next) : x)));
        const d = await db.getDocument(docId);
        if (d && d.pageIds[0] === pageId) await db.refreshCover(docId);
      } catch (e) {
        console.warn('[Studio] thumbnail failed', e);
      }
    }, 450));
  }, [decorate, docId]);

  // ---- Mutations ------------------------------------------------------------

  const addPagesFromBlobs = useCallback(async (items, { source = 'import', index = null } = {}) => {
    if (!doc) return [];
    pushHistory();
    const added = [];
    let insertAt = index;
    for (const item of items) {
      const blob = item.blob;
      let width = item.width || 0;
      let height = item.height || 0;
      if (!width || !height) {
        try {
          const bmp = await decodeBlob(blob);
          width = bmp.width; height = bmp.height;
          if (bmp.close) bmp.close();
        } catch { width = 0; height = 0; }
      }
      const base = {
        blob, mime: blob.type || 'image/jpeg', width, height,
        dpi: item.dpi || 300, source, role: item.role || 'normal',
        edits: { ...db.DEFAULT_EDITS, ...(item.edits || {}) },
        thumb: null,
        name: item.name || ''
      };
      try {
        base.thumb = await renderThumbnail(base, 360);
      } catch {}
      const { page, doc: nextDoc } = await db.addPage(doc.id, base, { index: insertAt });
      allPagesRef.current.set(page.id, page);
      added.push(page);
      setDoc(nextDoc);
      applyOrder(nextDoc);
      if (insertAt !== null) insertAt += 1;
    }
    if (added.length && !doc.cover) await db.refreshCover(doc.id);
    setSaveState('saved');
    return added;
  }, [doc, pushHistory, applyOrder]);

  const updateEdits = useCallback((pageId, patch, { record = true } = {}) => {
    const p = allPagesRef.current.get(pageId);
    if (!p) return;
    if (record) pushHistory();
    const edits = { ...p.edits, ...patch };
    const next = { ...p, edits };
    const moved = layoutChanged(p.edits, edits) && p.annotations?.length;
    if (moved) next.annotations = remapAnnotations(p.annotations, p.width, p.height, p.edits, edits);
    allPagesRef.current.set(pageId, next);
    setPages((prev) => prev.map((x) => (x.id === pageId ? decorate(next) : x)));
    const timers = editTimers.current;
    if (timers.has(pageId)) clearTimeout(timers.get(pageId));
    timers.set(pageId, setTimeout(() => {
      timers.delete(pageId);
      const cur = allPagesRef.current.get(pageId);
      persist(() => db.updatePage(pageId, { edits: cur?.edits || edits, annotations: cur?.annotations || [] }));
      scheduleThumb(pageId);
    }, 300));
  }, [pushHistory, decorate, persist, scheduleThumb]);

  const rotatePages = useCallback((pageIds, delta) => {
    pushHistory();
    const patches = [];
    for (const id of pageIds) {
      const p = allPagesRef.current.get(id);
      if (!p) continue;
      const rotation = (((p.edits.rotation || 0) + delta) % 360 + 360) % 360;
      const crop = rotateCropRect(p.edits.crop, delta);
      const edits = { ...p.edits, rotation, crop };
      const annotations = remapAnnotations(p.annotations || [], p.width, p.height, p.edits, edits);
      const next = { ...p, edits, annotations };
      allPagesRef.current.set(id, next);
      patches.push({ id, patch: { edits, annotations } });
      scheduleThumb(id);
    }
    setPages((prev) => prev.map((x) => (patches.some((q) => q.id === x.id) ? decorate(allPagesRef.current.get(x.id)) : x)));
    persist(() => db.updatePages(patches));
  }, [pushHistory, decorate, persist, scheduleThumb]);

  const setRole = useCallback((pageId, role) => {
    const p = allPagesRef.current.get(pageId);
    if (!p) return;
    pushHistory();
    const next = { ...p, role };
    allPagesRef.current.set(pageId, next);
    setPages((prev) => prev.map((x) => (x.id === pageId ? decorate(next) : x)));
    persist(() => db.updatePage(pageId, { role }));
  }, [pushHistory, decorate, persist]);

  const reorder = useCallback((pageIds) => {
    if (!doc) return;
    pushHistory();
    const next = { ...doc, pageIds: [...pageIds], pageCount: pageIds.length };
    setDoc(next);
    applyOrder(next);
    persist(() => db.reorderPages(doc.id, pageIds));
  }, [doc, pushHistory, applyOrder, persist]);

  const removePages = useCallback((ids) => {
    if (!doc) return;
    const set = new Set(ids);
    reorder(doc.pageIds.filter((id) => !set.has(id)));
  }, [doc, reorder]);

  const duplicate = useCallback(async (pageId) => {
    if (!doc) return null;
    pushHistory();
    const res = await db.duplicatePage(doc.id, pageId);
    if (!res) return null;
    allPagesRef.current.set(res.page.id, res.page);
    setDoc(res.doc);
    applyOrder(res.doc);
    return res.page;
  }, [doc, pushHistory, applyOrder]);

  const rename = useCallback((title) => {
    if (!doc) return;
    const next = { ...doc, title };
    setDoc(next);
    persist(() => db.updateDocument(doc.id, { title }));
  }, [doc, persist]);

  const patchDoc = useCallback((patch) => {
    if (!doc) return;
    const next = { ...doc, ...patch };
    setDoc(next);
    persist(() => db.updateDocument(doc.id, patch));
  }, [doc, persist]);

  const restore = useCallback((snap) => {
    const doc = docRef.current;
    if (!doc) return;
    const patches = [];
    for (const [id, s] of Object.entries(snap.byId)) {
      const p = allPagesRef.current.get(id);
      if (!p) continue;
      const next = { ...p, edits: { ...s.edits }, role: s.role, annotations: s.annotations || [] };
      allPagesRef.current.set(id, next);
      patches.push({ id, patch: { edits: next.edits, role: s.role, annotations: next.annotations } });
      scheduleThumb(id);
    }
    const nextDoc = { ...doc, pageIds: [...snap.pageIds], pageCount: snap.pageIds.length };
    setDoc(nextDoc);
    applyOrder(nextDoc);
    persist(async () => {
      await db.updatePages(patches);
      await db.reorderPages(doc.id, snap.pageIds);
    });
  }, [applyOrder, persist, scheduleThumb]);

  const undo = useCallback(() => {
    const d = docRef.current;
    if (!d || history.past.length === 0) return;
    const current = snapshotOf(d, [...allPagesRef.current.values()]);
    const prev = history.past[history.past.length - 1];
    setHistory((h) => ({ past: h.past.slice(0, -1), future: [current, ...h.future] }));
    restore(prev);
  }, [history, restore]);

  const redo = useCallback(() => {
    const d = docRef.current;
    if (!d || history.future.length === 0) return;
    const current = snapshotOf(d, [...allPagesRef.current.values()]);
    const next = history.future[0];
    setHistory((h) => ({ past: [...h.past, current], future: h.future.slice(1) }));
    restore(next);
  }, [history, restore]);

  const getPageRecord = useCallback((id) => allPagesRef.current.get(id) || null, []);

  // ---- Page objects -----------------------------------------------------------
  const annTimers = useRef(new Map());
  const setAnnotations = useCallback((pageId, updater, { record = true } = {}) => {
    const p = allPagesRef.current.get(pageId);
    if (!p) return;
    if (record) pushHistory();
    const cur = p.annotations || [];
    const annotations = typeof updater === 'function' ? updater(cur) : updater;
    const next = { ...p, annotations };
    allPagesRef.current.set(pageId, next);
    setPages((prev) => prev.map((x) => (x.id === pageId ? decorate(next) : x)));
    const timers = annTimers.current;
    if (timers.has(pageId)) clearTimeout(timers.get(pageId));
    setSaveState('saving');
    timers.set(pageId, setTimeout(() => {
      timers.delete(pageId);
      persist(() => db.updatePage(pageId, { annotations: allPagesRef.current.get(pageId)?.annotations || [] }));
      scheduleThumb(pageId);
    }, 250));
  }, [pushHistory, decorate, persist, scheduleThumb]);

  const addAnnotation = useCallback((pageId, ann) => {
    setAnnotations(pageId, (list) => [...list, ann]);
  }, [setAnnotations]);

  const updateAnnotation = useCallback((pageId, id, patch, opts) => {
    setAnnotations(pageId, (list) => list.map((a) => (a.id === id ? (typeof patch === 'function' ? patch(a) : { ...a, ...patch }) : a)), opts);
  }, [setAnnotations]);

  const removeAnnotation = useCallback((pageId, id) => {
    setAnnotations(pageId, (list) => list.filter((a) => a.id !== id));
  }, [setAnnotations]);

  /** Starts a history step without changing anything (drag gestures then update with record:false). */
  const beginChange = useCallback(() => pushHistory(), [pushHistory]);

  // ---- OCR results (not part of undo history) -------------------------------
  const setOcr = useCallback((pageId, ocr) => {
    const p = allPagesRef.current.get(pageId);
    if (!p) return;
    const next = { ...p, ocr };
    allPagesRef.current.set(pageId, next);
    setPages((prev) => prev.map((x) => (x.id === pageId ? decorate(next) : x)));
    persist(() => db.updatePage(pageId, { ocr }));
  }, [decorate, persist]);

  return useMemo(() => ({
    doc, pages, loading, saveState,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    addPagesFromBlobs, updateEdits, rotatePages, setRole, reorder, removePages, duplicate,
    rename, patchDoc, undo, redo, getPageRecord,
    setAnnotations, addAnnotation, updateAnnotation, removeAnnotation, beginChange, setOcr
  }), [doc, pages, loading, saveState, history, addPagesFromBlobs, updateEdits, rotatePages, setRole,
    reorder, removePages, duplicate, rename, patchDoc, undo, redo, getPageRecord,
    setAnnotations, addAnnotation, updateAnnotation, removeAnnotation, beginChange, setOcr]);
}
