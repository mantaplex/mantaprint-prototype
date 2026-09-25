/**
 * Minimal multi-page TIFF writer (baseline, little-endian, LZW compressed).
 * Input pages are RGBA pixel buffers; grayscale pages are written as 8-bit gray,
 * everything else as 8-bit RGB. Physical resolution is stored in DPI.
 */

const TAG = {
  ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278,
  StripByteCounts: 279, XResolution: 282, YResolution: 283, PlanarConfig: 284,
  ResolutionUnit: 296, Software: 305
};
const TYPE = { ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

/** TIFF LZW (MSB-first codes, 9..12 bits, with ClearCode at start and every 4094 codes). */
function lzwEncode(input) {
  const out = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code, bits) => {
    bitBuf = (bitBuf << bits) | code;
    bitCnt += bits;
    while (bitCnt >= 8) {
      out.push((bitBuf >>> (bitCnt - 8)) & 0xff);
      bitCnt -= 8;
    }
    bitBuf &= (1 << bitCnt) - 1;
  };
  const CLEAR = 256;
  const EOI = 257;
  let dict = new Map();
  let next = 258;
  let bits = 9;
  const reset = () => { dict = new Map(); next = 258; bits = 9; };

  emit(CLEAR, 9);
  reset();
  let w = -1; // current prefix code
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (w === -1) { w = c; continue; }
    const key = w * 256 + c;
    const found = dict.get(key);
    if (found !== undefined) {
      w = found;
    } else {
      emit(w, bits);
      dict.set(key, next++);
      // libtiff rules: clear the table at 4094 entries, otherwise widen the code
      // as soon as the next free entry no longer fits ("early change").
      if (next === 4094) {
        emit(CLEAR, bits);
        reset();
      } else if (next > (1 << bits) - 1) {
        bits++;
      }
      w = c;
    }
  }
  if (w !== -1) emit(w, bits);
  emit(EOI, bits);
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return Uint8Array.from(out);
}

function isGray(rgba) {
  const step = Math.max(4, Math.floor(rgba.length / 4 / 20000) * 4);
  for (let i = 0; i < rgba.length; i += step) {
    if (Math.abs(rgba[i] - rgba[i + 1]) > 6 || Math.abs(rgba[i + 1] - rgba[i + 2]) > 6) return false;
  }
  return true;
}

/**
 * @param {Array<{data:ArrayBuffer|Uint8ClampedArray, width:number, height:number, dpi?:number}>} pages
 * @returns {Blob}
 */
export function encodeMultiPageTiff(pages, { software = 'MantaPageScan Studio' } = {}) {
  const chunks = []; // Uint8Arrays in file order
  let offset = 8; // after header
  const ifdOffsets = [];
  const header = new Uint8Array(8);
  header.set([0x49, 0x49, 0x2a, 0x00]); // II, 42
  chunks.push(header);

  const strips = [];
  for (const p of pages) {
    const rgba = p.data instanceof ArrayBuffer ? new Uint8ClampedArray(p.data) : p.data;
    const gray = isGray(rgba);
    const spp = gray ? 1 : 3;
    const raw = new Uint8Array(p.width * p.height * spp);
    for (let i = 0, o = 0; i < rgba.length; i += 4) {
      if (gray) raw[o++] = rgba[i];
      else { raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; }
    }
    const comp = lzwEncode(raw);
    strips.push({ comp, gray, spp, width: p.width, height: p.height, dpi: p.dpi || 300 });
  }

  const softwareBytes = new TextEncoder().encode(software + '\0');

  strips.forEach((s, idx) => {
    // strip data
    const stripOffset = offset;
    chunks.push(s.comp);
    offset += s.comp.length;
    if (offset % 2) { chunks.push(new Uint8Array(1)); offset++; }

    // rational values + software string go before the IFD
    const extraOffset = offset;
    const extra = new ArrayBuffer(16 + softwareBytes.length + (softwareBytes.length % 2));
    const ev = new DataView(extra);
    ev.setUint32(0, s.dpi, true); ev.setUint32(4, 1, true);   // XResolution
    ev.setUint32(8, s.dpi, true); ev.setUint32(12, 1, true);  // YResolution
    new Uint8Array(extra).set(softwareBytes, 16);
    chunks.push(new Uint8Array(extra));
    offset += extra.byteLength;

    const entries = [
      [TAG.ImageWidth, TYPE.LONG, 1, s.width],
      [TAG.ImageLength, TYPE.LONG, 1, s.height],
      [TAG.BitsPerSample, TYPE.SHORT, s.spp, s.spp === 1 ? 8 : null],
      [TAG.Compression, TYPE.SHORT, 1, 5],
      [TAG.Photometric, TYPE.SHORT, 1, s.gray ? 1 : 2],
      [TAG.StripOffsets, TYPE.LONG, 1, stripOffset],
      [TAG.SamplesPerPixel, TYPE.SHORT, 1, s.spp],
      [TAG.RowsPerStrip, TYPE.LONG, 1, s.height],
      [TAG.StripByteCounts, TYPE.LONG, 1, s.comp.length],
      [TAG.XResolution, TYPE.RATIONAL, 1, extraOffset],
      [TAG.YResolution, TYPE.RATIONAL, 1, extraOffset + 8],
      [TAG.PlanarConfig, TYPE.SHORT, 1, 1],
      [TAG.ResolutionUnit, TYPE.SHORT, 1, 2],
      [TAG.Software, TYPE.ASCII, softwareBytes.length, extraOffset + 16]
    ];

    // BitsPerSample for RGB needs 3 shorts -> stored after IFD
    const ifdSize = 2 + entries.length * 12 + 4;
    const bpsExtra = s.spp === 3 ? 6 : 0;
    const ifd = new ArrayBuffer(ifdSize + bpsExtra);
    const dv = new DataView(ifd);
    const ifdOffset = offset;
    ifdOffsets.push(ifdOffset);
    dv.setUint16(0, entries.length, true);
    entries.forEach(([tag, type, count, value], i) => {
      const base = 2 + i * 12;
      dv.setUint16(base, tag, true);
      dv.setUint16(base + 2, type, true);
      dv.setUint32(base + 4, count, true);
      if (tag === TAG.BitsPerSample && s.spp === 3) {
        dv.setUint32(base + 8, ifdOffset + ifdSize, true);
      } else if (type === TYPE.SHORT) {
        dv.setUint16(base + 8, value, true);
      } else {
        dv.setUint32(base + 8, value, true);
      }
    });
    if (s.spp === 3) {
      dv.setUint16(ifdSize, 8, true); dv.setUint16(ifdSize + 2, 8, true); dv.setUint16(ifdSize + 4, 8, true);
    }
    // next IFD pointer patched later
    const ifdArr = new Uint8Array(ifd);
    chunks.push(ifdArr);
    offset += ifd.byteLength;
    if (offset % 2) { chunks.push(new Uint8Array(1)); offset++; }
    s._ifdChunk = ifdArr;
    s._ifdSize = ifdSize;
    s._idx = idx;
  });

  // Patch header -> first IFD and chain next-IFD pointers
  new DataView(header.buffer).setUint32(4, ifdOffsets[0], true);
  strips.forEach((s, i) => {
    const next = i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0;
    const dv = new DataView(s._ifdChunk.buffer);
    dv.setUint32(s._ifdSize - 4, next, true);
  });

  return new Blob(chunks, { type: 'image/tiff' });
}
