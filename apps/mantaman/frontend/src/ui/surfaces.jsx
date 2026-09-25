import React, { useEffect } from 'react';
import { X, ChevronRight, ChevronDown } from 'lucide-react';

export function Card({ children, className = '', padded = true, as: Tag = 'section', ...rest }) {
  return (
    <Tag className={`rounded-2xl bg-slate-900/70 border border-white/[0.07] shadow-lg shadow-black/20 ${padded ? 'p-4 sm:p-5' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ icon: Icon, title, description, actions, className = '' }) {
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      {Icon && (
        <span className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.05] border border-white/[0.08] text-manta-400 flex items-center justify-center shadow-inner">
          <Icon className="w-4 h-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold text-slate-100 leading-tight tracking-wide">{title}</h3>
        {description && <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, badge }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">{title}</h1>
          {badge}
        </div>
        {description && <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-3xl leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children, right, className = '' }) {
  return (
    <div className={`flex items-center justify-between mb-2.5 ${className}`}>
      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{children}</span>
      {right}
    </div>
  );
}

const TONES = {
  ok: { dot: 'bg-manta-400', pill: 'bg-manta-500/10 border-manta-500/25 text-manta-300' },
  warn: { dot: 'bg-amber-400', pill: 'bg-amber-500/10 border-amber-500/25 text-amber-300' },
  danger: { dot: 'bg-rose-400', pill: 'bg-rose-500/10 border-rose-500/25 text-rose-300' },
  info: { dot: 'bg-indigo-400', pill: 'bg-indigo-500/10 border-indigo-500/25 text-indigo-300' },
  idle: { dot: 'bg-slate-500', pill: 'bg-white/[0.04] border-white/10 text-slate-400' }
};

export function StatusDot({ tone = 'idle', pulse = false, className = '' }) {
  return <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${TONES[tone]?.dot || TONES.idle.dot} ${pulse ? 'animate-pulse' : ''} ${className}`} />;
}

export function StatusPill({ tone = 'idle', children, pulse = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11px] font-semibold whitespace-nowrap shadow-sm ${TONES[tone]?.pill || TONES.idle.pill} ${className}`}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

export function Badge({ children, className = '', tone = 'default' }) {
  const toneClasses = {
    default: 'bg-white/[0.06] text-slate-300 border-white/[0.08]',
    manta: 'bg-manta-500/15 text-manta-300 border-manta-500/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30'
  };
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-md border text-[10px] font-mono font-semibold ${toneClasses[tone] || toneClasses.default} ${className}`}>
      {children}
    </span>
  );
}

export function ListRow({ leading, title, subtitle, trailing, onClick, active = false, wrap = false, className = '' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${onClick ? 'hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:outline-none' : ''} ${active ? 'bg-manta-500/[0.06]' : ''} ${className}`}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold text-slate-100 ${wrap ? '' : 'truncate'}`}>{title}</div>
        {subtitle && <div className={`text-xs text-slate-400 mt-0.5 ${wrap ? 'leading-relaxed' : 'truncate'}`}>{subtitle}</div>}
      </div>
      {trailing && <div className="shrink-0 flex items-center gap-2">{trailing}</div>}
      {onClick && <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />}
    </Tag>
  );
}

export function Modal({ isOpen, onClose, title, subtitle, children, footer, maxWidth = 'max-w-lg' }) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className={`relative w-full ${maxWidth} rounded-2xl bg-slate-900 border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-pop-up`}>
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/[0.07] bg-slate-900/90">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-white tracking-wide">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {children}
        </div>

        {/* Modal Footer */}
        {footer && (
          <div className="px-5 py-3.5 border-t border-white/[0.07] bg-slate-900/60 flex items-center justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Meter({ value = 0, tone = 'ok' }) {
  const colors = {
    ok: 'bg-manta-500',
    warn: 'bg-amber-500',
    danger: 'bg-rose-500',
    info: 'bg-indigo-500'
  };
  const color = colors[tone] || colors.ok;
  return (
    <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div className={`h-full ${color} transition-[width] duration-300 rounded-full`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
