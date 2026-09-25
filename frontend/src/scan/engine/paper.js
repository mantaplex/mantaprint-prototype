/** Paper sizes used by the scanner request, the stage frame and the PDF exporter. */
export const PAPER_SIZES = {
  A4: { id: 'A4', name: 'A4', widthMm: 210, heightMm: 297, widthPt: 595.28, heightPt: 841.89, badge: 'ISO 216' },
  F4: { id: 'F4', name: 'F4 / Folio', widthMm: 215, heightMm: 330, widthPt: 609.45, heightPt: 935.43, badge: 'ID' },
  Legal: { id: 'Legal', name: 'Legal', widthMm: 216, heightMm: 356, widthPt: 612, heightPt: 1008, badge: 'US' },
  Letter: { id: 'Letter', name: 'Letter', widthMm: 216, heightMm: 279, widthPt: 612, heightPt: 792, badge: 'US' },
  A5: { id: 'A5', name: 'A5', widthMm: 148, heightMm: 210, widthPt: 419.53, heightPt: 595.28, badge: 'ISO 216' },
  CR80: { id: 'CR80', name: 'ID Card (CR80)', widthMm: 85.6, heightMm: 54, widthPt: 242.65, heightPt: 153.07, badge: 'ISO 7810' }
};

export const PAPER_ORDER = ['A4', 'F4', 'Legal', 'Letter', 'A5', 'CR80'];

export const DPI_OPTIONS = [150, 200, 300, 600];

/** Scan presets: what the scanner is asked for plus the default look applied to new pages. */
export const PRESETS = [
  {
    id: 'office',
    accent: 'manta',
    scan: { resolution: 300, mode: 'Color', paperSize: 'A4' },
    edits: { filter: 'clean', bgClean: 40, contrast: 1.35, brightness: 1.08 }
  },
  {
    id: 'ktp',
    accent: 'sky',
    scan: { resolution: 300, mode: 'Color', paperSize: 'A4' },
    edits: { filter: 'clean', bgClean: 35, contrast: 1.28, brightness: 1.05 }
  },
  {
    id: 'archive',
    accent: 'amber',
    scan: { resolution: 200, mode: 'Gray', paperSize: 'A4' },
    edits: { filter: 'bw', bgClean: 60, contrast: 1.8, brightness: 1.0 }
  },
  {
    id: 'photo',
    accent: 'rose',
    scan: { resolution: 300, mode: 'Color', paperSize: 'A4' },
    edits: { filter: 'none', bgClean: 0, contrast: 1.0, brightness: 1.0 }
  }
];

export const FILTERS = ['none', 'clean', 'bw', 'gray', 'dual_layer', 'color'];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

export function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}
