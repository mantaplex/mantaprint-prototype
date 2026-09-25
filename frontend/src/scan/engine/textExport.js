/**
 * Plain-text and Word (.docx) export of the recognised text. Only words that are current
 * and not under a redaction are used; pages without recognised text are skipped.
 */
import { exportableWords } from './pdfExport.js';

/** Paragraphs (arrays of lines) of one page, rebuilt from its exportable words. */
export function pageParagraphs(page) {
  const words = exportableWords(page);
  if (!words.length) return [];
  const lineParas = page.ocr.lines || [];
  const byLine = new Map();
  for (const w of words) {
    if (!byLine.has(w.l)) byLine.set(w.l, []);
    byLine.get(w.l).push(w.t);
  }
  const paras = [];
  let cur = null;
  let curP = null;
  for (const l of [...byLine.keys()].sort((a, b) => a - b)) {
    const p = lineParas[l]?.p ?? l;
    if (p !== curP) { cur = []; paras.push(cur); curP = p; }
    cur.push(byLine.get(l).join(' '));
  }
  return paras;
}

export function pagesToText(pages) {
  return pages
    .map((p) => pageParagraphs(p).map((lines) => lines.join('\n')).join('\n\n'))
    .filter(Boolean)
    .join('\n\n\f\n\n');
}

export async function pagesToDocx(pages, title) {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  const children = [];
  pages.forEach((page) => {
    const paras = pageParagraphs(page);
    if (!paras.length) return;
    paras.forEach((lines, i) => {
      children.push(new Paragraph({
        pageBreakBefore: children.length > 0 && i === 0,
        spacing: { after: 160 },
        children: lines.flatMap((line, j) => [new TextRun({ text: line, break: j > 0 ? 1 : 0 })])
      }));
    });
  });
  const doc = new Document({
    title,
    creator: 'MantaPageScan Studio',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: children.length ? children : [new Paragraph('')] }]
  });
  return Packer.toBlob(doc);
}
