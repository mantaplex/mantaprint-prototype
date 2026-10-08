import React, { useCallback, useEffect, useState } from 'react';
import { Cable, Wifi, Radio, Loader2, Lock, RefreshCw, Activity, RotateCcw, Check, Link2, AlertTriangle, Users, StopCircle, PlayCircle, ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, StatusPill, Button, List, SettingRow, Switch, Segmented, Field, TextInput, Disclosure, Modal, SectionLabel, EmptyState } from '../../ui/index.js';
import { adminFetch } from '../../shell/api.js';

const IPV4 = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.){3}(25[0-5]|(2[0-4]|1\d|[1-9]|)\d)$/;

function KV({ k, v, mono = true }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs py-1">
      <span className="text-slate-500">{k}</span>
      <span className={`text-slate-200 truncate ${mono ? 'font-mono' : ''}`}>{v || '—'}</span>
    </div>
  );
}

export default function Network({ showToast }) {
  const { t } = useI18n();
  const [net, setNet] = useState(null);
  const [networks, setNetworks] = useState(null);
  const [busy, setBusy] = useState(null);
  const [join, setJoin] = useState(null);
  const [password, setPassword] = useState('');
  const [eth, setEth] = useState({ mode: 'dhcp', ip: '', prefix: '24', gateway: '', dns1: '1.1.1.1', dns2: '8.8.8.8' });
  const [ping, setPing] = useState({ target: '1.1.1.1', result: null });
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmEth, setConfirmEth] = useState(false);
  const [applied, setApplied] = useState(null);
  const [dc, setDc] = useState(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await adminFetch('/api/network/status');
      setNet(d);
      setEth((e) => {
        if (e.touched) return e;
        const saved = d.ethernet?.config;
        if (saved?.mode === 'static') {
          const dnsList = Array.isArray(saved.dns) ? saved.dns : [saved.dns1, saved.dns2].filter(Boolean);
          return { ...e, mode: 'static', ip: saved.ip || '', prefix: String(saved.prefix || 24), gateway: saved.gateway || '', dns1: dnsList[0] || '1.1.1.1', dns2: dnsList[1] || '' };
        }
        const liveIp = d.ethernet?.ip && d.ethernet.ip !== '10.11.12.1' ? d.ethernet.ip : '';
        return { ...e, mode: 'dhcp', ip: liveIp, prefix: String(liveIp ? d.ethernet?.prefix || 24 : 24), gateway: liveIp ? d.system?.default_gateway || '' : '' };
      });
    } catch (e) {
      console.warn(e);
    }
  }, []);

  const loadDc = useCallback(async () => {
    try {
      const d = await adminFetch('/api/network/direct-connect/status');
      if (d?.success) setDc({ ...d, fetchedAt: Date.now() });
    } catch {}
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 8000); return () => clearInterval(id); }, [load]);
  useEffect(() => { loadDc(); const id = setInterval(loadDc, 3000); return () => clearInterval(id); }, [loadDc]);
  useEffect(() => {
    if (dc?.state !== 'waiting') return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [dc?.state]);
  const dcLeft = dc ? Math.max(0, (dc.countdown || 0) - Math.floor((Date.now() - (dc.fetchedAt || Date.now())) / 1000)) : 0;
  const dcTotal = dc?.countdown_total || 60;

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); if (ok) showToast?.(ok, 'success'); await load(); return r; } catch (e) { showToast?.(e.message, 'error'); return null; } finally { setBusy(null); }
  };

  const scan = async () => {
    const r = await run('scan', () => adminFetch('/api/network/wifi/scan'));
    if (r) setNetworks(r.networks || []);
  };

  const connect = async () => {
    const ssid = (join?.ssid || '').trim();
    if (!ssid) return;
    const sec = String(join?.security || '').toUpperCase();
    const authMethod = !join?.requires_password ? 'open' : (sec.includes('WPA3') || sec.includes('SAE') ? 'wpa3' : 'wpa2');
    const ok = await run('join', () => adminFetch('/api/network/wifi/connect', {
      method: 'POST',
      body: { ssid, password, auth_method: authMethod }
    }), t('adm.network.joined', { ssid }));
    if (ok) { setJoin(null); setPassword(''); }
  };

  const ethBody = () => ({
    mode: eth.mode,
    ip: eth.ip.trim(),
    prefix: parseInt(eth.prefix, 10) || 24,
    gateway: eth.gateway.trim(),
    dns1: eth.dns1.trim(),
    dns2: eth.dns2.trim(),
    dns: [eth.dns1.trim(), eth.dns2.trim()].filter(Boolean)
  });

  const applyEth = () => {
    if (eth.mode === 'static') {
      const ip = eth.ip.trim().split('/')[0];
      if (!IPV4.test(ip)) { showToast?.(t('adm.network.invalidIp'), 'error'); return; }
      if (ip === '10.11.12.1') { showToast?.(t('adm.network.reservedIp'), 'error'); return; }
      const p = parseInt(eth.prefix, 10);
      if (!(p >= 8 && p <= 30)) { showToast?.(t('adm.network.invalidPrefix'), 'error'); return; }
      if (eth.gateway.trim() && !IPV4.test(eth.gateway.trim())) { showToast?.(t('adm.network.invalidGateway'), 'error'); return; }
    }
    setConfirmEth(true);
  };

  const applyEthConfirmed = async () => {
    const body = ethBody();
    setBusy('eth');
    try {
      const r = await adminFetch('/api/network/ethernet/config', { method: 'POST', body });
      setConfirmEth(false);
      setApplied({ mode: body.mode, url: r.reconnect_url || (body.mode === 'static' ? `http://${body.ip.split('/')[0]}/` : null) });
      setEth((x) => ({ ...x, touched: false }));
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const dcAction = async (action) => {
    await run('dc', () => adminFetch(`/api/network/direct-connect/${action}`, { method: 'POST' }), action === 'stop' ? t('adm.network.dcStopped') : t('adm.network.dcStarted'));
    await loadDc();
  };

  const doPing = async () => {
    const r = await run('ping', () => adminFetch(`/api/network/diagnostics/ping?target=${encodeURIComponent(ping.target)}`));
    setPing((p) => ({ ...p, result: r }));
  };

  const e = net?.ethernet || {};
  const w = net?.wifi || {};
  const ap = net?.softap || {};

  return (
    <div>
      <PageHeader title={t('adm.network.title')} description={t('adm.network.desc')} actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={load}>{t('adm.common.refresh')}</Button>} />

      {dc && (dc.state !== 'off' || dc.suppressed) && (
        <Card className={`mb-4 ${dc.state === 'active' ? 'border-manta-500/40 bg-manta-900/20' : 'border-amber-500/30 bg-amber-950/20'}`}>
          {dc.state === 'waiting' && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                <span className="text-sm font-semibold text-amber-300 min-w-0">{t('adm.network.dcWaiting')}</span>
                <span className="ml-auto font-mono text-2xl font-bold text-amber-300 tabular-nums">{dcLeft}s</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden mb-3">
                <div className="bg-amber-400 h-2 rounded-full transition-all duration-1000 ease-linear" style={{ width: `${Math.min(100, ((dcTotal - dcLeft) / dcTotal) * 100)}%` }} />
              </div>
              <p className="text-xs text-slate-400">{t('adm.network.dcWaitingDesc', { ip: dc.local_ip })}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={busy === 'dc' ? Loader2 : PlayCircle} disabled={Boolean(busy)} onClick={() => dcAction('start')}>{t('adm.network.dcStartNow')}</Button>
                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => dcAction('stop')}>{t('adm.network.dcCancel')}</Button>
              </div>
            </div>
          )}
          {dc.state === 'active' && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <Link2 className="w-5 h-5 text-manta-400 shrink-0" />
                <span className="text-sm font-semibold text-manta-300">{t('adm.network.dcActive')}</span>
                <StatusPill tone="ok" pulse>{t('adm.network.on')}</StatusPill>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 text-xs mb-3">
                <KV k={t('adm.network.ip')} v={`${dc.local_ip}/${dc.prefix || 24}`} />
                <KV k={t('adm.network.dcRange')} v={`${dc.range_start} – ${dc.range_end}`} />
              </div>
              <div className="mb-3">
                <div className="flex items-center gap-1 text-xs text-slate-400 mb-1"><Users className="w-3 h-3" />{t('adm.network.dcClients')}</div>
                {dc.clients.length > 0
                  ? dc.clients.map((c) => <div key={c.ip} className="font-mono text-xs text-slate-200">{c.ip} {c.hostname ? `(${c.hostname})` : ''}</div>)
                  : <div className="text-xs text-slate-500">{t('adm.network.dcWaitingClients')}</div>}
              </div>
              {dc.error && <p className="text-xs text-amber-300 mb-3">{dc.error}</p>}
              <p className="text-xs text-slate-400 mb-3">{t('adm.network.dcActiveDesc')}</p>
              <Button size="sm" variant="secondary" icon={busy === 'dc' ? Loader2 : StopCircle} disabled={Boolean(busy)} onClick={() => dcAction('stop')}>{t('adm.network.dcStop')}</Button>
            </div>
          )}
          {dc.state === 'off' && dc.suppressed && (
            <div className="flex flex-wrap items-center gap-3">
              <Link2 className="w-5 h-5 text-slate-400 shrink-0" />
              <span className="text-xs text-slate-300 flex-1 min-w-0">{t('adm.network.dcSuppressed')}</span>
              <Button size="sm" variant="secondary" icon={busy === 'dc' ? Loader2 : PlayCircle} disabled={Boolean(busy)} onClick={() => dcAction('start')}>{t('adm.network.dcStart')}</Button>
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3 [&>*]:min-w-0">
        <Card>
          <CardHeader icon={Cable} title={t('adm.network.ethernet')} description={e.interface || 'eth0'} actions={<StatusPill tone={e.carrier ? 'ok' : 'idle'}>{e.carrier ? t('adm.network.connected') : t('adm.network.unplugged')}</StatusPill>} />
          <div className="mt-3"><KV k={t('adm.network.ip')} v={e.ip ? `${e.ip}/${e.prefix || ''}` : ''} /><KV k="MAC" v={e.mac} /><KV k={t('adm.network.speed')} v={e.carrier ? e.speed : ''} mono={false} /></div>
        </Card>
        <Card>
          <CardHeader icon={Wifi} title={t('adm.network.wifi')} description={w.interface || 'wlan0'} actions={<StatusPill tone={w.ssid ? 'ok' : w.radio_enabled ? 'idle' : 'warn'}>{w.ssid ? t('adm.network.connected') : w.radio_enabled ? t('adm.network.notConnected') : t('adm.network.radioOff')}</StatusPill>} />
          <div className="mt-3"><KV k="SSID" v={w.ssid} mono={false} /><KV k={t('adm.network.ip')} v={w.ip ? `${w.ip}/${w.prefix || ''}` : ''} /><KV k={t('adm.network.band')} v={w.ssid ? w.band : ''} mono={false} /></div>
        </Card>
        <Card>
          <CardHeader icon={Radio} title={t('adm.network.hotspot')} description={t('adm.network.hotspotDesc')} actions={<StatusPill tone={ap.active ? 'info' : 'idle'} pulse={ap.active}>{ap.active ? t('adm.network.on') : t('adm.network.off')}</StatusPill>} />
          <div className="mt-3"><KV k="SSID" v={ap.ssid || 'MantaPrint-Setup'} mono={false} /><KV k={t('adm.network.ip')} v={ap.ip || '192.168.4.1'} /></div>
          <Button size="sm" variant={ap.active ? 'danger' : 'secondary'} className="w-full mt-3" icon={busy === 'ap' ? Loader2 : Radio} disabled={Boolean(busy)}
            onClick={() => run('ap', () => adminFetch('/api/network/softap/toggle', { method: 'POST', body: { enabled: !ap.active } }), ap.active ? t('adm.network.hotspotStopped') : t('adm.network.hotspotStarted'))}>
            {ap.active ? t('adm.network.stopHotspot') : t('adm.network.startHotspot')}
          </Button>
        </Card>
      </div>

      <div className="mt-6 grid gap-5 grid-cols-1 lg:grid-cols-2 [&>*]:min-w-0">
        <div>
          <SectionLabel right={
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 text-[11px] text-slate-400">{t('adm.network.radio')}<Switch checked={Boolean(w.radio_enabled)} label={t('adm.network.radio')} onChange={(v) => run('radio', () => adminFetch('/api/network/wifi/radio', { method: 'POST', body: { enabled: v } }), t('adm.common.saved'))} /></span>
              <Button size="sm" variant="secondary" icon={busy === 'scan' ? Loader2 : Wifi} disabled={busy === 'scan' || !w.radio_enabled} onClick={scan}>{t('adm.network.scan')}</Button>
            </div>
          }>
            {t('adm.network.wifiNetworks')}
          </SectionLabel>
          {networks === null ? (
            <EmptyState icon={Wifi} title={t('adm.network.scanHint')} description={t('adm.network.scanHintDesc')} />
          ) : networks.length === 0 ? (
            <EmptyState icon={Wifi} title={t('adm.network.noNetworks')} />
          ) : (
            <List>
              {networks.map((n) => (
                <button key={n.bssid || n.ssid} type="button" onClick={() => { setJoin({ ...n, is_hidden: Boolean(n.is_hidden || !n.ssid), ssid: n.ssid || '' }); setPassword(''); }} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04]">
                  <Wifi className={`w-4 h-4 ${n.signal_percent > 60 ? 'text-manta-300' : n.signal_percent > 30 ? 'text-amber-300' : 'text-slate-500'}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-slate-100 truncate">{n.ssid || t('adm.network.hiddenSsid')}</span>
                    <span className="block text-[11px] text-slate-500">{n.band || ''}{n.signal_percent !== undefined ? ` · ${n.signal_percent}%` : ''}</span>
                  </span>
                  {n.active ? <StatusPill tone="ok">{t('adm.network.connected')}</StatusPill> : n.requires_password ? <Lock className="w-4 h-4 text-slate-500" /> : null}
                </button>
              ))}
            </List>
          )}
        </div>

        <div>
          <SectionLabel>{t('adm.network.ethConfig')}</SectionLabel>
          <Card>
            <Segmented size="sm" value={eth.mode} onChange={(v) => setEth((x) => ({ ...x, mode: v, touched: true }))} options={[{ value: 'dhcp', label: t('adm.network.dhcp') }, { value: 'static', label: t('adm.network.static') }]} />
            {eth.mode === 'dhcp' ? (
              <p className="mt-3 text-xs text-slate-400">{t('adm.network.dhcpDesc')}</p>
            ) : (
              <div className="mt-4 grid grid-cols-[1fr_90px] gap-3">
                <Field label={t('adm.network.ip')}><TextInput mono value={eth.ip} placeholder="192.0.2.10" onChange={(ev) => setEth((x) => ({ ...x, ip: ev.target.value, touched: true }))} /></Field>
                <Field label={t('adm.network.prefix')}><TextInput mono value={eth.prefix} onChange={(ev) => setEth((x) => ({ ...x, prefix: ev.target.value.replace(/\D/g, ''), touched: true }))} /></Field>
                <div className="col-span-2"><Field label={t('adm.network.gateway')}><TextInput mono value={eth.gateway} placeholder="192.168.1.1" onChange={(ev) => setEth((x) => ({ ...x, gateway: ev.target.value, touched: true }))} /></Field></div>
                <Field label="DNS 1"><TextInput mono value={eth.dns1} onChange={(ev) => setEth((x) => ({ ...x, dns1: ev.target.value, touched: true }))} /></Field>
                <Field label="DNS 2"><TextInput mono value={eth.dns2} onChange={(ev) => setEth((x) => ({ ...x, dns2: ev.target.value, touched: true }))} /></Field>
              </div>
            )}
            <Button variant="primary" className="w-full mt-4" icon={busy === 'eth' ? Loader2 : Check} disabled={Boolean(busy)} onClick={applyEth}>{t('adm.network.apply')}</Button>
            <p className="mt-2 text-[11px] text-slate-500">{t('adm.network.applyNote')}</p>
            {e.config?.mode && <p className="mt-1 text-[11px] text-slate-500">{t('adm.network.currentMode')}: <span className="text-slate-300">{e.config.mode === 'static' ? `${t('adm.network.static')} ${e.config.ip}/${e.config.prefix}` : t('adm.network.dhcp')}</span></p>}
            {e.last_apply && !e.last_apply.success && <p className="mt-2 text-[11px] text-rose-300">{t('adm.network.lastApplyFailed', { msg: e.last_apply.message })}</p>}
          </Card>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <Disclosure title={t('adm.network.diagnostics')}>
          <div className="flex gap-2">
            <TextInput mono value={ping.target} onChange={(ev) => setPing({ target: ev.target.value, result: null })} />
            <Button variant="secondary" icon={busy === 'ping' ? Loader2 : Activity} disabled={busy === 'ping'} onClick={doPing}>{t('adm.network.ping')}</Button>
          </div>
          {ping.result && (
            <pre className="mt-3 p-3 rounded-xl bg-black/40 border border-white/[0.06] text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap">{ping.result.raw_output || ping.result.output || ping.result.stdout || JSON.stringify(ping.result, null, 2)}</pre>
          )}
          <div className="mt-3 text-xs text-slate-500">{t('adm.network.dnsServers')}: <span className="font-mono text-slate-300">{(net?.system?.dns_servers || []).join(', ') || '—'}</span></div>
        </Disclosure>
        <Disclosure title={t('adm.network.dangerZone')}>
          <p className="text-xs text-slate-400">{t('adm.network.resetDesc')}</p>
          <Button size="sm" variant="danger" className="mt-3" icon={RotateCcw} onClick={() => setConfirmReset(true)}>{t('adm.network.reset')}</Button>
        </Disclosure>
      </div>

      <Modal open={Boolean(join)} onClose={() => setJoin(null)} title={t('adm.network.joinTitle', { ssid: join?.ssid || t('adm.network.hiddenSsid') })}
        footer={<><Button variant="ghost" onClick={() => setJoin(null)}>{t('common.cancel')}</Button><Button variant="primary" icon={busy === 'join' ? Loader2 : Wifi} disabled={busy === 'join' || !join?.ssid?.trim() || (join?.requires_password && password.length < 8)} onClick={connect}>{t('adm.network.join')}</Button></>}>
        <div className="space-y-3">
          {join?.is_hidden && (
            <Field label="SSID">
              <TextInput autoFocus value={join.ssid || ''} onChange={(ev) => setJoin((j) => ({ ...j, ssid: ev.target.value }))} />
            </Field>
          )}
          {join?.requires_password ? (
            <Field label={t('adm.network.password')} hint={t('adm.network.passwordHint')}><TextInput type="password" autoFocus={!join?.is_hidden} value={password} onChange={(ev) => setPassword(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter' && join?.ssid?.trim() && password.length >= 8) connect(); }} /></Field>
          ) : (
            <p className="text-sm text-slate-300">{t('adm.network.openNetwork')}</p>
          )}
        </div>
        <p className="mt-3 text-[11px] text-amber-300">{t('adm.network.joinWarning')}</p>
      </Modal>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title={t('adm.network.resetTitle')}
        footer={<><Button variant="ghost" onClick={() => setConfirmReset(false)}>{t('common.cancel')}</Button><Button variant="danger" icon={busy === 'reset' ? Loader2 : RotateCcw} disabled={Boolean(busy)} onClick={() => run('reset', () => adminFetch('/api/network/reset', { method: 'POST' }), t('adm.network.resetDone')).then(() => setConfirmReset(false))}>{t('adm.network.reset')}</Button></>}>
        <p className="text-sm text-slate-300">{t('adm.network.resetConfirm')}</p>
      </Modal>

      <Modal open={confirmEth} onClose={() => setConfirmEth(false)} title={eth.mode === 'static' ? t('adm.network.staticWarnTitle') : t('adm.network.dhcpWarnTitle')}
        footer={<><Button variant="ghost" onClick={() => setConfirmEth(false)}>{t('common.cancel')}</Button><Button variant="primary" icon={busy === 'eth' ? Loader2 : Check} disabled={Boolean(busy)} onClick={applyEthConfirmed}>{eth.mode === 'static' ? t('adm.network.staticWarnApply') : t('adm.network.dhcpWarnApply')}</Button></>}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            {eth.mode === 'static' ? (
              <>
                <p className="text-sm text-slate-200 mb-2">{t('adm.network.staticWarnBody')}</p>
                <p className="text-sm font-mono text-manta-300 font-bold break-all">http://{eth.ip.trim().split('/')[0]}/</p>
                <p className="mt-1 text-xs font-mono text-slate-400">/{eth.prefix}{eth.gateway ? ` · gw ${eth.gateway}` : ''} · DNS {eth.dns1}{eth.dns2 ? `, ${eth.dns2}` : ''}</p>
                <p className="mt-2 text-xs text-slate-400">{t('adm.network.staticWarnHint')}</p>
              </>
            ) : (
              <p className="text-sm text-slate-200">{t('adm.network.dhcpWarnBody')}</p>
            )}
            {dc && dc.state !== 'off' && <p className="mt-2 text-xs text-amber-300">{t('adm.network.staticWarnDc')}</p>}
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(applied)} onClose={() => setApplied(null)} title={t('adm.network.appliedTitle')}
        footer={<Button variant="ghost" onClick={() => setApplied(null)}>{t('common.close')}</Button>}>
        {applied?.url ? (
          <>
            <p className="text-sm text-slate-300 mb-3">{t('adm.network.appliedStatic')}</p>
            <a href={applied.url} className="inline-flex items-center gap-2 font-mono text-manta-300 font-bold break-all hover:underline">{applied.url}<ExternalLink className="w-4 h-4 shrink-0" /></a>
          </>
        ) : (
          <p className="text-sm text-slate-300">{t('adm.network.appliedDhcp')}</p>
        )}
      </Modal>
    </div>
  );
}
