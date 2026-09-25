/**
 * Public homepage of the hub. Its job: help people whose phone or laptop does not
 * list the hub's printers (mDNS/AirPrint blocked) add one by hand. Printing a file
 * from the browser and the scan studio are secondary actions in the hero.
 * Hub administration (hostname, mDNS broadcast names, queues) lives in /admin only.
 */
import React, { useState } from 'react';
import { Shield, Printer, ScanLine } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import AppHeader from '../shell/AppHeader.jsx';
import { StatusPill, Button } from '../ui/index.js';
import PrintDialog from './PrintDialog.jsx';
import AddPrinterGuide from './AddPrinterGuide.jsx';
import { MyJobsCard } from './MyJobs.jsx';

export default function Home({ data, isConnected, serverIp, onNavigateScan, onNavigateAdmin, showToast }) {
  const { t } = useI18n();
  const [jobsKey, setJobsKey] = useState(0);
  const [printOpen, setPrintOpen] = useState(false);

  const printers = (data?.published_printers || (data?.printers || []).filter((p) => p.is_published)) || [];
  const mdnsHost = data?.custom_mdns?.mdns_host || `${data?.system?.hostname || 'mantaprint'}.local`;
  const queueCount = data?.printer?.active_jobs?.length || 0;
  const version = data?.system?.version || data?.version || '';
  const scannerOn = Boolean(data?.scanner?.connected);

  return (
    <div className="min-h-[100dvh] bg-[#070a11] text-slate-100 flex flex-col">
      <AppHeader
        subtitle={mdnsHost}
        badge={
          <StatusPill tone={isConnected ? 'ok' : 'warn'} pulse={isConnected} className="hidden sm:inline-flex">
            {isConnected ? t('hub.header.online') : t('hub.header.connecting')}
          </StatusPill>
        }
        actions={
          <button
            type="button"
            onClick={onNavigateAdmin}
            className="h-9 px-2.5 rounded-xl hover:bg-white/10 flex items-center gap-1.5 text-xs font-semibold text-slate-300"
            title={t('hub.header.admin')}
            aria-label={t('hub.header.admin')}
          >
            <Shield className="w-4 h-4" />
            <span className="hidden sm:inline">{t('hub.header.admin')}</span>
          </button>
        }
      />

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        <section className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-manta-950/80 via-navy-900/60 to-plum-700/25 p-5 sm:p-6">
          <div aria-hidden className="absolute -top-20 -right-16 h-56 w-56 rounded-full bg-plum-600/20 blur-3xl pointer-events-none" />
          <div aria-hidden className="absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-manta-500/15 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
            <img src="/mantaprint.png" alt="" className="h-16 w-16 sm:h-20 sm:w-20 rounded-full shrink-0 shadow-xl shadow-black/40" />
            <div className="min-w-0 flex-1">
              <h1 className="text-lg sm:text-xl font-extrabold text-white leading-tight">{t('hub.hero.title')}</h1>
              <p className="mt-1.5 text-sm text-slate-300 leading-relaxed">{t('hub.hero.desc')}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" icon={Printer} onClick={() => setPrintOpen(true)}>{t('hub.actions.print')}</Button>
                <Button size="sm" icon={ScanLine} onClick={onNavigateScan}>
                  {t('hub.actions.scan')}
                  {scannerOn && <span className="h-1.5 w-1.5 rounded-full bg-manta-400" aria-hidden />}
                </Button>
              </div>
            </div>
          </div>
        </section>

        <AddPrinterGuide printers={printers} ip={serverIp} onPrintFile={() => setPrintOpen(true)} />

        <MyJobsCard refreshKey={jobsKey} queueCount={queueCount} showToast={showToast} />
      </main>

      <PrintDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        printers={printers}
        onJobSubmitted={() => setJobsKey((k) => k + 1)}
        showToast={showToast}
      />

      <footer className="border-t border-white/[0.06] py-5 text-[11px] text-slate-500">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>MantaPrint Hub{version ? ` v${version}` : ''}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{mdnsHost} · {serverIp}</span>
          <span className="ml-auto">{t('hub.footer.privacy')}</span>
        </div>
      </footer>
    </div>
  );
}
