import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Server, Clock, UserCog, Power, Loader2, Check, KeyRound, Eye, EyeOff, Lock, Unlock, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, Button, Segmented, Field, TextInput, Select, Switch, SettingRow, Disclosure, Modal, StatusPill, CopyField } from '../../ui/index.js';
import { adminFetch } from '../../shell/api.js';

const HOST_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function Section({ icon, title, description, children, actions }) {
  return (
    <Card>
      <CardHeader icon={icon} title={title} description={description} actions={actions} />
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/** Lockdown mode (print-only firewall). The same switch exists in the TUI. */
function LockdownSection({ showToast, t, refresh }) {
  const [st, setSt] = useState(null);
  const [ips, setIps] = useState('');
  const [ssh, setSsh] = useState(false);
  const [pin, setPin] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [disablePin, setDisablePin] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'enable' | 'disable'
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/api/lockdown');
      setSt(r);
      if (!touched) { setIps((r.admin_ips || []).join(', ')); setSsh(Boolean(r.ssh_from_admin)); }
    } catch (e) { console.warn(e); }
  }, [touched]);
  useEffect(() => { load(); }, [load]);

  const fail = (r) => { setError(t(`adm.settings.lockdown.errors.${r?.code || 'generic'}`, { bad: (r?.bad || []).join(', '), tail: r?.tail || '' })); };
  const act = async (key, fn) => {
    setBusy(key); setError('');
    try { const r = await fn(); if (!r.success) fail(r); else { showToast?.(t('adm.common.saved'), 'success'); setTouched(false); } }
    catch (e) {
      if (e?.body && typeof e.body === 'object') fail(e.body);
      else { try { fail(JSON.parse(e.message)); } catch { fail({ code: e.message }); } }
    }
    finally { setBusy(null); setConfirm(null); setPin(''); setDisablePin(''); load(); refresh?.(); }
  };

  const enabled = Boolean(st?.enabled);
  return (
    <Section icon={enabled ? Lock : Unlock} title={t('adm.settings.lockdown.title')} description={t('adm.settings.lockdown.desc')}
      actions={<StatusPill tone={enabled ? (st?.applied === false ? 'warn' : 'danger') : 'idle'} pulse={enabled}>{enabled ? (st?.applied === false ? t('adm.settings.lockdown.enabledNotApplied') : t('adm.settings.lockdown.enabled')) : t('adm.settings.lockdown.disabled')}</StatusPill>}>
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-100 flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold">{t('adm.settings.lockdown.printOnlyTitle')}</div>
          <p className="mt-1 text-amber-200/90">{t('adm.settings.lockdown.printOnlyDesc')}</p>
        </div>
      </div>
      {st && !st.nft_available && <p className="mt-3 text-xs text-rose-300">{t('adm.settings.lockdown.errors.nft_missing')}</p>}
      {enabled && st?.counters && <p className="mt-3 text-[11px] text-slate-500">{t('adm.settings.lockdown.counters', { i: st.counters.dropped_in, o: st.counters.dropped_out })}{st.enabled_at ? ` · ${t('adm.settings.lockdown.since', { at: new Date(st.enabled_at).toLocaleString(), by: st.enabled_by || '?' })}` : ''}</p>}
      <div className="mt-4 grid gap-3">
        <Field label={t('adm.settings.lockdown.adminIps')} hint={t('adm.settings.lockdown.adminIpsHint')}>
          <TextInput value={ips} onChange={(e) => { setIps(e.target.value); setTouched(true); }} placeholder="192.168.10.5, 10.20.0.0/24" mono />
        </Field>
        <SettingRow title={t('adm.settings.lockdown.ssh')} description={t('adm.settings.lockdown.sshDesc')}>
          <Switch checked={ssh} onChange={(v) => { setSsh(v); setTouched(true); }} label={t('adm.settings.lockdown.ssh')} />
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={busy === 'cfg' ? Loader2 : Check} disabled={Boolean(busy) || !touched} onClick={() => act('cfg', () => adminFetch('/api/lockdown/config', { method: 'POST', body: { admin_ips: ips, ssh_from_admin: ssh } }))}>{t('adm.settings.lockdown.saveAccess')}</Button>
          {enabled
            ? <Button variant="primary" icon={Unlock} disabled={Boolean(busy)} onClick={() => { setDisablePin(''); setConfirm('disable'); }}>{t('adm.settings.lockdown.turnOff')}</Button>
            : <Button variant="danger" icon={Lock} disabled={Boolean(busy) || (st && !st.nft_available)} onClick={() => setConfirm('enable')}>{t('adm.settings.lockdown.turnOn')}</Button>}
        </div>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <Field label={t('adm.settings.lockdown.pinCurrent')} hint={st?.pin_is_default ? t('adm.settings.lockdown.pinDefaultHint') : undefined}><PasswordInput value={pin} autoComplete="off" onChange={(e) => setPin(e.target.value)} /></Field>
          <Field label={t('adm.settings.lockdown.pinNew')}><PasswordInput value={pinNew} autoComplete="off" placeholder="4-8 digits" onChange={(e) => setPinNew(e.target.value)} /></Field>
          <Button variant="secondary" icon={busy === 'pin' ? Loader2 : KeyRound} disabled={Boolean(busy) || !pin || !pinNew} onClick={() => act('pin', () => adminFetch('/api/lockdown/config', { method: 'POST', body: { pin_current: pin, pin_new: pinNew } })).then(() => setPinNew(''))}>{t('adm.settings.lockdown.changePin')}</Button>
        </div>
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      </div>

      <Modal open={Boolean(confirm)} onClose={() => { setConfirm(null); setDisablePin(''); }} title={confirm === 'enable' ? t('adm.settings.lockdown.confirmOnTitle') : t('adm.settings.lockdown.confirmOffTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => { setConfirm(null); setDisablePin(''); }}>{t('common.cancel')}</Button>
          {confirm === 'enable'
            ? <Button variant="danger" icon={busy ? Loader2 : Lock} disabled={Boolean(busy)} onClick={() => act('on', () => adminFetch('/api/lockdown/enable', { method: 'POST', body: { admin_ips: ips, ssh_from_admin: ssh } }))}>{t('adm.settings.lockdown.turnOn')}</Button>
            : <Button variant="primary" icon={busy ? Loader2 : Unlock} disabled={Boolean(busy) || !disablePin} onClick={() => act('off', () => adminFetch('/api/lockdown/disable', { method: 'POST', body: { pin: disablePin } }))}>{t('adm.settings.lockdown.turnOff')}</Button>}
        </>}>
        {confirm === 'enable' ? (
          <div className="text-sm text-slate-300 space-y-2">
            <p>{t('adm.settings.lockdown.confirmOnBody')}</p>
            <ul className="list-disc pl-5 text-xs text-slate-400 space-y-0.5">
              {['scan', 'home', 'admin', 'ssh', 'updates', 'pool'].map((k) => <li key={k}>{t(`adm.settings.lockdown.blocks.${k}`)}</li>)}
            </ul>
            <p className="text-xs">{ips.trim() ? t('adm.settings.lockdown.confirmOnIps', { ips }) : t('adm.settings.lockdown.confirmOnNoIps')}</p>
            <p className="text-xs text-amber-300">{t('adm.settings.lockdown.confirmOnPin')}</p>
          </div>
        ) : (
          <div className="text-sm text-slate-300 space-y-3">
            <p>{t('adm.settings.lockdown.confirmOffBody')}</p>
            <Field label={t('adm.settings.lockdown.pin')}><PasswordInput value={disablePin} autoComplete="off" onChange={(e) => setDisablePin(e.target.value)} /></Field>
          </div>
        )}
      </Modal>
    </Section>
  );
}

