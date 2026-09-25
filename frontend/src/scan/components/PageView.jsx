import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnotationLayer, { layoutText } from './AnnotationLayer.jsx';
import ObjectToolbar from './ObjectToolbar.jsx';
import { usePageImage } from '../hooks/usePageImage.js';
import {
  annotationId, getBounds, pickAnnotation, translate, resizeTo, frameDiag,
  redactionRects, overlaps, TEXT_LINE_HEIGHT, ANNOTATION_FONT
} from '../engine/annotations.js';
import { visibleWords, ocrState } from '../engine/ocrText.js';
import { ptToFrac } from '../engine/annotationStyles.js';

const DRAW_TOOLS = new Set(['pen', 'highlighter', 'eraser', 'text', 'shape', 'redact']);
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const KEEP_ASPECT = new Set(['image', 'mark']);
const MIN = 0.004;

let wordCtx = null;
function measureWord(t, px) {
  if (!wordCtx) wordCtx = document.createElement('canvas').getContext('2d');
  wordCtx.font = `${px}px ${ANNOTATION_FONT}`;
  return wordCtx.measureText(t).width || 1;
}

function TextLayer({ words, W, H, pageId, enabled }) {
  return (
    <div className={`absolute inset-0 isolate ${enabled ? 'select-text' : 'pointer-events-none select-none'}`} data-text-layer>
      {words.map((w, i) => {
        const px = Math.max(4, w.h * H * 0.92);
        const sx = (w.w * W) / measureWord(w.t, px);
        return (
          <span
            key={i}
            data-ocr-word={i}
            data-ocr-page={pageId}
            data-ocr-line={w.l}
            className="absolute whitespace-pre text-transparent leading-none origin-top-left cursor-text select-text selection:bg-sky-400/40"
            style={{ left: w.x * W, top: w.y * H, fontSize: px, fontFamily: ANNOTATION_FONT, transform: `scaleX(${sx})` }}
          >
            {w.t}
          </span>
        );
      })}
      {/* pdf.js "endOfContent": empty space under the words, last in DOM order, so a drag
          that leaves the words extends the selection forward instead of jumping to the top. */}
      <div className="absolute inset-0 -z-10 select-none cursor-default" aria-hidden="true" />
    </div>
  );
}

/**
 * Text editor over a text object. It keeps its own value so fast typing never waits for
 * the document store (a controlled input fed from the store drops keystrokes).
 */
function TextEditor({ a, W, H, diag, placeholder, onText, onDone }) {
  const [value, setValue] = useState(a.text || '');
  return (
    <textarea
      data-text-editor
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => { setValue(e.target.value); onText(e.target.value); }}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); e.stopPropagation(); }}
      className="absolute resize-none overflow-hidden bg-sky-50/60 outline-2 outline-dashed outline-sky-500 p-0 m-0 border-0"
      style={{
        left: a.x * W,
        top: a.y * H,
        width: a.w * W,
        height: Math.max(a.h * H, a.fontSize * diag * TEXT_LINE_HEIGHT) + 2,
        font: `${a.bold ? 700 : 400} ${Math.max(4, a.fontSize * diag)}px ${ANNOTATION_FONT}`,
        lineHeight: TEXT_LINE_HEIGHT,
        color: a.color,
        textAlign: a.align || 'left'
      }}
    />
  );
}

