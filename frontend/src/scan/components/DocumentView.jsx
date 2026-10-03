import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PageView from './PageView.jsx';
import { pageFrame } from '../engine/annotationStyles.js';

const CSS_DPI = 96;
const GAP = 20;
const PAD_TOP = 64;
const PAD_BOTTOM = 150;
const PAD_X = 24;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/**
 * All pages of the document in one vertically scrolling column (like a PDF reader).
 * Pages keep their physical size relative to each other; 100 % zoom is real size.
 * Only pages near the viewport get a full-resolution image, a text layer and objects.
 */
export default function DocumentView({
  pages, activeId, onActivate, tool, toolOpts, selection, onSelect, editing, onEditText,
  api, zoomApi, findHits, isTouch, labels, onZoomChange
}) {
  const scrollRef = useRef(null);
  const gestureRef = useRef({ active: false });
  const [viewport, setViewport] = useState({ w: 0, h: 0, top: 0 });
  const [zoom, setZoom] = useState(1);
  const [fitted, setFitted] = useState(true);
  const anchor = useRef(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  const frames = useMemo(() => pages.map((p) => pageFrame(p)), [pages]);
  const maxInW = useMemo(() => Math.max(1, ...frames.map((f) => f.inW)), [frames]);

  const layout = useMemo(() => {
    let y = PAD_TOP;
    const items = frames.map((f) => {
      const w = f.inW * CSS_DPI * zoom;
      const h = f.inH * CSS_DPI * zoom;
      const item = { top: y, w, h };
      y += h + GAP;
      return item;
    });
    const contentW = Math.max(viewport.w, maxInW * CSS_DPI * zoom + PAD_X * 2);
    return { items, height: y - GAP + PAD_BOTTOM, width: contentW };
  }, [frames, zoom, viewport.w, maxInW]);

  const fitZoom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return 1;
    const avail = el.clientWidth - PAD_X * 2;
    return clampZoom(Math.min(1.6, avail / (maxInW * CSS_DPI)));
  }, [maxInW]);

  // ---- viewport tracking --------------------------------------------------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight, top: el.scrollTop });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);

  // Fit width on first layout and when the window changes size while fitted
  useEffect(() => {
    if (fitted && viewport.w) setZoom(fitZoom());
  }, [fitted, viewport.w, fitZoom]);

  useEffect(() => { onZoomChange?.(zoom); }, [zoom, onZoomChange]);

  // Active page = the one crossing 35 % of the viewport height
  const lastReported = useRef(null);
  useEffect(() => {
    if (!layout.items.length) return;
    const probe = viewport.top + viewport.h * 0.35;
    let idx = layout.items.findIndex((it) => probe >= it.top - GAP && probe < it.top + it.h);
    if (idx < 0) idx = probe < layout.items[0].top ? 0 : layout.items.length - 1;
    const id = pages[idx]?.id;
    if (id && id !== lastReported.current) {
      lastReported.current = id;
      if (id !== activeId) onActivate(id, { fromScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.top, viewport.h, layout]);

  // ---- zoom with an anchor that stays under the cursor/fingers -------------
  const pointToAnchor = useCallback((clientX, clientY) => {
    const el = scrollRef.current;
    const r = el.getBoundingClientRect();
    const vx = clientX - r.left; const vy = clientY - r.top;
    const cx = el.scrollLeft + vx; const cy = el.scrollTop + vy;
    const items = layout.items;
    let i = items.findIndex((it) => cy < it.top + it.h + GAP / 2);
    if (i < 0) i = items.length - 1;
    if (i < 0) return null;
    const it = items[i];
    const left = (layout.width - it.w) / 2;
    return { i, fx: (cx - left) / it.w, fy: (cy - it.top) / it.h, vx, vy };
  }, [layout]);

  const zoomTo = useCallback((z, clientX, clientY) => {
    const el = scrollRef.current;
    if (!el) return;
    const nz = clampZoom(z);
    if (Math.abs(nz - zoomRef.current) < 1e-4) return;
    if (clientX === undefined) {
      const r = el.getBoundingClientRect();
      clientX = r.left + el.clientWidth / 2; clientY = r.top + el.clientHeight / 2;
    }
    anchor.current = pointToAnchor(clientX, clientY);
    setFitted(false);
    setZoom(nz);
  }, [pointToAnchor]);

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    const it = layout.items[a.i];
    if (!it) return;
    const left = (layout.width - it.w) / 2;
    el.scrollLeft = left + a.fx * it.w - a.vx;
    el.scrollTop = it.top + a.fy * it.h - a.vy;
  }, [layout]);

  const scrollToPage = useCallback((id, { behavior = 'smooth', offsetFrac = null } = {}) => {
    const el = scrollRef.current;
    const i = pages.findIndex((p) => p.id === id);
    if (!el || i < 0) return;
    const it = layout.items[i];
    if (!it) return;
    const top = offsetFrac === null ? it.top - PAD_TOP + 8 : it.top + offsetFrac * it.h - el.clientHeight * 0.35;
    lastReported.current = id;
    el.scrollTo({ top: Math.max(0, top), behavior });
  }, [pages, layout]);

  /** Centre of the visible part of a page, in page fractions (where to drop new objects). */
  const visibleCenter = useCallback((id) => {
    const el = scrollRef.current;
    const i = pages.findIndex((p) => p.id === id);
    if (!el || i < 0) return { x: 0.5, y: 0.5 };
    const it = layout.items[i];
    if (!it) return { x: 0.5, y: 0.5 };
    const top = Math.max(it.top, el.scrollTop);
    const bottom = Math.min(it.top + it.h, el.scrollTop + el.clientHeight - 110);
    const cy = bottom > top ? (top + bottom) / 2 : it.top + it.h / 2;
    return { x: 0.5, y: Math.max(0.05, Math.min(0.95, (cy - it.top) / it.h)) };
  }, [pages, layout]);

  useEffect(() => {
    if (!zoomApi) return;
    zoomApi.current = {
      zoomBy: (f) => zoomTo(zoomRef.current * f),
      setZoom: (z) => zoomTo(z),
      fit: () => { setFitted(true); setZoom(fitZoom()); },
      get zoom() { return zoomRef.current; },
      scrollToPage,
      visibleCenter
    };
  }, [zoomApi, zoomTo, fitZoom, scrollToPage, visibleCenter]);

  // Ctrl/⌘ + wheel (and trackpad pinch) zoom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Two-finger pinch/pan on touch screens (one finger scrolls or draws)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let g = null;
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e) => {
      if (e.touches.length !== 2) return;
      gestureRef.current.active = true;
      g = { d: dist(e.touches), z: zoomRef.current, m: mid(e.touches) };
    };
    const onMove = (e) => {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      el.scrollLeft -= m.x - g.m.x;
      el.scrollTop -= m.y - g.m.y;
      g.m = m;
      zoomTo(g.z * (dist(e.touches) / g.d), m.x, m.y);
    };
    const onEnd = (e) => {
      if (e.touches.length < 2) g = null;
      if (e.touches.length === 0) setTimeout(() => { gestureRef.current.active = false; }, 0);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo]);

  // Pan tool: drag to scroll with a mouse or pen
  const panRef = useRef(null);
  const onPanDown = (e) => {
    if (tool !== 'pan' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'touch') return; // native scrolling already pans
    const el = scrollRef.current;
    panRef.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPanMove = (e) => {
    const p = panRef.current;
    if (!p) return;
    const el = scrollRef.current;
    el.scrollLeft = p.l - (e.clientX - p.x);
    el.scrollTop = p.t - (e.clientY - p.y);
  };
  const onPanUp = () => { panRef.current = null; };

  // Copy selected OCR text with real spaces and line breaks
  const onCopy = (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const spans = [...scrollRef.current.querySelectorAll('[data-ocr-word]')].filter((s) => sel.containsNode(s, true));
    if (!spans.length) return;
    let out = '';
    let prev = null;
    for (const s of spans) {
      const key = `${s.dataset.ocrPage}:${s.dataset.ocrLine}`;
      if (prev !== null) out += prev.split(':')[0] !== s.dataset.ocrPage ? '\n\n' : prev !== key ? '\n' : ' ';
      out += s.textContent;
      prev = key;
    }
    e.clipboardData.setData('text/plain', out);
    e.preventDefault();
  };

  const nearTop = viewport.top - viewport.h * 0.75;
  const nearBottom = viewport.top + viewport.h * 1.75;

  return (
    <div
      ref={scrollRef}
      className={`absolute inset-0 overflow-auto overscroll-contain ${tool === 'pan' ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      onPointerDown={onPanDown}
      onPointerMove={onPanMove}
      onPointerUp={onPanUp}
      onPointerCancel={onPanUp}
      onCopy={onCopy}
      onClick={(e) => { if (e.target === scrollRef.current || e.target.dataset?.docCanvas !== undefined) onSelect(null, null); }}
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }} data-doc-canvas="">
        {pages.map((p, i) => {
          const it = layout.items[i];
          if (!it) return null;
          const near = it.top + it.h >= nearTop && it.top <= nearBottom;
          const left = (layout.width - it.w) / 2;
          return (
            <div key={p.id} className="absolute" style={{ left, top: it.top, width: it.w, height: it.h }}>
              <div className={`absolute -top-6 left-0 text-[10px] font-mono ${p.id === activeId ? 'text-sky-300' : 'text-slate-500'}`}>{i + 1}</div>
              <PageView
                page={p}
                index={i}
                dispW={it.w}
                dispH={it.h}
                dpr={dpr}
                near={near}
                tool={tool}
                toolOpts={toolOpts}
                selectedId={selection?.pageId === p.id ? selection.id : null}
                editingId={editing?.pageId === p.id ? editing.id : null}
                onSelect={onSelect}
                onEditText={onEditText}
                onActivate={onActivate}
                api={api}
                findHits={findHits?.[p.id]}
                gestureRef={gestureRef}
                isTouch={isTouch}
                labels={labels}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
