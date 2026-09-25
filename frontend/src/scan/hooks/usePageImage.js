/**
 * Page bitmaps for the continuous view. Pages are rendered in the render worker (without
 * page objects, which the view draws live) at a size bucket that matches the zoom, so
 * zooming in sharpens a page once instead of re-rendering on every step. Until the render
 * is ready, the page's thumbnail stands in.
 */
import { useEffect, useState } from 'react';
import { renderPageBlob } from '../engine/renderClient.js';

const BUCKETS = [700, 1200, 1800, 2600, 3600];
const MAX_ENTRIES = 20;
const cache = new Map(); // key -> { url }
const inflight = new Map(); // key -> Promise<url>

function editsKey(edits) {
  const e = edits || {};
  return JSON.stringify([e.rotation, e.deskew, e.crop, e.brightness, e.contrast, e.bgClean, e.filter]);
}

export function bucketFor(neededLongSide, maxLongSide) {
  const need = Math.min(neededLongSide, maxLongSide);
  const b = BUCKETS.find((x) => x >= need) || BUCKETS[BUCKETS.length - 1];
  return Math.min(b, maxLongSide);
}

function remember(key, url) {
  cache.set(key, { url });
  while (cache.size > MAX_ENTRIES) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    // Give any <img> still showing it time to swap to its new source.
    setTimeout(() => URL.revokeObjectURL(old.url), 4000);
  }
}

function load(record, bucket) {
  const key = `${record.id}|${editsKey(record.edits)}|${bucket}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // LRU bump
    return Promise.resolve(hit.url);
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = renderPageBlob(record, { mime: 'image/jpeg', quality: 0.88, maxDim: bucket, annotations: 'none' })
    .then(({ blob }) => {
      const url = URL.createObjectURL(blob);
      remember(key, url);
      return url;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * @param record        full page record (blob, edits, width, height)
 * @param neededLongSide device pixels needed for the page's long side at the current zoom
 * @param active        only render while the page is near the viewport
 */
export function usePageImage(record, neededLongSide, active) {
  const [url, setUrl] = useState(null);
  const maxLong = Math.max(record?.width || 0, record?.height || 0) || 1;
  const bucket = bucketFor(Math.ceil(neededLongSide || 0), maxLong);
  const key = record ? `${record.id}|${editsKey(record.edits)}|${bucket}` : '';

  useEffect(() => {
    if (!record || !active) return undefined;
    let cancelled = false;
    // Debounce so a zoom gesture only renders the size it ends on.
    const t = setTimeout(() => {
      load(record, bucket).then((u) => { if (!cancelled) setUrl(u); }).catch((e) => console.warn('[view] page render failed', e));
    }, cache.has(key) ? 0 : 160);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return url;
}
