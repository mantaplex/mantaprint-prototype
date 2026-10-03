/**
 * MantaPageScan Studio - page objects (drawings, shapes, text, signatures, marks, redactions)
 *
 * Every object lives on one page and is stored in `page.annotations`. Positions are
 * fractions (0..1) of the page as the user sees it (after rotation, deskew and crop), so
 * they render the same at any zoom or export resolution. Line widths and font sizes are
 * fractions of the page diagonal, so they keep their look when the page is cropped or turned.
 *
 * Types:
 *   ink     { tool: 'pen'|'highlighter', points: [[x,y]...], color, width }
 *   shape   { shape: 'rect'|'rounded_rect'|'ellipse', x, y, w, h, stroke, strokeWidth, dash, fill }
 *           { shape: 'line'|'arrow', x1, y1, x2, y2, stroke, strokeWidth, dash }
 *   text    { x, y, w, h, text, color, fontSize, bold, align }
 *   image   { kind: 'signature'|'image', x, y, w, h, src (data URL) }
 *   mark    { kind: 'check'|'cross', x, y, w, h, color }
 *   redact  { x, y, w, h, style: 'black'|'white', label }
 *
 * Redactions are always painted last so they cover every other object and the scan itself.
 */

import { outputSize, rotatedSize } from './render.js';

export const ANNOTATION_FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';
export const TEXT_LINE_HEIGHT = 1.25;

