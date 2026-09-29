import React, { useEffect, useState } from 'react';
import { Printer, ListChecks, ScanLine, Wifi, AlertTriangle, KeyRound, RefreshCw, Radio, Server, Loader2, Thermometer, MemoryStick, HardDrive, Clock } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Card, CardHeader, PageHeader, StatusPill, List, ListRow, Button, Meter, SectionLabel } from '../../ui/index.js';
import { adminFetch } from '../../shell/api.js';
import { readinessReasonText } from './Printers.jsx';

function Stat({ icon: Icon, label, value, detail, tone = 'idle', onClick }) {
  return (
    <button type="button" onClick={onClick} className="text-left rounded-2xl bg-slate-900/70 border border-white/[0.07] hover:border-white/15 p-4 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
        <Icon className="w-4 h-4 text-slate-500" />
      </div>
      <div className="mt-2 text-lg font-extrabold text-white truncate">{value}</div>
      <div className="mt-1"><StatusPill tone={tone}>{detail}</StatusPill></div>
    </button>
  );
}

const SERVICES = [
  { key: 'cups', unit: 'cups', label: 'CUPS', descKey: 'cups' },
  { key: 'avahi', unit: 'avahi-daemon', label: 'Avahi (mDNS)', descKey: 'avahi' },
  { key: 'ipp_usb', unit: 'ipp-usb', label: 'IPP-over-USB', descKey: 'ippusb' }
];

