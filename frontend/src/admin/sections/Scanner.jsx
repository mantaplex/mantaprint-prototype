import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScanLine, Loader2, Cpu, Upload, Puzzle, ExternalLink, FileSignature } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, StatusPill, Button, List, SettingRow, Switch, SectionLabel } from '../../ui/index.js';
import { adminFetch, getAdminToken } from '../../shell/api.js';

const FW_ERRORS = ['no_nal_found', 'extract_failed', 'invalid_size', 'unknown_target', 'too_large', 'insufficient_space', 'busy', 'no_tools', 'write_failed', 'upload_failed'];

export function firmwareErrorText(t, code) {
  return t(`adm.scanner.fw.errors.${FW_ERRORS.includes(code) ? code : 'generic'}`);
}

// Raw-body upload through XHR (fetch can't report upload progress); an installer can
// be a few hundred MB over the hub's Wi-Fi.
function uploadFirmware(file, onProgress) {
  return uploadRaw('/api/scanner/firmware', file, onProgress);
}

function uploadRaw(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Admin-Token', getAdminToken());
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve(body || { success: false, code: 'generic' });
    };
    xhr.onerror = () => reject(new Error('upload_failed'));
    xhr.send(file);
  });
}

function FirmwareUpload({ fw, onDone, showToast }) {
  const { t } = useI18n();
  const input = useRef(null);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState('');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (fw?.max_upload_bytes && file.size > fw.max_upload_bytes) {
      setError(t('adm.scanner.fw.tooBig', { mb: Math.round(fw.max_upload_bytes / 1048576) }));
      return;
    }
    setPhase(0);
    try {
      const body = await uploadFirmware(file, (p) => setPhase(p >= 100 ? 'searching' : p));
      if (body.success) showToast?.(t('adm.scanner.fw.installed', { models: (body.installed || []).map((i) => i.model || i.filename).join(', ') }), 'success');
      else setError(firmwareErrorText(t, body.code));
    } catch {
      setError(firmwareErrorText(t, 'upload_failed'));
    } finally {
      setPhase(null);
      onDone?.();
    }
  };

  return (
    <div>
      <input ref={input} type="file" className="hidden" onChange={pick} />
      <Button size="sm" variant="secondary" icon={phase !== null ? Loader2 : Upload} disabled={phase !== null || fw?.busy} onClick={() => input.current?.click()}>
        {phase === null ? t('adm.scanner.fw.upload') : phase === 'searching' ? t('adm.scanner.fw.searching') : t('adm.scanner.fw.uploading', { p: phase })}
      </Button>
      {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

const HP_ERRORS = ['not_a_plugin', 'hplip_missing', 'version_mismatch', 'hp_plugin_missing', 'install_failed', 'too_large', 'insufficient_space', 'busy', 'upload_failed'];

function hpErrorText(t, body) {
  const code = HP_ERRORS.includes(body?.code) ? body.code : 'generic';
  return t(`adm.scanner.hp.errors.${code}`, { file: body?.required_file || '', v: body?.uploaded_version || '' });
}

/** Upload of HP's plugin (.run) and, optionally, its detached signature (.asc). */
function HpPluginUpload({ hp, onDone, showToast }) {
  const { t } = useI18n();
  const runInput = useRef(null);
  const ascInput = useRef(null);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');
  const disabled = phase !== null || hp?.busy || !hp?.hplip_installed;

  const pickAsc = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const body = await uploadRaw('/api/drivers/hplip/plugin?kind=asc', file, () => {});
      if (body.success) showToast?.(t('adm.scanner.hp.ascStored'), 'success');
      else setError(hpErrorText(t, body));
    } catch { setError(hpErrorText(t, { code: 'upload_failed' })); }
  };

  const pickRun = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setDetail('');
    if (hp?.max_upload_bytes && file.size > hp.max_upload_bytes) { setError(t('adm.scanner.hp.errors.too_large')); return; }
    if (hp?.required_file && file.name.toLowerCase() !== hp.required_file.toLowerCase()) {
      setError(t('adm.scanner.hp.errors.version_mismatch', { file: hp.required_file, v: file.name }));
      return;
    }
    setPhase(0);
    try {
      const body = await uploadRaw('/api/drivers/hplip/plugin', file, (p) => setPhase(p >= 100 ? 'installing' : p));
      if (body.success && body.job) showToast?.(t('adm.scanner.hp.jobStarted'), 'success');
      else if (body.success) showToast?.(t('adm.scanner.hp.installed', { v: body.version }), 'success');
      else { setError(hpErrorText(t, body)); if (body.tail) setDetail(body.tail); }
    } catch { setError(hpErrorText(t, { code: 'upload_failed' })); }
    finally { setPhase(null); onDone?.(); }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input ref={runInput} type="file" accept=".run" className="hidden" onChange={pickRun} />
      <input ref={ascInput} type="file" accept=".asc" className="hidden" onChange={pickAsc} />
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="secondary" icon={FileSignature} disabled={disabled} onClick={() => ascInput.current?.click()} title={t('adm.scanner.hp.ascHint')}>{t('adm.scanner.hp.uploadAsc')}</Button>
        <Button size="sm" variant="primary" icon={phase !== null ? Loader2 : Upload} disabled={disabled} onClick={() => runInput.current?.click()}>
          {phase === null ? t('adm.scanner.hp.upload') : phase === 'installing' ? t('adm.scanner.hp.installing') : t('adm.scanner.fw.uploading', { p: phase })}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-rose-300 text-right max-w-md">{error}</p>}
      {detail && <pre className="text-[10px] text-slate-500 max-w-md max-h-32 overflow-auto whitespace-pre-wrap text-left">{detail}</pre>}
    </div>
  );
}

