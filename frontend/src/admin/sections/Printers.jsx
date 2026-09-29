import React, { useCallback, useEffect, useState } from 'react';
import { Printer, Usb, Globe, Plus, RefreshCw, Loader2, Trash2, FileText, Pause, Play, Check, Radio, Star, Lock, DownloadCloud, AlertTriangle, HelpCircle, Search, Wifi } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import {
  PageHeader, List, ListRow, StatusPill, Badge, Button, SideSheet, Field, TextInput, Switch, SettingRow, CopyField,
  EmptyState, Modal, Segmented, Select, Card, CardHeader, SectionLabel, formatDate
} from '../../ui/index.js';
import { adminFetch } from '../../shell/api.js';

export function printerStatus(p, t) {
  if (!p.connected) return { tone: 'idle', label: t('adm.printers.state.offline') };
  if (p.state === 'stopped') return { tone: 'warn', label: t('adm.printers.state.paused') };
  if (p.state === 'error') return { tone: 'danger', label: t('adm.printers.state.error') };
  if (p.state === 'processing') return { tone: 'info', label: t('adm.printers.state.printing') };
  // A connected, idle CUPS queue isn't "Ready" if its own driver readiness says otherwise
  // (waiting on firmware, only a best-guess match, or no working driver at all) — showing both
  // "Ready" and e.g. "Needs firmware" side by side would read as a contradiction.
  const readiness = readinessStatus(p, t);
  if (readiness) return readiness;
  return { tone: 'ok', label: t('adm.printers.state.ready') };
}

// Set by printer_manager.py's sync_all_printers() — see docs/12-driver-compatibility.md.
// "ready"/null (nothing to show, or no readiness data yet) is the only state that gets AirPrint
// broadcast; everything else means the queue exists but hasn't been confirmed to actually print.
export function readinessStatus(p, t) {
  switch (p.readiness) {
    case 'needs_firmware': return { tone: 'warn', icon: DownloadCloud, label: t('adm.printers.readiness.needsFirmware') };
    case 'provisioning': return { tone: 'info', icon: Loader2, label: t('adm.printers.readiness.provisioning'), spin: true };
    case 'needs_review': return { tone: 'warn', icon: HelpCircle, label: t('adm.printers.readiness.needsReview') };
    case 'unsupported': return { tone: 'danger', icon: AlertTriangle, label: t('adm.printers.readiness.unsupported') };
    default: return null;
  }
}

// `p.readiness_reason` is a stable code from the hub (e.g. "fuzzy_match"), never ready-made
// English text — translated here so the reason reads correctly in both EN and ID.
export function readinessReasonText(p, t) {
  if (!p.readiness_reason) return t('adm.printers.readiness.genericDesc');
  return t(`adm.printers.readiness.reasons.${p.readiness_reason}`, { detail: p.readiness_detail || '' });
}

