import React from 'react';
import { Trash2, Copy, Pencil, Bold, AlignLeft, AlignCenter, AlignRight, Minus, Plus, Ban } from 'lucide-react';
import { getBounds, annotationId, translate } from '../engine/annotations.js';
import {
  PEN_COLORS, HIGHLIGHTER_COLORS, STROKE_COLORS, TEXT_COLORS, FILL_COLORS,
  PEN_SIZES, HIGHLIGHTER_SIZES, STROKE_SIZES, FONT_SIZES, ptToFrac, fracToPt
} from '../engine/annotationStyles.js';

export function Swatch({ color, active, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || color}
      aria-label={title || color}
      aria-pressed={active}
      className={`h-6 w-6 rounded-full border border-black/20 shrink-0 transition-transform hover:scale-110 ${active ? 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-900' : ''}`}
      style={{ background: color }}
    />
  );
}

export function SizeDots({ sizes, value, onChange, color = '#e2e8f0', labels = [] }) {
  return (
    <div className="flex items-center gap-1">
      {sizes.map((s, i) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          title={labels[i] || `${s} pt`}
          aria-label={labels[i] || `${s} pt`}
          aria-pressed={Math.abs(value - s) < 0.01}
          className={`h-7 w-7 rounded-lg flex items-center justify-center ${Math.abs(value - s) < 0.01 ? 'bg-sky-500/25 ring-1 ring-sky-400' : 'hover:bg-white/10'}`}
        >
          <span className="rounded-full" style={{ width: 3 + i * 3, height: 3 + i * 3, background: color }} />
        </button>
      ))}
    </div>
  );
}

const nearest = (list, v) => list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);
const Sep = () => <span className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />;
const Btn = ({ icon: Icon, onClick, title, active, danger }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-sky-500/25 text-sky-200' : danger ? 'text-rose-300 hover:bg-rose-500/20' : 'text-slate-200 hover:bg-white/10'}`}
  >
    <Icon className="w-4 h-4" />
  </button>
);

/** Floating toolbar above the selected object. */
export default function ObjectToolbar({ a, page, W, H, api, onEdit, labels }) {
  const b = getBounds(a);
  const set = (patch) => api.update(page.id, a.id, patch);
  const top = b.y * H - 48;
  const placeBelow = top < 4;
  const style = {
    left: Math.max(4, Math.min(W - 8, b.x * W + (b.w * W) / 2)),
    top: placeBelow ? (b.y + b.h) * H + 12 : top,
    transform: 'translateX(-50%)'
  };

  let colors = null; let colorKey = 'color';
  if (a.type === 'ink') colors = a.tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  else if (a.type === 'shape') { colors = STROKE_COLORS; colorKey = 'stroke'; }
  else if (a.type === 'text') colors = TEXT_COLORS;
  else if (a.type === 'mark') colors = PEN_COLORS;

  const widthKey = a.type === 'ink' ? 'width' : a.type === 'shape' ? 'strokeWidth' : null;
  const widthSizes = a.type === 'ink' ? (a.tool === 'highlighter' ? HIGHLIGHTER_SIZES : PEN_SIZES) : STROKE_SIZES;

  const duplicate = () => {
    const copy = { ...translate(a, 0.02, 0.02), id: annotationId() };
    api.add(page.id, copy);
    api.select(page.id, copy.id);
  };

  const stepFont = (dir) => {
    const cur = nearest(FONT_SIZES, fracToPt(a.fontSize, page));
    const i = Math.max(0, Math.min(FONT_SIZES.length - 1, FONT_SIZES.indexOf(cur) + dir));
    const fontSize = ptToFrac(FONT_SIZES[i], page);
    set({ fontSize, h: (a.h * fontSize) / a.fontSize });
  };

  return (
    <div
      data-object-toolbar
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-20 flex items-center gap-1 rounded-xl bg-slate-900/95 backdrop-blur border border-white/10 shadow-xl px-1.5 py-1 whitespace-nowrap max-w-[calc(100vw-24px)] overflow-x-auto no-scrollbar"
      style={style}
    >
      {colors && (
        <>
          {colors.map((c) => <Swatch key={c} color={c} active={(a[colorKey] || '').toLowerCase() === c} onClick={() => set({ [colorKey]: c })} />)}
          <Sep />
        </>
      )}
      {widthKey && (
        <>
          <SizeDots sizes={widthSizes} value={nearest(widthSizes, fracToPt(a[widthKey], page))} onChange={(s) => set({ [widthKey]: ptToFrac(s, page) })} color={a[colorKey] || '#e2e8f0'} />
          <Sep />
        </>
      )}
      {a.type === 'shape' && a.shape !== 'line' && a.shape !== 'arrow' && (
        <>
          <Btn icon={Ban} title={labels.noFill} active={!a.fill} onClick={() => set({ fill: null })} />
          {FILL_COLORS.slice(0, 4).map((c) => <Swatch key={c} color={c} active={a.fill === c} onClick={() => set({ fill: c })} title={labels.fill} />)}
          <Sep />
        </>
      )}
      {a.type === 'text' && (
        <>
          <Btn icon={Minus} title={labels.smaller} onClick={() => stepFont(-1)} />
          <span className="text-[11px] font-mono text-slate-300 w-8 text-center">{Math.round(fracToPt(a.fontSize, page))}</span>
          <Btn icon={Plus} title={labels.larger} onClick={() => stepFont(1)} />
          <Btn icon={Bold} title={labels.bold} active={a.bold} onClick={() => set({ bold: !a.bold })} />
          <Btn icon={a.align === 'center' ? AlignCenter : a.align === 'right' ? AlignRight : AlignLeft} title={labels.align} onClick={() => set({ align: a.align === 'left' || !a.align ? 'center' : a.align === 'center' ? 'right' : 'left' })} />
          <Btn icon={Pencil} title={labels.editText} onClick={onEdit} />
          <Sep />
        </>
      )}
      {a.type === 'redact' && (
        <>
          <button type="button" onClick={() => set({ style: 'black' })} className={`h-7 px-2 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 ${a.style !== 'white' ? 'bg-sky-500/25 text-sky-100' : 'text-slate-300 hover:bg-white/10'}`}><span className="w-4 h-2.5 bg-black border border-white/30 rounded-sm" />{labels.blackout}</button>
          <button type="button" onClick={() => set({ style: 'white' })} className={`h-7 px-2 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 ${a.style === 'white' ? 'bg-sky-500/25 text-sky-100' : 'text-slate-300 hover:bg-white/10'}`}><span className="w-4 h-2.5 bg-white rounded-sm" />{labels.whiteout}</button>
          <Sep />
        </>
      )}
      <Btn icon={Copy} title={labels.duplicate} onClick={duplicate} />
      <Btn icon={Trash2} title={labels.delete} danger onClick={() => api.remove(page.id, a.id)} />
    </div>
  );
}