let seq = 0;
export function annotationId() {
  seq += 1;
  return `an_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function frameDiag(w, h) {
  return Math.hypot(w, h);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Axis-aligned bounds of an object in page fractions. */
export function getBounds(a) {
  if (a.type === 'ink') {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const [x, y] of a.points || []) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (a.type === 'shape' && (a.shape === 'line' || a.shape === 'arrow')) {
    const x = Math.min(a.x1, a.x2); const y = Math.min(a.y1, a.y2);
    return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Does page point `p` (fractions) hit object `a`? `W`/`H` are the page size in any unit
 * (used to measure distance isotropically); `tol` is in that unit.
 */
export function hitTest(a, p, W, H, tol = 6) {
  const px = p.x * W; const py = p.y * H;
  const diag = frameDiag(W, H);
  if (a.type === 'ink') {
    const reach = tol + (a.width || 0) * diag / 2;
    const pts = a.points || [];
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(px, py, pts[i - 1][0] * W, pts[i - 1][1] * H, pts[i][0] * W, pts[i][1] * H) <= reach) return true;
    }
    return pts.length === 1 && Math.hypot(px - pts[0][0] * W, py - pts[0][1] * H) <= reach;
  }
  if (a.type === 'shape' && (a.shape === 'line' || a.shape === 'arrow')) {
    const reach = tol + (a.strokeWidth || 0) * diag / 2;
    return distToSegment(px, py, a.x1 * W, a.y1 * H, a.x2 * W, a.y2 * H) <= reach;
  }
  const b = getBounds(a);
  return px >= b.x * W - tol && px <= (b.x + b.w) * W + tol && py >= b.y * H - tol && py <= (b.y + b.h) * H + tol;
}

/** Topmost object under a point (redactions are on top, as they are painted last). */
export function pickAnnotation(list, p, W, H, tol) {
  const ordered = orderForPaint(list || []);
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTest(ordered[i], p, W, H, tol)) return ordered[i];
  }
  return null;
}

export function orderForPaint(list) {
  return [...list.filter((a) => a.type !== 'redact'), ...list.filter((a) => a.type === 'redact')];
}

/** Moves an object by (dx, dy) page fractions. */
export function translate(a, dx, dy) {
  if (a.type === 'ink') return { ...a, points: a.points.map(([x, y]) => [x + dx, y + dy]) };
  if (a.type === 'shape' && (a.shape === 'line' || a.shape === 'arrow')) {
    return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
  }
  return { ...a, x: a.x + dx, y: a.y + dy };
}

/** Fits an object into new bounds (resize handles). */
export function resizeTo(a, nb) {
  const b = getBounds(a);
  if (a.type === 'ink') {
    const sx = b.w ? nb.w / b.w : 1; const sy = b.h ? nb.h / b.h : 1;
    return { ...a, points: a.points.map(([x, y]) => [nb.x + (x - b.x) * sx, nb.y + (y - b.y) * sy]) };
  }
  if (a.type === 'shape' && (a.shape === 'line' || a.shape === 'arrow')) {
    const map = (x, y) => [nb.x + (b.w ? (x - b.x) / b.w : 0) * nb.w, nb.y + (b.h ? (y - b.y) / b.h : 0) * nb.h];
    const [x1, y1] = map(a.x1, a.y1); const [x2, y2] = map(a.x2, a.y2);
    return { ...a, x1, y1, x2, y2 };
  }
  return { ...a, x: nb.x, y: nb.y, w: nb.w, h: nb.h };
}

// ---------------------------------------------------------------------------
// Geometry remap when the page is rotated or re-cropped
// ---------------------------------------------------------------------------

function fullCrop(c) { return c || { x: 0, y: 0, w: 1, h: 1 }; }

function makePointMapper(fromEdits, toEdits) {
  const c1 = fullCrop(fromEdits?.crop);
  const c2 = fullCrop(toEdits?.crop);
  const delta = ((((toEdits?.rotation || 0) - (fromEdits?.rotation || 0)) % 360) + 360) % 360;
  return (x, y) => {
    let u = c1.x + x * c1.w;
    let v = c1.y + y * c1.h;
    if (delta === 90) [u, v] = [1 - v, u];
    else if (delta === 180) [u, v] = [1 - u, 1 - v];
    else if (delta === 270) [u, v] = [v, 1 - u];
    return [(u - c2.x) / c2.w, (v - c2.y) / c2.h];
  };
}

/** True when a change of edits moves content on the page (rotation or crop). */
export function geometryChanged(a, b) {
  const ca = a?.crop || null; const cb = b?.crop || null;
  const sameCrop = (!ca && !cb) || (ca && cb && ca.x === cb.x && ca.y === cb.y && ca.w === cb.w && ca.h === cb.h);
  return (a?.rotation || 0) !== (b?.rotation || 0) || !sameCrop || (a?.deskew || 0) !== (b?.deskew || 0);
}

/**
 * Re-expresses objects after the page's rotation/crop changed so they stay on the same
 * content. Upright objects (text, images, marks) keep their physical size and orientation;
 * drawings, shapes and redactions turn with the page.
 */
export function remapAnnotations(list, pageW, pageH, fromEdits, toEdits) {
  if (!list?.length) return list || [];
  const map = makePointMapper(fromEdits, toEdits);
  const s1 = outputSize(pageW, pageH, fromEdits);
  const s2 = outputSize(pageW, pageH, toEdits);
  const dScale = frameDiag(s1.width, s1.height) / Math.max(1, frameDiag(s2.width, s2.height));
  const box = (a) => {
    const [ax, ay] = map(a.x, a.y);
    const [bx, by] = map(a.x + a.w, a.y + a.h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };
  return list.map((a) => {
    switch (a.type) {
      case 'ink':
        return { ...a, points: a.points.map(([x, y]) => map(x, y)), width: a.width * dScale };
      case 'shape':
        if (a.shape === 'line' || a.shape === 'arrow') {
          const [x1, y1] = map(a.x1, a.y1); const [x2, y2] = map(a.x2, a.y2);
          return { ...a, x1, y1, x2, y2, strokeWidth: a.strokeWidth * dScale };
        }
        return { ...a, ...box(a), strokeWidth: a.strokeWidth * dScale };
      case 'redact':
        return { ...a, ...box(a) };
      default: {
        // upright: keep physical size, move the centre
        const [cx, cy] = map(a.x + a.w / 2, a.y + a.h / 2);
        const w = (a.w * s1.width) / s2.width;
        const h = (a.h * s1.height) / s2.height;
        const next = { ...a, x: cx - w / 2, y: cy - h / 2, w, h };
        if (a.type === 'text') next.fontSize = a.fontSize * dScale;
        return next;
      }
    }
  });
}

export { rotatedSize };

// ---------------------------------------------------------------------------
// Drawing helpers shared by the on-screen SVG layer and the canvas renderer
// ---------------------------------------------------------------------------

/** Smooth SVG path through ink points (quadratic curves through midpoints). */
export function inkPath(points, W, H) {
  if (!points?.length) return '';
  const p = points.map(([x, y]) => [x * W, y * H]);
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]} L${p[0][0] + 0.01} ${p[0][1]}`;
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2; const my = (p[i][1] + p[i + 1][1]) / 2;
    d += ` Q${p[i][0]} ${p[i][1]} ${mx} ${my}`;
  }
  const last = p[p.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}