function HpPluginNeeded({ hp, device, onDone, showToast }) {
  const { t } = useI18n();
  return (
    <Card className="!border-amber-500/30 !bg-amber-500/[0.06]">
      <CardHeader icon={Puzzle} title={t('adm.scanner.hp.needsTitle', { model: device.model })} description={hp.hplip_installed ? t('adm.scanner.hp.needsDesc') : t('adm.scanner.hp.noHplipDesc')}
        actions={<StatusPill tone="warn">{t('adm.scanner.hp.missing')}</StatusPill>} />
      <div className="mt-4 text-xs text-slate-300 space-y-1.5">
        <div className="font-semibold text-slate-100">{t('adm.scanner.fw.whereTitle')}</div>
        <p>{t('adm.scanner.hp.where1', { file: hp.required_file || 'hplip-<version>-plugin.run', v: hp.hplip_version || '?' })} <a className="text-manta-300 underline inline-flex items-center gap-1" href={hp.download_url} target="_blank" rel="noreferrer">developers.hp.com <ExternalLink className="w-3 h-3" /></a></p>
        <p>{t('adm.scanner.hp.where2')}</p>
        <p className="text-slate-500">{t('adm.scanner.hp.license')}</p>
      </div>
      <div className="mt-4"><HpPluginUpload hp={hp} onDone={onDone} showToast={showToast} /></div>
    </Card>
  );
}

function FirmwareNeeded({ fw, device, onDone, showToast }) {
  const { t } = useI18n();
  return (
    <Card className="!border-amber-500/30 !bg-amber-500/[0.06]">
      <CardHeader icon={Cpu} title={t('adm.scanner.fw.needsTitle', { model: device.model })} description={t('adm.scanner.fw.needsDesc', { file: device.filename })}
        actions={<StatusPill tone="warn">{t('adm.scanner.fw.missing')}</StatusPill>} />
      <div className="mt-4 text-xs text-slate-300 space-y-1.5">
        <div className="font-semibold text-slate-100">{t('adm.scanner.fw.whereTitle')}</div>
        <p>{t('adm.scanner.fw.where1', { file: device.filename })}</p>
        <p>{t('adm.scanner.fw.where2')}</p>
      </div>
      <div className="mt-4"><FirmwareUpload fw={fw} onDone={onDone} showToast={showToast} /></div>
    </Card>
  );
}

