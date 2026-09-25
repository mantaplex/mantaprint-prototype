import React from 'react';
import {
  PenTool, Highlighter, Eraser, Trash2, Square, RectangleHorizontal, Circle, Minus, MoveRight, Plus, Check, X,
  Calendar, ImagePlus, ShieldCheck, ScanText, Copy, Loader2, AlertTriangle, Wand2, Crop, RotateCcw, RotateCw, CreditCard, Ban
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Segmented } from './ui.jsx';
import { Swatch, SizeDots } from './ObjectToolbar.jsx';
import {
  PEN_COLORS, HIGHLIGHTER_COLORS, STROKE_COLORS, FILL_COLORS, PEN_SIZES, HIGHLIGHTER_SIZES, STROKE_SIZES, SHAPES
} from '../engine/annotationStyles.js';
import { OCR_LANGS } from '../engine/ocr.js';

function Tile({ icon: Icon, label, active, onClick, title, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      aria-pressed={active}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-1 h-14 min-w-14 px-1 rounded-xl border text-[11px] font-semibold transition-colors disabled:opacity-40 ${
        active ? 'border-sky-400/70 bg-sky-500/15 text-sky-100' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:text-white'
      }`}
    >
      {Icon ? <Icon className="w-5 h-5" /> : children}
      {label && <span className="leading-none whitespace-nowrap">{label}</span>}
    </button>
  );
}

const Label = ({ children }) => <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1.5">{children}</div>;

export function DrawTray({ tool, onTool, opts, onOpts, onClearPage, pageNumber }) {
  const { t } = useI18n();
  const hl = tool === 'highlighter';
  const o = hl ? opts.highlighter : opts.pen;
  const setO = (patch) => onOpts(hl ? 'highlighter' : 'pen', patch);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5">
        <Tile icon={PenTool} label={t('studio.draw.pen')} active={tool === 'pen'} onClick={() => onTool('pen')} title={`${t('studio.draw.pen')} (P)`} />
        <Tile icon={Highlighter} label={t('studio.draw.highlighter')} active={hl} onClick={() => onTool('highlighter')} />
        <Tile icon={Eraser} label={t('studio.draw.eraser')} active={tool === 'eraser'} onClick={() => onTool('eraser')} title={`${t('studio.draw.eraser')} (E)`} />
      </div>
      {tool === 'eraser' ? (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-400">{t('studio.draw.eraserHint')}</p>
          <button type="button" onClick={onClearPage} className="w-full h-10 rounded-xl border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-xs font-semibold flex items-center justify-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" />{t('studio.draw.clearPage', { n: pageNumber })}
          </button>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <Label>{t('studio.draw.color')}</Label>
            <div className="flex gap-1.5">{(hl ? HIGHLIGHTER_COLORS : PEN_COLORS).map((c) => <Swatch key={c} color={c} active={o.color === c} onClick={() => setO({ color: c })} />)}</div>
          </div>
          <div>
            <Label>{t('studio.draw.size')}</Label>
            <SizeDots sizes={hl ? HIGHLIGHTER_SIZES : PEN_SIZES} value={o.width} onChange={(w) => setO({ width: w })} color={o.color} labels={[t('studio.draw.thin'), t('studio.draw.medium'), t('studio.draw.thick')]} />
          </div>
        </div>
      )}
    </div>
  );
}

const SHAPE_ICONS = { rect: Square, rounded_rect: RectangleHorizontal, ellipse: Circle, line: Minus, arrow: MoveRight };

export function ShapesTray({ opts, onOpts, onPick }) {
  const { t } = useI18n();
  const s = opts.shape;
  const linear = s.shape === 'line' || s.shape === 'arrow';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-1.5">
        {SHAPES.map((id) => <Tile key={id} icon={SHAPE_ICONS[id]} active={s.shape === id} onClick={() => onPick(id)} title={t(`studio.shapes.${id}`)} />)}
      </div>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <Label>{t('studio.shapes.stroke')}</Label>
          <div className="flex gap-1.5">{STROKE_COLORS.map((c) => <Swatch key={c} color={c} active={s.stroke === c} onClick={() => onOpts('shape', { stroke: c })} />)}</div>
        </div>
        <div>
          <Label>{t('studio.shapes.width')}</Label>
          <SizeDots sizes={STROKE_SIZES} value={s.strokeWidth} onChange={(w) => onOpts('shape', { strokeWidth: w })} color={s.stroke} />
        </div>
      </div>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <Segmented size="sm" value={s.dash} onChange={(v) => onOpts('shape', { dash: v })} options={['solid', 'dashed', 'dotted'].map((v) => ({ value: v, label: t(`studio.shapes.${v}`) }))} />
        {!linear && (
          <div>
            <Label>{t('studio.shapes.fill')}</Label>
            <div className="flex gap-1.5 items-center">
              <button type="button" onClick={() => onOpts('shape', { fill: null })} title={t('studio.shapes.noFill')} aria-label={t('studio.shapes.noFill')} aria-pressed={!s.fill} className={`h-6 w-6 rounded-full border border-white/30 flex items-center justify-center text-rose-400 ${!s.fill ? 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-900' : ''}`}><Ban className="w-4 h-4" /></button>
              {FILL_COLORS.map((c) => <Swatch key={c} color={c} active={s.fill === c} onClick={() => onOpts('shape', { fill: c })} />)}
            </div>
          </div>
        )}
      </div>
      <p className="text-[11px] text-slate-500">{t('studio.shapes.hint')}</p>
    </div>
  );
}

