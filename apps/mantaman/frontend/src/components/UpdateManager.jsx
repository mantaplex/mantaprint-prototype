import React, { useState, useEffect, useRef } from 'react';
import { 
  RefreshCw, 
  Sparkles, 
  CheckCircle2, 
  AlertTriangle, 
  Terminal, 
  Database, 
  RotateCcw, 
  ExternalLink,
  ShieldCheck,
  Server,
  Layers,
  Copy,
  Clock,
  ArrowUpCircle
} from 'lucide-react';
import { Card, PageHeader, StatusPill, Badge, SectionLabel, Modal, Meter } from '../ui/surfaces';
import { Button } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function UpdateManager({ t }) {
  const { showToast } = useToast();
  const [versionInfo, setVersionInfo] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [backups, setBackups] = useState([]);
  const [checking, setChecking] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateState, setUpdateState] = useState('IDLE');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [copiedLog, setCopiedLog] = useState(false);
  const terminalEndRef = useRef(null);
  const updateStateRef = useRef(updateState);

  useEffect(() => {
    updateStateRef.current = updateState;
  }, [updateState]);

  const u = t.updates || {};

  const loadData = async () => {
    try {
      const [verRes, backupsRes] = await Promise.all([
        MantaClient.getSystemVersion().catch(() => null),
        MantaClient.listBackups().catch(() => ({ backups: [] }))
      ]);
      if (verRes) setVersionInfo(verRes);
      if (backupsRes && backupsRes.backups) setBackups(backupsRes.backups);
    } catch (err) {
      console.warn('Failed to load version info:', err);
    }
  };

  // Connect to SSE Update Stream
  const connectUpdateStream = () => {
    const proto = window.location.protocol;
    const host = window.location.host;
    const es = new EventSource(`${proto}//${host}/api/v1/system/updates/stream`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'state') {
          setUpdateState(data.state);
          setUpdateProgress(data.progress);
          setIsUpdating(data.isUpdating);
          if (data.logs && data.logs.length > 0) {
            setTerminalLogs(data.logs);
          }
          if (data.state === 'COMPLETED') {
            loadData();
            showToast('MantaPool updated successfully!', 'success');
          }
        } else if (data.type === 'log') {
          setTerminalLogs(prev => [...prev, data.line]);
        }
      } catch {}
    };

    es.onerror = () => {
      if (updateStateRef.current === 'RESTARTING') {
        setTimeout(() => {
          window.location.reload();
        }, 4000);
      }
    };

    return es;
  };

  useEffect(() => {
    loadData();
    const es = connectUpdateStream();
    return () => {
      if (es) es.close();
    };
  }, []);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollTop = terminalEndRef.current.scrollHeight;
    }
  }, [terminalLogs]);

  const handleCheckForUpdates = async () => {
    setChecking(true);
    try {
      const res = await MantaClient.checkForUpdates();
      if (res.success) {
        setUpdateInfo(res);
        if (res.updateAvailable) {
          showToast(`Update available: ${res.latestRelease?.tag_name}`, 'info');
        } else {
          showToast('MantaPool is already up to date', 'success');
        }
      }
    } catch (err) {
      showToast(`Failed to check GitHub releases: ${err.message}`, 'error');
    } finally {
      setChecking(false);
    }
  };

  const handleStartUpdate = async () => {
    setShowConfirmModal(false);
    setIsUpdating(true);
    setUpdateProgress(5);
    setTerminalLogs(['[Init] Preparing MantaPool Console upgrade pipeline...']);
    const es = connectUpdateStream();

    try {
      await MantaClient.installUpdate();
    } catch (err) {
      showToast(`Update failed to initiate: ${err.message}`, 'error');
      setIsUpdating(false);
      if (es) es.close();
    }
  };

  const handleRollback = async (filename) => {
    if (!window.confirm(u.confirm_rollback || 'Are you sure you want to rollback to this database snapshot?')) {
      return;
    }

    try {
      await MantaClient.rollbackDatabase(filename);
      showToast('Database rollback successful. System reloading...', 'success');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      showToast(`Failed rollback: ${err.message}`, 'error');
    }
  };

  const handleCopyLogs = async () => {
    try {
      await navigator.clipboard.writeText(terminalLogs.join('\n'));
      setCopiedLog(true);
      setTimeout(() => setCopiedLog(false), 2000);
      showToast('Logs copied to clipboard', 'info');
    } catch {}
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={u.title || 'MantaPool System & Updates'}
        description={u.subtitle || 'OTA firmware management, GitHub releases verification, and SQLite database snapshot engine.'}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={RefreshCw}
            loading={checking}
            disabled={isUpdating}
            onClick={handleCheckForUpdates}
          >
            {checking ? (u.btn_checking || 'Checking GitHub...') : (u.btn_check || 'Check for Updates')}
          </Button>
        }
      />

      {/* Top Cards: Version & Status Matrix */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{u.installed_version || 'Installed Version'}</div>
          <div className="text-xl font-bold font-mono text-white mt-1">
            v{versionInfo?.version || '0.2.3'}
          </div>
          <div className="text-[11px] text-manta-400 font-mono mt-0.5">
            {versionInfo?.environment || 'Production (Active)'}
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{u.channel || 'Release Channel'}</div>
          <div className="text-xl font-bold font-mono text-white mt-1">
            {versionInfo?.channel || 'Stable'}
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">
            Auto-Migration Enabled
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{u.db_schema || 'SQLite WAL Schema'}</div>
          <div className="text-xl font-bold font-mono text-white mt-1">
            v{versionInfo?.schemaVersion || 1}
          </div>
          <div className="text-[11px] text-emerald-400 font-mono mt-0.5 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>WAL Synchronized</span>
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{u.total_backups || 'PIT Backups'}</div>
          <div className="text-xl font-bold font-mono text-white mt-1">
            {backups.length} Snapshots
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">
            Auto point-in-time recovery
          </div>
        </Card>
      </div>

      {/* Update Available Banner */}
      {updateInfo?.updateAvailable && (
        <Card className="border-manta-500/40 bg-gradient-to-r from-manta-950/40 via-slate-900/60 to-plum-950/40">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-manta-500/20 border border-manta-500/30 text-manta-400 flex items-center justify-center shrink-0">
                <ArrowUpCircle className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">
                    {u.update_available || 'New System Release Available:'} {updateInfo.latestRelease?.tag_name}
                  </h3>
                  <StatusPill tone="ok">Ready to Apply</StatusPill>
                </div>
                <p className="text-xs text-slate-300 mt-1">
                  Published: {new Date(updateInfo.latestRelease?.published_at).toLocaleDateString()}
                </p>
              </div>
            </div>

            <Button
              variant="primary"
              size="md"
              icon={Sparkles}
              disabled={isUpdating}
              onClick={() => setShowConfirmModal(true)}
            >
              {u.btn_apply_update || 'Apply Update Now'}
            </Button>
          </div>
        </Card>
      )}

      {/* Live Upgrade Progress & Terminal */}
      {(isUpdating || terminalLogs.length > 0) && (
        <Card>
          <div className="flex items-center justify-between pb-3 border-b border-white/[0.07] mb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-manta-400" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                {u.ota_stream || 'Live OTA Installation Conduit'}
              </span>
              <StatusPill tone={updateState === 'COMPLETED' ? 'ok' : updateState === 'FAILED' ? 'danger' : 'warn'}>
                {updateState}
              </StatusPill>
            </div>
            <Button variant="ghost" size="sm" icon={Copy} onClick={handleCopyLogs}>
              {copiedLog ? 'Copied!' : 'Copy Log'}
            </Button>
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
              <span>Progress:</span>
              <span className="text-manta-400 font-bold">{updateProgress}%</span>
            </div>
            <Meter value={updateProgress} tone={updateState === 'FAILED' ? 'danger' : 'ok'} />
          </div>

          <div
            ref={terminalEndRef}
            className="h-64 overflow-y-auto bg-black/80 rounded-xl p-3.5 border border-white/10 font-mono text-xs text-slate-300 space-y-1"
          >
            {terminalLogs.map((line, idx) => (
              <div key={idx} className="leading-relaxed">
                {line}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Database Snapshots & Rollback Table */}
      <Card padded={false} className="overflow-hidden">
        <div className="p-4 border-b border-white/[0.07] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-manta-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              {u.backups_title || 'Point-in-Time Database Snapshots'}
            </h3>
          </div>
          <span className="text-xs text-slate-500 font-mono">{backups.length} archived</span>
        </div>

        {backups.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-xs">
            {u.no_backups || 'No point-in-time database snapshots found. Snapshots are created automatically before upgrades.'}
          </div>
        ) : (
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-white/[0.07] uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Filename</th>
                <th className="py-3 px-4">Size</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {backups.map((b) => (
                <tr key={b.filename} className="hover:bg-white/[0.03] transition-colors">
                  <td className="py-3 px-4 text-white font-medium">{b.filename}</td>
                  <td className="py-3 px-4 text-slate-400">{Math.round((b.size || 0) / 1024)} KB</td>
                  <td className="py-3 px-4 text-slate-400">{new Date(b.created_at).toLocaleString()}</td>
                  <td className="py-3 px-4 text-right">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={RotateCcw}
                      onClick={() => handleRollback(b.filename)}
                    >
                      {u.btn_rollback || 'Rollback'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <Modal
          isOpen={showConfirmModal}
          onClose={() => setShowConfirmModal(false)}
          title="Confirm System Upgrade"
          subtitle="Autonomous backup and schema migration will run automatically."
          footer={
            <div className="flex items-center justify-end gap-2 w-full">
              <Button variant="secondary" size="sm" onClick={() => setShowConfirmModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" icon={Sparkles} onClick={handleStartUpdate}>
                Proceed with Upgrade
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
            <p>
              Upgrading MantaPool Console to release <b className="text-white font-mono">{updateInfo?.latestRelease?.tag_name}</b>.
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-400">
              <li>Automatic SQLite database snapshot backup is performed first.</li>
              <li>Frontend and backend assets will be pulled and hot-reloaded.</li>
              <li>Fleet hub connections will seamlessly reconnect to the console.</li>
            </ul>
          </div>
        </Modal>
      )}
    </div>
  );
}
