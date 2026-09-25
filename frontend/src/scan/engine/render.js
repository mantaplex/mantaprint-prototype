/**
 * MantaPageScan Studio - Page render pipeline
 *
 * Turns an original page bitmap plus its non-destructive `edits` into a rendered canvas
 * or an encoded blob. The same function runs on the main thread (stage preview, thumbnails)
 * and inside the render worker (export at full resolution), so it never touches `document`
 * directly: a canvas factory is passed in.
 *
 * Order of operations (the crop rectangle is expressed in the frame the user sees, i.e.
 * after rotation and deskew):
 *   1. rotate by 0/90/180/270
 *   2. deskew by a small angle
 *   3. crop (fractions of the rotated frame)
 *   4. tone filters (brightness, contrast, filter mode via ctx.filter)
 *   5. pixel post-processing (paper whitening, dual-layer stamp preservation)
 */

import {
  buildImageFilterString,
  applySoftKneePaperWhitening,
  processDualLayerColorPreservation,
  injectJpegDpi,
  injectPngDpi
} from '../../utils/documentProcessor.js';
import { DEFAULT_EDITS } from '../db/studioDb.js';

export function normalizeEdits(edits) {
  return { ...DEFAULT_EDITS, ...(edits || {}) };
}

/** Size of the frame after rotation (before crop). */
export function rotatedSize(width, height, rotation) {
  const r = ((rotation % 360) + 360) % 360;
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/** Size of the final rendered output for a page and its edits. */
export function outputSize(width, height, edits) {
  const e = normalizeEdits(edits);
  const rot = rotatedSize(width, height, e.rotation);
  if (!e.crop) return rot;
  return {
    width: Math.max(1, Math.round(rot.width * e.crop.w)),
    height: Math.max(1, Math.round(rot.height * e.crop.h))
  };
}

/** Re-expresses a crop rectangle when the page is rotated by +90 or -90 degrees. */
export function rotateCropRect(crop, deltaDeg) {
  if (!crop) return null;
  const d = ((deltaDeg % 360) + 360) % 360;
  const { x, y, w, h } = crop;
  if (d === 90) return { x: 1 - y - h, y: x, w: h, h: w };
  if (d === 270) return { x: y, y: 1 - x - w, w: h, h: w };
  if (d === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  return crop;
}

function makeCanvas(factory, w, h) {
  const c = factory(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas: c, ctx };
}

/**
 * Renders `source` (ImageBitmap | HTMLImageElement | canvas) with `edits`.
 * @param {*} source            drawable with .width/.height
 * @param {object} edits
 * @param {object} options      { canvasFactory, maxDim, skipPixelPasses }
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function renderToCanvas(source, edits, options = {}) {
  const e = normalizeEdits(edits);
  const factory = options.canvasFactory;
  if (!factory) throw new Error('renderToCanvas needs a canvasFactory');

  const srcW = source.width;
  const srcH = source.height;
  const rot = rotatedSize(srcW, srcH, e.rotation);

  // Scale so the rotated frame fits maxDim (preview) or stays 1:1 (export).
  let scale = 1;
  if (options.maxDim) {
    scale = Math.min(1, options.maxDim / Math.max(rot.width, rot.height));
  }
  const frameW = Math.max(1, Math.round(rot.width * scale));
  const frameH = Math.max(1, Math.round(rot.height * scale));

  // Step 1+2: rotate & deskew into the frame canvas
  const { canvas: frame, ctx: fctx } = makeCanvas(factory, frameW, frameH);
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, frameW, frameH);
  fctx.save();
  fctx.translate(frameW / 2, frameH / 2);
  fctx.rotate(((e.rotation + e.deskew) * Math.PI) / 180);
  fctx.scale(scale, scale);
  fctx.drawImage(source, -srcW / 2, -srcH / 2);
  fctx.restore();

  // Step 3: crop
  let cropX = 0;
  let cropY = 0;
  let outW = frameW;
  let outH = frameH;
  if (e.crop) {
    cropX = Math.round(e.crop.x * frameW);
    cropY = Math.round(e.crop.y * frameH);
    outW = Math.max(1, Math.round(e.crop.w * frameW));
    outH = Math.max(1, Math.round(e.crop.h * frameH));
  }

  // Step 4: tone filters
  const { canvas: out, ctx } = makeCanvas(factory, outW, outH);
  const filterStr = buildImageFilterString({
    brightness: e.brightness,
    contrast: e.contrast,
    bgClean: e.bgClean,
    filter: e.filter
  });
  if ('filter' in ctx) ctx.filter = filterStr;
  ctx.drawImage(frame, cropX, cropY, outW, outH, 0, 0, outW, outH);
  if ('filter' in ctx) ctx.filter = 'none';

  // Step 5: pixel passes
  if (!options.skipPixelPasses) {
    if (e.filter === 'clean' && e.bgClean > 25) {
      const imgData = ctx.getImageData(0, 0, outW, outH);
      applySoftKneePaperWhitening(imgData, e.bgClean);
      ctx.putImageData(imgData, 0, 0);
    } else if (e.filter === 'dual_layer') {
      const imgData = ctx.getImageData(0, 0, outW, outH);
      const processed = processDualLayerColorPreservation(imgData, { saturationThreshold: 0.2 });
      ctx.putImageData(toImageDataCompat(processed, ctx), 0, 0);
    }
  }
  return out;
}

function toImageDataCompat(buf, ctx) {
  if (typeof ImageData !== 'undefined' && buf instanceof ImageData) return buf;
  const img = ctx.createImageData(buf.width, buf.height);
  img.data.set(buf.data);
  return img;
}

/** Encodes a canvas to a blob, tagging JPEG/PNG with physical DPI. */
export async function canvasToBlob(canvas, { mime = 'image/jpeg', quality = 0.92, dpi = 300 } = {}) {
  let blob;
  if (typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type: mime, quality });
  } else {
    blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality);
    });
  }
  try {
    const buf = await blob.arrayBuffer();
    if (mime === 'image/jpeg') return new Blob([injectJpegDpi(buf, dpi)], { type: mime });
    if (mime === 'image/png') return new Blob([injectPngDpi(buf, dpi)], { type: mime });
  } catch {}
  return blob;
}

/** Decodes a blob into an ImageBitmap (works on both threads). */
export async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {}
  }
  if (typeof document === 'undefined') throw new Error('Cannot decode image in this context');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function mainThreadCanvasFactory(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function offscreenCanvasFactory(w, h) {
  return new OffscreenCanvas(w, h);
}