export default function Scanner({ data, showToast, go }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [fw, setFw] = useState(null);
  const [hp, setHp] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, f, h] = await Promise.all([
        adminFetch('/api/scanner/status'),
        adminFetch('/api/scanner/firmware').catch(() => null),
        adminFetch('/api/drivers/hplip').catch(() => null)
      ]);
      setStatus(s);
      setFw(f);
      setHp(h);
    } catch (e) {
      console.warn(e);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 8000); return () => clearInterval(id); }, [load]);

  const act = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) showToast?.(ok, 'success'); await load(); } catch (e) { showToast?.(e.message, 'error'); } finally { setBusy(null); }
  };

  const scanner = status?.scanner || data?.scanner;
  const connected = Boolean(scanner?.connected);
  const mutex = status?.mutex;
  const needsFw = fw?.needs_firmware?.[0];
  const fwInstalled = (fw?.devices || []).filter((d) => d.installed);
  const needsHp = hp?.needs_plugin?.[0];
  const pendingPlugin = !connected && scanner?.plugin_required;
  const pending = !connected && (scanner?.firmware_required || scanner?.plugin_required);

  return (
    <div>
      <PageHeader title={t('adm.scanner.title')} description={t('adm.scanner.desc')} />

      {/* Several scanners plugged in: one card each; the active one is the hub's default,
          Scan Studio can still pick any of them per scan. */}
      {status?.scanners?.length > 1 ? (
        <div className="space-y-3">
          {status.scanners.map((dev) => {
            const isSelected = dev.device_id === scanner?.device_id;
            return (
              <Card key={dev.device_id}>
                <CardHeader
                  icon={ScanLine}
                  title={dev.name}
                  description={`${dev.driver || 'SANE'} · ${(dev.sources || []).join(' / ')}`}
                  actions={
                    <div className="flex items-center gap-2">
                      <StatusPill tone={isSelected ? (mutex?.is_busy ? 'info' : 'ok') : 'idle'} pulse={isSelected && Boolean(mutex?.is_busy)}>
                        {isSelected ? (mutex?.is_busy ? t('adm.scanner.busy', { who: mutex.holder?.name || mutex.holder || '…' }) : t('adm.scanner.multi.active')) : t('adm.scanner.multi.available')}
                      </StatusPill>
                      {!isSelected && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => act('select', () => adminFetch('/api/scanner/select', { method: 'POST', body: { device_id: dev.device_id } }), t('adm.common.saved'))}
                        >
                          {t('adm.scanner.multi.select')}
                        </Button>
                      )}
                    </div>
                  }
                />
              </Card>
            );
          })}
        </div>
      ) : (connected || (!needsFw && !needsHp)) && (
        <Card>
          <CardHeader icon={ScanLine} title={connected ? scanner.name : pending ? pending.model : t('adm.scanner.none')} description={connected ? `${scanner.driver || 'SANE'} · ${(scanner.sources || []).join(' / ')}` : pendingPlugin ? t('adm.scanner.hp.pendingDesc') : pending ? t('adm.scanner.fw.pendingDesc') : t('adm.scanner.noneDesc')}
            actions={<StatusPill tone={connected ? (mutex?.is_busy ? 'info' : 'ok') : pending ? 'warn' : 'idle'} pulse={Boolean(mutex?.is_busy)}>{connected ? (mutex?.is_busy ? t('adm.scanner.busy', { who: mutex.holder?.name || mutex.holder || '…' }) : t('adm.scanner.ready')) : pendingPlugin ? t('adm.scanner.hp.missing') : pending ? t('adm.scanner.fw.missing') : t('adm.scanner.offline')}</StatusPill>} />
        </Card>
      )}

      {needsFw && <div className={connected ? 'mt-4' : ''}><FirmwareNeeded fw={fw} device={needsFw} onDone={load} showToast={showToast} /></div>}
      {needsHp && <div className={connected || needsFw ? 'mt-4' : ''}><HpPluginNeeded hp={hp} device={needsHp} onDone={load} showToast={showToast} /></div>}

      <div className="mt-6">
        <SectionLabel>{t('adm.scanner.access')}</SectionLabel>
        <List>
          <SettingRow title={t('adm.scanner.portal')} description={t('adm.scanner.portalDesc')}>
            <Switch checked={status?.portal_enabled !== false} disabled={busy === 'portal'} onChange={(v) => act('portal', () => adminFetch('/api/scanner/config', { method: 'POST', body: { portal_enabled: v } }), t('adm.common.saved'))} label={t('adm.scanner.portal')} />
          </SettingRow>
        </List>
      </div>

      {(fw || hp) && (
        <div className="mt-6">
          <SectionLabel right={<Button size="sm" variant="ghost" onClick={() => go?.('drivers')}>{t('adm.scanner.drivers.openCenter')}</Button>}>{t('adm.scanner.drivers.title')}</SectionLabel>
          <p className="text-xs text-slate-500 mb-2">{t('adm.scanner.drivers.desc')}</p>
          <List>
            {fw && !needsFw && (
              <SettingRow title={fwInstalled.length ? t('adm.scanner.fw.installedCount', { n: fwInstalled.length, files: fwInstalled.map((d) => d.model.replace(/^Fujitsu\s+/, '')).join(', ') }) : t('adm.scanner.fw.noneInstalled')} description={t('adm.scanner.fw.desc')}>
                <FirmwareUpload fw={fw} onDone={load} showToast={showToast} />
              </SettingRow>
            )}
            {hp && !needsHp && (
              <SettingRow
                title={hp.plugin_installed ? t('adm.scanner.hp.installedTitle', { v: hp.plugin_version }) : hp.hplip_installed ? t('adm.scanner.hp.noneInstalled') : t('adm.scanner.hp.noHplip')}
                description={hp.plugin_installed ? t('adm.scanner.hp.installedDesc') : hp.hplip_installed ? t('adm.scanner.hp.desc', { file: hp.required_file || '' }) : t('adm.scanner.hp.noHplipDesc')}>
                {hp.plugin_installed ? <StatusPill tone={hp.plugin_matches === false ? 'warn' : 'ok'}>{hp.plugin_matches === false ? t('adm.scanner.hp.versionOff', { v: hp.plugin_version, h: hp.hplip_version }) : t('adm.scanner.hp.installedPill')}</StatusPill> : <HpPluginUpload hp={hp} onDone={load} showToast={showToast} />}
              </SettingRow>
            )}
          </List>
        </div>
      )}
    </div>
  );
}
