import React, { useCallback, useEffect, useState } from 'react';
import { ListChecks, X, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import { Card, CardHeader, StatusPill } from '../ui/index.js';
import { loadMyJobs, saveMyJobs } from '../shell/api.js';

const DONE = ['completed', 'canceled', 'cancelled', 'error', 'aborted', 'timeout', 'deleted'];

/** Jobs sent from this browser only (tracked with the per-job token the hub returns); hidden until there is one. */
export function MyJobsCard({ refreshKey, queueCount, showToast }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState(() => loadMyJobs());
  const [busy, setBusy] = useState(null);

  const poll = useCallback(async () => {
    const list = loadMyJobs();
    if (!list.length) {
      setJobs((prev) => (prev.length ? [] : prev));
      return;
    }
    const hasActive = list.some((j) => !j.state || !DONE.includes(j.state));
    if (!hasActive) {
      setJobs((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
      return;
    }
    const next = await Promise.all(list.map(async (j) => {
      if (j.state && DONE.includes(j.state)) return j;
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(j.id)}`, { headers: { 'X-Job-Token': j.token || '' } });
        const json = await res.json();
        if (json?.job) return { ...j, state: json.job.state, message: json.job.status_message };
        if (res.status === 404) return { ...j, state: 'completed' };
      } catch {}
      return j;
    }));
    saveMyJobs(next);
    setJobs(next);
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [poll, refreshKey]);

  const cancel = async (job) => {
    setBusy(job.id);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', headers: { 'X-Job-Token': job.token || '' } });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message);
      showToast?.(t('hub.jobs.cancelled'), 'info');
      poll();
    } catch (e) {
      showToast?.(e.message || t('hub.jobs.cancelFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const tone = (s) => (s === 'completed' ? 'ok' : s === 'error' || s === 'aborted' ? 'danger' : s === 'canceled' || s === 'cancelled' ? 'idle' : 'info');

  if (jobs.length === 0) return null;

  return (
    <Card>
      <CardHeader
        icon={ListChecks}
        title={t('hub.jobs.title')}
        description={queueCount > 0 ? t('hub.jobs.queueCount', { n: queueCount }) : t('hub.jobs.queueEmpty')}
      />
      <ul className="mt-3 divide-y divide-white/[0.05]">
        {jobs.slice(0, 5).map((j) => {
          const active = !DONE.includes(j.state || 'processing');
          return (
            <li key={j.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-100 truncate">{j.title}</div>
                <div className="text-[11px] text-slate-500 truncate">{j.printer}</div>
              </div>
              <StatusPill tone={tone(j.state || 'processing')} pulse={active}>{t(`hub.jobState.${j.state || 'processing'}`, j.state)}</StatusPill>
              {active && j.token && (
                <button type="button" onClick={() => cancel(j)} disabled={busy === j.id} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={t('hub.jobs.cancel')} title={t('hub.jobs.cancel')}>
                  {busy === j.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