export function SignTray({ signatures, onUseSignature, onRemoveSignature, onNewSignature, onMark, onImage }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div>
        <Label>{t('studio.sign.signature')}</Label>
        <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
          {signatures.map((sig) => (
            <div key={sig.id} className="relative group shrink-0">
              <button type="button" onClick={() => onUseSignature(sig)} className="h-12 w-24 rounded-xl border border-white/10 bg-white hover:border-sky-400 flex items-center justify-center p-1" title={t('studio.sign.place')}>
                <img src={sig.src} alt="" className="max-h-full max-w-full object-contain" />
              </button>
              <button type="button" onClick={() => onRemoveSignature(sig.id)} title={t('studio.sign.removeSaved')} aria-label={t('studio.sign.removeSaved')} className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-slate-800 border border-white/20 text-slate-300 hidden group-hover:flex group-focus-within:flex items-center justify-center"><X className="w-3 h-3" /></button>
            </div>
          ))}
          <button type="button" onClick={onNewSignature} className="h-12 px-3 shrink-0 rounded-xl border border-dashed border-white/25 text-slate-300 hover:border-sky-400 hover:text-sky-200 flex items-center gap-1.5 text-xs font-semibold">
            <Plus className="w-4 h-4" />{signatures.length ? t('studio.sign.newSignature') : t('studio.sign.createSignature')}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <Tile icon={Check} label={t('studio.sign.check')} onClick={() => onMark('check')} />
        <Tile icon={X} label={t('studio.sign.cross')} onClick={() => onMark('cross')} />
        <Tile icon={Calendar} label={t('studio.sign.date')} onClick={() => onMark('date')} />
        <label className="flex flex-col items-center justify-center gap-1 h-14 min-w-14 px-1 rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:text-white text-[11px] font-semibold cursor-pointer" title={t('studio.sign.image')}>
          <ImagePlus className="w-5 h-5" /><span className="leading-none">{t('studio.sign.image')}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImage(f); }} />
        </label>
      </div>
    </div>
  );
}

export function RedactTray({ opts, onOpts }) {
  const { t } = useI18n();
  const r = opts.redact;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => onOpts('redact', { style: 'black' })} aria-pressed={r.style !== 'white'} className={`h-11 rounded-xl border flex items-center justify-center gap-2 text-xs font-semibold ${r.style !== 'white' ? 'border-sky-400/70 bg-sky-500/15 text-sky-100' : 'border-white/10 text-slate-300 hover:border-white/25'}`}><span className="w-7 h-3.5 rounded-sm bg-black border border-white/30" />{t('studio.redact.blackout')}</button>
        <button type="button" onClick={() => onOpts('redact', { style: 'white' })} aria-pressed={r.style === 'white'} className={`h-11 rounded-xl border flex items-center justify-center gap-2 text-xs font-semibold ${r.style === 'white' ? 'border-sky-400/70 bg-sky-500/15 text-sky-100' : 'border-white/10 text-slate-300 hover:border-white/25'}`}><span className="w-7 h-3.5 rounded-sm bg-white" />{t('studio.redact.whiteout')}</button>
      </div>
      <input
        type="text"
        value={r.label}
        maxLength={40}
        onChange={(e) => onOpts('redact', { label: e.target.value })}
        placeholder={t('studio.redact.label')}
        className="w-full h-9 px-3 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400/60"
      />
      <p className="text-[11px] leading-snug text-slate-400 flex gap-1.5"><ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px text-emerald-400" /><span>{t('studio.redact.hint')}</span></p>
    </div>
  );
}

