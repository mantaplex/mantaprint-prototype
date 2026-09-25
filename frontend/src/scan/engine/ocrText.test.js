import test from 'node:test';
import assert from 'node:assert/strict';
import { toPageResult, linesToText, ocrGeometryKey, ocrState, visibleWords } from './ocrText.js';
import { overlaps } from './annotations.js';

const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });

test('toPageResult keeps reading order, lines and paragraphs', () => {
  const data = { blocks: [{ paragraphs: [
    { lines: [{ words: [word('Halo', 0, 0, 100, 20), word('dunia', 110, 0, 200, 20)] }, { words: [word('baris', 0, 30, 90, 50)] }] },
    { lines: [{ words: [word('Paragraf', 0, 80, 150, 100), word(' ', 0, 0, 0, 0)] }] }
  ] }] };
  const r = toPageResult(data, 1000, 500);
  assert.equal(r.text, 'Halo dunia\nbaris\n\nParagraf');
  assert.equal(r.words.length, 4);
  assert.deepEqual(r.words[1], { t: 'dunia', x: 0.11, y: 0, w: 0.09, h: 0.04, c: 90, l: 0 });
  assert.equal(r.words[2].l, 1);
});

test('linesToText handles empty input', () => {
  assert.equal(linesToText([]), '');
});

test('geometry key tracks rotation, deskew and crop only', () => {
  const page = { edits: { rotation: 90, deskew: 1.2, crop: null, brightness: 1 }, ocr: { status: 'done', key: ocrGeometryKey({ rotation: 90, deskew: 1.2 }) } };
  assert.equal(ocrState(page), 'done');
  assert.equal(ocrState({ ...page, edits: { ...page.edits, brightness: 1.3 } }), 'done');
  assert.equal(ocrState({ ...page, edits: { ...page.edits, rotation: 180 } }), 'stale');
  assert.equal(ocrState({ edits: {} }), 'none');
});

test('visibleWords drops words under redactions', () => {
  const words = [{ t: 'a', x: 0.1, y: 0.1, w: 0.1, h: 0.05 }, { t: 'b', x: 0.5, y: 0.5, w: 0.1, h: 0.05 }];
  assert.deepEqual(visibleWords(words, [{ x: 0.45, y: 0.45, w: 0.3, h: 0.2 }], overlaps).map((w) => w.t), ['a']);
});

import { findMatches } from './ocrText.js';

test('findMatches ignores case and accents and spans words', () => {
  const words = [
    { t: 'Surat', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { t: 'Keterangan', x: 0.21, y: 0.1, w: 0.2, h: 0.02 },
    { t: 'Café', x: 0.1, y: 0.2, w: 0.1, h: 0.02 }, { t: 'surat', x: 0.3, y: 0.3, w: 0.1, h: 0.02 }
  ];
  const pages = [{ id: 'p1' }, { id: 'p2' }];
  const wordsFor = (p) => (p.id === 'p1' ? words : []);
  const m = findMatches(pages, 'surat ket', wordsFor);
  assert.equal(m.length, 1);
  assert.equal(m[0].rects.length, 2);
  assert.equal(findMatches(pages, 'SURAT', wordsFor).length, 2);
  assert.equal(findMatches(pages, 'cafe', wordsFor).length, 1);
  assert.equal(findMatches(pages, 'x', wordsFor).length, 0);
});

import { pageParagraphs, pagesToText } from './textExport.js';

test('text export rebuilds paragraphs and drops redacted words', () => {
  const edits = { rotation: 0 };
  const { ocrGeometryKey: key } = { ocrGeometryKey };
  const page = {
    edits,
    annotations: [{ id: 'r', type: 'redact', x: 0.5, y: 0.19, w: 0.3, h: 0.05 }],
    ocr: {
      status: 'done', key: key(edits),
      words: [
        { t: 'Nama:', x: 0.1, y: 0.1, w: 0.1, h: 0.02, l: 0 }, { t: 'Budi', x: 0.25, y: 0.1, w: 0.1, h: 0.02, l: 0 },
        { t: 'NIK:', x: 0.1, y: 0.2, w: 0.1, h: 0.02, l: 1 }, { t: '3174012345678901', x: 0.55, y: 0.2, w: 0.2, h: 0.02, l: 1 },
        { t: 'Alamat', x: 0.1, y: 0.4, w: 0.1, h: 0.02, l: 2 }
      ],
      lines: [{ t: 'Nama: Budi', p: 0 }, { t: 'NIK: 3174012345678901', p: 0 }, { t: 'Alamat', p: 1 }]
    }
  };
  assert.deepEqual(pageParagraphs(page), [['Nama: Budi', 'NIK:'], ['Alamat']]);
  assert.equal(pagesToText([page, { edits }]), 'Nama: Budi\nNIK:\n\nAlamat');
});
