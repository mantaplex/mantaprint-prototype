// Copies the OCR engine (tesseract.js worker + WebAssembly core) and the Indonesian and
// English language data into public/ocr/<version>/, so the hub serves everything itself
// and OCR works on networks without internet access.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = require('tesseract.js/package.json').version;
const out = path.join(root, 'public', 'ocr', version);
const tjs = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));

const files = [
  [path.join(tjs, 'dist', 'worker.min.js'), 'worker.min.js'],
  [path.join(core, 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [path.join(core, 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  [require.resolve('@tesseract.js-data/ind/4.0.0_best_int/ind.traineddata.gz'), 'lang/ind.traineddata.gz'],
  [require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), 'lang/eng.traineddata.gz']
];

fs.rmSync(path.join(root, 'public', 'ocr'), { recursive: true, force: true });
for (const [src, rel] of files) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
fs.writeFileSync(path.join(root, 'src', 'scan', 'engine', 'ocrVersion.js'), `export const OCR_ASSET_BASE = '/ocr/${version}';\n`);
console.log(`[ocr] assets copied to public/ocr/${version}`);
