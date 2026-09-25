/**
 * MantaPageScan Studio - on-device OCR (tesseract.js, WebAssembly, in a Web Worker)
 *
 * The engine and the Indonesian/English language data are served by the hub itself
 * (see scripts/copy-ocr-assets.mjs), so OCR works without internet access and no page ever
 * leaves the browser. One worker is shared; jobs run one at a time so a 4 GB Chromebook is
 * never asked to hold two recognizers, and the worker is shut down after a minute idle.
 *
 * Results are stored per page as `page.ocr` in page fractions (like page objects):
 *   { status: 'done', lang, key, at, text, words: [{ t, x, y, w, h, c, l }], lines: [{ t, p }] }
 * `key` fingerprints the page geometry; when rotation/deskew/crop change, the result is stale.
 */

import { createWorker, OEM } from 'tesseract.js';
import { simd } from 'wasm-feature-detect';
import { OCR_ASSET_BASE } from './ocrVersion.js';
import { renderPageBlob } from './renderClient.js';
import { ocrGeometryKey, toPageResult } from './ocrText.js';

export { ocrGeometryKey, ocrState, toPageResult, linesToText } from './ocrText.js';

export const OCR_LANGS = ['ind+eng', 'ind', 'eng'];
export const DEFAULT_OCR_LANG = 'ind+eng';
const OCR_MAX_DIM = 2800; // ~240 DPI on A4: good accuracy, bounded memory and time
const IDLE_MS = 60000;

let workerPromise = null;
let workerLang = null;
let idleTimer = null;
let queue = Promise.resolve();
let activeLogger = null;

export function ocrSupported() {
  return typeof WebAssembly === 'object' && typeof Worker !== 'undefined';
}

const abs = (p) => new URL(p, typeof location !== 'undefined' ? location.origin : 'http://localhost').href;

async function getWorker(lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    const old = workerPromise;
    workerPromise = null;
    try { (await old).terminate(); } catch {}
  }
  workerLang = lang;
  const coreFile = (await simd()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  workerPromise = createWorker(lang.split('+'), OEM.LSTM_ONLY, {
    workerPath: abs(`${OCR_ASSET_BASE}/worker.min.js`),
    corePath: abs(`${OCR_ASSET_BASE}/${coreFile}`),
    langPath: abs(`${OCR_ASSET_BASE}/lang`),
    gzip: true,
    workerBlobURL: false,
    logger: (m) => activeLogger?.(m)
  }).then(async (w) => {
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  }).catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    if (p) { try { (await p).terminate(); } catch {} }
  }, IDLE_MS);
}

/**
 * Recognizes one page (a page record, or a function returning it). Jobs are serialized.
 * `onProgress(0..1, status)`.
 * @returns {Promise<object>} the `page.ocr` record
 */
export function ocrPage(pageOrGetter, { lang = DEFAULT_OCR_LANG, onProgress } = {}) {
  const job = queue.then(async () => {
    clearTimeout(idleTimer);
    // A getter lets a queued job see the page as it is when its turn comes.
    const page = typeof pageOrGetter === 'function' ? pageOrGetter() : pageOrGetter;
    if (!page) throw new Error('Page no longer exists');
    onProgress?.(0.02, 'render');
    // Redactions are burned in first so text under them is never recognized.
    const rendered = await renderPageBlob(page, { mime: 'image/jpeg', quality: 0.92, maxDim: OCR_MAX_DIM, annotations: 'redactions' });
    activeLogger = (m) => {
      if (!onProgress) return;
      if (m.status === 'recognizing text') onProgress(0.15 + 0.85 * (m.progress || 0), 'recognize');
      else onProgress(0.05 + 0.1 * (m.progress || 0), 'load');
    };
    try {
      const worker = await getWorker(lang);
      const { data } = await worker.recognize(rendered.blob, {}, { text: true, blocks: true });
      const res = toPageResult(data, rendered.width, rendered.height);
      onProgress?.(1, 'done');
      return { status: 'done', lang, key: ocrGeometryKey(page.edits), at: Date.now(), ...res };
    } finally {
      activeLogger = null;
      scheduleIdle();
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Stops the engine now (frees its memory). */
export async function shutdownOcr() {
  clearTimeout(idleTimer);
  const p = workerPromise;
  workerPromise = null;
  if (p) { try { (await p).terminate(); } catch {} }
}
