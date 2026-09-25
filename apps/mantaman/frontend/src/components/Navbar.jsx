import React from 'react';
import logoUrl from '../../mantaprint.png';
import { 
  Server, 
  Radar, 
  Building2, 
  Layers, 
  FileCheck2, 
  RefreshCw,
  Languages,
  Printer
} from 'lucide-react';
import { StatusPill, Badge } from '../ui/surfaces';

export function Navbar({ activeTab, setActiveTab, lang, setLang, t, isWsConnected, unadoptedCount = 0, managedCount = 0 }) {
  const navItems = [
    { id: 'fleet', label: t.nav.fleet, icon: Server, badge: managedCount > 0 ? managedCount : null },
    { id: 'peripherals', label: t.nav.peripherals || 'Periferal & Printer', icon: Printer },
    { id: 'adoption', label: t.nav.adoption, icon: Radar, badge: unadoptedCount > 0 ? unadoptedCount : null, badgeTone: 'amber' },
    { id: 'sites', label: t.nav.sites, icon: Building2 },
    { id: 'batch', label: t.nav.batch, icon: Layers },
    { id: 'audit', label: t.nav.audit, icon: FileCheck2 },
    { id: 'updates', label: t.nav.updates || 'Updates', icon: RefreshCw },
  ];

  return (
    <header className="sticky top-0 z-40 bg-[#070a11]/85 backdrop-blur-xl border-b border-white/[0.06]">
      <div className="max-w-7xl mx-auto h-16 px-4 sm:px-6 flex items-center justify-between gap-3">
        {/* Brand & Connection Status */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative flex items-center justify-center">
            <img 
              src={logoUrl} 
              alt="MantaPool" 
              className="w-8 h-8 rounded-full object-contain shrink-0 drop-shadow-[0_0_12px_rgba(18,163,173,0.45)]"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm sm:text-base font-extrabold text-white tracking-wide font-sans">
                Manta<span className="text-manta-400">Pool</span>
              </span>
              <StatusPill tone={isWsConnected ? 'ok' : 'danger'} pulse={isWsConnected} className="hidden sm:inline-flex">
                {isWsConnected ? (t.brand?.status_live || 'LIVE CONDUIT') : (t.brand?.status_offline || 'DISCONNECTED')}
              </StatusPill>
            </div>
            <div className="text-[11px] text-slate-400 truncate hidden sm:block">
              {t.brand?.tagline || 'Multi-Hub Fleet Operations'}
            </div>
          </div>
        </div>

        {/* Desktop Tab Switcher */}
        <nav className="hidden lg:flex items-center gap-1 bg-black/40 border border-white/[0.08] p-1 rounded-2xl">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-manta-600 text-white shadow-md shadow-manta-950/40'
                    : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.label}</span>
                {item.badge !== null && item.badge !== undefined && (
                  <span className={`inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    item.badgeTone === 'amber' ? 'bg-amber-400 text-slate-950' : 'bg-white/20 text-white'
                  }`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right actions: Language Switcher */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setLang(lang === 'id' ? 'en' : 'id')}
            className="h-9 px-3 rounded-xl bg-white/[0.05] hover:bg-white/10 border border-white/[0.08] flex items-center gap-1.5 text-xs font-bold text-slate-200 transition-colors"
            title="Switch Language"
          >
            <Languages className="w-3.5 h-3.5 text-manta-400" />
            <span>{lang.toUpperCase()}</span>
          </button>
        </div>
      </div>

      {/* Mobile Horizontal Sub-Navigation */}
      <div className="lg:hidden flex items-center gap-1 overflow-x-auto px-4 py-2 border-t border-white/[0.04] no-scrollbar bg-slate-950/50">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-all ${
                isActive
                  ? 'bg-manta-600 text-white shadow'
                  : 'text-slate-300 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
              {item.badge !== null && item.badge !== undefined && (
                <span className={`inline-flex items-center px-1.5 rounded-full text-[10px] font-bold ${
                  item.badgeTone === 'amber' ? 'bg-amber-400 text-slate-950' : 'bg-white/20 text-white'
                }`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </header>
  );
}
