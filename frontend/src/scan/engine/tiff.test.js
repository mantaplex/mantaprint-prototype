import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMultiPageTiff } from './tiff.js';
import { createZip } from './zip.js';

/** Reference TIFF LZW decoder (libtiff semantics) used to verify the encoder. */
function lzwDecode(bytes, expectedLen) {
  const out = new Uint8Array(expectedLen);
  let o = 0;
  let bitPos = 0;
  const readCode = (bits) => {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = bytes[bitPos >> 3];
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      v = (v << 1) | bit;
      bitPos++;
    }
    return v;
  };
  let table = [];
  const reset = () => { table = []; for (let i = 0; i < 256; i++) table.push([i]); table.push(null, null); };
  let bits = 9;
  let prev = null;
  reset();
  while (bitPos + bits <= bytes.length * 8) {
    const code = readCode(bits);
    if (code === 256) { reset(); bits = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < table.length) {
      entry = table[code];
    } else if (prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error('bad code');
    }
    for (const b of entry) out[o++] = b;
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    if (table.length + 1 >= (1 << bits) && bits < 12) bits++;
  }
  assert.equal(o, expectedLen, 'decoded length');
  return out;
}

function readIfd(dv, off) {
  const n = dv.getUint16(off, true);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const b = off + 2 + i * 12;
    const tag = dv.getUint16(b, true);
    const type = dv.getUint16(b + 2, true);
    const count = dv.getUint32(b + 4, true);
    const val = type === 3 && count === 1 ? dv.getUint16(b + 8, true) : dv.getUint32(b + 8, true);
    tags[tag] = { type, count, val };
  }
  return { tags, next: dv.getUint32(off + 2 + n * 12, true) };
}

test('multi-page TIFF: valid IFD chain, LZW strips round-trip (RGB + gray)', async () => {
  const w = 37, h = 11;
  const rgb = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgb[i * 4] = (i * 7) & 255; rgb[i * 4 + 1] = (i * 3) & 255; rgb[i * 4 + 2] = 200; rgb[i * 4 + 3] = 255; }
  const gray = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = i % 2 ? 255 : 0; gray[i * 4] = v; gray[i * 4 + 1] = v; gray[i * 4 + 2] = v; gray[i * 4 + 3] = 255; }

  const blob = encodeMultiPageTiff([{ data: rgb, width: w, height: h, dpi: 300 }, { data: gray, width: w, height: h, dpi: 200 }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  assert.equal(String.fromCharCode(buf[0], buf[1]), 'II');
  assert.equal(dv.getUint16(2, true), 42);

  const ifd1 = readIfd(dv, dv.getUint32(4, true));
  assert.equal(ifd1.tags[256].val, w);
  assert.equal(ifd1.tags[257].val, h);
  assert.equal(ifd1.tags[259].val, 5, 'LZW');
  assert.equal(ifd1.tags[262].val, 2, 'RGB photometric');
  assert.equal(ifd1.tags[277].val, 3);
  const strip1 = buf.subarray(ifd1.tags[273].val, ifd1.tags[273].val + ifd1.tags[279].val);
  const dec1 = lzwDecode(strip1, w * h * 3);
  for (let i = 0; i < w * h; i++) {
    assert.equal(dec1[i * 3], rgb[i * 4]);
    assert.equal(dec1[i * 3 + 1], rgb[i * 4 + 1]);
    assert.equal(dec1[i * 3 + 2], rgb[i * 4 + 2]);
  }
  assert.equal(dv.getUint32(ifd1.tags[282].val, true), 300, 'XResolution');

  assert.notEqual(ifd1.next, 0, 'second IFD linked');
  const ifd2 = readIfd(dv, ifd1.next);
  assert.equal(ifd2.tags[262].val, 1, 'gray photometric');
  assert.equal(ifd2.tags[277].val, 1);
  const strip2 = buf.subarray(ifd2.tags[273].val, ifd2.tags[273].val + ifd2.tags[279].val);
  const dec2 = lzwDecode(strip2, w * h);
  for (let i = 0; i < w * h; i++) assert.equal(dec2[i], gray[i * 4]);
  assert.equal(ifd2.next, 0, 'chain ends');
});

test('LZW survives long runs that force table clears', async () => {
  const w = 512, h = 64;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = (i * 31 + (i >> 5)) & 255; px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  const blob = encodeMultiPageTiff([{ data: px, width: w, height: h }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const ifd = readIfd(dv, dv.getUint32(4, true));
  const strip = buf.subarray(ifd.tags[273].val, ifd.tags[273].val + ifd.tags[279].val);
  const dec = lzwDecode(strip, w * h);
  for (let i = 0; i < w * h; i++) assert.equal(dec[i], px[i * 4]);
});

test('ZIP writer: local headers, central directory and EOCD are consistent', async () => {
  const a = new Blob([new Uint8Array([1, 2, 3, 4])]);
  const b = new Blob([new TextEncoder().encode('hello world')]);
  const zip = await createZip([{ name: 'a.bin', blob: a }, { name: 'b.txt', blob: b }]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2, 'two entries');
  const cdOffset = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cdOffset, true), 0x02014b50);
  const nameLen = dv.getUint16(cdOffset + 28, true);
  assert.equal(new TextDecoder().decode(buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen)), 'a.bin');
});
