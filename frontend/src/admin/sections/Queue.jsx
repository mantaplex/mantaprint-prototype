import React, { useCallback, useEffect, useState } from 'react';
import { ListChecks, X, Loader2, Trash2, Eraser } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PageHeader, Card, StatusPill, Button, EmptyState, Modal, SectionLabel, Segmented } from '../../ui/index.js';
import { adminFetch } from '../../shell/api.js';

const DONE = ['completed', 'canceled', 'cancelled', 'error', 'aborted'];

function tone(state) {
  if (state === 'completed') return 'ok';
  if (state === 'error' || state === 'aborted') return 'danger';
  if (state === 'canceled' || state === 'cancelled') return 'idle';
  return 'info';
}

function timeOf(ts, lang) {
  if (!ts) return '';
  try { return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts)); } catch { return ''; }
}

export default function Queue({ data, refresh, showToast }) {
  const { t, lang } = useI18n();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'all' | 'history'
  const [printer, setPrinter] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/api/jobs');
      const seen = new Set();
      // The tracker indexes each job twice (full id and numeric id); keep one entry.
      const list = (r.jobs || []).filter((j) => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
      list.sort((a, b) => (b.submitted_at || 0) - (a.submitted_at || 0));
      setJobs(list);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [load]);
  useEffect(() => { load(); }, [data?.timestamp, load]);

  const printers = data?.printers || [];
  const filtered = printer ? jobs.filter((j) => j.printer === printer) : jobs;
  const active = filtered.filter((j) => !DONE.includes(j.state));
  const history = filtered.filter((j) => DONE.includes(j.state)).slice(0, 30);

  const cancel = async (j) => {
    setBusy(j.id);
    try {
      await adminFetch('/api/printer/cancel-job', { method: 'POST', body: { jobId: j.id, printer: j.printer } });
      showToast?.(t('adm.queue.cancelled'), 'info');
      await load();
      refresh?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const bulk = async () => {
    const kind = confirm;
    setBusy(kind);
    try {
      if (kind === 'all') await adminFetch('/api/printer/cancel-all', { method: 'POST', body: { printer: printer || undefined, purge: false } });
      else await adminFetch('/api/jobs/clear-history', { method: 'POST' });
      showToast?.(kind === 'all' ? t('adm.queue.allCancelled') : t('adm.queue.historyCleared'), 'success');
      await load();
      refresh?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const Row = ({ j }) => (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-100 truncate">{j.title || `#${j.numeric_id || j.id}`}</div>
        <div className="text-xs text-slate-500 truncate">
          {j.printer} · {timeOf(j.submitted_at, lang)}{j.size ? ` · ${Math.max(1, Math.round(j.size / 1024))} KB` : ''}{j.user ? ` · ${j.user}` : ''}
        </div>
        {j.status_message && !DONE.includes(j.state) && <div className="text-[11px] text-slate-400 mt-0.5 truncate">{j.status_message}</div>}
      </div>
      <StatusPill tone={tone(j.state)} pulse={!DONE.includes(j.state)}>{t(`hub.jobState.${j.state}`, j.state)}</StatusPill>
      {!DONE.includes(j.state) && (
        <button type="button" onClick={() => cancel(j)} disabled={busy === j.id} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={t('adm.queue.cancel')} title={t('adm.queue.cancel')}>
          {busy === j.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
        </button>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title={t('adm.queue.title')}
        description={t('adm.queue.desc')}
        actions={<Button size="sm" variant="danger" icon={Trash2} disabled={active.length === 0} onClick={() => setConfirm('all')}>{t('adm.queue.cancelAll')}</Button>}
      />

      {printers.length > 1 && (
        <div className="mb-4 overflow-x-auto no-scrollbar">
          <Segmented size="sm" value={printer} onChange={setPrinter} options={[{ value: '', label: t('adm.queue.allPrinters') }, ...printers.map((p) => ({ value: p.queue_name, label: p.display_name || p.queue_name }))]} />
        </div>
      )}

      <SectionLabel>{t('adm.queue.active')} ({active.length})</SectionLabel>
      {loading ? (
        <div className="h-24 rounded-2xl bg-white/[0.03] animate-pulse" />
      ) : active.length === 0 ? (
        <EmptyState icon={ListChecks} title={t('adm.queue.emptyTitle')} description={t('adm.queue.emptyDesc')} />
      ) : (
        <Card padded={false} className="divide-y divide-white/[0.05]">{active.map((j) => <Row key={j.id} j={j} />)}</Card>
      )}

      <div className="mt-6">
        <SectionLabel right={history.length > 0 && <button type="button" onClick={() => setConfirm('history')} className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1"><Eraser className="w-3.5 h-3.5" />{t('adm.queue.clearHistory')}</button>}>
          {t('adm.queue.history')}
        </SectionLabel>
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">{t('adm.queue.noHistory')}</p>
        ) : (
          <Card padded={false} className="divide-y divide-white/[0.05]">{history.map((j) => <Row key={j.id} j={j} />)}</Card>
        )}
      </div>

      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm === 'all' ? t('adm.queue.cancelAllTitle') : t('adm.queue.clearHistoryTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" icon={busy ? Loader2 : Trash2} disabled={Boolean(busy)} onClick={bulk}>{t('adm.common.confirm')}</Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{confirm === 'all' ? t('adm.queue.cancelAllDesc', { n: active.length }) : t('adm.queue.clearHistoryDesc')}</p>
      </Modal>
    </div>
  );
}
