import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ScanLine, Smartphone, QrCode, Loader2, Pencil, Ban, RotateCcw, Trash2, Check, X, Lock, Unlock, Cpu, Upload } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, StatusPill, Button, List, SettingRow, Switch, EmptyState, Modal, SectionLabel, TextInput, CopyField, formatDate } from '../../ui/index.js';
import { adminFetch, getAdminToken } from '../../shell/api.js';

function PairingModal({ onClose, onPaired }) {
  const { t } = useI18n();
  const [code, setCode] = useState(null);
  const [qr, setQr] = useState('');
  const [left, setLeft] = useState(300);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const d = await adminFetch('/api/scanner/pairing/generate', { method: 'POST' });
        setCode(d);
        setLeft(d.expires_in_sec || 300);
        const host = window.location.host;
        const url = `http://${host}/scanner/#pairing=${d.pairing_token}&pin=${d.pin}&host=${host}`;
        setQr(await QRCode.toDataURL(url, { width: 240, margin: 2, color: { dark: '#000000', light: '#ffffff' } }));
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  useEffect(() => {
    if (!code || left <= 0) return;
    const id = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [code, left]);

  return (
    <Modal open onClose={() => { onClose(); onPaired?.(); }} title={t('adm.scanner.pairTitle')}>
      {error ? (
        <p className="text-sm text-rose-300">{error}</p>
      ) : !code ? (
        <div className="h-40 flex items-center justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="text-center">
          <p className="text-xs text-slate-400">{t('adm.scanner.pairDesc')}</p>
          {qr && <img src={qr} alt="QR" className="mx-auto mt-4 rounded-xl w-48 h-48" />}
          <div className="mt-4 text-[11px] text-slate-500 uppercase tracking-wide">{t('adm.scanner.pin')}</div>
          <div className="text-3xl font-black tracking-[0.3em] text-white font-mono">{code.pin}</div>
          <div className="mt-3"><StatusPill tone={left > 30 ? 'info' : 'warn'}>{left > 0 ? t('adm.scanner.expiresIn', { m: Math.floor(left / 60), s: String(left % 60).padStart(2, '0') }) : t('adm.scanner.expired')}</StatusPill></div>
          <div className="mt-4 text-left"><CopyField label={t('adm.scanner.pwaAddress')} value={`http://${window.location.host}/scanner/`} /></div>
        </div>
      )}
    </Modal>
  );
}

const FW_ERRORS = ['no_nal_found', 'extract_failed', 'invalid_size', 'unknown_target', 'too_large', 'insufficient_space', 'busy', 'no_tools', 'write_failed', 'upload_failed'];

export function firmwareErrorText(t, code) {
  return t(`adm.scanner.fw.errors.${FW_ERRORS.includes(code) ? code : 'generic'}`);
}

// Raw-body upload through XHR (fetch can't report upload progress); an installer can
// be a few hundred MB over the hub's Wi-Fi.
function uploadFirmware(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/scanner/firmware');
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

export default function Scanner({ data, showToast }) {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState(null);
  const [clients, setClients] = useState([]);
  const [busy, setBusy] = useState(null);
  const [pairing, setPairing] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [fw, setFw] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, c, f] = await Promise.all([adminFetch('/api/scanner/status'), adminFetch('/api/scanner/clients'), adminFetch('/api/scanner/firmware').catch(() => null)]);
      setStatus(s);
      setClients(c.clients || []);
      setFw(f);
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
  const pending = !connected && scanner?.firmware_required;

  return (
    <div>
      <PageHeader title={t('adm.scanner.title')} description={t('adm.scanner.desc')} />

      {/* A ScanSnap waiting on firmware *is* the scanner, so its card replaces the
          "not detected" one; next to another working scanner it's shown as well. */}
      {(connected || !needsFw) && (
        <Card>
          <CardHeader icon={ScanLine} title={connected ? scanner.name : pending ? pending.model : t('adm.scanner.none')} description={connected ? `${scanner.driver || 'SANE'} · ${(scanner.sources || []).join(' / ')}` : pending ? t('adm.scanner.fw.pendingDesc') : t('adm.scanner.noneDesc')}
            actions={<StatusPill tone={connected ? (mutex?.is_busy ? 'info' : 'ok') : pending ? 'warn' : 'idle'} pulse={Boolean(mutex?.is_busy)}>{connected ? (mutex?.is_busy ? t('adm.scanner.busy', { who: mutex.holder?.name || mutex.holder?.client_name || '…' }) : t('adm.scanner.ready')) : pending ? t('adm.scanner.fw.missing') : t('adm.scanner.offline')}</StatusPill>} />
        </Card>
      )}

      {needsFw && <div className={connected ? 'mt-4' : ''}><FirmwareNeeded fw={fw} device={needsFw} onDone={load} showToast={showToast} /></div>}

      <div className="mt-6">
        <SectionLabel>{t('adm.scanner.access')}</SectionLabel>
        <List>
          <SettingRow title={t('adm.scanner.portal')} description={t('adm.scanner.portalDesc')}>
            <Switch checked={status?.portal_enabled !== false} disabled={busy === 'portal'} onChange={(v) => act('portal', () => adminFetch('/api/scanner/config', { method: 'POST', body: { portal_enabled: v } }), t('adm.common.saved'))} label={t('adm.scanner.portal')} />
          </SettingRow>
          <SettingRow title={t('adm.scanner.pwaApi')} description={t('adm.scanner.pwaApiDesc')}>
            <Switch checked={status?.remote_pwa_api_enabled !== false} disabled={busy === 'pwa'} onChange={(v) => act('pwa', () => adminFetch('/api/scanner/config', { method: 'POST', body: { remote_pwa_api_enabled: v } }), t('adm.common.saved'))} label={t('adm.scanner.pwaApi')} />
          </SettingRow>
        </List>
      </div>

      {fw && !needsFw && (
        <div className="mt-6">
          <SectionLabel>{t('adm.scanner.fw.title')}</SectionLabel>
          <List>
            <SettingRow title={fwInstalled.length ? t('adm.scanner.fw.installedCount', { n: fwInstalled.length, files: fwInstalled.map((d) => d.model.replace(/^Fujitsu\s+/, '')).join(', ') }) : t('adm.scanner.fw.noneInstalled')} description={t('adm.scanner.fw.desc')}>
              <FirmwareUpload fw={fw} onDone={load} showToast={showToast} />
            </SettingRow>
          </List>
        </div>
      )}

      <div className="mt-6">
        <SectionLabel right={<Button size="sm" variant="secondary" icon={QrCode} onClick={() => setPairing(true)}>{t('adm.scanner.pair')}</Button>}>
          {t('adm.scanner.devices')} ({clients.length})
        </SectionLabel>
        {clients.length === 0 ? (
          <EmptyState icon={Smartphone} title={t('adm.scanner.noDevices')} description={t('adm.scanner.noDevicesDesc')} />
        ) : (
          <List>
            {clients.map((c) => {
              const revoked = c.status === 'revoked';
              return (
                <div key={c.client_id} className="flex items-center gap-3 px-4 py-3">
                  <span className={`h-9 w-9 rounded-xl flex items-center justify-center border ${revoked ? 'bg-white/[0.03] border-white/10 text-slate-600' : 'bg-manta-500/10 border-manta-500/25 text-manta-300'}`}>
                    {revoked ? <Lock className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editing === c.client_id ? (
                      <div className="flex items-center gap-1.5">
                        <TextInput autoFocus className="!h-9" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') act('rename', () => adminFetch(`/api/scanner/clients/${c.client_id}/rename`, { method: 'POST', body: { device_name: editName.trim() } }), t('adm.common.saved')).then(() => setEditing(null)); if (e.key === 'Escape') setEditing(null); }} />
                        <button type="button" className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-manta-300" aria-label={t('adm.common.save')} onClick={() => act('rename', () => adminFetch(`/api/scanner/clients/${c.client_id}/rename`, { method: 'POST', body: { device_name: editName.trim() } }), t('adm.common.saved')).then(() => setEditing(null))}><Check className="w-4 h-4" /></button>
                        <button type="button" className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={t('common.cancel')} onClick={() => setEditing(null)}><X className="w-4 h-4" /></button>
                      </div>
                    ) : (
                      <>
                        <div className="text-sm font-semibold text-slate-100 truncate">{c.device_name || c.client_id}</div>
                        <div className="text-xs text-slate-500 truncate">{c.platform || '—'} · {c.last_seen_at ? t('adm.scanner.lastSeen', { at: formatDate(c.last_seen_at, lang) }) : t('adm.scanner.neverSeen')}{c.last_seen_ip ? ` · ${c.last_seen_ip}` : ''}</div>
                      </>
                    )}
                  </div>
                  <StatusPill tone={revoked ? 'danger' : 'ok'}>{revoked ? t('adm.scanner.revoked') : t('adm.scanner.active')}</StatusPill>
                  {editing !== c.client_id && (
                    <div className="flex items-center">
                      <button type="button" title={t('adm.scanner.rename')} aria-label={t('adm.scanner.rename')} onClick={() => { setEditing(c.client_id); setEditName(c.device_name || ''); }} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400"><Pencil className="w-4 h-4" /></button>
                      {revoked ? (
                        <button type="button" title={t('adm.scanner.reauthorize')} aria-label={t('adm.scanner.reauthorize')} onClick={() => act(c.client_id, () => adminFetch(`/api/scanner/clients/${c.client_id}/reauthorize`, { method: 'POST' }), t('adm.scanner.reauthorized'))} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400"><Unlock className="w-4 h-4" /></button>
                      ) : (
                        <button type="button" title={t('adm.scanner.revoke')} aria-label={t('adm.scanner.revoke')} onClick={() => act(c.client_id, () => adminFetch(`/api/scanner/clients/${c.client_id}/revoke`, { method: 'POST' }), t('adm.scanner.revokedToast'))} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-amber-300"><Ban className="w-4 h-4" /></button>
                      )}
                      <button type="button" title={t('adm.scanner.remove')} aria-label={t('adm.scanner.remove')} onClick={() => act(c.client_id, () => adminFetch(`/api/scanner/clients/${c.client_id}`, { method: 'DELETE' }), t('adm.scanner.removed'))} className="h-9 w-9 rounded-lg hover:bg-rose-500/15 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </List>
        )}
      </div>

      {pairing && <PairingModal onClose={() => setPairing(false)} onPaired={load} />}
    </div>
  );
}
