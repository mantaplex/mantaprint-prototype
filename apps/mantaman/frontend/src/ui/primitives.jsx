import React from 'react';

export function Button({ children, variant = 'secondary', size = 'md', icon: Icon, loading = false, className = '', ...rest }) {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-manta-400 whitespace-nowrap select-none';
  const sizes = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-10 px-4 text-xs sm:text-sm',
    lg: 'h-12 px-5 text-sm'
  };
  const variants = {
    primary: 'bg-gradient-to-r from-manta-600 to-plum-600 hover:from-manta-500 hover:to-plum-500 text-white shadow-lg shadow-manta-950/50 border border-manta-400/20',
    secondary: 'bg-white/[0.06] hover:bg-white/10 text-slate-100 border border-white/10',
    ghost: 'text-slate-300 hover:bg-white/10 hover:text-white',
    danger: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30'
  };
  return (
    <button type="button" className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {loading ? (
        <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
      ) : Icon ? (
        <Icon className="w-4 h-4 shrink-0" />
      ) : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, active = false, onClick, disabled, className = '', size = 'md', badge = null, ...rest }) {
  const sz = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-12 w-12' : 'h-10 w-10';
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
      <Icon className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
      {badge !== null && badge !== undefined && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-manta-600 text-white text-[10px] font-bold flex items-center justify-center shadow">
          {badge}
        </span>
      )}
    </button>
  );
}

export function Segmented({ options, value, onChange, size = 'md', className = '' }) {
  return (
    <div role="radiogroup" className={`inline-flex p-1 rounded-xl bg-black/40 border border-white/10 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`${size === 'sm' ? 'h-7 px-2.5 text-[11px]' : 'h-8 px-3 text-xs'} rounded-lg font-semibold transition-colors ${
            value === o.value ? 'bg-manta-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-white/5'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint, error }) {
  return (
    <div className="space-y-1.5">
      {label && <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider">{label}</label>}
      {children}
      {hint && !error && <p className="text-[11px] text-slate-400 leading-relaxed">{hint}</p>}
      {error && <p className="text-[11px] text-rose-400 font-medium">{error}</p>}
    </div>
  );
}
