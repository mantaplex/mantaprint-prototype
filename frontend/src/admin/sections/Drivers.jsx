/**
 * Admin > Drivers & devices (Driver Center).
 *
 * Top to bottom: every device the hub sees and what it still needs; a "check a model" box
 * answered from the hub's own data; one upload area for vendor files (with a confirmation
 * popup before anything that runs vendor code as root); what's been installed so far;
 * packages from the Debian repositories (allowlist, needs internet); and the catalog.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Printer, ScanLine, Usb, Search, Upload, Loader2, Package, Trash2, Check, AlertTriangle, ShieldAlert,
  ExternalLink, DownloadCloud, HelpCircle, Puzzle, FileText, Cpu, RefreshCw, Boxes, Globe, X
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, StatusPill, Button, List, SettingRow, EmptyState, Modal, SectionLabel, TextInput, formatBytes } from '../../ui/index.js';
import { adminFetch, getAdminToken } from '../../shell/api.js';
import { readinessReasonText } from './Printers.jsx';

const KIND_ICON = { nal: Cpu, 'hplip-plugin': Puzzle, ppd: FileText, deb: Package, dl: DownloadCloud, archive: Boxes, asc: FileText };

function uploadRaw(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Admin-Token', getAdminToken());
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText); } catch {} resolve(body || { success: false, code: 'generic' }); };
    xhr.onerror = () => reject(new Error('upload_failed'));
    xhr.send(file);
  });
}

const STATUS_TONE = { verified: 'ok', available: 'info', needs_file: 'warn', unsupported: 'danger' };
const VERDICT_TONE = { supported: 'ok', likely: 'info', needs_file: 'warn', unsupported: 'danger', unknown: 'idle' };

function needTone(readiness) {
  if (readiness === 'ready') return 'ok';
  if (readiness === 'unsupported') return 'danger';
  if (readiness === 'needs_file' || readiness === 'needs_firmware' || readiness === 'needs_review') return 'warn';
  if (readiness === 'provisioning') return 'info';
  return 'idle';
}

/** One connected device with what it needs and the matching action. */
function DeviceCard({ d, onUpload, hplip, t }) {
  const Icon = d.type === 'printer' ? Printer : d.type === 'scanner' ? ScanLine : Usb;
  const tone = needTone(d.readiness);
  const label = d.readiness ? t(`adm.drivers.readiness.${d.readiness}`) : t('adm.drivers.readiness.unknown');
  return (
    <Card className={tone === 'danger' ? '!border-rose-500/30 !bg-rose-500/[0.05]' : tone === 'warn' ? '!border-amber-500/30 !bg-amber-500/[0.05]' : ''}>
      <CardHeader icon={Icon} title={d.name || d.model} description={[d.vendor, d.model, d.usb_id, d.queue].filter(Boolean).join(' · ')}
        actions={<StatusPill tone={tone}>{label}</StatusPill>} />
      {d.readiness_reason && <p className="mt-2 text-xs text-slate-400">{readinessReasonText(d, t)}</p>}
      {d.recipe && (
        <p className="mt-2 text-[11px] text-slate-500">
          {t('adm.drivers.matchedFamily')}: <span className="text-slate-300">{d.recipe.family}</span>
          {d.recipe.status && <> · <span className="uppercase tracking-wide">{t(`adm.drivers.status.${d.recipe.status}`)}</span></>}
        </p>
      )}
      {d.needs.length > 0 && (
        <div className="mt-3 space-y-2">
          {d.needs.map((n, i) => (
            <div key={i} className="rounded-xl bg-white/[0.04] border border-white/10 p-3 text-xs">
              <div className="font-semibold text-slate-100">{t(`adm.drivers.need.${n.kind}`, { file: n.required_file || n.filename || n.package || '' })}</div>
              {n.note && <p className="mt-1 text-slate-400">{/^[a-z_]+$/.test(n.note) ? t(`adm.printers.readiness.reasons.${n.note}`, { detail: d.readiness_detail || '' }) : n.note}</p>}
              {n.kind === 'hplip-plugin' && !n.hplip_installed && <p className="mt-1 text-amber-300">{t('adm.drivers.need.hplipMissing')}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {n.download && <a className="inline-flex items-center gap-1 text-manta-300 underline" href={n.download} target="_blank" rel="noreferrer">{t('adm.drivers.downloadFromVendor')} <ExternalLink className="w-3 h-3" /></a>}
                {n.kind !== 'review' && <Button size="sm" variant="primary" icon={Upload} onClick={() => onUpload(d)}>{t('adm.drivers.uploadFor', { name: d.name || d.model })}</Button>}
                {n.kind === 'review' && <Button size="sm" variant="secondary" icon={Upload} onClick={() => onUpload(d)}>{t('adm.drivers.uploadPpd')}</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Lookup({ t }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const search = async (e) => {
    e?.preventDefault();
    if (q.trim().length < 3) return;
    setBusy(true);
    try { setRes(await adminFetch(`/api/drivers/lookup?q=${encodeURIComponent(q.trim())}`)); } catch { setRes(null); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader icon={Search} title={t('adm.drivers.lookup.title')} description={t('adm.drivers.lookup.desc')} />
      <form onSubmit={search} className="mt-3 flex items-center gap-2">
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.drivers.lookup.placeholder')} className="flex-1" />
        <Button type="submit" variant="primary" icon={busy ? Loader2 : Search} disabled={busy || q.trim().length < 3}>{t('adm.drivers.lookup.go')}</Button>
      </form>
      {res && (
        <div className="mt-4 space-y-3 text-xs">
          <div className="flex items-center gap-2">
            <StatusPill tone={VERDICT_TONE[res.verdict] || 'idle'}>{t(`adm.drivers.lookup.verdict.${res.verdict}`)}</StatusPill>
            <span className="text-slate-400">{t(`adm.drivers.lookup.verdictDesc.${res.verdict}`)}</span>
          </div>
          {res.recipes?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-200 mb-1">{t('adm.drivers.lookup.families')}</div>
              {res.recipes.map((r) => (
                <div key={r.id} className="flex items-start gap-2 py-1">
                  <StatusPill tone={STATUS_TONE[r.status]}>{t(`adm.drivers.status.${r.status}`)}</StatusPill>
                  <div className="min-w-0"><div className="text-slate-100">{r.vendor} · {r.family}</div>
                    {(r.requires || []).map((x, i) => <div key={i} className="text-slate-400">{t(`adm.drivers.need.${x.kind}`, { file: x.package || '' })}{x.download && <> · <a className="text-manta-300 underline" href={x.download} target="_blank" rel="noreferrer">{t('adm.drivers.downloadFromVendor')}</a></>}</div>)}
                    {r.note && <div className="text-slate-500">{r.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {res.ppd?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-200 mb-1">{t('adm.drivers.lookup.ppd')}</div>
              {res.ppd.map((h, i) => <div key={i} className="text-slate-300 truncate">{h.confidence === 'exact' ? <Check className="inline w-3 h-3 text-manta-300 mr-1" /> : <HelpCircle className="inline w-3 h-3 text-amber-300 mr-1" />}{h.make_model} <span className="text-slate-500">({h.driver})</span></div>)}
            </div>
          )}
          {res.sane?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-200 mb-1">{t('adm.drivers.lookup.sane')}</div>
              {res.sane.map((h, i) => <div key={i} className="text-slate-300">{h.name} <span className="text-slate-500 font-mono">{h.usb_id}</span></div>)}
            </div>
          )}
          {res.hp?.plugin?.needed && <p className="text-amber-300">{t('adm.drivers.lookup.hpPlugin')}</p>}
        </div>
      )}
    </Card>
  );
}

/** Drop zone / picker; results either install straight away or become a pending item. */
function UploadArea({ overview, onDone, showToast, target, onClearTarget, t }) {
  const input = useRef(null);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);

  const send = async (file) => {
    setError('');
    if (!file) return;
    if (overview?.max_upload_bytes && file.size > overview.max_upload_bytes) { setError(t('adm.drivers.errors.too_large')); return; }
    if (/\.nal$/i.test(file.name)) { setError(t('adm.drivers.errors.use_scanner_firmware')); return; }
    setPhase(0);
    try {
      const url = `/api/drivers/upload${target?.queue ? `?queue=${encodeURIComponent(target.queue)}` : ''}`;
      const body = await uploadRaw(url, file, (p) => setPhase(p >= 100 ? 'processing' : p));
      if (!body.success) { setError(t(`adm.drivers.errors.${body.code}`, { file: body.required_file || '', v: body.uploaded_version || '' }) ); if (body.tail) setError((e) => `${e}\n${body.tail}`); }
      else if (body.pending) showToast?.(t('adm.drivers.pendingCreated', { name: file.name }), 'success');
      else showToast?.(t('adm.drivers.installedToast', { name: file.name }), 'success');
    } catch { setError(t('adm.drivers.errors.upload_failed')); }
    finally { setPhase(null); onClearTarget?.(); onDone?.(); }
  };

  return (
    <Card>
      <CardHeader icon={Upload} title={t('adm.drivers.upload.title')} description={t('adm.drivers.upload.desc')} />
      {target && (
        <div className="mt-3 flex items-center gap-2 text-xs text-manta-300">
          <span>{t('adm.drivers.upload.target', { name: target.name || target.model })}</span>
          <button type="button" onClick={onClearTarget} className="h-6 w-6 rounded-md hover:bg-white/10 flex items-center justify-center" aria-label={t('common.cancel')}><X className="w-3 h-3" /></button>
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files?.[0]); }}
        className={`mt-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${drag ? 'border-manta-400 bg-manta-500/10' : 'border-white/10 bg-white/[0.02]'}`}
      >
        <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; send(f); }} />
        <p className="text-sm text-slate-200">{t('adm.drivers.upload.drop')}</p>
        <p className="mt-1 text-[11px] text-slate-500">{t('adm.drivers.upload.kinds')}</p>
        <Button className="mt-3" variant="primary" icon={phase !== null ? Loader2 : Upload} disabled={phase !== null || overview?.job?.state === 'running'} onClick={() => input.current?.click()}>
          {phase === null ? t('adm.drivers.upload.pick') : phase === 'processing' ? t('adm.drivers.upload.processing') : t('adm.scanner.fw.uploading', { p: phase })}
        </Button>
      </div>
      <p className="mt-3 text-[11px] text-amber-200/80 flex items-start gap-1.5"><ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />{t('adm.drivers.upload.rootWarning')}</p>
      {error && <pre role="alert" className="mt-2 text-xs text-rose-300 whitespace-pre-wrap">{error}</pre>}
    </Card>
  );
}

/** Pending items: a .deb waiting for confirmation, or an unpacked installer to pick from. */
function PendingList({ pending, onChanged, showToast, t }) {
  const [confirm, setConfirm] = useState(null); // { id, file }
  const [busy, setBusy] = useState(false);
  const install = async (id, file, opts = {}) => {
    setBusy(true);
    try {
      const r = await adminFetch('/api/drivers/pending/install', { method: 'POST', body: { id, sha256: file?.sha256, confirm: true, ...opts } });
      if (r.success) showToast?.(t('adm.drivers.jobStarted', { name: file?.name || '' }), 'success');
    } catch (e) { showToast?.(t(`adm.drivers.errors.${e.message}`) || e.message, 'error'); }
    finally { setBusy(false); setConfirm(null); onChanged?.(); }
  };
  const drop = async (id) => { await adminFetch('/api/drivers/pending/drop', { method: 'POST', body: { id } }).catch(() => {}); onChanged?.(); };
  if (!pending?.length) return null;
  return (
    <div className="mt-6">
      <SectionLabel>{t('adm.drivers.pending.title')}</SectionLabel>
      <List>
        {pending.map((p) => (
          <div key={p.id} className="px-4 py-3.5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 flex items-center justify-center">{React.createElement(KIND_ICON[p.kind] || FileText, { className: 'w-4 h-4' })}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-100 truncate">{p.name}</div>
                <div className="text-xs text-slate-500">{p.kind === 'deb' ? `${p.info?.package} ${p.info?.version} · ${p.info?.architecture}` : t('adm.drivers.pending.archiveDesc', { n: p.files?.length || 0 })}{p.size ? ` · ${formatBytes(p.size)}` : ''}</div>
              </div>
              {p.kind === 'deb' && <Button size="sm" variant="primary" icon={Package} disabled={busy} onClick={() => setConfirm({ id: p.id, file: { kind: 'deb', name: p.name, sha256: p.sha256, info: p.info } })}>{t('adm.drivers.pending.review')}</Button>}
              <button type="button" title={t('adm.drivers.pending.discard')} aria-label={t('adm.drivers.pending.discard')} onClick={() => drop(p.id)} className="h-9 w-9 rounded-lg hover:bg-rose-500/15 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
            </div>
            {p.kind === 'archive' && (
              <div className="mt-3 space-y-1.5">
                {p.files.map((f) => (
                  <div key={f.sha256} className="flex items-center gap-2 text-xs rounded-lg bg-white/[0.03] px-3 py-2">
                    {React.createElement(KIND_ICON[f.kind] || FileText, { className: 'w-3.5 h-3.5 text-slate-400 shrink-0' })}
                    <span className="flex-1 truncate text-slate-200">{f.name} <span className="text-slate-500">· {t(`adm.drivers.kind.${f.kind}`)} · {formatBytes(f.size)}</span></span>
                    {f.kind === 'deb'
                      ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm({ id: p.id, file: f })}>{t('adm.drivers.pending.review')}</Button>
                      : <Button size="sm" variant="secondary" disabled={busy} onClick={() => install(p.id, f)}>{t('adm.drivers.pending.install')}</Button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </List>

      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title={t('adm.drivers.confirm.title')} footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={busy ? Loader2 : Package} disabled={busy} onClick={() => install(confirm.id, confirm.file, { force: !confirm.file.info?.arch_ok })}>{t('adm.drivers.confirm.go')}</Button>
          </>
        }>
          <div className="space-y-3 text-xs">
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-rose-200 flex items-start gap-2"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" /><span>{t('adm.drivers.confirm.warning')}</span></div>
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-slate-300">
              <dt className="text-slate-500">{t('adm.drivers.confirm.package')}</dt><dd className="font-mono">{confirm.file.info?.package} {confirm.file.info?.version}</dd>
              <dt className="text-slate-500">{t('adm.drivers.confirm.arch')}</dt><dd className={confirm.file.info?.arch_ok ? '' : 'text-rose-300'}>{confirm.file.info?.architecture} {confirm.file.info?.arch_ok ? '' : t('adm.drivers.confirm.archMismatch', { host: confirm.file.info?.host_architecture })}</dd>
              <dt className="text-slate-500">{t('adm.drivers.confirm.maintainer')}</dt><dd className="break-all">{confirm.file.info?.maintainer || '—'}</dd>
              <dt className="text-slate-500">{t('adm.drivers.confirm.description')}</dt><dd>{confirm.file.info?.description || '—'}</dd>
              <dt className="text-slate-500">{t('adm.drivers.confirm.depends')}</dt><dd className="break-all">{confirm.file.info?.depends || '—'}</dd>
              <dt className="text-slate-500">{t('adm.drivers.confirm.scripts')}</dt><dd>{confirm.file.info?.has_maintainer_scripts ? t('adm.drivers.confirm.scriptsYes') : t('adm.drivers.confirm.scriptsNo')}</dd>
              <dt className="text-slate-500">SHA-256</dt><dd className="font-mono break-all text-[10px]">{confirm.file.sha256}</dd>
            </dl>
            <p className="text-slate-400">{t('adm.drivers.confirm.license')}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function JobCard({ job, t }) {
  if (!job) return null;
  const running = job.state === 'running';
  return (
    <Card className={`mt-4 ${job.state === 'failed' ? '!border-rose-500/30' : running ? '!border-manta-500/30' : '!border-white/10'}`}>
      <CardHeader icon={running ? Loader2 : job.state === 'failed' ? AlertTriangle : Check} title={t(`adm.drivers.job.${job.kind}`, { name: job.label })}
        description={running ? t('adm.drivers.job.running') : job.state === 'failed' ? t(`adm.drivers.errors.${job.result?.code || 'install_failed'}`) : t('adm.drivers.job.done')}
        actions={<StatusPill tone={running ? 'info' : job.state === 'failed' ? 'danger' : 'ok'} pulse={running}>{t(`adm.drivers.job.state.${job.state}`)}</StatusPill>} />
      {job.log?.length > 0 && <pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-black/40 p-3 text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap">{job.log.slice(-60).join('\n')}</pre>}
    </Card>
  );
}

export default function Drivers({ showToast }) {
  const { t } = useI18n();
  const [ov, setOv] = useState(null);
  const [target, setTarget] = useState(null);
  const [aptBusy, setAptBusy] = useState(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const uploadRef = useRef(null);

  const load = useCallback(async () => {
    try { setOv(await adminFetch('/api/drivers/overview')); } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Poll faster while a job runs.
  useEffect(() => {
    const ms = ov?.job?.state === 'running' ? 2000 : 10000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, ov?.job?.state]);

  const aptInstall = async (pkg) => {
    setAptBusy(pkg);
    try { const r = await adminFetch('/api/drivers/apt/install', { method: 'POST', body: { package: pkg } }); if (r.success) showToast?.(t('adm.drivers.jobStarted', { name: pkg }), 'success'); }
    catch (e) { showToast?.(e.message, 'error'); }
    finally { setAptBusy(null); load(); }
  };
  const removeInstalled = async (item) => {
    if (!window.confirm(t('adm.drivers.installed.removeConfirm', { name: item.name }))) return;
    try { await adminFetch('/api/drivers/installed/remove', { method: 'POST', body: { id: item.id } }); } catch (e) { showToast?.(e.message, 'error'); }
    load();
  };
  const pickForDevice = (d) => { setTarget(d); uploadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const devices = ov?.devices || [];
  const attention = devices.filter((d) => d.needs.length > 0 || d.readiness === 'unsupported');
  const fine = devices.filter((d) => !attention.includes(d));

  return (
    <div>
      <PageHeader title={t('adm.drivers.title')} description={t('adm.drivers.desc')} />

      <JobCard job={ov?.job} t={t} />

      <div className="mt-6">
        <SectionLabel>{t('adm.drivers.devices.title')} ({devices.length})</SectionLabel>
        {!ov ? <EmptyState icon={Loader2} title={t('adm.common.loading')} /> : devices.length === 0 ? (
          <EmptyState icon={Usb} title={t('adm.drivers.devices.none')} description={t('adm.drivers.devices.noneDesc')} />
        ) : (
          <div className="space-y-3">
            {attention.map((d) => <DeviceCard key={d.id} d={d} onUpload={pickForDevice} hplip={ov.hplip} t={t} />)}
            {fine.map((d) => <DeviceCard key={d.id} d={d} onUpload={pickForDevice} hplip={ov.hplip} t={t} />)}
          </div>
        )}
      </div>

      <div className="mt-6"><Lookup t={t} /></div>

      <div className="mt-6" ref={uploadRef}>
        <UploadArea overview={ov} onDone={load} showToast={showToast} target={target} onClearTarget={() => setTarget(null)} t={t} />
      </div>

      <PendingList pending={ov?.pending} onChanged={load} showToast={showToast} t={t} />

      <div className="mt-6">
        <SectionLabel>{t('adm.drivers.installed.title')} ({ov?.installed?.length || 0})</SectionLabel>
        {!ov?.installed?.length ? (
          <EmptyState icon={Package} title={t('adm.drivers.installed.none')} description={t('adm.drivers.installed.noneDesc')} />
        ) : (
          <List>
            {ov.installed.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-4 py-3">
                <span className="h-9 w-9 rounded-xl bg-manta-500/10 border border-manta-500/25 text-manta-300 flex items-center justify-center">{React.createElement(KIND_ICON[i.kind] || FileText, { className: 'w-4 h-4' })}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-100 truncate">{i.package || i.name}{i.version ? ` ${i.version}` : ''}</div>
                  <div className="text-xs text-slate-500 truncate">{t(`adm.drivers.kind.${i.kind}`)}{i.note ? ` · ${i.note}` : ''}{i.target ? ` · ${i.target}` : ''} · {new Date(i.installed_at).toLocaleDateString()}</div>
                </div>
                <button type="button" title={t('adm.drivers.installed.remove')} aria-label={t('adm.drivers.installed.remove')} onClick={() => removeInstalled(i)} className="h-9 w-9 rounded-lg hover:bg-rose-500/15 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </List>
        )}
      </div>

      <div className="mt-6">
        <SectionLabel>{t('adm.drivers.apt.title')}</SectionLabel>
        <p className="text-xs text-slate-500 mb-2 flex items-center gap-1.5"><Globe className="w-3.5 h-3.5" />{t('adm.drivers.apt.desc')}</p>
        <List>
          {(ov?.apt?.packages || []).map((p) => (
            <SettingRow key={p.name} title={<span className="font-mono">{p.name}</span>} description={p.for}>
              {p.installed ? <StatusPill tone="ok">{t('adm.drivers.apt.installed')}</StatusPill>
                : <Button size="sm" variant="secondary" icon={aptBusy === p.name ? Loader2 : DownloadCloud} disabled={Boolean(aptBusy) || ov?.job?.state === 'running'} onClick={() => aptInstall(p.name)}>{t('adm.drivers.apt.install')}</Button>}
            </SettingRow>
          ))}
        </List>
      </div>

      <div className="mt-6">
        <SectionLabel right={<Button size="sm" variant="ghost" icon={showCatalog ? X : Boxes} onClick={() => setShowCatalog((v) => !v)}>{showCatalog ? t('adm.drivers.catalog.hide') : t('adm.drivers.catalog.show')}</Button>}>{t('adm.drivers.catalog.title')}</SectionLabel>
        <p className="text-xs text-slate-500 mb-2">{t('adm.drivers.catalog.desc')}</p>
        {showCatalog && (
          <List>
            {(ov?.catalog || []).map((r) => (
              <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                <span className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.04] border border-white/10 text-slate-400 flex items-center justify-center">{r.kind === 'scanner' ? <ScanLine className="w-4 h-4" /> : <Printer className="w-4 h-4" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-100">{r.vendor} · {r.family}</div>
                  <div className="text-xs text-slate-500">{[r.print?.note || r.print?.package || (r.print?.how && t(`adm.drivers.how.${r.print.how}`)), r.scan?.backend && `${t('adm.drivers.catalog.scan')}: ${r.scan.backend}`].filter(Boolean).join(' · ')}</div>
                  {(r.requires || []).map((x, i) => <div key={i} className="text-xs text-amber-200/80 mt-0.5">{t(`adm.drivers.need.${x.kind}`, { file: x.package || '' })}{x.download && <> · <a className="text-manta-300 underline" href={x.download} target="_blank" rel="noreferrer">{t('adm.drivers.downloadFromVendor')}</a></>}</div>)}
                  {r.note && <div className="text-xs text-slate-500 mt-0.5">{r.note}</div>}
                </div>
                <StatusPill tone={STATUS_TONE[r.status]}>{t(`adm.drivers.status.${r.status}`)}</StatusPill>
              </div>
            ))}
          </List>
        )}
      </div>
    </div>
  );
}