function SelectionBox({ a, W, H, onHandleDown, onBodyDown, onDoubleClick }) {
  const b = getBounds(a);
  const pad = 4;
  const left = b.x * W - pad; const top = b.y * H - pad;
  const width = b.w * W + pad * 2; const height = b.h * H + pad * 2;
  const isLine = a.type === 'shape' && (a.shape === 'line' || a.shape === 'arrow');
  const knob = 'absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 border-sky-500 shadow touch-none';
  if (isLine) {
    return (
      <>
        <div className="absolute border border-dashed border-sky-400/70 pointer-events-none" style={{ left, top, width, height }} />
        {[['p1', a.x1, a.y1], ['p2', a.x2, a.y2]].map(([id, x, y]) => (
          <div key={id} data-handle={id} className={`${knob} cursor-move`} style={{ left: x * W, top: y * H }} onPointerDown={(e) => onHandleDown(e, id)} />
        ))}
      </>
    );
  }
  const pos = (h) => ({
    left: h.includes('w') ? left : h.includes('e') ? left + width : left + width / 2,
    top: h.includes('n') ? top : h.includes('s') ? top + height : top + height / 2
  });
  const cursor = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  const handles = KEEP_ASPECT.has(a.type) ? ['nw', 'ne', 'se', 'sw'] : HANDLES;
  return (
    <>
      <div
        data-handle="body"
        className="absolute border-2 border-sky-500 rounded-sm cursor-move touch-none"
        style={{ left, top, width, height }}
        onPointerDown={onBodyDown}
        onDoubleClick={onDoubleClick}
      />
      {handles.map((h) => (
        <div key={h} data-handle={h} className={knob} style={{ ...pos(h), cursor: cursor[h] }} onPointerDown={(e) => onHandleDown(e, h)} />
      ))}
    </>
  );
}