function PrinterSheet({ printer, broadcastName, onClose, refresh, showToast, go }) {
  const { t } = useI18n();
  const q = printer.queue_name || printer.name;
  const [form, setForm] = useState({
    display_name: printer.raw_display_name || printer.display_name || q,
    location: printer.location || '',
    broadcast_name: broadcastName || '',
    publish: Boolean(printer.is_published),
    is_default: Boolean(printer.is_default)
  });
  const [busy, setBusy] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = printerStatus(printer, t);
  const readiness = readinessStatus(printer, t);
  const locked = printer.classification === 'active_usb';

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) showToast?.(okMsg, 'success');
      await refresh?.();
      return true;
    } catch (e) {
      showToast?.(e.message, 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = () => run('save', async () => {
    await adminFetch('/api/printers/update', {
      method: 'POST',
      body: { queue_name: q, display_name: form.display_name.trim() || q, location: form.location.trim(), publish_broadcast: form.publish, is_default: form.is_default }
    });
    if ((broadcastName || '') !== form.broadcast_name.trim()) {
      await adminFetch('/api/system/mdns', { method: 'POST', body: { queue_name: q, custom_name: form.broadcast_name.trim() } });
    }
  }, t('adm.printers.saved')).then((ok) => ok && onClose());

  return (
    <SideSheet
      open
      onClose={onClose}
      title={printer.display_name || q}
      subtitle={`${q} · ${printer.protocol === 'usb' || printer.is_usb ? 'USB' : (printer.protocol || '').toUpperCase() || t('adm.printers.network')}`}
      footer={
        <>
          {printer.can_delete && !locked && (
            <Button variant="danger" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>{t('adm.printers.delete')}</Button>
          )}
          <Button variant="primary" className="ml-auto" icon={busy === 'save' ? Loader2 : Check} disabled={Boolean(busy)} onClick={save}>{t('adm.common.save')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
          {printer.is_default && <Badge><Star className="w-3 h-3 mr-1" />{t('adm.printers.default')}</Badge>}
          {locked && <Badge><Lock className="w-3 h-3 mr-1" />{t('adm.printers.pnp')}</Badge>}
          {printer.added_by === 'auto' && <Badge><Wifi className="w-3 h-3 mr-1" />{t('adm.printers.autoAdded')}</Badge>}
        </div>
        {printer.network_reachability?.state === 'offline'
          ? <p className="text-xs text-slate-400">{t('adm.printers.netOffline', { host: printer.network_reachability.host, port: printer.network_reachability.port })}</p>
          : printer.alert_description && !printer.connected && <p className="text-xs text-slate-400">{printer.alert_description}</p>}

        {readiness && (
          <Card className={readiness.tone === 'danger' ? '!border-rose-500/30 !bg-rose-500/[0.06]' : '!border-amber-500/30 !bg-amber-500/[0.06]'}>
            <CardHeader
              icon={readiness.icon}
              title={readiness.label}
              description={readinessReasonText(printer, t)}
            />
            {printer.readiness === 'needs_firmware' && (
              <>
                <Button size="sm" className="mt-3" icon={busy === 'firmware' ? Loader2 : DownloadCloud} disabled={Boolean(busy)}
                  onClick={() => run('firmware', () => adminFetch(`/api/printers/${encodeURIComponent(q)}/provision-firmware`, { method: 'POST' }), t('adm.printers.readiness.firmwareSent'))}>
                  {t('adm.printers.readiness.provisionNow')}
                </Button>
                <p className="mt-2 text-[11px] text-slate-500">{t('adm.printers.readiness.firmwareNotice')}</p>
              </>
            )}
            {go && <Button size="sm" variant="secondary" className="mt-3" onClick={() => go('drivers')}>{t('adm.printers.readiness.openDrivers')}</Button>}
          </Card>
        )}

        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" variant="secondary" icon={busy === 'test' ? Loader2 : FileText} disabled={!printer.connected || Boolean(busy)}
            onClick={() => run('test', () => adminFetch(`/api/printers/${encodeURIComponent(q)}/test-page`, { method: 'POST' }), t('adm.printers.testSent'))}>
            {t('adm.printers.testPage')}
          </Button>
          {printer.state === 'stopped' ? (
            <Button size="sm" variant="secondary" icon={busy === 'toggle' ? Loader2 : Play} disabled={Boolean(busy)}
              onClick={() => run('toggle', () => adminFetch('/api/printer/toggle', { method: 'POST', body: { action: 'resume', printer: q } }), t('adm.printers.resumed'))}>
              {t('adm.printers.resume')}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={busy === 'toggle' ? Loader2 : Pause} disabled={!printer.connected || Boolean(busy)}
              onClick={() => run('toggle', () => adminFetch('/api/printer/toggle', { method: 'POST', body: { action: 'pause', printer: q } }), t('adm.printers.paused'))}>
              {t('adm.printers.pause')}
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={Star} disabled={printer.is_default || Boolean(busy)}
            onClick={() => run('default', () => adminFetch(`/api/printers/${encodeURIComponent(q)}/set-default`, { method: 'POST' }), t('adm.printers.defaultSet'))}>
            {t('adm.printers.makeDefault')}
          </Button>
        </div>

        <Field label={t('adm.printers.displayName')}>
          <TextInput value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} />
        </Field>
        <Field label={t('adm.printers.location')}>
          <TextInput value={form.location} placeholder={t('adm.printers.locationPh')} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
        </Field>

        <div className="rounded-2xl border border-white/[0.07] divide-y divide-white/[0.05]">
          <SettingRow title={t('adm.printers.broadcast')} description={t('adm.printers.broadcastDesc')}>
            <Switch checked={form.publish} onChange={(v) => setForm((f) => ({ ...f, publish: v }))} label={t('adm.printers.broadcast')} />
          </SettingRow>
          {form.publish && (
            <div className="px-4 py-3.5">
              <Field label={t('adm.printers.broadcastName')} hint={t('adm.printers.broadcastNameHint', { name: printer.mdns_name || printer.display_name })}>
                <TextInput value={form.broadcast_name} placeholder={printer.display_name} onChange={(e) => setForm((f) => ({ ...f, broadcast_name: e.target.value.slice(0, 60) }))} />
              </Field>
            </div>
          )}
          <SettingRow title={t('adm.printers.default')} description={t('adm.printers.defaultDesc')}>
            <Switch checked={form.is_default} onChange={(v) => setForm((f) => ({ ...f, is_default: v }))} label={t('adm.printers.default')} />
          </SettingRow>
        </div>

        <div className="space-y-3">
          {printer.ipp_url && <CopyField label={t('adm.printers.ippAddress')} value={printer.ipp_url} />}
          {printer.mdns_url && <CopyField label={t('adm.printers.mdnsAddress')} value={printer.mdns_url} />}
          {printer.device_uri && <CopyField label={t('adm.printers.deviceUri')} value={printer.device_uri} />}
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('adm.printers.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" icon={busy === 'delete' ? Loader2 : Trash2} disabled={Boolean(busy)} onClick={() => run('delete', () => adminFetch(`/api/printers/${encodeURIComponent(q)}`, { method: 'DELETE' }), t('adm.printers.deleted')).then((ok) => { if (ok) { setConfirmDelete(false); onClose(); } })}>
              {t('adm.printers.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{t('adm.printers.deleteDesc', { name: printer.display_name || q })}</p>
      </Modal>
    </SideSheet>
  );
}

const PROTOCOLS = [
  { value: 'socket', label: 'RAW 9100', port: '9100' },
  { value: 'ipp', label: 'IPP', port: '631' },
  { value: 'ipps', label: 'IPPS', port: '631' },
  { value: 'lpd', label: 'LPD', port: '515' }
];

function AddPrinterModal({ onClose, refresh, showToast }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', display_name: '', location: '', protocol: 'ipp', host: '', port: '631', queue_path: 'ipp/print', driver: 'everywhere', publish: false });
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  const test = async () => {
    setBusy('probe');
    setProbe(null);
    try {
      const r = await adminFetch('/api/printers/probe-network', { method: 'POST', body: { host: f.host.trim(), port: parseInt(f.port, 10) || 631 } });
      setProbe(r);
    } catch (e) {
      setProbe({ reachable: false, error: e.message });
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!f.name.trim() || !f.host.trim()) { showToast?.(t('adm.printers.add.required'), 'error'); return; }
    setBusy('add');
    try {
      await adminFetch('/api/printers/add', {
        method: 'POST',
        body: {
          name: f.name.trim(), display_name: f.display_name.trim() || f.name.trim(), location: f.location.trim(),
          protocol: f.protocol, host: f.host.trim(), port: parseInt(f.port, 10) || 631, queue_path: f.queue_path.trim(),
          driver: f.driver, publish_broadcast: f.publish
        }
      });
      showToast?.(t('adm.printers.add.added'), 'success');
      await refresh?.();
      onClose();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('adm.printers.add.title')}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={busy === 'add' ? Loader2 : Plus} disabled={Boolean(busy)} onClick={add}>{t('adm.printers.add.submit')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-400">{t('adm.printers.add.desc')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t('adm.printers.add.queueName')} hint={t('adm.printers.add.queueHint')}>
            <TextInput value={f.name} mono placeholder="Office_Laser" onChange={(e) => set({ name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '_') })} />
          </Field>
          <Field label={t('adm.printers.displayName')}>
            <TextInput value={f.display_name} placeholder="Office Laser" onChange={(e) => set({ display_name: e.target.value })} />
          </Field>
        </div>
        <Field label={t('adm.printers.add.protocol')}>
          <Segmented size="sm" value={f.protocol} onChange={(v) => { const p = PROTOCOLS.find((x) => x.value === v); set({ protocol: v, port: p.port }); setProbe(null); }} options={PROTOCOLS} />
        </Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={t('adm.printers.add.host')}>
            <TextInput value={f.host} mono placeholder="192.168.1.50" onChange={(e) => { set({ host: e.target.value }); setProbe(null); }} />
          </Field>
          <Field label={t('adm.printers.add.port')}>
            <TextInput value={f.port} mono onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        {(f.protocol === 'ipp' || f.protocol === 'ipps' || f.protocol === 'lpd') && (
          <Field label={t('adm.printers.add.path')}>
            <TextInput value={f.queue_path} mono onChange={(e) => set({ queue_path: e.target.value })} />
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" icon={busy === 'probe' ? Loader2 : Globe} disabled={!f.host.trim() || Boolean(busy)} onClick={test}>{t('adm.printers.add.test')}</Button>
          {probe && (probe.reachable
            ? <StatusPill tone="ok">{t('adm.printers.add.reachable', { ms: probe.latency_ms ?? '?' })}</StatusPill>
            : <StatusPill tone="danger">{probe.error || t('adm.printers.add.unreachable')}</StatusPill>)}
        </div>
        <Field label={t('adm.printers.add.driver')}>
          <Select value={f.driver} onChange={(e) => set({ driver: e.target.value })}>
            <option value="everywhere">{t('adm.printers.add.drivers.everywhere')}</option>
            <option value="generic-pcl">{t('adm.printers.add.drivers.pcl')}</option>
            <option value="generic-ps">{t('adm.printers.add.drivers.ps')}</option>
            <option value="generic-escp">{t('adm.printers.add.drivers.escp')}</option>
            <option value="raw">{t('adm.printers.add.drivers.raw')}</option>
          </Select>
        </Field>
        <div className="rounded-2xl border border-white/[0.07]">
          <SettingRow title={t('adm.printers.broadcast')} description={t('adm.printers.broadcastDesc')}>
            <Switch checked={f.publish} onChange={(v) => set({ publish: v })} label={t('adm.printers.broadcast')} />
          </SettingRow>
        </div>
      </div>
    </Modal>
  );
}

const REC_TONE = { native: 'info', driver: 'ok', review: 'warn', generic: 'danger', unknown: 'idle' };
const DISCOVER_ERRORS = ['lpadmin_failed', 'already_configured', 'not_found', 'not_adoptable', 'timeout', 'discovery_failed', 'discovery_timeout'];
const discoverError = (t, code) => t(`adm.printers.discover.errors.${DISCOVER_ERRORS.includes(code) ? code : 'generic'}`);

function discoveryPill(c, t) {
  if (c.configured_queue) return <StatusPill tone="idle">{t('adm.printers.discover.added', { queue: c.configured_queue })}</StatusPill>;
  return <StatusPill tone={REC_TONE[c.recommendation] || 'idle'}>{t(`adm.printers.discover.rec.${c.recommendation}`)}</StatusPill>;
}

function AdoptModal({ candidate, onClose, onDone, showToast }) {
  const { t } = useI18n();
  const name = candidate.make_model || candidate.name || candidate.host;
  // Sharing defaults on only where the hub adds something phones don't already have: an exact
  // driver for a printer that can't do AirPrint itself.
  const [publish, setPublish] = useState(candidate.recommendation === 'driver');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const adopt = async () => {
    setBusy(true);
    setError('');
    try {
      await adminFetch('/api/printers/discover/adopt', { method: 'POST', body: { id: candidate.id, publish } });
      showToast?.(t('adm.printers.discover.adopted', { name }), 'success');
      onDone?.();
      onClose();
    } catch (e) {
      setError(discoverError(t, e.body?.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('adm.printers.discover.adoptTitle', { name })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" className="ml-auto" icon={busy ? Loader2 : Plus} disabled={busy} onClick={adopt}>{t('adm.printers.discover.adoptConfirm')}</Button>
      </>}>
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <StatusPill tone={REC_TONE[candidate.recommendation] || 'idle'}>{t(`adm.printers.discover.rec.${candidate.recommendation}`)}</StatusPill>
        </div>
        <p className="text-xs text-slate-300 leading-relaxed">{t(`adm.printers.discover.recDesc.${candidate.recommendation}`)}</p>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-slate-500">{t('adm.printers.discover.address')}</dt>
          <dd className="font-mono text-slate-200 break-all">{candidate.adopt?.uri}</dd>
          <dt className="text-slate-500">{t('adm.printers.discover.driver')}</dt>
          <dd className="text-slate-200">{candidate.adopt?.driver_desc}</dd>
        </dl>
        <List>
          <SettingRow title={t('adm.printers.discover.share')} description={t('adm.printers.discover.shareDesc')}>
            <Switch checked={publish} onChange={setPublish} label={t('adm.printers.discover.share')} />
          </SettingRow>
        </List>
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      </div>
    </Modal>
  );
}

function NetworkDiscovery({ refresh, showToast }) {
  const { t, lang } = useI18n();
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [adopting, setAdopting] = useState(null);
  const [savingAuto, setSavingAuto] = useState(false);

  // The last scan the hub ran (if any) without starting a new one; scanning takes a few seconds.
  const load = useCallback(async (fresh) => {
    if (fresh) setScanning(true);
    try {
      setScan(await adminFetch(`/api/printers/discover?${fresh ? 'refresh=1' : 'cached=1'}`));
    } catch (e) {
      if (fresh) showToast?.(discoverError(t, e.body?.code), 'error');
    } finally {
      setScanning(false);
    }
  }, [showToast, t]);

  useEffect(() => { load(false); }, [load]);

  const setAuto = async (value) => {
    setSavingAuto(true);
    try {
      await adminFetch('/api/printers/discover/settings', { method: 'POST', body: { auto_adopt: value } });
      setScan((prev) => ({ ...(prev || {}), auto_adopt: value }));
      showToast?.(t('adm.common.saved'), 'success');
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setSavingAuto(false);
    }
  };

  const candidates = scan?.candidates || [];
  return (
    <div className="mt-8">
      <SectionLabel right={<Button size="sm" variant="secondary" icon={scanning ? Loader2 : Search} disabled={scanning} onClick={() => load(true)}>{scanning ? t('adm.printers.discover.scanning') : t('adm.printers.discover.scan')}</Button>}>
        {t('adm.printers.discover.title')}
      </SectionLabel>
      <List>
        <SettingRow title={t('adm.printers.discover.autoAdopt')} description={t('adm.printers.discover.autoAdoptDesc')}>
          <Switch checked={Boolean(scan?.auto_adopt)} disabled={savingAuto || !scan} onChange={setAuto} label={t('adm.printers.discover.autoAdopt')} />
        </SettingRow>
      </List>
      <div className="mt-3">
        {!scan?.scanned_at ? (
          <EmptyState icon={Wifi} title={t('adm.printers.discover.title')} description={t('adm.printers.discover.never')} />
        ) : candidates.length === 0 ? (
          <EmptyState icon={Wifi} title={t('adm.printers.discover.none')} description={t('adm.printers.discover.noneDesc')} />
        ) : (
          <List>
            {candidates.map((c) => (
              <ListRow
                key={c.id}
                wrap
                leading={<span className="h-10 w-10 rounded-xl flex items-center justify-center border bg-white/[0.04] border-white/10 text-slate-400"><Globe className="w-4 h-4" /></span>}
                title={c.make_model || c.name || c.host}
                // On a phone the verdict pill moves under the address so the name keeps its width.
                subtitle={<>
                  {[c.host || c.name, (c.protocols || []).join(' · ').toUpperCase(), c.location].filter(Boolean).join(' · ')}
                  <span className="sm:hidden block mt-1.5">{discoveryPill(c, t)}</span>
                </>}
                trailing={<>
                  <span className="hidden sm:inline-flex">{discoveryPill(c, t)}</span>
                  {!c.configured_queue && c.adopt && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setAdopting(c)}>{t('adm.printers.discover.adopt')}</Button>}
                </>}
              />
            ))}
          </List>
        )}
        {scan?.scanned_at && <p className="mt-2 text-[11px] text-slate-500">{t('adm.printers.discover.lastScan', { at: formatDate(scan.scanned_at * 1000, lang) })}</p>}
      </div>
      {adopting && <AdoptModal candidate={adopting} onClose={() => setAdopting(null)} onDone={() => { load(false); refresh?.(); }} showToast={showToast} />}
    </div>
  );
}

export default function Printers({ data, refresh, showToast, go }) {
  const { t } = useI18n();
  const [openQueue, setOpenQueue] = useState(null);
  const [adding, setAdding] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const printers = data?.printers || [];
  const names = data?.custom_mdns?.custom_broadcast_names || {};
  const open = printers.find((p) => (p.queue_name || p.name) === openQueue) || null;

  useEffect(() => { if (openQueue && !open) setOpenQueue(null); }, [openQueue, open]);

  const rescan = async () => {
    setRescanning(true);
    try {
      await adminFetch('/api/system/rescan', { method: 'POST' });
      showToast?.(t('adm.printers.rescanned'), 'success');
      await refresh?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setRescanning(false);
    }
  };

  const sorted = [...printers].sort((a, b) => Number(b.connected) - Number(a.connected) || String(a.display_name).localeCompare(String(b.display_name)));

  return (
    <div>
      <PageHeader
        title={t('adm.printers.title')}
        description={t('adm.printers.desc')}
        actions={
          <>
            <Button size="sm" variant="secondary" icon={rescanning ? Loader2 : RefreshCw} disabled={rescanning} onClick={rescan}>{t('adm.printers.rescan')}</Button>
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>{t('adm.printers.addBtn')}</Button>
          </>
        }
      />

      {printers.length === 0 ? (
        <EmptyState icon={Printer} title={t('adm.printers.emptyTitle')} description={t('adm.printers.emptyDesc')} />
      ) : (
        <List>
          {sorted.map((p) => {
            const q = p.queue_name || p.name;
            // printerStatus() already folds in driver readiness (it won't claim "Ready" if the
            // driver hasn't been confirmed working), so the list row needs only the one pill.
            const st = printerStatus(p, t);
            const usb = p.protocol === 'usb' || p.is_usb;
            return (
              <ListRow
                key={q}
                onClick={() => setOpenQueue(q)}
                leading={
                  <span className={`h-10 w-10 rounded-xl flex items-center justify-center border ${p.connected ? 'bg-manta-500/10 border-manta-500/25 text-manta-300' : 'bg-white/[0.04] border-white/10 text-slate-500'}`}>
                    {usb ? <Usb className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
                  </span>
                }
                title={<span className="flex items-center gap-2">{p.display_name || q}{p.is_default && <Star className="w-3.5 h-3.5 text-amber-300 fill-amber-300" aria-label={t('adm.printers.default')} />}</span>}
                subtitle={`${q} · ${usb ? 'USB' : (p.protocol || 'network').toUpperCase()}${p.location ? ` · ${p.location}` : ''}`}
                trailing={
                  <>
                    {p.is_published ? (
                      <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-manta-300 font-semibold" title={t('adm.printers.broadcast')}><Radio className="w-3.5 h-3.5" />{names[q] || p.mdns_name || t('adm.printers.broadcasting')}</span>
                    ) : (
                      <span className="hidden sm:inline text-[11px] text-slate-500">{t('adm.printers.hidden')}</span>
                    )}
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                  </>
                }
              />
            );
          })}
        </List>
      )}

      <p className="mt-3 text-[11px] text-slate-500">{t('adm.printers.footnote')}</p>

      <NetworkDiscovery refresh={refresh} showToast={showToast} />

      {open && <PrinterSheet go={go} key={openQueue} printer={open} broadcastName={names[openQueue] || ''} onClose={() => setOpenQueue(null)} refresh={refresh} showToast={showToast} />}
      {adding && <AddPrinterModal onClose={() => setAdding(false)} refresh={refresh} showToast={showToast} />}
    </div>
  );
}
