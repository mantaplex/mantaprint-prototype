import React from 'react';
import {
  ScanLine, ImagePlus, Layers, MousePointer2, Hand, PenTool, Highlighter, Eraser, Type, Square, Circle, Minus,
  MoveRight, RectangleHorizontal, FileSignature, ShieldCheck, ScanText, SlidersHorizontal, ZoomIn, ZoomOut
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';

const SHAPE_ICONS = { rect: Square, rounded_rect: RectangleHorizontal, ellipse: Circle, line: Minus, arrow: MoveRight };
const DRAW_ICONS = { pen: PenTool, highlighter: Highlighter, eraser: Eraser };

/**
 * Bottom tool dock (MantaPDF layout). Tools with options (▴) open a tray above the dock;
 * pressing them also switches to that tool. Order: acquire → edit → text → adjust → zoom.
 */
export default function ToolDock({
  tool, onTool, openTray, onOpenTray, isPhone, buttonRefs, pageCount, shape, drawTool, zoomPct, onZoomIn, onZoomOut, onFit, ocrBusy
}) {
  const { t } = useI18n();
  const noPages = pageCount === 0;
  const isDraw = tool === 'pen' || tool === 'highlighter' || tool === 'eraser';

  const groups = [
    [
      isPhone && { id: 'pages', tray: 'pages', icon: Layers, label: t('studio.tools.pages'), badge: pageCount },
      { id: 'scan', tray: 'scan', icon: ScanLine, label: t('studio.tools.scan'), accent: true },
      { id: 'import', tray: 'import', icon: ImagePlus, label: t('studio.tools.import') }
    ],
    [
      { id: 'select', icon: MousePointer2, label: t('studio.tools.select'), active: tool === 'select', onClick: () => onTool('select'), needsPage: true, title: `${t('studio.tools.select')} (V)` },
      { id: 'pan', icon: Hand, label: t('studio.tools.pan'), active: tool === 'pan', onClick: () => onTool('pan'), needsPage: true, title: `${t('studio.tools.pan')} (H)` },
      { id: 'draw', tray: 'draw', icon: DRAW_ICONS[drawTool] || PenTool, label: t('studio.tools.draw'), active: isDraw, onClick: () => { if (!isDraw) onTool(drawTool || 'pen'); onOpenTray(openTray === 'draw' ? null : 'draw'); }, needsPage: true, title: `${t('studio.tools.draw')} (P)` },
      { id: 'text', icon: Type, label: t('studio.tools.text'), active: tool === 'text', onClick: () => onTool('text'), needsPage: true, title: `${t('studio.tools.text')} (T)` },
      { id: 'shapes', tray: 'shapes', icon: SHAPE_ICONS[shape] || Square, label: t('studio.tools.shapes'), active: tool === 'shape', onClick: () => { onTool('shape'); onOpenTray(openTray === 'shapes' ? null : 'shapes'); }, needsPage: true },
      { id: 'sign', tray: 'sign', icon: FileSignature, label: t('studio.tools.sign'), needsPage: true },
      { id: 'redact', tray: 'redact', icon: ShieldCheck, label: t('studio.tools.redact'), active: tool === 'redact', onClick: () => { onTool('redact'); onOpenTray(openTray === 'redact' ? null : 'redact'); }, needsPage: true }
    ],
    [
      { id: 'ocr', tray: 'ocr', icon: ScanText, label: t('studio.tools.ocr'), needsPage: true, busy: ocrBusy },
      { id: 'adjust', tray: 'adjust', icon: SlidersHorizontal, label: t('studio.tools.adjust'), needsPage: true }
    ]
  ].map((g) => g.filter(Boolean));

  const renderButton = (it) => {
    const trayOpen = it.tray && openTray === it.tray;
    const active = it.active || trayOpen;
    const disabled = it.needsPage && noPages;
    const onClick = it.onClick || (() => onOpenTray(trayOpen ? null : it.tray));
    return (
      <button
        key={it.id}
        ref={(el) => { if (buttonRefs && it.tray) buttonRefs.current[it.tray] = el; }}
        type="button"
        disabled={disabled}
        aria-pressed={active}
        aria-expanded={it.tray ? trayOpen : undefined}
        onClick={onClick}
        className={`relative flex flex-col items-center justify-center gap-0.5 min-w-[54px] sm:min-w-[60px] h-[56px] rounded-xl text-[10px] font-semibold transition-colors disabled:opacity-35 disabled:pointer-events-none shrink-0 ${
          it.active ? 'bg-manta-600 text-white' : trayOpen ? 'bg-white/15 text-white' : it.accent ? 'text-manta-300 hover:bg-manta-500/15' : 'text-slate-300 hover:bg-white/10 hover:text-white'
        }`}
        title={it.title || (it.badge ? `${it.label} (${it.badge})` : it.label)}
        aria-label={it.label}
      >
        <it.icon className={`w-5 h-5 ${it.busy ? 'animate-pulse text-sky-300' : ''}`} />
        <span className="leading-none">{it.label}</span>
        {it.badge !== undefined && it.badge > 0 && (
          <span aria-hidden="true" className="absolute top-1 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-manta-600 text-white text-[9px] font-black flex items-center justify-center">{it.badge}</span>
        )}
        {it.tray && it.tray !== 'pages' && <span aria-hidden="true" className={`absolute top-1 right-1.5 text-[8px] ${trayOpen ? 'text-white rotate-180' : 'text-slate-500'}`}>▴</span>}
      </button>
    );
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-2 pb-[max(10px,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-[0_20px_40px_-4px_rgba(0,0,0,0.85)] p-1.5 max-w-full overflow-x-auto no-scrollbar">
        {groups.map((g, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <span className="w-px h-8 bg-white/10 mx-1 shrink-0" />}
            {g.map(renderButton)}
          </React.Fragment>
        ))}
        {!isPhone && (
          <>
            <span className="w-px h-8 bg-white/10 mx-1 shrink-0" />
            <button type="button" onClick={onZoomOut} disabled={noPages} title={`${t('studio.tools.zoomOut')} (-)`} aria-label={t('studio.tools.zoomOut')} className="h-10 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-300 disabled:opacity-35 shrink-0"><ZoomOut className="w-4 h-4" /></button>
            <button type="button" onClick={onFit} disabled={noPages} title={`${t('studio.tools.fit')} (0)`} className="h-10 px-1.5 rounded-lg hover:bg-white/10 text-[11px] font-mono text-slate-200 min-w-[50px] disabled:opacity-35 shrink-0">{zoomPct}%</button>
            <button type="button" onClick={onZoomIn} disabled={noPages} title={`${t('studio.tools.zoomIn')} (+)`} aria-label={t('studio.tools.zoomIn')} className="h-10 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-300 disabled:opacity-35 shrink-0"><ZoomIn className="w-4 h-4" /></button>
          </>
        )}
      </div>
    </div>
  );
}
