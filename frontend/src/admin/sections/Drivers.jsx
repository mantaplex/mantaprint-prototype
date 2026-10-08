/**
 * Admin > Drivers & devices (Driver Center).
 *
 * The page is a set of checklists. The hub computes, for every connected device and every
 * family in the catalog, the ordered steps that make it work (support packages, a vendor
 * file, firmware, a PPD, then connect and verify) with their current status; this page renders
 * them and runs each step in place: install packages, upload the exact file, fetch firmware,
 * send firmware, print a test page. Nothing here needs the admin to know package names.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Printer, ScanLine, Usb, Search, Upload, Loader2, Package, Trash2, Check, AlertTriangle, ShieldAlert, ExternalLink,
  DownloadCloud, Lock, Info, ChevronDown, ChevronRight, Boxes, Globe, Cpu, Puzzle, FileText, Play, Wrench, Send, X
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, CardHeader, StatusPill, Button, List, SettingRow, EmptyState, Modal, SectionLabel, TextInput, Select, Disclosure, formatBytes } from '../../ui/index.js';
import { adminFetch, getAdminToken } from '../../shell/api.js';
import { readinessReasonText } from './Printers.jsx';

const KIND_ICON = { nal: Cpu, 'hplip-plugin': Puzzle, ppd: FileText, deb: Package, dl: DownloadCloud, archive: Boxes, asc: FileText };
const ERROR_CODES = new Set(['unknown_kind', 'use_scanner_firmware', 'not_a_deb', 'not_a_ppd', 'ppd_invalid', 'bad_name', 'invalid_size', 'nothing_useful', 'extract_failed', 'no_tools', 'too_large', 'insufficient_space', 'busy', 'upload_failed', 'not_allowed', 'offline', 'arch_mismatch', 'confirm_required', 'install_failed', 'version_mismatch', 'hplip_missing', 'not_a_plugin', 'hp_plugin_missing', 'exception', 'bad_model', 'fetch_failed', 'no_nal_found', 'unknown_target', 'write_failed']);
const TOOL_PACKAGES = ['nftables', 'p7zip-full', 'cabextract', 'unshield', 'ipp-usb', 'sane-airscan', 'sane-utils', 'cups-filters', 'printer-driver-all'];
const VERDICT_TONE = { supported: 'ok', likely: 'info', needs_file: 'warn', unsupported: 'danger', unknown: 'idle' };

function uploadRaw(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Admin-Token', getAdminToken());
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status === 401) {
        try {
          localStorage.removeItem('mantaprint_admin_token');
          window.dispatchEvent(new CustomEvent('mantaprint:unauthorized'));
        } catch {}
      }
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve(body || { success: false, code: 'generic' });
    };
    xhr.onerror = () => reject(new Error('upload_failed'));
    xhr.onabort = () => reject(new Error('upload_failed'));
    xhr.ontimeout = () => reject(new Error('upload_failed'));
    xhr.send(file);
  });
}

function summaryPill(summary, readiness, t) {
  if (readiness === 'provisioning') return { tone: 'info', label: t('adm.drivers.readiness.provisioning') };
  if (!summary || summary.state === 'unsupported' || readiness === 'unsupported' && summary?.todo === 0) return { tone: 'danger', label: t('adm.drivers.family.unsupported') };
  if (summary.state === 'ready') return { tone: 'ok', label: t('adm.drivers.family.ready') };
  return { tone: 'warn', label: t('adm.drivers.family.setup', { n: summary.todo }) };
}

// ---- steps ------------------------------------------------------------------------------

function StepIcon({ step, index }) {
  const base = 'h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 border';
  if (step.status === 'done') return <span className={`${base} bg-manta-500/15 border-manta-500/40 text-manta-300`}><Check className="w-3.5 h-3.5" /></span>;
  if (step.status === 'blocked') return <span className={`${base} bg-white/[0.03] border-white/10 text-slate-500`}><Lock className="w-3 h-3" /></span>;
  if (step.status === 'info') return <span className={`${base} bg-white/[0.03] border-white/10 text-slate-400`}><Info className="w-3.5 h-3.5" /></span>;
  if (step.status === 'optional') return <span className={`${base} bg-white/[0.03] border-white/15 text-slate-300`}>{index}</span>;
  return <span className={`${base} bg-amber-500/15 border-amber-500/40 text-amber-300`}>{index}</span>;
}

function stepText(step, t) {
  const s = step;
  switch (s.kind) {
    case 'packages': return { title: t('adm.drivers.step.packages.title'), detail: s.status === 'done' ? t('adm.drivers.step.packages.installed', { list: s.packages.join(', ') }) : t('adm.drivers.step.packages.missing', { list: s.missing.join(', ') }) };
    case 'deb': return { title: t('adm.drivers.step.deb.title', { package: s.package }), detail: s.status === 'done' ? t('adm.drivers.step.deb.done') : [s.note, s.arch?.length ? t('adm.drivers.step.deb.arch', { arch: s.arch.join(' / ') }) : ''].filter(Boolean).join(' ') };
    case 'plugin': return { title: t('adm.drivers.step.plugin.title'), detail: s.status === 'done' ? t('adm.drivers.step.plugin.done', { v: s.plugin_version || '' }) : s.status === 'blocked' ? t('adm.drivers.step.plugin.blocked') : t('adm.drivers.step.plugin.todo', { file: s.required_file, v: s.hplip_version || '?' }) };
    case 'nal': {
      const done = (s.targets || []).filter((x) => x.installed).map((x) => x.model);
      return { title: t('adm.drivers.step.nal.title'), detail: `${t('adm.drivers.step.nal.todo')}${done.length ? ` ${t('adm.drivers.step.nal.installedFor', { list: done.join(', ') })}` : ''}` };
    }
    case 'dl': {
      const missing = (s.models || []).filter((m) => !m.present).map((m) => `${m.filename} (${m.models.join(', ')})`);
      const present = (s.models || []).filter((m) => m.present).map((m) => m.filename);
      return { title: t('adm.drivers.step.dl.title'), detail: s.status === 'done' ? t('adm.drivers.step.dl.done', { list: present.join(', ') }) : missing.length ? t('adm.drivers.step.dl.missing', { list: missing.join(' · ') }) : t('adm.drivers.step.dl.queue') };
    }
    case 'connect': return { title: t('adm.drivers.step.connect.title'), detail: s.status === 'done' ? t('adm.drivers.step.connect.done', { list: (s.connected || []).join(', ') }) : t('adm.drivers.step.connect.todo') };
    case 'verify': return { title: t('adm.drivers.step.verify.title'), detail: s.status === 'blocked' ? t('adm.drivers.step.verify.blocked') : t('adm.drivers.step.verify.todo') };
    case 'ppd': return { title: s.status === 'optional' ? t('adm.drivers.step.ppd.titleOptional') : t('adm.drivers.step.ppd.title'), detail: s.reason === 'unknown_device' ? t('adm.drivers.step.ppd.unknown') : t('adm.drivers.step.ppd.detail') };
    case 'provisioning': return { title: t('adm.drivers.step.provisioning.title'), detail: t('adm.drivers.step.provisioning.detail') };
    case 'unsupported': return { title: t('adm.drivers.step.unsupported.title'), detail: s.note || '' };
    default: return { title: s.kind, detail: '' };
  }
}

/** File-picking action. Knows which endpoint and query the step needs. */
function UploadAction({ action, step, ctx, api, t }) {
  const input = useRef(null);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState('');
  const targets = step.kind === 'nal' ? step.targets || [] : [];
  const [target, setTarget] = useState(action.target || (targets.length === 1 ? targets[0].filename : ''));
  const label = action.label || t(`adm.drivers.step.upload.${action.expect}`);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (action.expect === 'hplip-plugin' && step.required_file && /\.run$/i.test(file.name) && file.name.toLowerCase() !== step.required_file.toLowerCase()) {
      setError(t('adm.drivers.errors.version_mismatch', { file: step.required_file, v: file.name }));
      return;
    }
    const qs = new URLSearchParams();
    const queue = action.queue || ctx?.queue;
    if (queue && action.endpoint === '/api/drivers/upload') qs.set('queue', queue);
    if (action.endpoint === '/api/scanner/firmware' && target) qs.set('target', target);
    if (action.expect === 'hplip-plugin' && /\.asc$/i.test(file.name)) { qs.delete('queue'); qs.set('kind', 'asc'); }
    const url = `${action.endpoint}${qs.toString() ? `?${qs}` : ''}`;
    setPhase(0);
    try {
      const body = await uploadRaw(url, file, (p) => setPhase(p >= 100 ? 'processing' : p));
      if (!body.success) { setError(api.errorText(body)); if (body.tail) setError((x) => `${x}\n${body.tail}`); }
      else api.afterUpload(body, file, action);
    } catch { setError(t('adm.drivers.errors.upload_failed')); }
    finally { setPhase(null); }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {step.kind === 'nal' && targets.length > 1 && !action.target && (
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="!h-9 text-xs">
            <option value="">{t('adm.drivers.step.nal.chooseTarget')}</option>
            {targets.map((x) => <option key={x.filename} value={x.filename}>{x.model} ({x.filename}){x.installed ? ' ✓' : ''}</option>)}
          </Select>
        )}
        <input ref={input} type="file" accept={action.accept} className="hidden" onChange={pick} />
        <Button size="sm" variant="primary" icon={phase !== null ? Loader2 : Upload} disabled={phase !== null || api.busy || (step.kind === 'nal' && targets.length > 1 && !target)} onClick={() => input.current?.click()}>
          {phase === null ? label : phase === 'processing' ? t('adm.drivers.actions.processing') : t('adm.drivers.actions.uploading', { p: phase })}
        </Button>
      </div>
      {error && <pre role="alert" className="text-xs text-rose-300 whitespace-pre-wrap">{error}</pre>}
    </div>
  );
}