export function OcrTray({ supported, page, state, progress, queuedCount, remaining, lang, onLang, auto, onAuto, onRunPage, onRunAll, onCopyPage, onCopyAll, busy }) {
  const { t } = useI18n();
  if (!supported) return <p className="text-xs text-amber-300 flex gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" />{t('studio.ocr.unsupported')}</p>;
  const words = page?.ocr?.words || [];
  const conf = words.length ? Math.round(words.reduce((s, w) => s + (w.c || 0), 0) / words.length) : 0;
  let status;
  if (progress !== undefined) status = <span className="text-sky-300 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{progress < 0 ? t('studio.ocr.stateQueued') : t('studio.ocr.stateRunning', { pct: Math.round(progress * 100) })}</span>;
  else if (state === 'done') status = <span className="text-emerald-300">{words.length ? t('studio.ocr.stateDone', { n: words.length, conf }) : t('studio.ocr.noText')}</span>;
  else if (state === 'stale') status = <span className="text-amber-300">{t('studio.ocr.stateStale')}</span>;
  else status = <span className="text-slate-400">{t('studio.ocr.stateNone')}</span>;
  return (
    <div className="space-y-3">
      <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/10 text-xs">{status}</div>
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={!page || progress !== undefined} onClick={onRunPage} className="h-10 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center justify-center gap-1.5"><ScanText className="w-4 h-4" />{t('studio.ocr.thisPage')}</button>
        <button type="button" disabled={!remaining || busy} onClick={onRunAll} className="h-10 rounded-xl border border-white/15 hover:border-white/30 disabled:opacity-40 text-slate-100 text-xs font-semibold flex items-center justify-center gap-1.5">{t('studio.ocr.allPages')}</button>
      </div>
      {(remaining > 0 || queuedCount > 0) && <p className="text-[11px] text-slate-500">{t('studio.ocr.remaining', { n: remaining })}</p>}
      <div>
        <Label>{t('studio.ocr.language')}</Label>
        <Segmented size="sm" value={lang} onChange={onLang} options={OCR_LANGS.map((l) => ({ value: l, label: t(`studio.ocr.langs.${l}`) }))} />
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="checkbox" checked={auto} onChange={(e) => onAuto(e.target.checked)} className="accent-sky-500 h-4 w-4" />{t('studio.ocr.auto')}
      </label>
      {state === 'done' && words.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <button type="button" onClick={onCopyPage} className="flex-1 h-9 rounded-xl border border-white/10 hover:border-white/25 text-xs font-semibold text-slate-200 flex items-center justify-center gap-1.5"><Copy className="w-3.5 h-3.5" />{t('studio.ocr.copyPage')}</button>
            <button type="button" onClick={onCopyAll} className="flex-1 h-9 rounded-xl border border-white/10 hover:border-white/25 text-xs font-semibold text-slate-200 flex items-center justify-center gap-1.5"><Copy className="w-3.5 h-3.5" />{t('studio.ocr.copyAll')}</button>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] leading-snug text-slate-300 bg-black/30 border border-white/5 rounded-lg p-2 select-text">{page.ocr.text}</pre>
          <p className="text-[11px] text-slate-500">{t('studio.ocr.selectHint')}</p>
        </div>
      )}
      <p className="text-[11px] text-slate-500 flex gap-1.5"><ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px text-emerald-400" />{t('studio.ocr.privacy')}</p>
    </div>
  );
}

export function AdjustTray({ onOpen, onRotate, hasPage }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-5 gap-1.5">
      <Tile icon={Wand2} label={t('studio.tools.enhance')} onClick={() => onOpen('enhance')} disabled={!hasPage} />
      <Tile icon={Crop} label={t('studio.tools.crop')} onClick={() => onOpen('crop')} disabled={!hasPage} />
      <Tile icon={RotateCcw} label={t('studio.tools.rotateLeft')} onClick={() => onRotate(-90)} disabled={!hasPage} />
      <Tile icon={RotateCw} label={t('studio.tools.rotateRight')} onClick={() => onRotate(90)} disabled={!hasPage} />
      <Tile icon={CreditCard} label={t('studio.tools.ktp')} onClick={() => onOpen('ktp')} disabled={!hasPage} />
    </div>
  );
}
