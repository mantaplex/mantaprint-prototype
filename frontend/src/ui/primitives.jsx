import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function IconButton({ icon: Icon, label, active = false, onClick, disabled, className = '', size = 'md', badge = null, ...rest }) {
  const sz = size === 'sm' ? 'h-9 w-9' : 'h-11 w-11';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex items-center justify-center rounded-xl transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-manta-400 ${sz} ${
        active ? 'bg-manta-600 text-white shadow-[0_0_0_1px_rgba(44,194,203,0.45)]' : 'text-slate-300 hover:bg-white/10 hover:text-white'
      } ${className}`}
      {...rest}
    >
      <Icon className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} />
      {badge !== null && badge !== undefined && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-manta-600 text-white text-[10px] font-bold flex items-center justify-center">{badge}</span>
      )}
    </button>
  );
}

export function Button({ children, variant = 'secondary', size = 'md', icon: Icon, className = '', ...rest }) {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-manta-400 whitespace-nowrap';
  const sizes = { sm: 'h-9 px-3 text-xs', md: 'h-11 px-4 text-sm', lg: 'h-12 px-5 text-sm' };
  const variants = {
    primary: 'bg-gradient-to-r from-manta-600 to-plum-600 hover:from-manta-500 hover:to-plum-500 text-white shadow-lg shadow-manta-900/40',
    secondary: 'bg-white/[0.06] hover:bg-white/10 text-slate-100 border border-white/10',
    ghost: 'text-slate-300 hover:bg-white/10 hover:text-white',
    danger: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30'
  };
  return (
    <button type="button" className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {Icon && <Icon className="w-4 h-4 shrink-0" />}
      {children}
    </button>
  );
}

export function Segmented({ options, value, onChange, size = 'md', className = '' }) {
  return (
    <div role="radiogroup" className={`inline-flex p-1 rounded-xl bg-black/30 border border-white/10 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`${size === 'sm' ? 'h-8 px-2.5 text-[11px]' : 'h-9 px-3 text-xs'} rounded-lg font-semibold transition-colors ${
            value === o.value ? 'bg-manta-600 text-white' : 'text-slate-300 hover:text-white hover:bg-white/5'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format = (v) => v, onCommit }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
        <span className="text-[11px] font-mono text-slate-200">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onPointerCancel={onCommit}
        onBlur={onCommit}
        onKeyUp={onCommit}
        className="studio-range w-full"
      />
    </label>
  );
}

export function Field({ label, children, hint }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</div>
      {children}
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

/** Tray anchored above the dock on desktop, bottom sheet on phones. */
export function Tray({ open, onClose, title, children, anchorRef, width = 360, isPhone, persistent = false }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0 });

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (persistent) return; // e.g. the crop tray stays open while handles on the page are dragged
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef, persistent]);

  useEffect(() => {
    if (!open || isPhone || !anchorRef?.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = a.left + a.width / 2 - width / 2;
    left = Math.max(12, Math.min(vw - width - 12, left));
    setPos({ left });
  }, [open, isPhone, anchorRef, width]);

  if (!open) return null;

  if (isPhone) {
    return (
      <div ref={ref} className="fixed inset-x-0 bottom-[84px] z-40 px-2 pb-1 animate-slide-up" role="dialog" aria-label={title}>
        <div className="rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl max-h-[60vh] overflow-y-auto">
          <div className="sticky top-0 flex items-center justify-between px-4 pt-3 pb-2 bg-slate-900/95">
            <div className="mx-auto h-1 w-10 rounded-full bg-white/20 absolute left-1/2 -translate-x-1/2 top-1.5" />
            <span className="text-xs font-bold text-slate-200 mt-1">{title}</span>
            <button type="button" onClick={onClose} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
          </div>
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      style={{ left: pos.left, width }}
      className="fixed bottom-[92px] z-40 animate-pop-up"
    >
      <div className="rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="text-xs font-bold text-slate-200">{title}</span>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 pb-4 max-h-[60vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** Centered modal dialog. */
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${width} rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-white/10 shadow-2xl max-h-[92vh] flex flex-col animate-slide-up`}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function useIsPhone() {
  const query = '(max-width: 767px)';
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange));
  }, []);
  return isPhone;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(ts, lang = 'en') {
  try {
    return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}
