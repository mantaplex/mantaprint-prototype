/**
 * Zoom & pan for the stage. Mouse: Ctrl/⌘ + wheel zooms around the cursor, wheel pans,
 * drag pans (when the tool allows). Touch/pen (pointer events): one finger pans, two
 * fingers pinch-zoom around the midpoint. Zoom is a single CSS transform, so nothing
 * re-renders during a gesture (the MantaPDF approach).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const MIN = 0.1;
const MAX = 6;

export function useZoomPan(containerRef, contentSize, { enabledDrag = true } = {}) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fitted: false });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map());
  const gesture = useRef(null);

  // Fits the content inside the container, leaving room for the tool dock at the bottom
  // (`--stage-dock-inset`, set by the workbench) so the page never hides behind it.
  const fit = useCallback((padding = 28) => {
    const el = containerRef.current;
    if (!el || !contentSize.width || !contentSize.height) return;
    const dockInset = parseFloat(getComputedStyle(el).getPropertyValue('--stage-dock-inset')) || 0;
    const topInset = 56; // HUD row
    const cw = el.clientWidth - padding * 2;
    const ch = el.clientHeight - padding * 2 - dockInset - topInset;
    const scale = Math.max(MIN, Math.min(cw / contentSize.width, ch / contentSize.height));
    const x = (el.clientWidth - contentSize.width * scale) / 2;
    const y = topInset + padding + (ch - contentSize.height * scale) / 2;
    setView({ scale, x, y, fitted: true });
  }, [containerRef, contentSize.width, contentSize.height]);

  const zoomAt = useCallback((factor, cx, cy) => {
    setView((v) => {
      const scale = Math.max(MIN, Math.min(MAX, v.scale * factor));
      const ratio = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio, fitted: false };
    });
  }, []);

  const zoomBy = useCallback((factor) => {
    const el = containerRef.current;
    if (!el) return;
    zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  }, [containerRef, zoomAt]);

  const setScaleCentered = useCallback((scale) => {
    const el = containerRef.current;
    if (!el) return;
    const v = viewRef.current;
    zoomAt(scale / v.scale, el.clientWidth / 2, el.clientHeight / 2);
  }, [containerRef, zoomAt]);

  // Wheel
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0022);
        zoomAt(factor, cx, cy);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY, fitted: false }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [containerRef, zoomAt]);

  // Pointer drag / pinch
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rectOf = () => el.getBoundingClientRect();

    const onDown = (e) => {
      if (e.target.closest?.('[data-stage-interactive]')) return; // crop handles etc.
      if (e.pointerType === 'mouse' && (e.button !== 0 || !enabledDrag)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture?.(e.pointerId);
      const pts = [...pointers.current.values()];
      const v = viewRef.current;
      if (pts.length === 1) {
        gesture.current = { type: 'pan', start: pts[0], origin: { x: v.x, y: v.y } };
      } else if (pts.length === 2) {
        const r = rectOf();
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
        gesture.current = { type: 'pinch', dist, mid, origin: { ...v } };
      }
      el.dataset.dragging = '1';
    };
    const onMove = (e) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      if (!g) return;
      const pts = [...pointers.current.values()];
      if (g.type === 'pan' && pts.length === 1) {
        e.preventDefault();
        setView((v) => ({ ...v, x: g.origin.x + (pts[0].x - g.start.x), y: g.origin.y + (pts[0].y - g.start.y), fitted: false }));
      } else if (g.type === 'pinch' && pts.length === 2) {
        e.preventDefault();
        const r = rectOf();
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
        const scale = Math.max(MIN, Math.min(MAX, g.origin.scale * (dist / g.dist)));
        const ratio = scale / g.origin.scale;
        setView({
          scale,
          x: mid.x - (g.mid.x - g.origin.x) * ratio,
          y: mid.y - (g.mid.y - g.origin.y) * ratio,
          fitted: false
        });
      }
    };
    const onUp = (e) => {
      pointers.current.delete(e.pointerId);
      try { el.releasePointerCapture?.(e.pointerId); } catch {}
      if (pointers.current.size === 0) {
        gesture.current = null;
        delete el.dataset.dragging;
      } else if (pointers.current.size === 1) {
        const [p] = [...pointers.current.values()];
        const v = viewRef.current;
        gesture.current = { type: 'pan', start: p, origin: { x: v.x, y: v.y } };
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [containerRef, enabledDrag]);

  return { view, setView, fit, zoomBy, setScaleCentered };
}
