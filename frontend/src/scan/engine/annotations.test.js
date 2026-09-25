import test from 'node:test';
import assert from 'node:assert/strict';
import { remapAnnotations, getBounds, hitTest, pickAnnotation, wrapText, translate, resizeTo, overlaps } from './annotations.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const W = 2000; const H = 3000;
const e0 = { rotation: 0, crop: null };

test('rotating four times by 90 returns objects to where they were', () => {
  const list = [
    { id: 'a', type: 'shape', shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, strokeWidth: 0.002 },
    { id: 'b', type: 'ink', tool: 'pen', points: [[0.1, 0.1], [0.5, 0.7]], width: 0.003 },
    { id: 'c', type: 'shape', shape: 'arrow', x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.9, strokeWidth: 0.002 }
  ];
  let cur = list; let e = e0;
  for (let i = 0; i < 4; i++) {
    const next = { rotation: (e.rotation + 90) % 360, crop: null };
    cur = remapAnnotations(cur, W, H, e, next);
    e = next;
  }
  assert.ok(close(cur[0].x, 0.1) && close(cur[0].y, 0.2) && close(cur[0].w, 0.3) && close(cur[0].h, 0.1));
  assert.ok(close(cur[1].points[1][0], 0.5) && close(cur[1].points[1][1], 0.7));
  assert.ok(close(cur[2].x2, 0.8) && close(cur[2].y2, 0.9));
});

test('a 90 degree turn moves the top-left corner to the top-right', () => {
  const [r] = remapAnnotations([{ type: 'redact', x: 0, y: 0, w: 0.2, h: 0.1 }], W, H, e0, { rotation: 90, crop: null });
  assert.ok(close(r.x, 0.9) && close(r.y, 0) && close(r.w, 0.1) && close(r.h, 0.2), JSON.stringify(r));
});

test('cropping keeps objects on the same content', () => {
  const crop = { x: 0.25, y: 0.5, w: 0.5, h: 0.5 };
  const [r] = remapAnnotations([{ type: 'redact', x: 0.5, y: 0.75, w: 0.1, h: 0.1 }], W, H, e0, { rotation: 0, crop });
  assert.ok(close(r.x, 0.5) && close(r.y, 0.5) && close(r.w, 0.2) && close(r.h, 0.2), JSON.stringify(r));
  const [back] = remapAnnotations([r], W, H, { rotation: 0, crop }, e0);
  assert.ok(close(back.x, 0.5) && close(back.y, 0.75));
});

test('signatures stay upright and keep their physical size on rotation', () => {
  const sig = { type: 'image', kind: 'signature', x: 0.4, y: 0.4, w: 0.2, h: 0.05 };
  const [r] = remapAnnotations([sig], W, H, e0, { rotation: 90, crop: null });
  // page becomes 3000 x 2000; 0.2*2000 = 400px wide stays 400px => 400/3000
  assert.ok(close(r.w, 400 / 3000) && close(r.h, 150 / 2000), JSON.stringify(r));
  assert.ok(close(r.x + r.w / 2, 1 - 0.425) && close(r.y + r.h / 2, 0.5));
});

test('hit testing and picking prefer redactions on top', () => {
  const ink = { id: 'i', type: 'ink', points: [[0.1, 0.1], [0.9, 0.1]], width: 0.002 };
  const red = { id: 'r', type: 'redact', x: 0.4, y: 0.05, w: 0.2, h: 0.1 };
  assert.ok(hitTest(ink, { x: 0.3, y: 0.1 }, W, H));
  assert.ok(!hitTest(ink, { x: 0.3, y: 0.2 }, W, H));
  assert.equal(pickAnnotation([red, ink], { x: 0.5, y: 0.1 }, W, H).id, 'r');
  assert.equal(pickAnnotation([red, ink], { x: 0.2, y: 0.1 }, W, H).id, 'i');
});

test('translate and resize', () => {
  const line = { type: 'shape', shape: 'line', x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.5 };
  const moved = translate(line, 0.1, 0.1);
  assert.ok(close(moved.x2, 0.4) && close(moved.y2, 0.6));
  const b = getBounds(moved);
  const big = resizeTo(moved, { x: b.x, y: b.y, w: b.w * 2, h: b.h * 2 });
  assert.ok(close(big.x2, 0.2 + 0.4) && close(big.y2, 0.2 + 0.8));
});

test('wrapText breaks on words and keeps newlines', () => {
  const measure = (s) => s.length * 10;
  assert.deepEqual(wrapText('hello big world', 90, measure), ['hello big', 'world']);
  assert.deepEqual(wrapText('a\nb', 100, measure), ['a', 'b']);
  assert.deepEqual(wrapText('abcdefghijkl', 50, measure), ['abcde', 'fghij', 'kl']);
});

test('overlaps measures the covered share of a word box', () => {
  assert.ok(overlaps({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.4, y: 0.1, w: 0.2, h: 0.1 }));
  assert.ok(!overlaps({ x: 0, y: 0, w: 0.41, h: 1 }, { x: 0.4, y: 0.1, w: 0.2, h: 0.1 }));
});
