/**
 * PDF export with pdf-lib. Every page is rendered locally (worker) with its objects painted
 * in and embedded as JPEG. Pages whose aspect ratio matches the chosen paper are placed 1:1
 * borderless; anything else is fitted proportionally and centred.
 *
 * With `searchable`, recognised text (OCR) is laid over each page image as invisible text
 * (text render mode 3), so the PDF can be searched, selected and copied. Words under a
 * redaction are left out, so redacted text cannot be recovered from the file.
 */
import {
  PDFDocument, StandardFonts, TextRenderingMode, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setTextRenderingMode, setCharacterSqueeze, moveText, showText
} from 'pdf-lib';
import { PAPER_SIZES } from './paper.js';
import { renderPageBlob } from './renderClient.js';
import { redactionRects, overlaps } from './annotations.js';
import { ocrState, visibleWords } from './ocrText.js';

/** Words of a page that may go into an export (recognised, current, not redacted). */
export function exportableWords(page) {
  if (ocrState(page) !== 'done') return [];
  return visibleWords(page.ocr.words, redactionRects(page.annotations), overlaps);
}

function encodable(font, text) {
  try {
    return font.encodeText(text);
  } catch {
    const folded = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
    try { return font.encodeText(folded); } catch { return null; }
  }
}

function addTextLayer(pdf, page, font, words, box) {
  if (!words.length) return;
  const fontKey = page.node.newFontDictionary(font.name, font.ref);
  const ops = [pushGraphicsState()];
  for (const w of words) {
    const size = Math.max(1, w.h * box.h * 0.9);
    // Each word is stretched to exactly its own box; the real gaps between boxes are what
    // text extractors and viewers read as spaces.
    const enc = encodable(font, w.t);
    if (!enc) continue;
    const natural = font.widthOfTextAtSize(w.t, size) || 1;
    const target = w.w * box.w;
    const x = box.x + w.x * box.w;
    const y = box.y + box.h - (w.y + w.h) * box.h + w.h * box.h * 0.2;
    ops.push(
      beginText(),
      setFontAndSize(fontKey, size),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setCharacterSqueeze(Math.max(1, Math.min(1000, (100 * target) / natural))),
      moveText(x, y),
      showText(enc),
      endText()
    );
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

/**
 * @param {Array} pages   page records ({ blob, edits, dpi, width, height, annotations, ocr })
 * @param {object} opts   { paperSize, title, quality, onProgress, fitMode: 'paper'|'image', searchable }
 * @returns {Promise<Uint8Array>}
 */
export async function exportPagesToPdf(pages, opts = {}) {
  const { paperSize = 'A4', title = 'Scan', quality = 0.9, onProgress, fitMode = 'paper', searchable = true } = opts;
  const paper = PAPER_SIZES[paperSize] || PAPER_SIZES.A4;
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('MantaPageScan Studio');
  pdf.setCreator('MantaPrint Hub');
  const font = searchable ? await pdf.embedFont(StandardFonts.Helvetica) : null;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    onProgress?.(i, pages.length);
    const { blob } = await renderPageBlob(p, { mime: 'image/jpeg', quality });
    const img = await pdf.embedJpg(await blob.arrayBuffer());

    let page;
    let box;
    if (fitMode === 'image') {
      // Page takes the physical size of the scan (pixels / dpi)
      const dpi = p.dpi || 300;
      const w = (img.width / dpi) * 72;
      const h = (img.height / dpi) * 72;
      page = pdf.addPage([w, h]);
      box = { x: 0, y: 0, w, h };
    } else {
      const isLandscape = img.width > img.height;
      const pw = isLandscape ? paper.heightPt : paper.widthPt;
      const ph = isLandscape ? paper.widthPt : paper.heightPt;
      page = pdf.addPage([pw, ph]);
      const pageAspect = pw / ph;
      const imgAspect = img.width / img.height;
      let drawW; let drawH;
      if (Math.abs(pageAspect - imgAspect) / pageAspect < 0.04) {
        drawW = pw; drawH = ph;
      } else {
        drawW = pw; drawH = pw / imgAspect;
        if (drawH > ph) { drawH = ph; drawW = ph * imgAspect; }
      }
      box = { x: (pw - drawW) / 2, y: (ph - drawH) / 2, w: drawW, h: drawH };
    }
    page.drawImage(img, { x: box.x, y: box.y, width: box.w, height: box.h });
    if (font) addTextLayer(pdf, page, font, exportableWords(p), box);
  }
  onProgress?.(pages.length, pages.length);
  return pdf.save();
}
