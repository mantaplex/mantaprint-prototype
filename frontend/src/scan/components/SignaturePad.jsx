import React, { useEffect, useRef, useState } from 'react';
import { Eraser, Upload, Check } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Modal, Button } from './ui.jsx';
import { Swatch } from './ObjectToolbar.jsx';

const INK = ['#0f172a', '#1d4ed8'];
const SCALE = 2;

/** Crops transparent margins and returns a PNG data URL (null when empty). */
export function trimCanvas(canvas, pad = 6) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL('image/png'), width: out.width, height: out.height };
}

/** Downscales an uploaded image to at most `maxDim` px and returns a data URL. */
export async function imageFileToDataUrl(file, maxDim = 1600) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const png = file.type === 'image/png';
  return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), width: c.width, height: c.height };
}

export default function SignaturePad({ open, onClose, onDone }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const drawing = useRef(null);
  const [color, setColor] = useState(INK[0]);
  const [empty, setEmpty] = useState(true);
  const [save, setSave] = useState(true);

  useEffect(() => {
    if (!open) return;
    setEmpty(true);
    requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * SCALE);
      c.height = Math.round(r.height * SCALE);
    });
  }, [open]);

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) * SCALE, (e.clientY - r.top) * SCALE, e.pressure || 0.5];
  };

  const down = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    drawing.current = { last: pos(e), mid: null };
  };
  const move = (e) => {
    const d = drawing.current;
    if (!d) return;
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(e);
    const mid = [(d.last[0] + p[0]) / 2, (d.last[1] + p[1]) / 2];
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pressure = e.pointerType === 'pen' ? 0.6 + p[2] : 1;
    ctx.lineWidth = 2.6 * SCALE * pressure;
    ctx.beginPath();
    ctx.moveTo(...(d.mid || d.last));
    ctx.quadraticCurveTo(d.last[0], d.last[1], mid[0], mid[1]);
    ctx.stroke();
    d.mid = mid;
    d.last = p;
    setEmpty(false);
  };
  const up = () => { drawing.current = null; };

  const clear = () => {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };

  const finish = () => {
    const res = trimCanvas(canvasRef.current);
    if (!res) return;
    onDone({ ...res, save });
  };

  const upload = async (file) => {
    const res = await imageFileToDataUrl(file, 1200);
    onDone({ ...res, save });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('studio.sign.padTitle')}
      width="max-w-xl"
      footer={(
        <>
          <label className="mr-auto h-9 px-3 rounded-lg border border-white/15 hover:border-white/30 text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer">
            <Upload className="w-4 h-4" />{t('studio.sign.upload')}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
          </label>
          <Button variant="ghost" icon={Eraser} onClick={clear} disabled={empty}>{t('studio.sign.clear')}</Button>
          <Button variant="primary" icon={Check} onClick={finish} disabled={empty}>{t('studio.sign.place')}</Button>
        </>
      )}
    >
      <p className="text-xs text-slate-400 mb-3">{t('studio.sign.padHint')}</p>
      <div className="relative rounded-xl bg-white overflow-hidden border border-white/10">
        <canvas
          ref={canvasRef}
          className="block w-full h-48 sm:h-56 touch-none cursor-crosshair"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label={t('studio.sign.padTitle')}
        />
        <div className="absolute left-6 right-6 bottom-10 border-b border-dashed border-slate-300 pointer-events-none" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2">{INK.map((c) => <Swatch key={c} color={c} active={color === c} onClick={() => setColor(c)} />)}</div>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-sky-500 h-4 w-4" />{t('studio.sign.saveForLater')}
        </label>
      </div>
    </Modal>
  );
}