function PageView({
  page, index, dispW, dispH, dpr, near, tool, toolOpts, selectedId, editingId, onSelect, onEditText,
  onActivate, api, findHits, gestureRef, isTouch, labels
}) {
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const annotations = page.annotations || [];
  const url = usePageImage(page, Math.max(dispW, dispH) * dpr, near);
  const diag = frameDiag(dispW, dispH);
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : null;
  const editing = editingId ? annotations.find((a) => a.id === editingId) : null;

  const words = useMemo(() => {
    if (!near || ocrState(page) !== 'done') return [];
    return visibleWords(page.ocr.words, redactionRects(annotations), overlaps);
  }, [near, page, annotations]);

  const toFrac = useCallback((e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }, []);

  const tol = isTouch ? 14 : 6;

  // ---- gesture plumbing -------------------------------------------------------
  const capture = (e) => { try { wrapRef.current.setPointerCapture(e.pointerId); } catch {} };
  const cancelled = () => gestureRef?.current?.active;

  const startMove = (e, a) => {
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    drag.current = { kind: 'move', start: toFrac(e), orig: a, begun: false };
  };

  const onHandleDown = (e, handle) => {
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    drag.current = { kind: 'resize', handle, start: toFrac(e), orig: selected, bounds: getBounds(selected), begun: false };
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (!e.isPrimary) return;
    if (e.target.closest?.('[data-object-toolbar],[data-text-editor]')) return;
    onActivate(page.id);
    const p = toFrac(e);

    if (tool === 'select') {
      if (e.target.closest?.('[data-handle]')) return;
      const hit = pickAnnotation(annotations, p, dispW, dispH, tol);
      if (hit) {
        onSelect(page.id, hit.id);
        startMove(e, hit);
      } else {
        onSelect(page.id, null);
      }
      return;
    }
    if (!DRAW_TOOLS.has(tool)) return;
    e.preventDefault();
    capture(e);
    onSelect(page.id, null);

    if (tool === 'pen' || tool === 'highlighter') {
      const o = toolOpts[tool];
      drag.current = { kind: 'ink', points: [[p.x, p.y]] };
      setDraft({ id: 'draft', type: 'ink', tool, points: [[p.x, p.y]], color: o.color, width: ptToFrac(o.width, page) });
      return;
    }
    if (tool === 'eraser') {
      drag.current = { kind: 'erase', begun: false };
      eraseAt(p);
      return;
    }
    if (tool === 'text') {
      // Created on pointer-up, so the mouse events that follow cannot pull focus from the editor.
      drag.current = { kind: 'text', start: p };
      return;
    }
    // shape / redact: drag a box (or a segment for line/arrow)
    drag.current = { kind: tool, start: p };
    setDraft(null);
  };

  const eraseAt = (p) => {
    const hit = pickAnnotation(annotations.filter((a) => a.type === 'ink'), p, dispW, dispH, tol + 4);
    if (!hit) return;
    if (!drag.current.begun) { api.beginChange(); drag.current.begun = true; }
    api.remove(page.id, hit.id, { record: false });
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (cancelled()) { drag.current = null; setDraft(null); return; }
    const p = toFrac(e);
    if (d.kind === 'ink') {
      const last = d.points[d.points.length - 1];
      if (Math.hypot((p.x - last[0]) * dispW, (p.y - last[1]) * dispH) < 1.2) return;
      d.points.push([p.x, p.y]);
      setDraft((dr) => (dr ? { ...dr, points: [...d.points] } : dr));
      return;
    }
    if (d.kind === 'erase') { eraseAt(p); return; }
    if (d.kind === 'shape' || d.kind === 'redact') {
      setDraft(buildBoxObject(d.kind, d.start, p, true));
      return;
    }
    if (d.kind === 'move') {
      const dx = p.x - d.start.x; const dy = p.y - d.start.y;
      if (!d.begun) {
        if (Math.hypot(dx * dispW, dy * dispH) < 3) return;
        api.beginChange();
        d.begun = true;
      }
      api.update(page.id, d.orig.id, translate(d.orig, dx, dy), { record: false });
      return;
    }
    if (d.kind === 'resize') {
      if (!d.begun) { api.beginChange(); d.begun = true; }
      api.update(page.id, d.orig.id, resizeObject(d, p), { record: false });
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    try { wrapRef.current?.releasePointerCapture(e.pointerId); } catch {}
    if (!d || cancelled()) { setDraft(null); return; }
    const p = toFrac(e);
    if (d.kind === 'ink') {
      setDraft(null);
      const o = toolOpts[tool] || toolOpts.pen;
      api.add(page.id, { id: annotationId(), type: 'ink', tool, points: simplify(d.points, dispW, dispH), color: o.color, width: ptToFrac(o.width, page) });
      return;
    }
    if (d.kind === 'text') {
      createTextAt(d.start);
      return;
    }
    if (d.kind === 'shape' || d.kind === 'redact') {
      setDraft(null);
      const obj = buildBoxObject(d.kind, d.start, p, false);
      api.add(page.id, obj);
      onSelect(page.id, obj.id);
      if (d.kind === 'shape') api.setTool('select');
    }
  };

  function createTextAt(p) {
    const o = toolOpts.text;
    const fontSize = ptToFrac(o.fontSize, page);
    const lh = (fontSize * diag * TEXT_LINE_HEIGHT) / dispH;
    const w = Math.min(0.42, Math.max(0.12, 0.98 - p.x));
    const ann = { id: annotationId(), type: 'text', x: Math.min(p.x, 0.98 - w), y: Math.max(0, Math.min(p.y - lh / 2, 1 - lh)), w, h: lh, text: '', color: o.color, fontSize, bold: o.bold, align: o.align };
    api.add(page.id, ann);
    onSelect(page.id, ann.id);
    onEditText(page.id, ann.id, true);
    api.setTool('select');
  }

  function buildBoxObject(kind, a, b, isDraft) {
    const tiny = Math.hypot((b.x - a.x) * dispW, (b.y - a.y) * dispH) < 6;
    const id = isDraft ? 'draft' : annotationId();
    if (kind === 'redact') {
      const o = toolOpts.redact;
      const box = tiny
        ? { x: Math.max(0, a.x - 0.12), y: Math.max(0, a.y - 0.012), w: 0.24, h: 0.024 }
        : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      return { id, type: 'redact', ...box, style: o.style, label: o.label || '' };
    }
    const o = toolOpts.shape;
    const base = { id, type: 'shape', shape: o.shape, stroke: o.stroke, strokeWidth: ptToFrac(o.strokeWidth, page), dash: o.dash };
    if (o.shape === 'line' || o.shape === 'arrow') {
      const end = tiny ? { x: Math.min(1, a.x + 0.2), y: a.y } : b;
      return { ...base, x1: a.x, y1: a.y, x2: end.x, y2: end.y };
    }
    const box = tiny
      ? { x: Math.max(0, a.x - 0.1), y: Math.max(0, a.y - 0.05), w: 0.2, h: 0.1 * (dispW / dispH) * 1.0 }
      : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    return { ...base, ...box, fill: o.fill };
  }

  function resizeObject(d, p) {
    const a = d.orig;
    if (d.handle === 'p1' || d.handle === 'p2') {
      return d.handle === 'p1' ? { ...a, x1: p.x, y1: p.y } : { ...a, x2: p.x, y2: p.y };
    }
    const b = d.bounds;
    let x0 = b.x; let y0 = b.y; let x1 = b.x + b.w; let y1 = b.y + b.h;
    if (d.handle.includes('w')) x0 = Math.min(p.x, x1 - MIN);
    if (d.handle.includes('e')) x1 = Math.max(p.x, x0 + MIN);
    if (d.handle.includes('n')) y0 = Math.min(p.y, y1 - MIN);
    if (d.handle.includes('s')) y1 = Math.max(p.y, y0 + MIN);
    let nb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (KEEP_ASPECT.has(a.type) && b.w > 0 && b.h > 0) {
      const ratio = (b.h * dispH) / (b.w * dispW);
      const w = nb.w;
      const h = (w * dispW * ratio) / dispH;
      nb = { x: d.handle.includes('w') ? x1 - w : x0, y: d.handle.includes('n') ? y1 - h : y0, w, h };
    }
    return resizeTo(a, nb);
  }

  // Keep a text box as tall as its wrapped text
  const fitTextHeight = useCallback((a, text) => {
    const px = Math.max(4, a.fontSize * diag);
    const lines = layoutText({ ...a, text }, px, a.w * dispW).length || 1;
    return (lines * px * TEXT_LINE_HEIGHT) / dispH;
  }, [diag, dispW, dispH]);

  const drawing = DRAW_TOOLS.has(tool);
  const cursor = tool === 'pen' || tool === 'highlighter' || tool === 'shape' || tool === 'redact' ? 'crosshair' : tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : undefined;

  return (
    <div
      ref={wrapRef}
      className="absolute bg-white shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)] select-none"
      style={{ width: dispW, height: dispH, cursor, touchAction: drawing ? 'none' : 'pan-x pan-y' }}
      data-page-id={page.id}
      data-page-index={index}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if (tool !== 'select') return;
        const hit = pickAnnotation(annotations, toFrac(e), dispW, dispH, tol);
        if (hit?.type === 'text') onEditText(page.id, hit.id, false);
      }}
    >
      <img src={url || page.thumbUrl || undefined} alt="" draggable={false} className="absolute inset-0 w-full h-full pointer-events-none" style={{ imageRendering: url ? 'auto' : 'auto' }} />
      {near && words.length > 0 && <TextLayer words={words} W={dispW} H={dispH} pageId={page.id} enabled={tool === 'select'} />}
      {near && (findHits || []).map((h, i) => (
        <div key={i} className={`absolute pointer-events-none rounded-[2px] ${h.current ? 'bg-amber-400/45 ring-2 ring-amber-500' : 'bg-yellow-300/40'}`} style={{ left: h.x * dispW - 1, top: h.y * dispH - 1, width: h.w * dispW + 2, height: h.h * dispH + 2 }} />
      ))}
      {near && <AnnotationLayer annotations={annotations} W={dispW} H={dispH} hiddenId={editingId} draft={draft} />}

      {near && selected && !editing && (
        <>
          <SelectionBox a={selected} W={dispW} H={dispH} onHandleDown={onHandleDown} onBodyDown={(e) => startMove(e, selected)} onDoubleClick={() => selected.type === 'text' && onEditText(page.id, selected.id, false)} />
          <ObjectToolbar a={selected} page={page} W={dispW} H={dispH} api={api} onEdit={() => onEditText(page.id, selected.id, false)} labels={labels} />
        </>
      )}

      {near && editing && (
        <TextEditor
          key={editing.id}
          a={editing}
          W={dispW}
          H={dispH}
          diag={diag}
          placeholder={labels.typeHere}
          onText={(text) => api.update(page.id, editing.id, { text, h: fitTextHeight(editing, text) }, { record: false })}
          onDone={(text) => {
            if (!text.trim()) api.remove(page.id, editing.id, { record: false });
            onEditText(page.id, null);
          }}
        />
      )}
    </div>
  );
}

/** Drops points closer than ~0.7 px apart at the current zoom (keeps storage small). */
function simplify(points, W, H) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1];
    if (Math.hypot((points[i][0] - px) * W, (points[i][1] - py) * H) >= 1.5) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
}

export default memo(PageView);
