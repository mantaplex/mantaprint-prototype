/**
 * Main-thread facade over the render worker with a same-thread fallback for
 * browsers without OffscreenCanvas / module workers.
 */
import { renderToCanvas, canvasToBlob, decodeBlob, mainThreadCanvasFactory } from './render.js';
import { paintAnnotations } from './annotations.js';
import {
  detectCardContour,
  cropImageBuffer,
  createKtp2in1Template
} from '../../utils/documentProcessor.js';

let worker = null;
let seq = 0;
const pending = new Map();
let workerBroken = false;

function supportsWorker() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && !workerBroken;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./renderWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error || 'Render failed'));
  };
  worker.onerror = (ev) => {
    console.warn('[RenderWorker] error, falling back to main thread:', ev.message);
    workerBroken = true;
    for (const [, p] of pending) p.reject(new Error('Render worker crashed'));
    pending.clear();
    try { worker.terminate(); } catch {}
    worker = null;
  };
  return worker;
}

function call(op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, op, payload });
  });
}

// --- Same-thread fallbacks ---------------------------------------------------

async function renderPageLocal({ blob, edits, mime, quality, dpi, maxDim, annotations }) {
  const bitmap = await decodeBlob(blob);
  try {
    const canvas = renderToCanvas(bitmap, edits, { canvasFactory: mainThreadCanvasFactory, maxDim });
    await paintAnnotations(canvas, annotations);
    const out = await canvasToBlob(canvas, { mime, quality, dpi });
    return { blob: out, width: canvas.width, height: canvas.height };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

async function renderPixelsLocal({ blob, edits, maxDim, annotations }) {
  const bitmap = await decodeBlob(blob);
  try {
    const canvas = renderToCanvas(bitmap, edits, { canvasFactory: mainThreadCanvasFactory, maxDim });
    await paintAnnotations(canvas, annotations);
    const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data.buffer, width: canvas.width, height: canvas.height };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

async function ktp2in1Local({ front, back, dpi, autoDetect }) {
  const cards = [];
  for (const side of [front, back]) {
    const bitmap = await decodeBlob(side.blob);
    try {
      const canvas = renderToCanvas(bitmap, side.edits, { canvasFactory: mainThreadCanvasFactory, maxDim: 2600 });
      let img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      if (autoDetect && !side.edits?.crop) {
        const contour = detectCardContour(img);
        if (contour && contour.confidence >= 0.35 && contour.width > 40 && contour.height > 25) {
          img = cropImageBuffer(img, contour);
        }
      }
      cards.push(img);
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }
  const sheet = createKtp2in1Template(cards[0], cards[1], { dpi, applyToneMapping: true, drawBorder: true });
  const canvas = mainThreadCanvasFactory(sheet.width, sheet.height);
  const ctx = canvas.getContext('2d');
  const imgData = sheet instanceof ImageData ? sheet : new ImageData(new Uint8ClampedArray(sheet.data), sheet.width, sheet.height);
  ctx.putImageData(imgData, 0, 0);
  const blob = await canvasToBlob(canvas, { mime: 'image/jpeg', quality: 0.93, dpi });
  return { blob, width: canvas.width, height: canvas.height };
}

// --- Public API --------------------------------------------------------------

/** Which page objects to paint: 'all' (exports, thumbnails), 'redactions' (OCR input) or 'none'. */
export function selectAnnotations(page, mode = 'all') {
  const list = page.annotations || [];
  if (mode === 'none' || !list.length) return [];
  if (mode === 'redactions') return list.filter((a) => a.type === 'redact');
  return list;
}

/** Full-quality render of a page to an encoded blob. */
export async function renderPageBlob(page, { mime = 'image/jpeg', quality = 0.92, maxDim = 0, annotations = 'all' } = {}) {
  const payload = { blob: page.blob, edits: page.edits, mime, quality, dpi: page.dpi || 300, maxDim: maxDim || undefined, annotations: selectAnnotations(page, annotations) };
  if (supportsWorker()) {
    try { return await call('render', payload); } catch (e) { if (!workerBroken) throw e; }
  }
  return renderPageLocal(payload);
}

/** Rendered RGBA pixels of a page (TIFF encoder input). */
export async function renderPagePixels(page, { maxDim = 0, annotations = 'all' } = {}) {
  const payload = { blob: page.blob, edits: page.edits, maxDim: maxDim || undefined, annotations: selectAnnotations(page, annotations) };
  if (supportsWorker()) {
    try { return await call('pixels', payload); } catch (e) { if (!workerBroken) throw e; }
  }
  return renderPixelsLocal(payload);
}

/** Small JPEG thumbnail used by the pages rail and the library. */
export async function renderThumbnail(page, maxDim = 320) {
  const r = await renderPageBlob(page, { mime: 'image/jpeg', quality: 0.8, maxDim });
  return r.blob;
}

/** Composes the KTP 2-in-1 sheet out of two pages. */
export async function composeKtp2in1(frontPage, backPage, { dpi = 300, autoDetect = true } = {}) {
  const payload = {
    front: { blob: frontPage.blob, edits: frontPage.edits },
    back: { blob: backPage.blob, edits: backPage.edits },
    dpi,
    autoDetect
  };
  if (supportsWorker()) {
    try { return await call('ktp2in1', payload); } catch (e) { if (!workerBroken) throw e; }
  }
  return ktp2in1Local(payload);
}
