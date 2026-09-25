import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Download, Loader2, History, Copy, Check, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, StatusPill, Button, Disclosure, Modal, Meter, formatBytes, formatDate } from '../../ui/index.js';
import { useApplianceUpdater } from '../../hooks/useApplianceUpdater.js';

const STEPS = ['PREFLIGHT', 'BACKING_UP', 'DOWNLOADING', 'INSTALLING', 'RESTARTING', 'VERIFYING'];
const BUSY_STATES = new Set([...STEPS, 'CHECKING']);

export default function Updates({ showToast }) {
  const { t, lang } = useI18n();
  const u = useApplianceUpdater();
  const [confirm, setConfirm] = useState(false);
  const [backup, setBackup] = useState(true);
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [u.logs]);

  const info = u.versionInfo || {};
  const current = info.version || info.current_version || '—';
  const latest = info.latest_version || current;
  const hasUpdate = Boolean(info.update_available);
  const state = u.isRestartingAppliance ? 'RESTARTING' : u.state;
  const running = BUSY_STATES.has(state) && state !== 'CHECKING';
  const stepIndex = STEPS.indexOf(state);
  const notes = Array.isArray(info.changelog) ? info.changelog : Array.isArray(info.manifest?.changelog) ? info.manifest.changelog : [];
  const built = info.manifest?.build?.timestamp;
  const lastChecked = info.last_checked;

  const install = async () => {
    setConfirm(false);
    try {
      await u.startUpdate({ backup });
      showToast?.(t('adm.updates.started'), 'info');
    } catch (e) {
      showToast?.(e.message, 'error');
    }
  };

  const copyLogs = () => {
    const raw = u.logs.map((l) => `[${l.timestamp}] [${(l.level || 'info').toUpperCase()}] ${l.message}`).join('\n');
    try { navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <div>
      <PageHeader title={t('adm.updates.title')} description={t('adm.updates.desc')} />

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-2xl font-extrabold text-white">v{current}</span>
              {running ? (
                <StatusPill tone="info" pulse>{t(`adm.updates.state.${state}`, state)}</StatusPill>
              ) : hasUpdate ? (
                <StatusPill tone="warn">{t('adm.updates.available', { v: latest })}</StatusPill>
              ) : (
                <StatusPill tone="ok">{t('adm.updates.upToDate')}</StatusPill>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {t('adm.updates.channel', { c: info.channel || info.manifest?.channel || 'prototype' })}
              {built ? ` · ${t('adm.updates.built', { d: formatDate(built, lang) })}` : ''}
              {lastChecked ? ` · ${t('adm.updates.checked', { d: formatDate(lastChecked, lang) })}` : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={u.isChecking ? Loader2 : RefreshCw} disabled={u.isChecking || running} onClick={() => u.checkForUpdates(true)}>{t('adm.updates.check')}</Button>
            {hasUpdate && <Button variant="primary" icon={Download} disabled={running} onClick={() => setConfirm(true)}>{t('adm.updates.install', { v: latest })}</Button>}
          </div>
        </div>

        {running && (
          <div className="mt-5">
            <Meter value={u.progress || ((stepIndex + 1) / STEPS.length) * 100} />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {STEPS.map((s, i) => (
                <span key={s} className={`text-[11px] font-semibold ${i < stepIndex ? 'text-manta-300' : i === stepIndex ? 'text-white' : 'text-slate-600'}`}>{t(`adm.updates.state.${s}`, s)}</span>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">{u.currentStep}</p>
          </div>
        )}
        {u.error && <p className="mt-4 text-xs text-rose-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{u.error}</p>}

        {notes.length > 0 && (
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">{hasUpdate ? t('adm.updates.whatsNew', { v: latest }) : t('adm.updates.inThisVersion')}</div>
            <ul className="space-y-1.5 list-disc pl-5 marker:text-slate-600">
              {notes.slice(0, 6).map((n, i) => <li key={i} className="text-xs text-slate-300 leading-relaxed">{n}</li>)}
            </ul>
          </div>
        )}
      </Card>

      <div className="mt-6 space-y-3">
        <Disclosure title={`${t('adm.updates.log')}${u.logs.length ? ` (${u.logs.length})` : ''}`} defaultOpen={running}>
          <div className="flex justify-end gap-2 mb-2">
            <Button size="sm" variant="ghost" icon={copied ? Check : Copy} disabled={!u.logs.length} onClick={copyLogs}>{t('adm.updates.copyLog')}</Button>
          </div>
          <div ref={logRef} className="h-56 overflow-y-auto rounded-xl bg-black/50 border border-white/[0.06] p-3 font-mono text-[11px] leading-relaxed">
            {u.logs.length === 0 ? <span className="text-slate-600">{t('adm.updates.noLog')}</span> : u.logs.map((l, i) => (
              <div key={i} className={l.level === 'ERROR' || l.level === 'error' ? 'text-rose-300' : l.level === 'SUCCESS' || l.level === 'success' ? 'text-manta-300' : l.level === 'WARN' || l.level === 'warn' ? 'text-amber-300' : 'text-slate-300'}>
                <span className="text-slate-600">{String(l.timestamp || '').slice(11, 19)} </span>{l.message}
              </div>
            ))}
          </div>
        </Disclosure>

        <Disclosure title={`${t('adm.updates.snapshots')} (${u.backups.length})`}>
          {u.backups.length === 0 ? (
            <p className="text-xs text-slate-500">{t('adm.updates.noSnapshots')}</p>
          ) : (
            <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06]">
              {u.backups.map((b) => {
                const id = b.snapshot_id || b.id;
                return (
                  <div key={id} className="flex items-center gap-3 px-3 py-2.5">
                    <History className="w-4 h-4 text-slate-500" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-slate-200 truncate font-mono">{id}</div>
                      <div className="text-[11px] text-slate-500">{formatDate(b.created_at || b.timestamp, lang)}{b.size_bytes ? ` · ${formatBytes(b.size_bytes)}` : ''}</div>
                    </div>
                    <Button size="sm" variant="ghost" disabled={running} onClick={async () => { if (!window.confirm(t('adm.updates.rollbackConfirm'))) return; try { await u.rollback(id); showToast?.(t('adm.updates.rollbackStarted'), 'info'); } catch (e) { showToast?.(e.message, 'error'); } }}>{t('adm.updates.rollback')}</Button>
                  </div>
                );
              })}
            </div>
          )}
        </Disclosure>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title={t('adm.updates.confirmTitle', { v: latest })}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button><Button variant="primary" icon={Download} onClick={install}>{t('adm.updates.installNow')}</Button></>}>
        <p className="text-sm text-slate-300">{t('adm.updates.confirmDesc')}</p>
        <label className="mt-4 flex items-center gap-2.5 text-sm text-slate-200 cursor-pointer">
          <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} className="h-4 w-4 accent-manta-500" />
          {t('adm.updates.backupFirst')}
        </label>
      </Modal>
    </div>
  );
}
