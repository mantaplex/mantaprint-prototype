/**
 * MantaPrint design system — surfaces, lists and status.
 *
 * Visual language (shared with MantaPageScan Studio):
 *   background #070a11 · surfaces slate-900/70 · borders white/[0.07] · one accent: manta teal (from the logo)
 *   amber = attention · rose = danger · 11px uppercase labels · rounded-2xl cards · 44px targets
 */
import React, { useEffect, useState } from 'react';
import { X, Check, Copy, ChevronRight, ChevronDown } from 'lucide-react';

export function Card({ children, className = '', padded = true, as: Tag = 'section', ...rest }) {
  return (
    <Tag className={`rounded-2xl bg-slate-900/70 border border-white/[0.07] ${padded ? 'p-4 sm:p-5' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

/** Card heading: title, optional description, optional actions on the right. */
export function CardHeader({ icon: Icon, title, description, actions, className = '' }) {
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      {Icon && (
        <span className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.05] border border-white/[0.08] text-slate-300 flex items-center justify-center">
          <Icon className="w-4 h-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold text-slate-100 leading-tight">{title}</h3>
        {description && <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Page title row used at the top of every admin section. */
export function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-5">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-white">{title}</h1>
        {description && <p className="text-sm text-slate-400 mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{children}</span>
      {right}
    </div>
  );
}

const TONES = {
  ok: { dot: 'bg-manta-400', pill: 'bg-manta-500/10 border-manta-500/25 text-manta-300' },
  warn: { dot: 'bg-amber-400', pill: 'bg-amber-500/10 border-amber-500/25 text-amber-300' },
  danger: { dot: 'bg-rose-400', pill: 'bg-rose-500/10 border-rose-500/25 text-rose-300' },
  info: { dot: 'bg-violet-400', pill: 'bg-violet-500/10 border-violet-500/25 text-violet-300' },
  idle: { dot: 'bg-slate-500', pill: 'bg-white/[0.04] border-white/10 text-slate-400' }
};

export function StatusDot({ tone = 'idle', pulse = false, className = '' }) {
  return <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${TONES[tone]?.dot || TONES.idle.dot} ${pulse ? 'animate-pulse' : ''} ${className}`} />;
}

export function StatusPill({ tone = 'idle', children, pulse = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[11px] font-semibold whitespace-nowrap ${TONES[tone]?.pill || TONES.idle.pill} ${className}`}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

export function Badge({ children, className = '' }) {
  return <span className={`inline-flex items-center h-5 px-1.5 rounded-md bg-white/[0.06] text-[10px] font-semibold text-slate-300 ${className}`}>{children}</span>;
}

/** A row inside a list card. Clickable when onClick is given. */
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

export function List({ children, className = '' }) {
  return <div className={`rounded-2xl bg-slate-900/70 border border-white/[0.07] divide-y divide-white/[0.05] overflow-hidden ${className}`}>{children}</div>;
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-manta-400 ${checked ? 'bg-manta-500' : 'bg-white/15'}`}
    >
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

/** Label + description on the left, control on the right. */
export function SettingRow({ title, description, children }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-100">{title}</div>
        {description && <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function TextInput({ className = '', mono = false, ...rest }) {
  return (
    <input
      className={`h-11 w-full px-3 rounded-xl bg-white/[0.05] border border-white/10 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-manta-500/50 disabled:opacity-50 ${mono ? 'font-mono' : ''} ${className}`}
      {...rest}
    />
  );
}

export function Select({ className = '', children, ...rest }) {
  return <select className={`studio-select h-11 ${className}`} {...rest}>{children}</select>;
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center">
      {Icon && <div className="mx-auto h-12 w-12 rounded-2xl bg-white/[0.04] flex items-center justify-center text-slate-500"><Icon className="w-5 h-5" /></div>}
      <h3 className="mt-3 text-sm font-bold text-slate-200">{title}</h3>
      {description && <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Slides in from the right on desktop, from the bottom on phones. */
export function SideSheet({ open, onClose, title, subtitle, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[92vh] md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[440px] flex flex-col bg-slate-900 border-t md:border-t-0 md:border-l border-white/10 rounded-t-3xl md:rounded-none shadow-2xl animate-slide-up md:animate-slide-left">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/[0.06]">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-white truncate">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-white/[0.06] flex items-center gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Copyable monospace value. */
export function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    let ok = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {}
    }
    if (!ok && typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea');
        ta.value = String(value ?? '');
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {}
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="min-w-0">
      {label && <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</div>}
      <div className="flex items-center gap-2 h-10 pl-3 pr-1 rounded-xl bg-black/30 border border-white/[0.08]">
        <code className="flex-1 min-w-0 truncate text-xs text-slate-200 font-mono">{value}</code>
        <button type="button" onClick={copy} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label="Copy">
          {copied ? <Check className="w-4 h-4 text-manta-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

/** Collapsible "advanced" block. */
export function Disclosure({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-slate-900/40">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-2 px-4 h-12 text-left">
        <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm font-semibold text-slate-200">{title}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/** Horizontal usage bar. */
export function Meter({ value = 0, tone = 'ok' }) {
  const color = tone === 'danger' ? 'bg-rose-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-manta-500';
  return (
    <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div className={`h-full ${color} transition-[width]`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
