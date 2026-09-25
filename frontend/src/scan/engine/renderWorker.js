/**
 * Render worker: full-resolution page rendering and KTP 2-in-1 composition
 * off the main thread, using OffscreenCanvas.
 */
import { renderToCanvas, canvasToBlob, decodeBlob, offscreenCanvasFactory } from './render.js';
import { paintAnnotations } from './annotations.js';
import {
  detectCardContour,
  cropImageBuffer,
  createKtp2in1Template
} from '../../utils/documentProcessor.js';

async function renderPage({ blob, edits, mime, quality, dpi, maxDim, annotations }) {
  const bitmap = await decodeBlob(blob);
  try {
    const canvas = renderToCanvas(bitmap, edits, { canvasFactory: offscreenCanvasFactory, maxDim });
    await paintAnnotations(canvas, annotations);
    const out = await canvasToBlob(canvas, { mime, quality, dpi });
    return { blob: out, width: canvas.width, height: canvas.height };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/** Renders a page then returns raw RGBA pixels (for the TIFF encoder). */
async function renderPixels({ blob, edits, maxDim, annotations }) {
  const bitmap = await decodeBlob(blob);
  try {
    const canvas = renderToCanvas(bitmap, edits, { canvasFactory: offscreenCanvasFactory, maxDim });
    await paintAnnotations(canvas, annotations);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data.buffer, width: canvas.width, height: canvas.height };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

function canvasImageData(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Builds the KTP 2-in-1 sheet: detects each card on its scan, crops it, tone-maps it and
 * lays both onto a white A4 canvas at `dpi`.
 */
async function ktp2in1({ front, back, dpi, autoDetect }) {
  const cards = [];
  for (const side of [front, back]) {
    const bitmap = await decodeBlob(side.blob);
    try {
      const canvas = renderToCanvas(bitmap, side.edits, { canvasFactory: offscreenCanvasFactory, maxDim: 2600 });
      let img = canvasImageData(canvas);
      if (autoDetect) {
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
  const canvas = offscreenCanvasFactory(sheet.width, sheet.height);
  const ctx = canvas.getContext('2d');
  const imgData = sheet instanceof ImageData ? sheet : new ImageData(new Uint8ClampedArray(sheet.data), sheet.width, sheet.height);
  ctx.putImageData(imgData, 0, 0);
  const blob = await canvasToBlob(canvas, { mime: 'image/jpeg', quality: 0.93, dpi });
  return { blob, width: canvas.width, height: canvas.height };
}

self.onmessage = async (ev) => {
  const { id, op, payload } = ev.data || {};
  try {
    let result;
    if (op === 'render') result = await renderPage(payload);
    else if (op === 'pixels') result = await renderPixels(payload);
    else if (op === 'ktp2in1') result = await ktp2in1(payload);
    else throw new Error(`Unknown op ${op}`);
    const transfer = result?.data instanceof ArrayBuffer ? [result.data] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
