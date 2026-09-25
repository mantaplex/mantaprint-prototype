/**
 * Manual "add this printer" guide: the reason the homepage exists. Devices that
 * receive the hub's mDNS/AirPrint broadcast list the printers by themselves; this
 * page is for networks where discovery is blocked, so every OS gets the by-address steps.
 */
import React, { useMemo, useState } from 'react';
import { Printer, Download, LifeBuoy } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import { Card, StatusPill, CopyField, Disclosure, EmptyState, Button } from '../ui/index.js';
import { detectOS } from '../utils/detectOS.js';
import { printerTone, printerLabel } from './PrintDialog.jsx';

const OS = [
  { id: 'android', label: 'Android', steps: 4 },
  { id: 'ios', label: 'iPhone / iPad', steps: 3 },
  { id: 'windows', label: 'Windows', steps: 4 },
  { id: 'macos', label: 'macOS', steps: 3 },
  { id: 'chromeos', label: 'ChromeOS', steps: 3 },
  { id: 'linux', label: 'Linux', steps: 2 }
];

function StepTitle({ n, children }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="h-6 w-6 shrink-0 rounded-full bg-gradient-to-br from-manta-500 to-plum-600 text-[11px] font-bold text-white flex items-center justify-center">{n}</span>
      <h2 className="text-sm font-bold text-slate-100">{children}</h2>
    </div>
  );
}

export default function AddPrinterGuide({ printers, ip, onPrintFile }) {
  const { t } = useI18n();
  const [os, setOs] = useState(() => {
    const d = detectOS();
    return OS.some((o) => o.id === d) ? d : 'android';
  });
  const [queue, setQueue] = useState('');
  const printer = printers.find((p) => p.queue_name === queue) || printers.find((p) => p.connected) || printers[0] || null;
  const q = printer?.queue_name || '';
  const name = printer ? printerLabel(printer) : t('hub.guide.yourPrinter');
  const ipp = `ipp://${ip}:631/printers/${q}`;
  const http = `http://${ip}:631/printers/${q}`;
  const params = { printer: name, ip, queue: q };
  const current = useMemo(() => OS.find((o) => o.id === os) || OS[0], [os]);

  const details = {
    android: <CopyField label={t('hub.guide.ipAddress')} value={ip} />,
    ios: (
      <div className="space-y-3">
        <Button
          variant="primary"
          icon={Download}
          className="w-full"
          disabled={!q}
          onClick={() => { if (q) window.location.href = `/api/airprint.mobileconfig?queue=${encodeURIComponent(q)}`; }}
        >
          {t('hub.guide.iosProfile')}
        </Button>
        <p className="text-[11px] text-slate-500 leading-relaxed">{t('hub.guide.iosProfileNote')}</p>
      </div>
    ),
    windows: <CopyField label={t('hub.guide.printerUrl')} value={http} />,
    macos: (
      <div className="space-y-3">
        <CopyField label={t('hub.guide.address')} value={ip} />
        <CopyField label={t('hub.guide.queue')} value={`printers/${q}`} />
      </div>
    ),
    chromeos: (
      <div className="space-y-3">
        <CopyField label={t('hub.guide.address')} value={ip} />
        <CopyField label={t('hub.guide.queue')} value={`printers/${q}`} />
      </div>
    ),
    linux: (
      <div className="space-y-3">
        <CopyField label={t('hub.guide.printerUrl')} value={ipp} />
        <CopyField label={t('hub.guide.command')} value={`sudo lpadmin -p ${q || 'MantaPrint'} -E -v ${ipp} -m everywhere`} />
      </div>
    )
  };

  return (
    <div className="space-y-5">
      <Card>
        <StepTitle n={1}>{t('hub.guide.pickPrinter')}</StepTitle>
        {printers.length === 0 ? (
          <EmptyState icon={Printer} title={t('hub.print.noPrinterTitle')} description={t('hub.print.noPrinterDesc')} />
        ) : (
          <div role="radiogroup" aria-label={t('hub.guide.pickPrinter')} className="grid gap-2 grid-cols-1 sm:grid-cols-2 [&>*]:min-w-0">
            {printers.map((p) => {
              const isSel = printer?.queue_name === p.queue_name;
              return (
                <button
                  key={p.queue_name}
                  type="button"
                  role="radio"
                  aria-checked={isSel}
                  onClick={() => setQueue(p.queue_name)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${
                    isSel ? 'border-manta-400/60 bg-manta-500/[0.08]' : 'border-white/[0.08] hover:border-white/20 bg-white/[0.02]'
                  }`}
                >
                  <span className={`h-4 w-4 rounded-full border-2 shrink-0 ${isSel ? 'border-manta-400 bg-manta-400 shadow-[inset_0_0_0_3px_#0f172a]' : 'border-slate-600'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-100 truncate">{printerLabel(p)}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{p.model && p.model !== printerLabel(p) ? p.model : p.queue_name}</span>
                  </span>
                  <StatusPill tone={printerTone(p)}>{t(`hub.printerState.${p.connected ? (p.state || 'idle') : 'offline'}`, p.state)}</StatusPill>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <StepTitle n={2}>{t('hub.guide.addOn')}</StepTitle>
        <div role="tablist" aria-label={t('hub.guide.addOn')} className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
          {OS.map((o) => (
            <button
              key={o.id}
              role="tab"
              type="button"
              aria-selected={os === o.id}
              onClick={() => setOs(o.id)}
              className={`h-9 px-3 rounded-xl text-xs font-semibold whitespace-nowrap border transition-colors ${
                os === o.id ? 'bg-manta-600 text-white border-manta-600' : 'border-white/10 text-slate-300 hover:border-white/25'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] [&>*]:min-w-0">
          <ol className="space-y-3">
            {Array.from({ length: current.steps }).map((_, i) => (
              <li key={i} className="flex gap-3">
                <span className="h-6 w-6 shrink-0 rounded-full bg-white/[0.06] border border-white/10 text-[11px] font-bold text-slate-200 flex items-center justify-center">{i + 1}</span>
                <span className="text-sm text-slate-300 leading-relaxed pt-0.5">{t(`hub.guide.${current.id}.s${i + 1}`, params)}</span>
              </li>
            ))}
          </ol>
          <div className="rounded-2xl bg-black/25 border border-white/[0.07] p-4">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">{t('hub.guide.details', { os: current.label })}</div>
            {details[current.id]}
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-500 leading-relaxed">{t('hub.guide.autoNote', params)}</p>
      </Card>

      <Disclosure title={<span className="inline-flex items-center gap-2"><LifeBuoy className="w-4 h-4 text-slate-400" />{t('hub.guide.trouble.title')}</span>}>
        <ul className="space-y-2 text-sm text-slate-300 leading-relaxed list-disc pl-5">
          <li>{t('hub.guide.trouble.t1')}</li>
          <li>{t('hub.guide.trouble.t2')}</li>
          <li>{t('hub.guide.trouble.t3')}</li>
        </ul>
        <Button className="mt-4" icon={Printer} onClick={onPrintFile}>{t('hub.actions.print')}</Button>
      </Disclosure>
    </div>
  );
}
