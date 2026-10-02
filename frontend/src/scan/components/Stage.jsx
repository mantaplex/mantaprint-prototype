import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { renderToCanvas, decodeBlob, mainThreadCanvasFactory, normalizeEdits, rotatedSize } from '../engine/render.js';
import { useZoomPan } from '../hooks/useZoomPan.js';
import { ZoomIn, ZoomOut, Maximize2, Eye } from 'lucide-react';

const PREVIEW_MAX = 1800;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Renders the active page (with its edits) to a canvas, offers zoom/pan and, in crop mode,
 * an interactive crop rectangle. The crop rectangle lives in the rotated+deskewed frame,
 * so in crop mode the stage shows that frame uncropped and draws the rectangle on top.
 */
export default function Stage({ page, cropMode, cropDraft, onCropDraft, compareOriginal, onToggleCompare, zoomApi }) {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const bitmapRef = useRef({ id: null, bmp: null });
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [rendering, setRendering] = useState(false);
  const renderSeq = useRef(0);

  const edits = useMemo(() => normalizeEdits(page?.edits), [page?.edits]);

  // Effective edits for the stage: in crop mode we show the uncropped frame.
  const stageEdits = useMemo(() => {
    if (compareOriginal) return { ...edits, brightness: 1, contrast: 1, bgClean: 0, filter: 'none', crop: cropMode ? null : edits.crop };
    return cropMode ? { ...edits, crop: null } : edits;
  }, [edits, cropMode, compareOriginal]);

  const { view, fit, zoomBy, setScaleCentered } = useZoomPan(containerRef, frame, { enabledDrag: true });

  // Decode the page blob once per page
  useEffect(() => {
    let cancelled = false;
    if (!page) {
      bitmapRef.current.bmp?.close?.();
      bitmapRef.current = { id: null, bmp: null };
      setFrame({ width: 0, height: 0 });
      return undefined;
    }
    if (bitmapRef.current.id === page.id) return undefined;
    (async () => {
      try {
        const bmp = await decodeBlob(page.blob);
        if (cancelled) { bmp.close?.(); return; }
        const prev = bitmapRef.current.bmp;
        if (prev?.close) prev.close();
        bitmapRef.current = { id: page.id, bmp };
        setFrame({ width: -1, height: -1 }); // force re-render effect
      } catch (e) {
        console.error('[Stage] decode failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [page]);

  useEffect(() => () => {
    bitmapRef.current.bmp?.close?.();
    bitmapRef.current = { id: null, bmp: null };
  }, []);

  // Render whenever the edits (or page bitmap) change
  useEffect(() => {
    const bmp = bitmapRef.current.bmp;
    if (!bmp || !page || bitmapRef.current.id !== page.id) return;
    const seq = ++renderSeq.current;
    setRendering(true);
    const raf = requestAnimationFrame(() => {
      try {
        const out = renderToCanvas(bmp, stageEdits, { canvasFactory: mainThreadCanvasFactory, maxDim: PREVIEW_MAX });
        if (seq !== renderSeq.current) return;
        const c = canvasRef.current;
        if (!c) return;
        c.width = out.width;
        c.height = out.height;
        c.getContext('2d').drawImage(out, 0, 0);
        // Logical (unscaled) frame size drives zoom-to-fit
        const rot = rotatedSize(bmp.width, bmp.height, stageEdits.rotation);
        const logical = stageEdits.crop
          ? { width: rot.width * stageEdits.crop.w, height: rot.height * stageEdits.crop.h }
          : rot;
        const scale = out.width / Math.max(1, logical.width);
        setFrame((f) => (f.width === out.width && f.height === out.height ? f : { width: out.width, height: out.height, scale }));
      } finally {
        if (seq === renderSeq.current) setRendering(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [stageEdits, page, frame.width === -1]);

  // Fit when the page or frame size changes
  const lastFitKey = useRef('');
  useEffect(() => {
    if (!frame.width || frame.width < 0) return;
    const key = `${page?.id}:${cropMode}:${stageEdits.rotation}`;
    if (lastFitKey.current !== key) {
      lastFitKey.current = key;
      fit();
    }
  }, [frame.width, frame.height, page?.id, cropMode, stageEdits.rotation, fit]);

  useEffect(() => {
    if (!zoomApi) return;
    zoomApi.current = { fit, zoomBy, setScaleCentered, get scale() { return view.scale; } };
  }, [zoomApi, fit, zoomBy, setScaleCentered, view.scale]);

  // Resize observer → refit if currently fitted
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (view.fitted) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, view.fitted]);

  // ---- Crop interaction -----------------------------------------------------
  const cropRect = cropMode ? (cropDraft || { x: 0.04, y: 0.04, w: 0.92, h: 0.92 }) : null;
  const dragRef = useRef(null);

  const clientToFrac = useCallback((clientX, clientY) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  }, []);

  const onHandleDown = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { handle, start: clientToFrac(e.clientX, e.clientY), rect: { ...cropRect } };
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const p = clientToFrac(e.clientX, e.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    let { x, y, w, h } = d.rect;
    const min = 0.05;
    if (d.handle === 'move') {
      x = Math.max(0, Math.min(1 - w, x + dx));
      y = Math.max(0, Math.min(1 - h, y + dy));
    } else {
      if (d.handle.includes('w')) { const nx = Math.max(0, Math.min(x + w - min, x + dx)); w = x + w - nx; x = nx; }
      if (d.handle.includes('e')) { w = Math.max(min, Math.min(1 - x, w + dx)); }
      if (d.handle.includes('n')) { const ny = Math.max(0, Math.min(y + h - min, y + dy)); h = y + h - ny; y = ny; }
      if (d.handle.includes('s')) { h = Math.max(min, Math.min(1 - y, h + dy)); }
    }
    onCropDraft({ x, y, w, h });
  };
  const onHandleUp = (e) => {
    if (dragRef.current) { try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {} }
    dragRef.current = null;
  };

  const handlePos = (hnd) => {
    const cx = hnd.includes('w') ? 0 : hnd.includes('e') ? 100 : 50;
    const cy = hnd.includes('n') ? 0 : hnd.includes('s') ? 100 : 50;
    return { left: `${cx}%`, top: `${cy}%` };
  };
  const cursorFor = (hnd) => ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[hnd]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[#0a0d14] select-none touch-none cursor-grab data-[dragging]:cursor-grabbing"
      style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '22px 22px', '--stage-dock-inset': '96px' }}
    >
      {!page && (
        <div className="absolute inset-0 flex items-center justify-center text-center p-8">
          <div>
            <div className="mx-auto h-16 w-16 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-500"><Eye className="w-7 h-7" /></div>
            <h3 className="mt-4 text-sm font-bold text-slate-200">{t('studio.stage.emptyTitle')}</h3>
            <p className="mt-1 text-xs text-slate-500 max-w-xs">{t('studio.stage.emptyDesc')}</p>
          </div>
        </div>
      )}

      <div
        className="absolute top-0 left-0 will-change-transform"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0' }}
      >
        <div className="relative bg-white shadow-[0_30px_60px_-12px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.08)]" style={{ width: frame.width > 0 ? frame.width : 0, height: frame.height > 0 ? frame.height : 0 }}>
          <canvas ref={canvasRef} className="block" style={{ width: '100%', height: '100%' }} />

          {cropRect && frame.width > 0 && (
            <div className="absolute inset-0" data-stage-interactive>
              {/* darkened outside */}
              <div className="absolute inset-0 bg-black/55 pointer-events-none" style={{
                clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${cropRect.x * 100}% ${cropRect.y * 100}%, ${cropRect.x * 100}% ${(cropRect.y + cropRect.h) * 100}%, ${(cropRect.x + cropRect.w) * 100}% ${(cropRect.y + cropRect.h) * 100}%, ${(cropRect.x + cropRect.w) * 100}% ${cropRect.y * 100}%, ${cropRect.x * 100}% ${cropRect.y * 100}%)`
              }} />
              <div
                className="absolute border-2 border-manta-400 shadow-[0_0_0_9999px_transparent]"
                style={{ left: `${cropRect.x * 100}%`, top: `${cropRect.y * 100}%`, width: `${cropRect.w * 100}%`, height: `${cropRect.h * 100}%`, cursor: 'move' }}
                onPointerDown={(e) => onHandleDown(e, 'move')}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              >
                {/* rule of thirds */}
                <div className="absolute inset-0 pointer-events-none opacity-60">
                  <div className="absolute left-1/3 top-0 bottom-0 border-l border-white/50" />
                  <div className="absolute left-2/3 top-0 bottom-0 border-l border-white/50" />
                  <div className="absolute top-1/3 left-0 right-0 border-t border-white/50" />
                  <div className="absolute top-2/3 left-0 right-0 border-t border-white/50" />
                </div>
                {HANDLES.map((hnd) => (
                  <div
                    key={hnd}
                    onPointerDown={(e) => onHandleDown(e, hnd)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    className="absolute -translate-x-1/2 -translate-y-1/2 crop-handle"
                    style={{ ...handlePos(hnd), cursor: cursorFor(hnd), transform: `translate(-50%, -50%) scale(${1 / Math.max(0.2, view.scale)})` }}
                  >
                    <div className="h-4 w-4 rounded-sm bg-manta-400 border-2 border-slate-950 shadow" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Stage HUD */}
      {page && (
        <>
          <div className="absolute top-3 left-3 flex items-center gap-1.5 pointer-events-none">
            <span className="px-2 py-1 rounded-lg bg-black/60 border border-white/10 text-[11px] font-mono text-slate-300">
              {page.width}×{page.height}px · {page.dpi || 300} DPI
            </span>
            {rendering && <span className="px-2 py-1 rounded-lg bg-manta-500/20 border border-manta-500/30 text-[10px] font-semibold text-manta-200">{t('studio.stage.rendering')}</span>}
            {compareOriginal && <span className="px-2 py-1 rounded-lg bg-amber-500/90 text-slate-950 text-[10px] font-bold">{t('studio.stage.original')}</span>}
          </div>
          <div className="absolute top-3 right-3 flex items-center gap-1 rounded-xl bg-black/60 border border-white/10 p-1">
            <button type="button" title={t('studio.stage.zoomOut')} onClick={() => zoomBy(1 / 1.25)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-200"><ZoomOut className="w-4 h-4" /></button>
            <button type="button" onClick={() => fit()} className="h-8 px-2 rounded-lg hover:bg-white/10 text-[11px] font-mono text-slate-200 min-w-[52px]">{Math.round(view.scale * 100)}%</button>
            <button type="button" title={t('studio.stage.zoomIn')} onClick={() => zoomBy(1.25)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-200"><ZoomIn className="w-4 h-4" /></button>
            <button type="button" title={t('studio.stage.fit')} onClick={() => fit()} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-200"><Maximize2 className="w-4 h-4" /></button>
            <button
              type="button"
              title={t('studio.stage.compare')}
              onPointerDown={() => onToggleCompare(true)}
              onPointerUp={() => onToggleCompare(false)}
              onPointerLeave={() => onToggleCompare(false)}
              className={`h-8 w-8 rounded-lg flex items-center justify-center ${compareOriginal ? 'bg-amber-500 text-slate-950' : 'hover:bg-white/10 text-slate-200'}`}
            >
              <Eye className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