export default function Overview({ data, refresh, showToast, go }) {
  const { t } = useI18n();
  const [defaultPassword, setDefaultPassword] = useState(false);
  const [restarting, setRestarting] = useState(null);

  useEffect(() => {
    adminFetch('/api/auth/profile').then((p) => setDefaultPassword(Boolean(p.isDefaultPassword))).catch(() => {});
  }, []);

  const printers = data?.printers || [];
  const online = printers.filter((p) => p.connected);
  const broadcasting = printers.filter((p) => p.is_published && p.connected);
  const activeJobs = data?.printer?.active_jobs?.length || 0;
  const scanner = data?.scanner;
  const sys = data?.system || {};
  const services = data?.services || {};
  const storage = sys.storage?.emmc || {};

  const attention = [];
  if (data?.lockdown?.enabled) attention.push({ icon: KeyRound, tone: 'danger', title: t('adm.overview.attn.lockdown'), desc: t('adm.overview.attn.lockdownDesc', { ips: (data.lockdown.admin_ips || []).join(', ') || '—' }), action: () => go('settings') });
  if (defaultPassword) attention.push({ icon: KeyRound, tone: 'danger', title: t('adm.overview.attn.password'), desc: t('adm.overview.attn.passwordDesc'), action: () => go('settings') });
  if (data?.updates?.update_available) attention.push({ icon: RefreshCw, tone: 'warn', title: t('adm.overview.attn.update', { v: data.updates.latest_version }), desc: t('adm.overview.attn.updateDesc'), action: () => go('updates') });
  if (printers.length === 0) attention.push({ icon: Printer, tone: 'warn', title: t('adm.overview.attn.noPrinters'), desc: t('adm.overview.attn.noPrintersDesc'), action: () => go('printers') });
  else if (online.length > 0 && broadcasting.length === 0) attention.push({ icon: Radio, tone: 'warn', title: t('adm.overview.attn.noBroadcast'), desc: t('adm.overview.attn.noBroadcastDesc'), action: () => go('printers') });
  for (const p of printers.filter((x) => x.connected && (x.state === 'stopped' || x.state === 'error'))) {
    attention.push({ icon: AlertTriangle, tone: 'danger', title: t('adm.overview.attn.printerProblem', { name: p.display_name }), desc: p.alert_description || '', action: () => go('printers') });
  }
  for (const p of printers.filter((x) => x.connected && x.readiness && x.readiness !== 'ready')) {
    const isUnsupported = p.readiness === 'unsupported';
    attention.push({
      icon: isUnsupported ? AlertTriangle : RefreshCw,
      tone: isUnsupported ? 'danger' : 'warn',
      title: t(`adm.overview.attn.readiness.${p.readiness}`, { name: p.display_name }),
      desc: readinessReasonText(p, t),
      action: () => go('printers')
    });
  }
  if (!scanner?.connected && scanner?.firmware_required) {
    attention.push({ icon: ScanLine, tone: 'warn', title: t('adm.overview.attn.scannerFirmware', { model: scanner.firmware_required.model }), desc: t('adm.overview.attn.scannerFirmwareDesc'), action: () => go('scanner') });
  }
  if (!scanner?.connected && scanner?.plugin_required) {
    attention.push({ icon: ScanLine, tone: 'warn', title: t('adm.overview.attn.scannerPlugin', { model: scanner.plugin_required.model }), desc: t('adm.overview.attn.scannerPluginDesc'), action: () => go('scanner') });
  }
  for (const s of SERVICES) {
    if (s.key !== 'ipp_usb' && services[s.key] === false) attention.push({ icon: Server, tone: 'danger', title: t('adm.overview.attn.service', { name: s.label }), desc: t('adm.overview.attn.serviceDesc'), action: null });
  }
  if ((storage.percent || 0) >= 85) attention.push({ icon: HardDrive, tone: 'warn', title: t('adm.overview.attn.storage', { p: storage.percent }), desc: '', action: null });

  const restart = async (s) => {
    setRestarting(s.key);
    try {
      await adminFetch('/api/service/restart', { method: 'POST', body: { service: s.unit } });
      showToast?.(t('adm.overview.restarted', { name: s.label }), 'success');
      refresh?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setRestarting(null);
    }
  };

  const ramPct = sys.ram?.percent || 0;
  const temp = sys.cpu_temp;

  return (
    <div>
      <PageHeader title={t('adm.overview.title')} description={t('adm.overview.desc')} />

      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        <Stat icon={Printer} label={t('adm.nav.printers')} value={`${online.length} / ${printers.length}`} tone={online.length ? 'ok' : 'idle'} detail={online.length ? t('adm.overview.online') : t('adm.overview.noneOnline')} onClick={() => go('printers')} />
        <Stat icon={ListChecks} label={t('adm.nav.queue')} value={String(activeJobs)} tone={activeJobs ? 'info' : 'idle'} detail={activeJobs ? t('adm.overview.printing') : t('adm.overview.idle')} onClick={() => go('queue')} />
        <Stat icon={ScanLine} label={t('adm.nav.scanner')} value={scanner?.connected ? (scanner.name || '—') : scanner?.firmware_required ? scanner.firmware_required.model : scanner?.plugin_required ? scanner.plugin_required.model : t('adm.overview.notDetected')} tone={scanner?.connected ? 'ok' : (scanner?.firmware_required || scanner?.plugin_required) ? 'warn' : 'idle'} detail={scanner?.connected ? t('adm.overview.ready') : scanner?.firmware_required ? t('adm.overview.needsFirmware') : scanner?.plugin_required ? t('adm.overview.needsPlugin') : t('adm.overview.offline')} onClick={() => go('scanner')} />
        <Stat icon={Wifi} label={t('adm.nav.network')} value={sys.ip || '—'} tone={sys.ip ? 'ok' : 'warn'} detail={sys.broadcast_network?.iface || sys.mdns_host || '—'} onClick={() => go('network')} />
      </div>

      <div className="mt-6">
        <SectionLabel>{t('adm.overview.attention')}</SectionLabel>
        {attention.length === 0 ? (
          <Card className="flex items-center gap-3">
            <StatusPill tone="ok">{t('adm.overview.allGood')}</StatusPill>
            <span className="text-sm text-slate-400">{t('adm.overview.allGoodDesc')}</span>
          </Card>
        ) : (
          <List>
            {attention.map((a, i) => (
              <ListRow
                key={i}
                leading={<span className={`h-9 w-9 rounded-xl flex items-center justify-center ${a.tone === 'danger' ? 'bg-rose-500/10 text-rose-300' : 'bg-amber-500/10 text-amber-300'}`}><a.icon className="w-4 h-4" /></span>}
                title={a.title}
                subtitle={a.desc}
                wrap
                onClick={a.action || undefined}
              />
            ))}
          </List>
        )}
      </div>

      <div className="mt-6 grid gap-5 grid-cols-1 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader icon={Server} title={t('adm.overview.system')} description={`${sys.hostname || 'mantaprint'} · ${t('adm.overview.uptime', { u: sys.uptime || '—' })}`} />
          <div className="mt-4 space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400 flex items-center gap-1.5"><MemoryStick className="w-3.5 h-3.5" />RAM</span><span className="text-slate-200 font-mono">{sys.ram ? `${sys.ram.used_mb} / ${sys.ram.total_mb} MB` : '—'}</span></div>
              <Meter value={ramPct} tone={ramPct > 85 ? 'danger' : ramPct > 70 ? 'warn' : 'ok'} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400 flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" />{t('adm.overview.storage')}</span><span className="text-slate-200 font-mono">{storage.totalMb ? `${(storage.usedMb / 1024).toFixed(1)} / ${(storage.totalMb / 1024).toFixed(1)} GB` : '—'}</span></div>
              <Meter value={storage.percent || 0} tone={(storage.percent || 0) > 85 ? 'danger' : 'ok'} />
            </div>
            <div className="grid grid-cols-3 gap-3 pt-1">
              <div><div className="text-[11px] text-slate-500 flex items-center gap-1"><Thermometer className="w-3 h-3" />{t('adm.overview.temp')}</div><div className={`text-sm font-bold ${temp >= 75 ? 'text-rose-300' : temp >= 65 ? 'text-amber-300' : 'text-slate-100'}`}>{temp ? `${temp}°C` : '—'}</div></div>
              <div><div className="text-[11px] text-slate-500">{t('adm.overview.load')}</div><div className="text-sm font-bold text-slate-100 font-mono">{Array.isArray(sys.load) ? sys.load[0].toFixed(2) : '—'}</div></div>
              <div><div className="text-[11px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" />{t('adm.overview.timezone')}</div><div className="text-sm font-bold text-slate-100 truncate">{sys.timezone || '—'}</div></div>
            </div>
            {sys.storage?.tiering_mode && <p className="text-[11px] text-slate-500">{t('adm.overview.spool')}: {sys.storage.ram_spool_active ? t('adm.overview.spoolRam') : sys.storage.microsd?.mounted ? t('adm.overview.spoolSd') : t('adm.overview.spoolInternal')}</p>}
          </div>
        </Card>

        <Card padded={false}>
          <div className="p-4 sm:p-5 pb-2"><CardHeader icon={Radio} title={t('adm.overview.services')} description={t('adm.overview.servicesDesc')} /></div>
          <div className="divide-y divide-white/[0.05]">
            {SERVICES.map((s) => {
              const up = services[s.key];
              return (
                <div key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-3">
                  <div className="min-w-[10rem] flex-1 basis-40">
                    <div className="text-sm font-semibold text-slate-100">{s.label}</div>
                    <div className="text-xs text-slate-500">{t(`adm.overview.svc.${s.descKey}`)}{s.key === 'ipp_usb' && !up && <> · {t('adm.overview.standbyDesc')}</>}</div>
                  </div>
                  {/* ipp-usb is started by udev only while an IPP-over-USB device is plugged in, so "stopped" is its normal idle state. */}
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    <StatusPill tone={up ? 'ok' : s.key === 'ipp_usb' ? 'idle' : up === false ? 'danger' : 'idle'}>{up ? t('adm.overview.running') : s.key === 'ipp_usb' ? t('adm.overview.standby') : t('adm.overview.stopped')}</StatusPill>
                    <Button size="sm" variant="ghost" icon={restarting === s.key ? Loader2 : RefreshCw} disabled={Boolean(restarting)} onClick={() => restart(s)}>{t('adm.overview.restart')}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
