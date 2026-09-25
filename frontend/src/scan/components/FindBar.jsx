import React, { useEffect, useRef } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function FindBar({ query, onQuery, count, index, onStep, onClose, hasOcr }) {
  const { t } = useI18n();
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[min(440px,calc(100%-24px))]" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1 rounded-xl bg-slate-900/95 backdrop-blur border border-white/10 shadow-xl p-1">
        <Search className="w-4 h-4 text-slate-500 ml-2 shrink-0" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            e.stopPropagation();
          }}
          placeholder={t('studio.find.placeholder')}
          aria-label={t('studio.find.placeholder')}
          className="flex-1 min-w-0 h-8 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
        <span className="text-[11px] font-mono text-slate-400 px-1 whitespace-nowrap">
          {!hasOcr ? '' : query.trim().length < 2 ? '' : count ? t('studio.find.of', { i: index + 1, n: count }) : t('studio.find.none')}
        </span>
        <button type="button" onClick={() => onStep(-1)} disabled={!count} title={t('studio.find.prev')} aria-label={t('studio.find.prev')} className="h-8 w-8 rounded-lg hover:bg-white/10 disabled:opacity-35 flex items-center justify-center text-slate-300"><ChevronUp className="w-4 h-4" /></button>
        <button type="button" onClick={() => onStep(1)} disabled={!count} title={t('studio.find.next')} aria-label={t('studio.find.next')} className="h-8 w-8 rounded-lg hover:bg-white/10 disabled:opacity-35 flex items-center justify-center text-slate-300"><ChevronDown className="w-4 h-4" /></button>
        <button type="button" onClick={onClose} title={t('studio.find.close')} aria-label={t('studio.find.close')} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
      </div>
      {!hasOcr && <p className="mt-1.5 text-center text-[11px] text-amber-300 bg-slate-900/90 rounded-lg py-1">{t('studio.find.needsOcr')}</p>}
    </div>
  );
}
