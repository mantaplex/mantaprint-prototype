import React, { useState, useEffect } from 'react';
import { 
  Layers, 
  Play, 
  Terminal, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  RotateCcw, 
  RefreshCw,
  Printer,
  Trash2,
  Power,
  ChevronRight
} from 'lucide-react';
import { Card, PageHeader, StatusPill, Badge, SectionLabel, Modal, Meter } from '../ui/surfaces';
import { Button, Field } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function BatchOperations({ sites = [], t }) {
  const { showToast } = useToast();
  const [tasks, setTasks] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [taskType, setTaskType] = useState('test_print');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [concurrency, setConcurrency] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);

  const loadTasks = async () => {
    try {
      const res = await MantaClient.listBatchTasks();
      if (res.tasks) setTasks(res.tasks);
    } catch {}
  };

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleLaunchTask = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast('Task title is required', 'warning');
      return;
    }
    setIsSubmitting(true);
    try {
      await MantaClient.createBatchTask({
        title: title.trim(),
        task_type: taskType,
        target_site_id: targetSiteId || null,
        concurrency: Number(concurrency)
      });
      showToast('Batch task queued successfully', 'success');
      setShowModal(false);
      setTitle('');
      loadTasks();
    } catch (err) {
      showToast(`Error queueing batch task: ${err.message}`, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t.batch?.title || 'Batch Operations & Rolling Rollouts'}
        description={t.batch?.subtitle || 'Execute mass diagnostics, service restarts, and configuration sweeps across multiple locations.'}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={Play}
            onClick={() => {
              setTitle(`Fleet Diagnostic Test Print - ${new Date().toLocaleDateString()}`);
              setShowModal(true);
            }}
          >
            {t.batch?.btn_new_task || 'Launch Batch Task'}
          </Button>
        }
      />

      {/* Task Queue / History Card */}
      <Card padded={false} className="overflow-hidden">
        <div className="p-4 border-b border-white/[0.07] flex items-center justify-between">
          <div className="text-xs font-bold text-white uppercase tracking-wider">
            {t.batch?.history_title || 'Execution History & Live Queues'} ({tasks.length})
          </div>
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={loadTasks}>
            {t.common?.refresh || 'Refresh'}
          </Button>
        </div>

        {tasks.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-xs">
            No batch operations executed yet. Click &quot;Launch Batch Task&quot; above to run diagnostics across your fleet.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {tasks.map((task) => {
              const isFinished = task.status === 'completed' || task.status === 'failed';
              const progressPct = task.total_nodes > 0 
                ? Math.round(((task.successful_nodes + task.failed_nodes) / task.total_nodes) * 100) 
                : 0;

              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className="p-4 hover:bg-white/[0.03] transition-colors cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-xs sm:text-sm text-white">{task.title}</span>
                      <StatusPill
                        tone={task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'danger' : 'warn'}
                        pulse={!isFinished}
                      >
                        {task.status.toUpperCase()}
                      </StatusPill>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono mt-1 flex-wrap">
                      <span>Type: <code className="text-slate-300">{task.task_type}</code></span>
                      <span>•</span>
                      <span>
                        Target: <span className="text-slate-300">{task.target_site_id ? `Site ${task.target_site_id}` : 'Entire Fleet'}</span>
                      </span>
                      <span>•</span>
                      <span>
                        Nodes: <span className="text-manta-300 font-bold">{task.successful_nodes}</span>/{task.total_nodes} done
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="mt-2 max-w-md">
                      <Meter value={progressPct} tone={task.status === 'failed' ? 'danger' : 'ok'} />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="secondary" size="sm" icon={Terminal}>
                      View Logs
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Launch New Batch Task Modal */}
      {showModal && (
        <Modal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          title={t.batch?.btn_new_task || 'Launch Batch Task'}
          subtitle="Configure rollout parameters and select target sites"
          footer={
            <div className="flex items-center justify-end gap-2.5 w-full">
              <Button variant="secondary" size="sm" onClick={() => setShowModal(false)}>
                {t.common?.cancel || 'Cancel'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Play}
                loading={isSubmitting}
                onClick={handleLaunchTask}
              >
                {t.batch?.btn_execute || 'Execute Rollout'}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleLaunchTask} className="space-y-3.5">
            <Field label="Task Name">
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Nightly Fleet Diagnostics"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>

            <Field label={t.batch?.task_type || 'Operation Type'}>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white focus:outline-none focus:border-manta-500/50"
              >
                <option value="test_print">{t.batch?.task_type_test || 'Fleet Diagnostic Test Print'}</option>
                <option value="restart_cups">{t.batch?.task_type_restart || 'Staggered CUPS Daemon Restart'}</option>
                <option value="clear_queue">{t.batch?.task_type_clear || 'Emergency Spool Queue Purge'}</option>
                <option value="reboot">Rolling Appliance Reboot</option>
              </select>
            </Field>

            <Field label="Target Scope">
              <select
                value={targetSiteId}
                onChange={(e) => setTargetSiteId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white focus:outline-none focus:border-manta-500/50"
              >
                <option value="">All Managed Hubs (Entire Fleet)</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    Branch: {s.name} ({s.slug})
                  </option>
                ))}
              </select>
            </Field>

            <Field 
              label={t.batch?.concurrency || 'Concurrency Limit (Nodes per stage)'}
              hint="Controls how many hubs receive commands concurrently to protect local network bandwidth."
            >
              <input
                type="number"
                min={1}
                max={50}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white focus:outline-none focus:border-manta-500/50 font-mono"
              />
            </Field>
          </form>
        </Modal>
      )}

      {/* Task Execution Logs Modal */}
      {selectedTask && (
        <Modal
          isOpen={Boolean(selectedTask)}
          onClose={() => setSelectedTask(null)}
          title={`Batch Task: ${selectedTask.title}`}
          subtitle={`ID: ${selectedTask.id} • Status: ${selectedTask.status.toUpperCase()}`}
          maxWidth="max-w-2xl"
          footer={
            <Button variant="secondary" size="sm" onClick={() => setSelectedTask(null)}>
              {t.common?.close || 'Close'}
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs bg-slate-950 p-3 rounded-xl border border-white/10">
              <span className="text-slate-400">Total Nodes: <b className="text-white font-mono">{selectedTask.total_nodes}</b></span>
              <span className="text-slate-400">Succeeded: <b className="text-manta-400 font-mono">{selectedTask.successful_nodes}</b></span>
              <span className="text-slate-400">Failed: <b className="text-rose-400 font-mono">{selectedTask.failed_nodes}</b></span>
            </div>

            <div className="bg-black/80 rounded-xl p-3.5 border border-white/10 font-mono text-xs max-h-72 overflow-y-auto space-y-1">
              <div className="text-slate-500 text-[10px] pb-1 border-b border-white/10">--- EXECUTION LOG STREAM ---</div>
              {selectedTask.logs && selectedTask.logs.length > 0 ? (
                selectedTask.logs.map((log, idx) => (
                  <div key={idx} className="text-slate-300">
                    <span className="text-slate-600">[{new Date(log.time || Date.now()).toLocaleTimeString()}]</span>{' '}
                    <span className="text-manta-400 font-bold">{log.hub_id}:</span>{' '}
                    <span className={log.success ? 'text-emerald-400' : 'text-rose-400'}>
                      {log.message || (log.success ? 'OK' : 'Error')}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-600 italic">No detailed log entries recorded.</div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
