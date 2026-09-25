import React, { memo } from 'react';
import {
  inkPath, arrowHead, dashArray, markSegments, wrapText, textFont, orderForPaint,
  frameDiag, TEXT_LINE_HEIGHT, ANNOTATION_FONT, fitLabelSize
} from '../engine/annotations.js';

let measureCtx = null;
function measurer() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/** Wrapped lines of a text object at `px` font size, measured like the export renderer. */
export function layoutText(a, px, boxW) {
  const ctx = measurer();
  ctx.font = textFont(a, px);
  return wrapText(a.text, boxW, (s) => ctx.measureText(s).width).map((line) => ({ line, width: ctx.measureText(line).width }));
}

function labelSize(label, w, h) {
  const ctx = measurer();
  return fitLabelSize(label, w, h, (s, sz) => { ctx.font = `700 ${sz}px ${ANNOTATION_FONT}`; return ctx.measureText(s).width; });
}

function Item({ a, W, H, diag }) {
  const opacity = a.opacity ?? 1;
  switch (a.type) {
    case 'ink': {
      const hl = a.tool === 'highlighter';
      return (
        <path
          d={inkPath(a.points, W, H)}
          fill="none"
          stroke={a.color}
          strokeWidth={Math.max(0.5, a.width * diag)}
          strokeLinecap={hl ? 'butt' : 'round'}
          strokeLinejoin="round"
          opacity={hl ? opacity * 0.45 : opacity}
          style={hl ? { mixBlendMode: 'multiply' } : undefined}
        />
      );
    }
    case 'shape': {
      const sw = Math.max(0.5, a.strokeWidth * diag);
      const dash = dashArray(a.dash, sw).join(' ') || undefined;
      if (a.shape === 'line' || a.shape === 'arrow') {
        const x1 = a.x1 * W; const y1 = a.y1 * H; const x2 = a.x2 * W; const y2 = a.y2 * H;
        const tri = a.shape === 'arrow' ? arrowHead(x1, y1, x2, y2, sw) : null;
        return (
          <g opacity={opacity}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.stroke} strokeWidth={sw} strokeDasharray={dash} strokeLinecap="round" />
            {tri && <polygon points={tri.map((p) => p.join(',')).join(' ')} fill={a.stroke} />}
          </g>
        );
      }
      const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
      const common = { stroke: a.stroke, strokeWidth: sw, strokeDasharray: dash, fill: a.fill || 'none', fillOpacity: a.fill ? (a.fillOpacity ?? 1) : undefined, opacity };
      if (a.shape === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={Math.max(0.5, w / 2)} ry={Math.max(0.5, h / 2)} {...common} />;
      const r = a.shape === 'rounded_rect' ? Math.min(w, h) * 0.18 : 0;
      return <rect x={x} y={y} width={Math.max(0.5, w)} height={Math.max(0.5, h)} rx={r} ry={r} {...common} />;
    }
    case 'text': {
      const px = Math.max(4, a.fontSize * diag);
      const boxW = a.w * W;
      const lh = px * TEXT_LINE_HEIGHT;
      const lines = layoutText(a, px, boxW);
      return (
        <text fill={a.color} opacity={opacity} style={{ font: textFont(a, px), whiteSpace: 'pre' }} dominantBaseline="text-before-edge">
          {lines.map(({ line, width }, i) => {
            const dx = a.align === 'center' ? (boxW - width) / 2 : a.align === 'right' ? boxW - width : 0;
            return <tspan key={i} x={a.x * W + dx} y={a.y * H + i * lh + (lh - px) / 2}>{line || ' '}</tspan>;
          })}
        </text>
      );
    }
    case 'image':
      return <image href={a.src} x={a.x * W} y={a.y * H} width={Math.max(1, a.w * W)} height={Math.max(1, a.h * H)} preserveAspectRatio="none" opacity={opacity} />;
    case 'mark': {
      const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
      return (
        <g stroke={a.color} strokeWidth={Math.max(1, Math.min(w, h) * 0.12)} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={opacity}>
          {markSegments(a.kind).map((seg, i) => <polyline key={i} points={seg.map(([u, v]) => `${x + u * w},${y + v * h}`).join(' ')} />)}
        </g>
      );
    }
    case 'redact': {
      const x = a.x * W; const y = a.y * H; const w = a.w * W; const h = a.h * H;
      const white = a.style === 'white';
      const size = a.label ? labelSize(a.label, w, h) : 0;
      return (
        <g>
          <rect x={x} y={y} width={Math.max(1, w)} height={Math.max(1, h)} fill={white ? '#ffffff' : '#000000'} stroke={white ? '#94a3b8' : 'none'} strokeDasharray={white ? '4 3' : undefined} strokeWidth={white ? 1 : 0} />
          {a.label && (
            <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="central" fill={white ? '#0f172a' : '#ffffff'} style={{ font: `700 ${size}px ${ANNOTATION_FONT}` }}>{a.label}</text>
          )}
        </g>
      );
    }
    default:
      return null;
  }
}

/** Renders page objects as SVG at the displayed page size (W x H CSS px). */
function AnnotationLayer({ annotations, W, H, hiddenId = null, draft = null }) {
  if (!W || !H) return null;
  const diag = frameDiag(W, H);
  const list = orderForPaint(annotations || []).filter((a) => a.id !== hiddenId);
  return (
    <svg className="absolute inset-0 pointer-events-none overflow-visible" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {list.map((a) => <Item key={a.id} a={a} W={W} H={H} diag={diag} />)}
      {draft && <Item a={draft} W={W} H={H} diag={diag} />}
    </svg>
  );
}

export default memo(AnnotationLayer);