function PasswordInput({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextInput type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} autoComplete={autoComplete} className="pr-11" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-1 top-1 h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={show ? 'Hide' : 'Show'}>
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function Settings({ data, refresh, showToast, adminUser }) {
  const { t, setLanguage } = useI18n();
  const [settings, setSettings] = useState(null);
  const [timeStatus, setTimeStatus] = useState(null);
  const [zones, setZones] = useState({ curated: [], all: [] });
  const [busy, setBusy] = useState(null);
  const [hostname, setHostname] = useState('');
  const [tz, setTz] = useState('');
  const [ntp, setNtp] = useState({ enabled: true, servers: '' });
  const [manual, setManual] = useState(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
    };
  });
  const [profile, setProfile] = useState(null);
  const [acct, setAcct] = useState({ currentPassword: '', newUsername: '', newPassword: '', confirmPassword: '' });
  const [confirmReboot, setConfirmReboot] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/api/system/settings');
      setSettings(r.settings);
      setTimeStatus(r.time_status);
      setHostname((h) => h || r.settings?.hostname || 'mantaprint');
      setTz((x) => x || r.settings?.timezone || 'Asia/Jakarta');
      setNtp((n) => (n.touched ? n : { enabled: Boolean(r.settings?.ntp?.enabled), servers: (r.settings?.ntp?.servers || []).join(', ') }));
    } catch (e) {
      console.warn(e);
    }
  }, []);

  useEffect(() => {
    load();
    adminFetch('/api/system/timezones').then((z) => setZones({ curated: z.curated || [], all: z.all || [] })).catch(() => {});
    adminFetch('/api/auth/profile').then((p) => { setProfile(p); setAcct((a) => ({ ...a, newUsername: p.username || '' })); }).catch(() => {});
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); if (ok) showToast?.(ok, 'success'); await load(); refresh?.(); return r || true; } catch (e) { showToast?.(e.message, 'error'); return null; } finally { setBusy(null); }
  };

  const lang = settings?.language || 'en';
  const cleanHost = hostname.trim().toLowerCase();
  const hostValid = HOST_RE.test(cleanHost);
  const currentHost = data?.custom_mdns?.hostname || settings?.hostname || 'mantaprint';
  const zoneOptions = [...zones.curated.map((z) => ({ id: z.id, label: z.label })), ...zones.all.filter((id) => !zones.curated.some((c) => c.id === id)).map((id) => ({ id, label: id }))];

  const saveAccount = async () => {
    if (!acct.currentPassword) { showToast?.(t('adm.settings.account.needCurrent'), 'error'); return; }
    if (acct.newPassword && acct.newPassword !== acct.confirmPassword) { showToast?.(t('adm.settings.account.mismatch'), 'error'); return; }
    const r = await run('acct', () => adminFetch('/api/auth/profile', { method: 'POST', body: acct }), t('adm.settings.account.saved'));
    if (r) {
      setAcct({ currentPassword: '', newUsername: r.username || acct.newUsername, newPassword: '', confirmPassword: '' });
      setProfile((p) => ({ ...p, username: r.username, isDefaultPassword: r.isDefaultPassword }));
    }
  };

  return (
    <div>
      <PageHeader title={t('adm.settings.title')} description={t('adm.settings.desc')} />

      <div className="grid gap-5 grid-cols-1 xl:grid-cols-2 [&>*]:min-w-0">
        <Section icon={Server} title={t('adm.settings.hostname.title')} description={t('adm.settings.hostname.desc')}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <TextInput mono value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} className="pr-16" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-mono">.local</span>
            </div>
            <Button variant="primary" icon={busy === 'host' ? Loader2 : Check} disabled={!hostValid || cleanHost === currentHost || Boolean(busy)}
              onClick={() => run('host', () => adminFetch('/api/system/settings/hostname', { method: 'POST', body: { hostname: cleanHost } }), t('adm.settings.hostname.saved', { host: `${cleanHost}.local` }))}>
              {t('adm.common.save')}
            </Button>
          </div>
          <p className={`mt-2 text-[11px] ${hostValid ? 'text-slate-500' : 'text-rose-300'}`}>{hostValid ? t('adm.settings.hostname.hint') : t('adm.settings.hostname.invalid')}</p>
          <div className="mt-3"><CopyField label={t('adm.settings.hostname.current')} value={`http://${currentHost}.local`} /></div>
          <p className="mt-3 text-[11px] text-slate-500">{t('adm.settings.hostname.printerNames')}</p>
        </Section>

        <Section icon={Globe} title={t('adm.settings.language.title')} description={t('adm.settings.language.desc')}>
          <Segmented value={lang} onChange={(v) => run('lang', () => adminFetch('/api/system/settings/language', { method: 'POST', body: { language: v } }), t('adm.common.saved')).then((ok) => ok && setLanguage(v))}
            options={[{ value: 'en', label: 'English' }, { value: 'id', label: 'Bahasa Indonesia' }]} />
          <p className="mt-3 text-[11px] text-slate-500">{t('adm.settings.language.note')}</p>
        </Section>

        <Section icon={Clock} title={t('adm.settings.time.title')} description={timeStatus ? `${timeStatus.local_time} · ${timeStatus.timezone}` : t('adm.settings.time.desc')}
          actions={timeStatus && <StatusPill tone={timeStatus.ntp_active ? 'ok' : 'idle'}>{timeStatus.ntp_active ? t('adm.settings.time.synced') : t('adm.settings.time.manualMode')}</StatusPill>}>
          <Field label={t('adm.settings.time.zone')}>
            <div className="flex gap-2">
              <Select value={tz} onChange={(e) => setTz(e.target.value)}>
                {zoneOptions.length === 0 && <option value={tz}>{tz}</option>}
                {zoneOptions.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              </Select>
              <Button variant="secondary" icon={busy === 'tz' ? Loader2 : Check} disabled={!tz || tz === settings?.timezone || Boolean(busy)}
                onClick={() => run('tz', () => adminFetch('/api/system/settings/timezone', { method: 'POST', body: { timezone: tz } }), t('adm.common.saved'))}>
                {t('adm.common.save')}
              </Button>
            </div>
          </Field>
          <div className="mt-4 rounded-2xl border border-white/[0.07]">
            <SettingRow title={t('adm.settings.time.ntp')} description={t('adm.settings.time.ntpDesc')}>
              <Switch checked={ntp.enabled} onChange={(v) => setNtp((n) => ({ ...n, enabled: v, touched: true }))} label={t('adm.settings.time.ntp')} />
            </SettingRow>
            {ntp.enabled && (
              <div className="px-4 pb-4">
                <Field label={t('adm.settings.time.servers')}><TextInput mono value={ntp.servers} onChange={(e) => setNtp((n) => ({ ...n, servers: e.target.value, touched: true }))} /></Field>
              </div>
            )}
          </div>
          <Button variant="secondary" className="mt-3" icon={busy === 'ntp' ? Loader2 : Check} disabled={Boolean(busy)}
            onClick={() => run('ntp', () => adminFetch('/api/system/settings/ntp', { method: 'POST', body: { enabled: ntp.enabled, servers: ntp.servers.split(',').map((s) => s.trim()).filter(Boolean) } }), t('adm.common.saved')).then(() => setNtp((n) => ({ ...n, touched: false })))}>
            {t('adm.settings.time.saveNtp')}
          </Button>
          {!ntp.enabled && (
            <div className="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <Field label={t('adm.settings.time.date')}><TextInput type="date" value={manual.date} onChange={(e) => setManual((m) => ({ ...m, date: e.target.value }))} /></Field>
              <Field label={t('adm.settings.time.clock')}><TextInput type="time" value={manual.time} onChange={(e) => setManual((m) => ({ ...m, time: e.target.value }))} /></Field>
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => run('time', () => adminFetch('/api/system/settings/time', { method: 'POST', body: { datetime: `${manual.date} ${manual.time}:00` } }), t('adm.common.saved'))}>{t('adm.settings.time.set')}</Button>
            </div>
          )}
        </Section>

        <Section icon={UserCog} title={t('adm.settings.account.title')} description={t('adm.settings.account.desc', { user: profile?.username || adminUser || 'admin' })}
          actions={profile?.isDefaultPassword ? <StatusPill tone="danger">{t('adm.settings.account.defaultPw')}</StatusPill> : null}>
          <div className="grid gap-3">
            <Field label={t('adm.settings.account.username')}><TextInput value={acct.newUsername} autoComplete="username" onChange={(e) => setAcct((a) => ({ ...a, newUsername: e.target.value }))} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={t('adm.settings.account.newPassword')}><PasswordInput value={acct.newPassword} autoComplete="new-password" placeholder={t('adm.settings.account.minChars')} onChange={(e) => setAcct((a) => ({ ...a, newPassword: e.target.value }))} /></Field>
              <Field label={t('adm.settings.account.confirm')}><PasswordInput value={acct.confirmPassword} autoComplete="new-password" onChange={(e) => setAcct((a) => ({ ...a, confirmPassword: e.target.value }))} /></Field>
            </div>
            <Field label={t('adm.settings.account.current')} hint={t('adm.settings.account.currentHint')}><PasswordInput value={acct.currentPassword} autoComplete="current-password" onChange={(e) => setAcct((a) => ({ ...a, currentPassword: e.target.value }))} /></Field>
          </div>
          <Button variant="primary" className="mt-4" icon={busy === 'acct' ? Loader2 : KeyRound} disabled={Boolean(busy)} onClick={saveAccount}>{t('adm.settings.account.save')}</Button>
        </Section>
      </div>

      <div className="mt-6">
        <LockdownSection showToast={showToast} t={t} refresh={refresh} />
      </div>

      <div className="mt-6">
        <Disclosure title={t('adm.settings.danger')}>
          <SettingRow title={t('adm.settings.reboot')} description={t('adm.settings.rebootDesc')}>
            <Button size="sm" variant="danger" icon={Power} onClick={() => setConfirmReboot(true)}>{t('adm.settings.reboot')}</Button>
          </SettingRow>
        </Disclosure>
      </div>

      <Modal open={confirmReboot} onClose={() => setConfirmReboot(false)} title={t('adm.settings.rebootTitle')}
        footer={<><Button variant="ghost" onClick={() => setConfirmReboot(false)}>{t('common.cancel')}</Button><Button variant="danger" icon={busy === 'reboot' ? Loader2 : Power} disabled={Boolean(busy)} onClick={() => run('reboot', () => adminFetch('/api/network/system/reboot', { method: 'POST' }), t('adm.settings.rebooting')).then(() => setConfirmReboot(false))}>{t('adm.settings.reboot')}</Button></>}>
        <p className="text-sm text-slate-300">{t('adm.settings.rebootConfirm')}</p>
      </Modal>
    </div>
  );
}