/** Arrow head triangle (three points) at (x2,y2) pointing away from (x1,y1). */
export function arrowHead(x1, y1, x2, y2, sw) {
  const len = Math.max(sw * 4, 8);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2, y2],
    [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)],
    [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)]
  ];
}

export function dashArray(dash, sw) {
  if (dash === 'dashed') return [sw * 3, sw * 2];
  if (dash === 'dotted') return [0.01, sw * 2];
  return [];
}

export function markSegments(kind) {
  return kind === 'cross'
    ? [[[0.15, 0.15], [0.85, 0.85]], [[0.85, 0.15], [0.15, 0.85]]]
    : [[[0.12, 0.55], [0.4, 0.85], [0.9, 0.15]]];
}

/** Word-wraps `text` to `maxWidth` using `measure(str) => width`. Keeps explicit newlines. */
export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (measure(next.trimEnd()) <= maxWidth) { line = next; continue; }
      if (line.trim()) out.push(line.trimEnd());
      line = w.trimStart();
      while (line && measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function textFont(a, px) {
  return `${a.bold ? '700' : '400'} ${px}px ${ANNOTATION_FONT}`;
}

// ---------------------------------------------------------------------------
// Canvas renderer (main thread or worker)
// ---------------------------------------------------------------------------

/** Decodes the data-URL images used by image objects; returns Map(src -> bitmap). */
export async function loadAnnotationImages(list) {
  const out = new Map();
  for (const a of list || []) {
    if (a.type !== 'image' || !a.src || out.has(a.src)) continue;
    try {
      const blob = await (await fetch(a.src)).blob();
      out.set(a.src, await createImageBitmap(blob));
    } catch (e) {
      console.warn('[annotations] image decode failed', e);
    }
  }
  return out;
}

function strokeSegments(ctx, pts, W, H) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  ctx.stroke();
}