/** One row per required file: name, note, status, its own upload button, a check mark once it is on the hub. */
function FileList({ step, ctx, api, t }) {
  const files = step.files || [];
  if (!files.length) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {files.map((f) => (
        <li key={f.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 ${f.done ? 'border-manta-500/25 bg-manta-500/[0.06]' : 'border-white/[0.08] bg-white/[0.02]'}`}>
          <span className={`h-5 w-5 shrink-0 rounded-full flex items-center justify-center border ${f.done ? 'bg-manta-500/20 border-manta-500/50 text-manta-300' : 'border-white/15 text-slate-500'}`}>{f.done ? <Check className="w-3 h-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}</span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-mono text-slate-100 truncate">{f.name}{f.optional && <span className="ml-2 font-sans text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('adm.drivers.step.optional')}</span>}</div>
            <div className={`text-[11px] ${f.done ? 'text-manta-300' : 'text-slate-500'}`}>
              {f.done ? t('adm.drivers.step.files.uploaded') : t('adm.drivers.step.files.missing')}
              {step.kind === 'plugin' && ` · ${t(`adm.drivers.step.plugin.file.${f.id}`)}`}
              {f.note && step.kind !== 'plugin' && ` · ${f.note}`}
            </div>
          </div>
          {!f.done && step.status !== 'blocked' && <UploadAction action={{ type: 'upload', accept: f.accept, endpoint: f.endpoint, expect: f.expect, target: f.target || null, label: t('adm.drivers.step.files.upload') }} step={step} ctx={ctx} api={api} t={t} />}
        </li>
      ))}
    </ul>
  );
}

function StepActions({ step, ctx, api, t }) {
  const actions = (step.actions || []).filter((a) => !(a.type === 'upload' && step.files?.length));
  if (!actions.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      {actions.map((a, i) => {
        switch (a.type) {
          case 'apt': return <Button key={i} size="sm" variant="primary" icon={api.busy ? Loader2 : DownloadCloud} disabled={api.busy} onClick={() => api.apt(a.packages)}>{t('adm.drivers.step.packages.action', { n: a.packages.length })}</Button>;
          case 'upload': return <UploadAction key={i} action={a} step={step} ctx={ctx} api={api} t={t} />;
          case 'link': return <a key={i} className="inline-flex items-center gap-1 h-9 px-2 text-xs text-manta-300 underline" href={a.href} target="_blank" rel="noreferrer">{t('adm.drivers.step.download')} <ExternalLink className="w-3 h-3" /></a>;
          case 'getweb': return <Button key={i} size="sm" variant="secondary" icon={api.busy ? Loader2 : Globe} disabled={api.busy} onClick={() => api.getweb(a.models)}>{t('adm.drivers.step.dl.fetch')}</Button>;
          case 'provision': return <Button key={i} size="sm" variant="primary" icon={Send} disabled={api.busy} onClick={() => api.provision(a.queue)}>{t('adm.drivers.step.dl.provision')}</Button>;
          case 'test-print': return <Button key={i} size="sm" variant="primary" icon={Play} disabled={api.busy} onClick={() => api.testPrint(a.queue)}>{t('adm.drivers.step.verify.testPrint')}{a.name && actions.filter((x) => x.type === 'test-print').length > 1 ? ` · ${a.name}` : ''}</Button>;
          case 'open-scan': return <Button key={i} size="sm" variant="secondary" icon={ScanLine} onClick={() => window.open('/scan', '_blank')}>{t('adm.drivers.step.verify.openScan')}</Button>;
          default: return null;
        }
      })}
    </div>
  );
}

function Steps({ steps, ctx, api, t }) {
  if (!steps?.length) return null;
  let n = 0;
  return (
    <ol className="space-y-3">
      {steps.map((step) => {
        if (step.status !== 'info') n += 1;
        const { title, detail } = stepText(step, t);
        const muted = step.status === 'done' || step.status === 'blocked';
        return (
          <li key={step.id} className="flex items-start gap-3">
            <StepIcon step={step} index={n} />
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${muted ? 'text-slate-400' : 'text-slate-100'}`}>{title}{step.status === 'optional' && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('adm.drivers.step.optional')}</span>}</div>
              {detail && <p className={`text-xs mt-0.5 ${step.status === 'blocked' ? 'text-slate-500' : 'text-slate-400'}`}>{detail}</p>}
              {step.status !== 'done' && <FileList step={step} ctx={ctx} api={api} t={t} />}
              {step.status !== 'done' && step.status !== 'blocked' && <StepActions step={step} ctx={ctx} api={api} t={t} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---- your devices --------------------------------------------------------------------------

function DeviceCard({ d, api, t }) {
  const Icon = d.type === 'printer' ? Printer : d.type === 'scanner' ? ScanLine : Usb;
  const pill = summaryPill(d.summary, d.readiness, t);
  const readinessLabel = d.readiness ? t(`adm.drivers.readiness.${d.readiness}`) : t('adm.drivers.readiness.unknown');
  return (
    <Card className={pill.tone === 'danger' ? '!border-rose-500/30 !bg-rose-500/[0.04]' : pill.tone === 'warn' ? '!border-amber-500/30 !bg-amber-500/[0.04]' : ''}>
      <CardHeader icon={Icon} title={d.name || d.model} description={[d.vendor, d.model, d.usb_id, d.queue].filter(Boolean).join(' · ')}
        actions={<StatusPill tone={pill.tone}>{pill.label}</StatusPill>} />
      {(d.readiness_reason || d.recipe) && (
        <p className="mt-2 text-xs text-slate-400">
          {d.readiness && <span className="text-slate-300">{readinessLabel}. </span>}
          {d.readiness_reason && readinessReasonText(d, t)}
          {d.recipe && <span className="text-slate-500"> · {t('adm.drivers.family.label')}: {d.recipe.name}</span>}
        </p>
      )}
      {d.steps?.length > 0 && <div className="mt-4 rounded-xl bg-white/[0.03] border border-white/[0.06] p-4"><Steps steps={d.steps} ctx={{ queue: d.queue }} api={api} t={t} /></div>}
    </Card>
  );
}

// ---- catalog with checklists ------------------------------------------------------------

function KindBadges({ kind, t }) {
  const printer = kind === 'printer' || kind === 'mfp';
  const scanner = kind === 'scanner' || kind === 'mfp';
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {printer && <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[10px] font-bold"><Printer className="w-3 h-3" />{t('adm.drivers.support.printer')}</span>}
      {scanner && <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[10px] font-bold"><ScanLine className="w-3 h-3" />{t('adm.drivers.support.scanner')}</span>}
    </span>
  );
}

function FamilyRow({ r, open, onToggle, api, t }) {
  const pill = summaryPill(r.summary, null, t);
  const connected = (r.steps || []).find((s) => s.kind === 'connect')?.connected || [];
  const Icon = r.kind === 'scanner' ? ScanLine : Printer;
  return (
    <div className={open ? 'bg-white/[0.02]' : ''}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
        <span className="h-9 w-9 shrink-0 rounded-xl bg-white/[0.04] border border-white/10 text-slate-400 flex items-center justify-center"><Icon className="w-4 h-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{r.name}</span>
            <KindBadges kind={r.kind} t={t} />
            {r.status === 'verified' && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-manta-300"><Check className="w-3 h-3" />{t('adm.drivers.family.verified')}</span>}
          </div>
          <div className="text-xs text-slate-500 truncate">{connected.length ? <span className="text-manta-300">{t('adm.drivers.family.connected', { list: connected.join(', ') })} · </span> : null}{r.family}</div>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
      </button>
      {open && (
        <div className="px-4 pb-4 pl-[4rem]">
          {r.models?.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {r.models.map((m) => <span key={m} className="px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/10 text-[11px] text-slate-300">{m}</span>)}
            </div>
          )}
          <Steps steps={r.steps} ctx={{}} api={api} t={t} />
          {(r.note || r.status === 'available') && <p className="mt-3 text-[11px] text-slate-500">{r.note}{r.note && r.status === 'available' ? ' ' : ''}{r.status === 'available' ? t('adm.drivers.family.notTested') : ''}</p>}
        </div>
      )}
    </div>
  );
}

function LookupResult({ res, t }) {
  if (!res) return null;
  return (
    <Card className="mt-3">
      <div className="flex items-center gap-2 text-xs">
        <StatusPill tone={VERDICT_TONE[res.verdict] || 'idle'}>{t(`adm.drivers.lookup.verdict.${res.verdict}`)}</StatusPill>
        <span className="text-slate-400">{t(`adm.drivers.lookup.verdictDesc.${res.verdict}`)}</span>
      </div>
      {res.ppd?.length > 0 && (
        <div className="mt-3 text-xs">
          <div className="font-semibold text-slate-200 mb-1">{t('adm.drivers.lookup.ppd')}</div>
          {res.ppd.map((h, i) => <div key={i} className="text-slate-300 truncate">{h.confidence === 'exact' ? <Check className="inline w-3 h-3 text-manta-300 mr-1" /> : <Info className="inline w-3 h-3 text-amber-300 mr-1" />}{h.make_model} <span className="text-slate-500">({h.driver})</span></div>)}
        </div>
      )}
      {res.sane?.length > 0 && (
        <div className="mt-3 text-xs">
          <div className="font-semibold text-slate-200 mb-1">{t('adm.drivers.lookup.sane')}</div>
          {res.sane.map((h, i) => <div key={i} className="text-slate-300">{h.name} <span className="text-slate-500 font-mono">{h.usb_id}</span></div>)}
        </div>
      )}
      {res.hp?.plugin?.needed && <p className="mt-3 text-xs text-amber-300">{t('adm.drivers.lookup.hpPlugin')}</p>}
    </Card>
  );
}

function SupportList({ catalog, api, t }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [openIds, setOpenIds] = useState(() => new Set());
  const [lookup, setLookup] = useState(null);
  const [looking, setLooking] = useState(false);
  const qn = q.trim().toLowerCase();

  const rows = useMemo(() => catalog.filter((r) => {
    if (kind === 'printer' && !(r.kind === 'printer' || r.kind === 'mfp')) return false;
    if (kind === 'scanner' && !(r.kind === 'scanner' || r.kind === 'mfp')) return false;
    if (kind === 'setup' && r.summary?.state !== 'setup') return false;
    if (!qn) return true;
    return [r.vendor, r.name, r.family, ...(r.models || [])].join(' ').toLowerCase().includes(qn);
  }), [catalog, kind, qn]);

  const groups = useMemo(() => {
    const g = [];
    for (const r of rows) { let x = g.find((y) => y.vendor === r.vendor); if (!x) { x = { vendor: r.vendor, items: [] }; g.push(x); } x.items.push(r); }
    g.sort((a, b) => a.vendor.localeCompare(b.vendor));
    for (const x of g) x.items.sort((a, b) => a.name.localeCompare(b.name));
    return g;
  }, [rows]);

  // Families with a connected device open by themselves; so do the few results of a search.
  const autoOpen = useMemo(() => {
    const set = new Set(catalog.filter((r) => (r.steps || []).some((s) => s.kind === 'connect' && s.status === 'done')).map((r) => r.id));
    if (qn && rows.length <= 2) for (const r of rows) set.add(r.id);
    return set;
  }, [catalog, rows, qn]);
  const isOpen = (id) => openIds.has(id) || (autoOpen.has(id) && !openIds.has(`!${id}`));
  const toggle = (id) => setOpenIds((s) => { const n = new Set(s); if (isOpen(id)) { n.delete(id); n.add(`!${id}`); } else { n.add(id); n.delete(`!${id}`); } return n; });

  const counts = { all: catalog.length, printer: catalog.filter((r) => r.kind !== 'scanner').length, scanner: catalog.filter((r) => r.kind !== 'printer').length, setup: catalog.filter((r) => r.summary?.state === 'setup').length };

  const runLookup = async () => {
    setLooking(true);
    try { setLookup(await adminFetch(`/api/drivers/lookup?q=${encodeURIComponent(q.trim())}`)); } catch { setLookup(null); } finally { setLooking(false); }
  };
  useEffect(() => { setLookup(null); }, [qn]);

  return (
    <div>
      <SectionLabel>{t('adm.drivers.support.title')}</SectionLabel>
      <p className="text-xs text-slate-500 mb-3">{t('adm.drivers.support.desc')}</p>
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5 pointer-events-none" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.drivers.support.search')} className="pl-9" />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {['all', 'printer', 'scanner', 'setup'].map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`h-9 px-3 rounded-xl text-xs font-semibold whitespace-nowrap ${kind === k ? 'bg-manta-600 text-white' : 'bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/10'}`}>
              {t(`adm.drivers.support.filter.${k}`)} <span className="opacity-60">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={Search} title={t('adm.drivers.support.noMatch')} description={t('adm.drivers.support.noMatchDesc')} />
      ) : groups.map((g) => (
        <div key={g.vendor} className="mb-4">
          <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5 px-1">{g.vendor}</div>
          <List>
            {g.items.map((r) => <FamilyRow key={r.id} r={r} open={isOpen(r.id)} onToggle={() => toggle(r.id)} api={api} t={t} />)}
          </List>
        </div>
      ))}

      {qn.length >= 3 && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{t('adm.drivers.support.lookup', { q: q.trim() })}</span>
            <Button size="sm" variant="secondary" icon={looking ? Loader2 : Search} disabled={looking} onClick={runLookup}>{t('adm.drivers.support.lookupGo')}</Button>
          </div>
          <LookupResult res={lookup} t={t} />
        </div>
      )}
    </div>
  );
}

// ---- pending items, jobs, advanced ----------------------------------------------------------

function DebConfirmModal({ confirm, busy, onClose, onInstall, t }) {
  if (!confirm) return null;
  const info = confirm.file.info || {};
  return (
    <Modal open onClose={onClose} title={t('adm.drivers.confirm.title')} footer={
      <>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" icon={busy ? Loader2 : Package} disabled={busy} onClick={() => onInstall(confirm.id, confirm.file, { force: !info.arch_ok })}>{t('adm.drivers.confirm.go')}</Button>
      </>
    }>
      <div className="space-y-3 text-xs">
        <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-rose-200 flex items-start gap-2"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" /><span>{t('adm.drivers.confirm.warning')}</span></div>
        <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-slate-300">
          <dt className="text-slate-500">{t('adm.drivers.confirm.package')}</dt><dd className="font-mono">{info.package} {info.version}</dd>
          <dt className="text-slate-500">{t('adm.drivers.confirm.arch')}</dt><dd className={info.arch_ok ? '' : 'text-rose-300'}>{info.architecture} {info.arch_ok ? '' : t('adm.drivers.confirm.archMismatch', { host: info.host_architecture })}</dd>
          <dt className="text-slate-500">{t('adm.drivers.confirm.maintainer')}</dt><dd className="break-all">{info.maintainer || '—'}</dd>
          <dt className="text-slate-500">{t('adm.drivers.confirm.description')}</dt><dd>{info.description || '—'}</dd>
          <dt className="text-slate-500">{t('adm.drivers.confirm.depends')}</dt><dd className="break-all">{info.depends || '—'}</dd>
          <dt className="text-slate-500">{t('adm.drivers.confirm.scripts')}</dt><dd>{info.has_maintainer_scripts ? t('adm.drivers.confirm.scriptsYes') : t('adm.drivers.confirm.scriptsNo')}</dd>
          <dt className="text-slate-500">SHA-256</dt><dd className="font-mono break-all text-[10px]">{confirm.file.sha256}</dd>
        </dl>
        <p className="text-slate-400">{t('adm.drivers.confirm.license')}</p>
      </div>
    </Modal>
  );
}

function PendingList({ pending, api, t }) {
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
              {p.kind === 'deb' && <Button size="sm" variant="primary" icon={Package} disabled={api.busy} onClick={() => api.confirmDeb({ id: p.id, file: { kind: 'deb', name: p.name, sha256: p.sha256, info: p.info } })}>{t('adm.drivers.pending.review')}</Button>}
              <button type="button" title={t('adm.drivers.pending.discard')} aria-label={t('adm.drivers.pending.discard')} onClick={() => api.dropPending(p.id)} className="h-9 w-9 rounded-lg hover:bg-rose-500/15 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
            </div>
            {p.kind === 'archive' && (
              <div className="mt-3 space-y-1.5">
                {p.files.map((f) => (
                  <div key={f.sha256} className="flex items-center gap-2 text-xs rounded-lg bg-white/[0.03] px-3 py-2">
                    {React.createElement(KIND_ICON[f.kind] || FileText, { className: 'w-3.5 h-3.5 text-slate-400 shrink-0' })}
                    <span className="flex-1 truncate text-slate-200">{f.name} <span className="text-slate-500">· {t(`adm.drivers.kind.${f.kind}`)} · {formatBytes(f.size)}</span></span>
                    {f.kind === 'deb'
                      ? <Button size="sm" variant="secondary" disabled={api.busy} onClick={() => api.confirmDeb({ id: p.id, file: f })}>{t('adm.drivers.pending.review')}</Button>
                      : <Button size="sm" variant="secondary" disabled={api.busy} onClick={() => api.installPending(p.id, f)}>{t('adm.drivers.pending.install')}</Button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </List>
    </div>
  );
}

function JobCard({ job, t }) {
  if (!job) return null;
  const running = job.state === 'running';
  return (
    <Card className={`mt-4 ${job.state === 'failed' ? '!border-rose-500/30' : running ? '!border-manta-500/30' : '!border-white/10'}`}>
      <CardHeader icon={running ? Loader2 : job.state === 'failed' ? AlertTriangle : Check} title={t(`adm.drivers.job.${job.kind}`, { name: job.label })}
        description={running ? t('adm.drivers.job.running') : job.state === 'failed' ? `${t(`adm.drivers.errors.${ERROR_CODES.has(job.result?.code) ? job.result.code : 'install_failed'}`)}${job.result?.message ? ` (${job.result.message})` : ''}` : t('adm.drivers.job.done')}
        actions={<StatusPill tone={running ? 'info' : job.state === 'failed' ? 'danger' : 'ok'} pulse={running}>{t(`adm.drivers.job.state.${job.state}`)}</StatusPill>} />
      {job.log?.length > 0 && <pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-black/40 p-3 text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap">{job.log.slice(-60).join('\n')}</pre>}
    </Card>
  );
}

function AdvancedUpload({ ov, api, t }) {
  const input = useRef(null);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState('');
  const send = async (file) => {
    if (!file) return;
    setError('');
    if (/\.nal$/i.test(file.name)) { setError(t('adm.drivers.errors.use_scanner_firmware')); return; }
    setPhase(0);
    try {
      const body = await uploadRaw('/api/drivers/upload', file, (p) => setPhase(p >= 100 ? 'processing' : p));
      if (!body.success) setError(api.errorText(body)); else api.afterUpload(body, file, {});
    } catch { setError(t('adm.drivers.errors.upload_failed')); }
    finally { setPhase(null); }
  };
  return (
    <div>
      <p className="text-xs text-slate-400">{t('adm.drivers.advanced.uploadDesc')}</p>
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); send(e.dataTransfer.files?.[0]); }} className="mt-3 rounded-2xl border-2 border-dashed border-white/10 bg-white/[0.02] p-5 text-center">
        <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; send(f); }} />
        <p className="text-sm text-slate-200">{t('adm.drivers.advanced.drop')}</p>
        <p className="mt-1 text-[11px] text-slate-500">{t('adm.drivers.advanced.kinds')}</p>
        <Button className="mt-3" variant="secondary" icon={phase !== null ? Loader2 : Upload} disabled={phase !== null || api.busy} onClick={() => input.current?.click()}>
          {phase === null ? t('adm.drivers.advanced.pick') : phase === 'processing' ? t('adm.drivers.actions.processing') : t('adm.drivers.actions.uploading', { p: phase })}
        </Button>
      </div>
      {error && <pre role="alert" className="mt-2 text-xs text-rose-300 whitespace-pre-wrap">{error}</pre>}
      <div className="mt-5">
        <div className="text-xs font-semibold text-slate-200 mb-1 flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5" />{t('adm.drivers.advanced.toolsTitle')}</div>
        <p className="text-[11px] text-slate-500 mb-2">{t('adm.drivers.advanced.toolsDesc')}</p>
        <List>
          {(ov?.apt?.packages || []).filter((p) => TOOL_PACKAGES.includes(p.name)).map((p) => (
            <SettingRow key={p.name} title={t(`adm.drivers.tools.names.${p.name}`)} description={<span className="font-mono text-[11px]">{p.name}</span>}>
              {p.installed ? <StatusPill tone="ok">{t('adm.drivers.advanced.installed')}</StatusPill>
                : <Button size="sm" variant="secondary" icon={api.busy ? Loader2 : DownloadCloud} disabled={api.busy} onClick={() => api.apt([p.name])}>{t('adm.drivers.advanced.install')}</Button>}
            </SettingRow>
          ))}
        </List>
      </div>
    </div>
  );
}

// ---- page -------------------------------------------------------------------------------------

export default function Drivers({ showToast }) {
  const { t } = useI18n();
  const [ov, setOv] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    try { setOv(await adminFetch('/api/drivers/overview')); } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, ov?.job?.state === 'running' ? 2000 : 10000);
    return () => clearInterval(id);
  }, [load, ov?.job?.state]);

  const errorText = useCallback((body) => t(`adm.drivers.errors.${ERROR_CODES.has(body?.code) ? body.code : 'generic'}`, { file: body?.required_file || '', v: body?.uploaded_version || '' }), [t]);
  const post = useCallback(async (url, body, okMsg) => {
    setActing(true);
    try {
      const r = await adminFetch(url, { method: 'POST', body });
      if (r && r.success === false) showToast?.(errorText(r), 'error');
      else showToast?.(okMsg, 'success');
    } catch (e) {
      let parsed = (e?.body && typeof e.body === 'object') ? e.body : null;
      if (!parsed) { try { parsed = JSON.parse(e.message); } catch {} }
      showToast?.(parsed ? errorText(parsed) : e.message, 'error');
    } finally { setActing(false); load(); }
  }, [errorText, load, showToast]);

  const api = useMemo(() => ({
    busy: acting || ov?.job?.state === 'running',
    errorText,
    reload: load,
    afterUpload: (body, file) => {
      if (body.job) showToast?.(t('adm.drivers.jobStarted', { name: file.name }), 'success');
      else if (body.pending && body.kind === 'deb') setConfirm({ id: body.pending.id, file: { kind: 'deb', name: body.pending.name, sha256: body.pending.sha256, info: body.pending.info } });
      else if (body.pending) showToast?.(t('adm.drivers.pendingCreated', { name: file.name }), 'success');
      else if (body.stored === 'asc') showToast?.(t('adm.drivers.step.plugin.ascStored'), 'success');
      else showToast?.(t('adm.drivers.installedToast', { name: file.name }), 'success');
      load();
    },
    apt: (packages) => post('/api/drivers/apt/install', { packages }, t('adm.drivers.jobStarted', { name: packages.join(', ') })),
    getweb: (models) => post('/api/drivers/hp-firmware/fetch', { models }, t('adm.drivers.jobStarted', { name: models.join(', ') })),
    provision: (queue) => post(`/api/printers/${encodeURIComponent(queue)}/provision-firmware`, {}, t('adm.printers.readiness.firmwareSent')),
    testPrint: (queue) => post(`/api/printers/${encodeURIComponent(queue)}/test-page`, {}, t('adm.printers.testSent')),
    confirmDeb: (c) => setConfirm(c),
    installPending: async (id, file, opts = {}) => {
      await post('/api/drivers/pending/install', { id, sha256: file?.sha256, confirm: true, ...opts }, t('adm.drivers.jobStarted', { name: file?.name || '' }));
      setConfirm(null);
    },
    dropPending: (id) => post('/api/drivers/pending/drop', { id }, t('adm.drivers.pending.discarded'))
  }), [acting, ov?.job?.state, errorText, load, post, showToast, t]);

  const devices = ov?.devices || [];
  const sortedDevices = [...devices].sort((a, b) => (a.summary?.state === 'setup' ? 0 : 1) - (b.summary?.state === 'setup' ? 0 : 1));

  return (
    <div>
      <PageHeader title={t('adm.drivers.title')} description={t('adm.drivers.desc')} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {['s1', 's2', 's3'].map((k, i) => (
          <div key={k} className="flex items-start gap-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
            <span className="h-6 w-6 shrink-0 rounded-full bg-manta-500/15 border border-manta-500/40 text-manta-300 text-[11px] font-bold flex items-center justify-center">{i + 1}</span>
            <span className="text-xs text-slate-300">{t(`adm.drivers.how.${k}`)}</span>
          </div>
        ))}
      </div>

      <JobCard job={ov?.job} t={t} />

      <div className="mt-6">
        <SectionLabel>{t('adm.drivers.devices.title')} ({devices.length})</SectionLabel>
        {!ov ? <EmptyState icon={Loader2} title={t('adm.common.loading')} /> : devices.length === 0 ? (
          <EmptyState icon={Usb} title={t('adm.drivers.devices.none')} description={t('adm.drivers.devices.noneDesc')} />
        ) : (
          <div className="space-y-3">{sortedDevices.map((d) => <DeviceCard key={d.id} d={d} api={api} t={t} />)}</div>
        )}
      </div>

      <PendingList pending={ov?.pending} api={api} t={t} />

      <div className="mt-6"><SupportList catalog={ov?.catalog || []} api={api} t={t} /></div>

      <div className="mt-6">
        <Disclosure title={`${t('adm.drivers.installed.title')} (${ov?.installed?.length || 0})`} defaultOpen={Boolean(ov?.installed?.length)}>
          {!ov?.installed?.length ? <p className="text-xs text-slate-500">{t('adm.drivers.installed.noneDesc')}</p> : (
            <List>
              {ov.installed.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="h-9 w-9 rounded-xl bg-manta-500/10 border border-manta-500/25 text-manta-300 flex items-center justify-center">{React.createElement(KIND_ICON[i.kind] || FileText, { className: 'w-4 h-4' })}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-100 truncate">{i.package || i.name}{i.version ? ` ${i.version}` : ''}</div>
                    <div className="text-xs text-slate-500 truncate">{t(`adm.drivers.kind.${i.kind}`)}{i.note ? ` · ${i.note}` : ''}{i.target ? ` · ${i.target}` : ''} · {new Date(i.installed_at).toLocaleDateString()}</div>
                  </div>
                  <button type="button" title={t('adm.drivers.installed.remove')} aria-label={t('adm.drivers.installed.remove')} onClick={() => { if (window.confirm(t('adm.drivers.installed.removeConfirm', { name: i.package || i.name }))) post('/api/drivers/installed/remove', { id: i.id }, t('adm.drivers.jobStarted', { name: i.package || i.name })); }} className="h-9 w-9 rounded-lg hover:bg-rose-500/15 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </List>
          )}
        </Disclosure>
      </div>

      <div className="mt-4">
        <Disclosure title={t('adm.drivers.advanced.title')}>
          <p className="text-[11px] text-amber-200/80 mb-3 flex items-start gap-1.5"><ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />{t('adm.drivers.advanced.rootWarning')}</p>
          <AdvancedUpload ov={ov} api={api} t={t} />
        </Disclosure>
      </div>

      <DebConfirmModal confirm={confirm} busy={acting} onClose={() => setConfirm(null)} onInstall={api.installPending} t={t} />
    </div>
  );
}
