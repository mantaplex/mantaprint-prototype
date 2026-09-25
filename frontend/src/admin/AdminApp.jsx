/**
 * Admin console shell: header, section navigation (sidebar on desktop, scrollable tabs on
 * phones) and the section router. Sections live in ./sections and share the ui/ design system.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard, Printer, ListChecks, ScanLine, Wifi, Settings as SettingsIcon, RefreshCw,
  Home, LogOut, CircleUser
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import AppHeader from '../shell/AppHeader.jsx';
import { PrototypeAckDialog } from '../shell/Prototype.jsx';
import { StatusPill } from '../ui/index.js';
import Overview from './sections/Overview.jsx';
import Printers from './sections/Printers.jsx';
import Queue from './sections/Queue.jsx';
import Scanner from './sections/Scanner.jsx';
import Network from './sections/Network.jsx';
import Settings from './sections/Settings.jsx';
import Updates from './sections/Updates.jsx';

export const SECTIONS = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'printers', icon: Printer },
  { id: 'queue', icon: ListChecks },
  { id: 'scanner', icon: ScanLine },
  { id: 'network', icon: Wifi },
  { id: 'settings', icon: SettingsIcon },
  { id: 'updates', icon: RefreshCw }
];

function sectionFromPath() {
  if (typeof window === 'undefined') return 'overview';
  const m = window.location.pathname.match(/^\/admin\/([a-z]+)/);
  const legacy = { telemetry: 'overview', account: 'settings', system: 'settings' };
  const id = m ? (legacy[m[1]] || m[1]) : 'overview';
  return SECTIONS.some((s) => s.id === id) ? id : 'overview';
}

export default function AdminApp({ data, adminUser, onLogout, onNavigateHome, refresh, showToast, initialSection }) {
  const { t } = useI18n();
  const [section, setSection] = useState(() => initialSection || sectionFromPath());

  useEffect(() => {
    const onPop = () => setSection(sectionFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);

  const go = useCallback((id) => {
    setSection(id);
    const path = id === 'overview' ? '/admin' : `/admin/${id}`;
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    window.scrollTo({ top: 0 });
  }, []);

  const updateAvailable = Boolean(data?.updates?.update_available);
  const activeJobs = data?.printer?.active_jobs?.length || 0;
  const hostName = data?.custom_mdns?.mdns_host || `${data?.system?.hostname || 'mantaprint'}.local`;
  const props = { data, refresh, showToast, go };

  const badgeFor = (id) => {
    if (id === 'updates' && updateAvailable) return <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />;
    if (id === 'queue' && activeJobs > 0) return <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-manta-600 text-white text-[10px] font-bold flex items-center justify-center">{activeJobs}</span>;
    return null;
  };

  return (
    <div className="min-h-[100dvh] bg-[#070a11] text-slate-100 flex flex-col">
      <PrototypeAckDialog />
      <AppHeader
        maxWidth="max-w-7xl"
        title={t('adm.title')}
        subtitle={hostName}
        leading={
          <button type="button" onClick={onNavigateHome} className="h-9 w-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-slate-300" title={t('adm.header.home')} aria-label={t('adm.header.home')}>
            <Home className="w-4 h-4" />
          </button>
        }
        badge={updateAvailable ? (
          <button type="button" onClick={() => go('updates')} className="hidden sm:inline-flex"><StatusPill tone="warn">{t('adm.header.updateAvailable')}</StatusPill></button>
        ) : null}
        actions={
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => go('settings')} className="h-9 px-2.5 rounded-xl hover:bg-white/10 flex items-center gap-1.5 text-xs font-semibold text-slate-300" title={t('adm.header.account')}>
              <CircleUser className="w-4 h-4" /><span className="hidden sm:inline">{adminUser || 'admin'}</span>
            </button>
            <button type="button" onClick={onLogout} className="h-9 w-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-slate-300" title={t('adm.header.logout')} aria-label={t('adm.header.logout')}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        }
      />

      {/* Phone navigation */}
      <nav className="md:hidden sticky top-14 z-30 bg-[#070a11]/90 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="flex gap-1 overflow-x-auto no-scrollbar px-3 py-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => go(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              className={`h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${section === s.id ? 'bg-manta-600 text-white' : 'text-slate-300 hover:bg-white/10'}`}
            >
              <s.icon className="w-4 h-4" />{t(`adm.nav.${s.id}`)}{badgeFor(s.id)}
            </button>
          ))}
        </div>
      </nav>

      <div className="flex-1 w-full max-w-7xl mx-auto flex">
        <aside className="hidden md:block w-56 shrink-0 px-3 py-6">
          <nav className="sticky top-20 space-y-0.5" aria-label={t('adm.title')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(s.id)}
                aria-current={section === s.id ? 'page' : undefined}
                className={`w-full h-10 px-3 rounded-xl flex items-center gap-2.5 text-sm font-medium transition-colors ${
                  section === s.id ? 'bg-manta-500/10 text-manta-300 shadow-[inset_2px_0_0_#2cc2cb]' : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.05]'
                }`}
              >
                <s.icon className="w-4 h-4" />
                <span className="flex-1 text-left">{t(`adm.nav.${s.id}`)}</span>
                {badgeFor(s.id)}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 min-w-0 px-4 sm:px-6 md:pl-4 py-6">
          {section === 'overview' && <Overview {...props} />}
          {section === 'printers' && <Printers {...props} />}
          {section === 'queue' && <Queue {...props} />}
          {section === 'scanner' && <Scanner {...props} />}
          {section === 'network' && <Network {...props} />}
          {section === 'settings' && <Settings {...props} adminUser={adminUser} />}
          {section === 'updates' && <Updates {...props} />}
        </main>
      </div>
    </div>
  );
}
