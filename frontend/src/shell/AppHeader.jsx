import React from 'react';
import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import { PrototypeBadge } from './Prototype.jsx';

/**
 * Sticky 56px application header shared by Home and Admin (same anatomy as the
 * MantaPageScan Studio header): brand on the left, context in the middle, actions right.
 */
export default function AppHeader({ leading, title = 'MantaPrint Hub', subtitle, badge, actions, maxWidth = 'max-w-6xl' }) {
  const { t, lang, setLanguage } = useI18n();
  return (
    <header className="sticky top-0 z-40 bg-[#070a11]/85 backdrop-blur-xl border-b border-white/[0.06]">
      <div className={`${maxWidth} mx-auto h-14 px-3 sm:px-6 flex items-center gap-2 sm:gap-3`}>
        {leading}
        <div className="flex items-center gap-2.5 min-w-0">
          <img src="/mantaprint.png" alt="" className="h-9 w-9 rounded-full object-contain shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold leading-tight truncate">{title}</span>
              <PrototypeBadge />
              {badge}
            </div>
            {subtitle && <div className="text-[11px] text-slate-500 leading-tight truncate">{subtitle}</div>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {actions}
          <button
            type="button"
            onClick={() => setLanguage(lang === 'id' ? 'en' : 'id')}
            className="h-9 px-2.5 rounded-xl hover:bg-white/10 flex items-center gap-1.5 text-xs font-bold text-slate-300"
            title={t('hub.header.language')}
            aria-label={t('hub.header.language')}
          >
            <Languages className="w-4 h-4" />
            {lang.toUpperCase()}
          </button>
        </div>
      </div>
    </header>
  );
}
