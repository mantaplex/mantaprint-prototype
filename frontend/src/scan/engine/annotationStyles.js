/**
 * Tool presets for page objects. Sizes are physical points; when an object is placed they
 * are converted to fractions of that page's diagonal (see annotations.js), so 12 pt text is
 * 12 pt on an A4 scan and on an ID-card scan alike, at any zoom.
 */
import { outputSize } from './render.js';

export const PEN_COLORS = ['#0f172a', '#1d4ed8', '#dc2626', '#16a34a', '#d97706', '#7c3aed'];
export const HIGHLIGHTER_COLORS = ['#fde047', '#86efac', '#7dd3fc', '#f9a8d4', '#fdba74'];
export const STROKE_COLORS = ['#dc2626', '#1d4ed8', '#0f172a', '#16a34a', '#d97706', '#7c3aed'];
export const FILL_COLORS = ['#fee2e2', '#dbeafe', '#dcfce7', '#fef9c3', '#f1f5f9', '#0f172a'];
export const TEXT_COLORS = ['#0f172a', '#1d4ed8', '#dc2626', '#16a34a', '#7c3aed'];

export const PEN_SIZES = [1.2, 2.2, 4];
export const HIGHLIGHTER_SIZES = [9, 13, 20];
export const STROKE_SIZES = [1, 2, 4];
export const FONT_SIZES = [9, 11, 14, 18, 24, 32];

export const SHAPES = ['rect', 'rounded_rect', 'ellipse', 'line', 'arrow'];

export const DEFAULT_TOOL_OPTIONS = Object.freeze({
  pen: { color: PEN_COLORS[1], width: PEN_SIZES[1] },
  highlighter: { color: HIGHLIGHTER_COLORS[0], width: HIGHLIGHTER_SIZES[1] },
  shape: { shape: 'rect', stroke: STROKE_COLORS[0], strokeWidth: STROKE_SIZES[1], dash: 'solid', fill: null },
  text: { color: TEXT_COLORS[0], fontSize: FONT_SIZES[2], bold: false, align: 'left' },
  redact: { style: 'black', label: '' },
  mark: { color: PEN_COLORS[1] }
});

/** Rendered page size in pixels and inches (after rotation and crop). */
export function pageFrame(page) {
  const px = outputSize(page.width || 1, page.height || 1, page.edits);
  const dpi = page.dpi || 300;
  return { pxW: px.width, pxH: px.height, inW: px.width / dpi, inH: px.height / dpi };
}

function diagInches(page) {
  const f = pageFrame(page);
  return Math.hypot(f.inW, f.inH) || 1;
}

/** Points -> fraction of this page's diagonal. */
export function ptToFrac(points, page) {
  return points / 72 / diagInches(page);
}

/** Fraction of this page's diagonal -> points (rounded to 0.1). */
export function fracToPt(frac, page) {
  return Math.round(frac * diagInches(page) * 72 * 10) / 10;
}