function traceInk(ctx, points, W, H) {
  const p = points.map(([x, y]) => [x * W, y * H]);
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  if (p.length === 1) { ctx.lineTo(p[0][0] + 0.01, p[0][1]); return; }
  for (let i = 1; i < p.length - 1; i++) {
    ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
  }
  ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function fitLabelSize(label, w, h, measureAt) {
  if (!label) return 0;
  let size = Math.min(h * 0.55, 64);
  while (size > 6 && measureAt(label, size) > w * 0.9) size *= 0.9;
  return size;
}

/**
 * Paints objects onto a 2D context whose canvas is exactly the rendered page (W x H px).
 * `images` comes from loadAnnotationImages().
 */
export function drawAnnotations(ctx, list, W, H, images = new Map()) {
  if (!list?.length) return;
  const diag = frameDiag(W, H);
  for (const a of orderForPaint(list)) {
    ctx.save();
    ctx.globalAlpha = a.opacity ?? 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (a.type) {
      case 'ink': {
        if (!a.points?.length) break;
        ctx.strokeStyle = a.color || '#1d4ed8';
        ctx.lineWidth = Math.max(0.5, (a.width || 0.003) * diag);
        if (a.tool === 'highlighter') {
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = (a.opacity ?? 1) * 0.45;
          ctx.lineCap = 'butt';
        }
        traceInk(ctx, a.points, W, H);
        ctx.stroke();
        break;
      }
      case 'shape': {
        const sw = Math.max(0.5, (a.strokeWidth || 0.002) * diag);
        ctx.lineWidth = sw;
        ctx.strokeStyle = a.stroke || '#dc2626';
        ctx.setLineDash(dashArray(a.dash, sw));
        if (a.shape === 'line' || a.shape === 'arrow') {
          const x1 = a.x1 * W; const y1 = a.y1 * H; const x2 = a.x2 * W; const y2 = a.y2 * H;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          if (a.shape === 'arrow') {
            ctx.setLineDash([]);
            const tri = arrowHead(x1, y1, x2, y2, sw);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath(); ctx.moveTo(...tri[0]); ctx.lineTo(...tri[1]); ctx.lineTo(...tri[2]); ctx.closePath(); ctx.fill();
          }
          break;
        }
        const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
        if (a.shape === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
        } else {
          roundRectPath(ctx, x, y, w, h, a.shape === 'rounded_rect' ? Math.min(w, h) * 0.18 : 0);
        }
        if (a.fill) { ctx.fillStyle = a.fill; ctx.globalAlpha = (a.opacity ?? 1) * (a.fillOpacity ?? 1); ctx.fill(); ctx.globalAlpha = a.opacity ?? 1; }
        ctx.stroke();
        break;
      }
      case 'text': {
        const px = Math.max(4, (a.fontSize || 0.018) * diag);
        ctx.font = textFont(a, px);
        ctx.fillStyle = a.color || '#0f172a';
        ctx.textBaseline = 'top';
        const boxW = a.w * W;
        const lines = wrapText(a.text, boxW, (s) => ctx.measureText(s).width);
        const lh = px * TEXT_LINE_HEIGHT;
        lines.forEach((line, i) => {
          const lw = ctx.measureText(line).width;
          const dx = a.align === 'center' ? (boxW - lw) / 2 : a.align === 'right' ? boxW - lw : 0;
          ctx.fillText(line, a.x * W + dx, a.y * H + i * lh + (lh - px) / 2);
        });
        break;
      }
      case 'image': {
        const bmp = images.get(a.src);
        if (bmp) ctx.drawImage(bmp, a.x * W, a.y * H, a.w * W, a.h * H);
        break;
      }
      case 'mark': {
        const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
        ctx.strokeStyle = a.color || '#1d4ed8';
        ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.12);
        for (const seg of markSegments(a.kind)) strokeSegments(ctx, seg.map(([u, v]) => [(x + u * w) / W, (y + v * h) / H]), W, H);
        break;
      }
      case 'redact': {
        const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
        ctx.globalAlpha = 1;
        ctx.fillStyle = a.style === 'white' ? '#ffffff' : '#000000';
        ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(w) + 1, Math.ceil(h) + 1);
        if (a.label) {
          const size = fitLabelSize(a.label, w, h, (s, sz) => { ctx.font = `700 ${sz}px ${ANNOTATION_FONT}`; return ctx.measureText(s).width; });
          ctx.font = `700 ${size}px ${ANNOTATION_FONT}`;
          ctx.fillStyle = a.style === 'white' ? '#0f172a' : '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(a.label, x + w / 2, y + h / 2);
        }
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }
}

/** Only redactions, used to cut words out of the OCR text layer. */
export function redactionRects(list) {
  return (list || []).filter((a) => a.type === 'redact').map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h }));
}

export function overlaps(r, b, minFrac = 0.3) {
  const ix = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x));
  const iy = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y));
  const area = b.w * b.h;
  return area > 0 && (ix * iy) / area >= minFrac;
}

export { clamp01 };

/** Paints `list` onto a rendered page canvas (sizes taken from the canvas). */
export async function paintAnnotations(canvas, list) {
  if (!list?.length) return;
  const images = await loadAnnotationImages(list);
  try {
    const ctx = canvas.getContext('2d');
    drawAnnotations(ctx, list, canvas.width, canvas.height, images);
  } finally {
    for (const bmp of images.values()) bmp.close?.();
  }
}
