/** Pure helpers for OCR results (no engine import, safe to unit-test). */

/** Fingerprint of everything that moves text on the page. */
export function ocrGeometryKey(edits) {
  const e = edits || {};
  const c = e.crop ? [e.crop.x, e.crop.y, e.crop.w, e.crop.h].map((v) => v.toFixed(4)).join(',') : '-';
  return `${e.rotation || 0}|${(e.deskew || 0).toFixed(2)}|${c}`;
}

export function ocrState(page) {
  const o = page?.ocr;
  if (!o || o.status !== 'done') return 'none';
  return o.key === ocrGeometryKey(page.edits) ? 'done' : 'stale';
}

/** Converts tesseract blocks into compact page-fraction words and text lines. */
export function toPageResult(data, width, height) {
  const words = [];
  const lines = [];
  let lineIdx = 0;
  let paraIdx = 0;
  for (const block of data?.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const lineWords = [];
        for (const w of line.words || []) {
          const t = (w.text || '').trim();
          if (!t) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          words.push({ t, x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height, c: Math.round(w.confidence || 0), l: lineIdx });
          lineWords.push(t);
        }
        if (lineWords.length) {
          lines.push({ t: lineWords.join(' '), p: paraIdx });
          lineIdx += 1;
        }
      }
      paraIdx += 1;
    }
  }
  return { words, lines, text: linesToText(lines) };
}

/** Plain text with blank lines between paragraphs. */
export function linesToText(lines) {
  let out = '';
  let prevP = null;
  for (const ln of lines || []) {
    if (prevP !== null) out += ln.p !== prevP ? '\n\n' : '\n';
    out += ln.t;
    prevP = ln.p;
  }
  return out;
}

/** Words with no part under a redaction (used by the text layer and exports). */
export function visibleWords(words, redactions, overlaps) {
  if (!redactions?.length) return words || [];
  return (words || []).filter((w) => !redactions.some((r) => overlaps(r, w, 0.15)));
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Finds `query` in the recognised text of `pages` (in page order). Each match lists the
 * word boxes it covers. `wordsFor(page)` returns the searchable words of a page.
 * @returns {Array<{ pageId, rects: Array<{x,y,w,h}>, y }>}
 */
export function findMatches(pages, query, wordsFor) {
  const q = norm(String(query || '').trim().replace(/\s+/g, ' '));
  if (q.length < 2) return [];
  const out = [];
  for (const page of pages) {
    const words = wordsFor(page);
    if (!words?.length) continue;
    let text = '';
    const starts = [];
    words.forEach((w, i) => {
      if (i) text += ' ';
      starts.push(text.length);
      text += norm(w.t);
    });
    let from = 0;
    for (;;) {
      const at = text.indexOf(q, from);
      if (at < 0) break;
      const end = at + q.length;
      const rects = [];
      words.forEach((w, i) => {
        const s = starts[i];
        const e = s + norm(w.t).length;
        if (s < end && e > at) rects.push({ x: w.x, y: w.y, w: w.w, h: w.h });
      });
      out.push({ pageId: page.id, rects, y: rects[0]?.y ?? 0 });
      from = at + Math.max(1, q.length);
    }
  }
  return out;
}
