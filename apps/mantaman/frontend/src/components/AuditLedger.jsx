import React, { useState, useEffect } from 'react';
import { 
  FileCheck2, 
  ShieldCheck, 
  Hash, 
  RefreshCw,
  Search,
  Download
} from 'lucide-react';
import { Card, PageHeader, StatusPill, Badge } from '../ui/surfaces';
import { Button } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function AuditLedger({ t }) {
  const { showToast } = useToast();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const loadLogs = async () => {
    setLoading(true);
    try {
      const res = await MantaClient.listAuditLogs();
      if (res.logs) setLogs(res.logs);
    } catch (err) {
      showToast(`Failed loading audit ledger: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  const filteredLogs = logs.filter(l => 
    (l.actor && l.actor.toLowerCase().includes(filter.toLowerCase())) ||
    (l.action && l.action.toLowerCase().includes(filter.toLowerCase())) ||
    (l.target_id && String(l.target_id).toLowerCase().includes(filter.toLowerCase()))
  );

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mantapool-audit-ledger-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t.audit?.title || 'Audit Ledger'}
        description={t.audit?.subtitle || 'Cryptographically verifiable, hash-chained ledger of all administrative fleet actions.'}
        badge={
          <StatusPill tone="ok" className="font-mono">
            <ShieldCheck className="w-3 h-3 text-manta-400" />
            <span>{t.audit?.verified || 'SHA-256 Chained'}</span>
          </StatusPill>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon={Download} onClick={exportJson}>
              Export JSON
            </Button>
            <Button variant="secondary" size="sm" icon={RefreshCw} loading={loading} onClick={loadLogs}>
              {t.common?.refresh || 'Refresh'}
            </Button>
          </div>
        }
      />

      {/* Filter Card */}
      <Card padded={false} className="p-3">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by actor, action, or target ID..."
            className="w-full pl-9 pr-4 py-2 bg-slate-950/70 border border-white/10 rounded-xl text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
          />
        </div>
      </Card>

      {/* Ledger Table */}
      <Card padded={false} className="overflow-hidden">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-slate-950/80 text-slate-400 border-b border-white/[0.07] uppercase text-[10px] tracking-wider">
            <tr>
              <th className="py-3 px-4">{t.audit?.col_timestamp || 'Timestamp'}</th>
              <th className="py-3 px-4">{t.audit?.col_actor || 'Actor'}</th>
              <th className="py-3 px-4">{t.audit?.col_action || 'Action'}</th>
              <th className="py-3 px-4">{t.audit?.col_target || 'Target'}</th>
              <th className="py-3 px-4">{t.audit?.col_hash || 'Record Hash (SHA-256)'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-500 text-xs">
                  No audit logs recorded yet.
                </td>
              </tr>
            ) : (
              filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-white/[0.03] transition-colors">
                  <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-manta-400 font-bold">{log.actor}</td>
                  <td className="py-3 px-4 text-white font-semibold">{log.action}</td>
                  <td className="py-3 px-4 text-slate-300 truncate max-w-[140px]">{log.target_id}</td>
                  <td className="py-3 px-4 text-slate-500 truncate max-w-[200px]" title={log.record_hash}>
                    <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px] text-slate-400 border border-white/[0.06]">
                      {log.record_hash ? log.record_hash.slice(0, 16) + '...' : '-'}
                    </code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
