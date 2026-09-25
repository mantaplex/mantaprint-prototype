import React, { useState } from 'react';
import { 
  Printer, 
  Cpu, 
  HardDrive, 
  Clock, 
  Play, 
  RotateCcw, 
  Trash2, 
  Power, 
  Search, 
  Flame, 
  LayoutGrid, 
  List, 
  Server,
  Building2,
  ExternalLink,
  ChevronRight,
  Filter,
  Radar,
  ShieldCheck
} from 'lucide-react';
import { Card, PageHeader, StatusPill, Meter, Badge, SectionLabel } from '../ui/surfaces';
import { Button, Segmented } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';
import { HubDetailModal } from './HubDetailModal';

export function FleetOverview({ hubs = [], sites = [], onRefresh, onNavigateTab, t }) {
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // all, online, offline
  const [selectedSiteId, setSelectedSiteId] = useState('all');
  const [viewMode, setViewMode] = useState('grid'); // grid, table
  const [actionLoading, setActionLoading] = useState({});
  const [inspectedHub, setInspectedHub] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);

  // Strictly filter only managed hubs on the homepage
  const managedHubs = hubs.filter(h => h && h.status === 'managed');

  const filteredHubs = managedHubs.filter(hub => {
    const matchesSearch = 
      (hub.name && hub.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (hub.id && hub.id.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (hub.ip_address && hub.ip_address.includes(searchTerm));

    if (!matchesSearch) return false;
    if (filterMode === 'online' && !hub.is_online) return false;
    if (filterMode === 'offline' && hub.is_online) return false;
    if (selectedSiteId !== 'all' && hub.site_id !== selectedSiteId) return false;
    return true;
  });

  const onlineCount = managedHubs.filter(h => h && h.is_online).length;
  const printingCount = managedHubs.filter(h => h && h.cups_state === 'printing').length;
  const avgTemp = managedHubs.length > 0 
    ? Math.round((managedHubs.reduce((acc, h) => acc + ((h && h.cpu_temp) || 45), 0) / managedHubs.length) * 10) / 10 
    : 0;

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      showToast('Memindai dan menyinkronkan status live semua hub...', 'info');
      const res = await MantaClient.syncAllHubs();
      showToast(`Sinkronisasi selesai: ${res.synced}/${res.total} hub aktif diperbarui.`, 'success');
      if (typeof onRefresh === 'function') onRefresh();
    } catch (err) {
      showToast(`Gagal sinkronisasi: ${err.message}`, 'error');
    } finally {
      setSyncingAll(false);
    }
  };

  const handleOpenAdminSso = async (e, hub) => {
    e.stopPropagation();
    setActionLoading(prev => ({ ...prev, [`${hub.id}_sso`]: true }));
    try {
      showToast(`Menyiapkan sesi SSO untuk ${hub.name}...`, 'info');
      const res = await MantaClient.getHubSso(hub.id);
      if (res && res.url) {
        window.open(res.url, '_blank', 'noopener,noreferrer');
        showToast(`Membuka Dashboard Admin ${hub.name} (SSO Aktif)`, 'success');
      } else {
        window.open(`http://${hub.ip_address}/admin`, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      showToast(`Gagal SSO: ${err.message}. Membuka admin standar...`, 'warning');
      window.open(`http://${hub.ip_address}/admin`, '_blank', 'noopener,noreferrer');
    } finally {
      setActionLoading(prev => ({ ...prev, [`${hub.id}_sso`]: false }));
    }
  };

  const handleCommand = async (e, hubId, cmd, label) => {
    e.stopPropagation();
    setActionLoading(prev => ({ ...prev, [`${hubId}_${cmd}`]: true }));
    try {
      await MantaClient.sendCommand(hubId, cmd);
      showToast(`${label} triggered successfully on ${hubId}`, 'success');
      if (typeof onRefresh === 'function') onRefresh();
    } catch (err) {
      showToast(`Error triggering ${label}: ${err.message}`, 'error');
    } finally {
      setActionLoading(prev => ({ ...prev, [`${hubId}_${cmd}`]: false }));
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t.fleet?.title || 'Fleet Matrix'}
        description={t.fleet?.subtitle || 'Real-time telemetry, state monitoring, and hardware orchestration across all appliance hubs.'}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              loading={syncingAll}
              onClick={handleSyncAll}
            >
              Sync & Probe Fleets
            </Button>
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              {t.common?.refresh || 'Refresh'}
            </Button>
          </div>
        }
      />

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Armada Terkelola</div>
          <div className="mt-1 text-2xl font-extrabold text-white font-mono">{managedHubs.length}</div>
          <div className="mt-1 text-xs text-slate-400 font-sans">
            <span className="text-manta-400 font-bold">{onlineCount}</span> online • <span className="text-slate-500 font-bold">{managedHubs.length - onlineCount}</span> offline
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{t.fleet?.online_nodes || 'Online Hubs'}</div>
          <div className="mt-1 text-2xl font-extrabold text-manta-400 font-mono flex items-center gap-2">
            <span>{onlineCount}</span>
            <span className="text-xs font-normal text-slate-400 font-sans">/ {managedHubs.length} active</span>
          </div>
          <div className="mt-1">
            <Meter value={managedHubs.length > 0 ? (onlineCount / managedHubs.length) * 100 : 0} tone="ok" />
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{t.fleet?.active_jobs || 'Active Jobs'}</div>
          <div className="mt-1 text-2xl font-extrabold text-cyan-300 font-mono">
            {printingCount}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {printingCount > 0 ? 'Print engines engaged' : 'Semua antrian cetak idle'}
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{t.fleet?.avg_temp || 'Avg SoC Temp'}</div>
          <div className="mt-1 text-2xl font-extrabold text-amber-400 font-mono flex items-center gap-1.5">
            <Flame className="w-5 h-5 text-amber-500" />
            <span>{avgTemp}°C</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Nominal thermal range (<span className="text-slate-300">65°C max</span>)
          </div>
        </Card>
      </div>

      {/* Control Bar: Search, Branch Filter & View Toggle */}
      <Card padded={false} className="p-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={t.fleet?.search_placeholder || 'Filter by hostname, IP address, or site...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Site / Branch Filter */}
            {sites.length > 0 && (
              <div className="flex items-center gap-1.5 bg-slate-950/70 border border-white/10 rounded-xl px-2.5 py-1">
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
                <select
                  value={selectedSiteId}
                  onChange={(e) => setSelectedSiteId(e.target.value)}
                  className="bg-transparent text-xs text-slate-300 focus:outline-none cursor-pointer"
                >
                  <option value="all" className="bg-slate-900 text-white">All Sites</option>
                  {sites.map(s => (
                    <option key={s.id} value={s.id} className="bg-slate-900 text-white">
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Status Filter Segmented */}
            <Segmented
              size="sm"
              value={filterMode}
              onChange={setFilterMode}
              options={[
                { value: 'all', label: t.fleet?.filter_all || 'Semua' },
                { value: 'online', label: t.fleet?.filter_online || 'Online' },
                { value: 'offline', label: 'Offline' }
              ]}
            />

            {/* Grid / Table Toggle */}
            <div className="hidden sm:flex items-center bg-black/40 border border-white/10 rounded-xl p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-manta-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                title="Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`p-1.5 rounded-lg transition-colors ${viewMode === 'table' ? 'bg-manta-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                title="Table View"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* Hubs Content */}
      {filteredHubs.length === 0 ? (
        <Card className="text-center py-16">
          <Server className="w-12 h-12 mx-auto text-slate-600 mb-3" />
          <h3 className="text-base font-bold text-white">Belum Ada Fleet Hub Teradopsi</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-4 leading-relaxed">
            Hub yang terdeteksi di jaringan lokal belum diadopsi ke dalam armada MantaPool. Silakan buka menu Radar Adopsi untuk menghubungkan hub.
          </p>
          {onNavigateTab && (
            <Button
              variant="primary"
              size="sm"
              icon={Radar}
              onClick={() => onNavigateTab('adoption')}
            >
              Buka Radar Adopsi
            </Button>
          )}
        </Card>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredHubs.map((hub) => {
            const isOnline = hub.is_online;
            const tonerK = hub.toner_cmyk?.k ?? 90;
            const site = sites.find(s => s.id === hub.site_id);

            return (
              <Card
                key={hub.id}
                onClick={() => setInspectedHub(hub)}
                className="cursor-pointer hover:border-manta-500/40 hover:bg-slate-900/90 transition-all flex flex-col justify-between group"
              >
                <div>
                  {/* Card Header: Device Name & Status */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-bold text-sm text-white group-hover:text-manta-300 transition-colors truncate">
                          {hub.name || 'Unnamed Hub'}
                        </h4>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono mt-0.5">
                        <span>{hub.ip_address}</span>
                        <span>•</span>
                        <span className="text-slate-500">{site ? site.name : 'Default Site'}</span>
                      </div>
                    </div>

                    <StatusPill tone={isOnline ? 'ok' : 'idle'} pulse={isOnline}>
                      {isOnline ? (t.status?.healthy || 'Online') : (t.status?.offline || 'Offline')}
                    </StatusPill>
                  </div>

                  {/* Printer & Hardware Specs */}
                  <div className="space-y-2 p-3 rounded-xl bg-slate-950/40 border border-white/[0.05] text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Printer className="w-3.5 h-3.5 text-manta-400" />
                        <span>Printer:</span>
                      </span>
                      <span className="font-semibold text-slate-200 truncate max-w-[140px]">
                        {hub.printer_name || 'Generic / Ready'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Cpu className="w-3.5 h-3.5 text-amber-400" />
                        <span>Thermal / RAM:</span>
                      </span>
                      <span className="font-mono text-slate-300">
                        {hub.cpu_temp || 45}°C • {hub.ram_used_mb || 240}MB
                      </span>
                    </div>

                    {/* Supply Bar */}
                    <div className="pt-1">
                      <div className="flex items-center justify-between text-[10px] mb-1">
                        <span className="text-slate-400">Toner Supply</span>
                        <span className="font-mono font-bold text-manta-300">{tonerK}%</span>
                      </div>
                      <Meter value={tonerK} tone={tonerK > 20 ? 'ok' : 'danger'} />
                    </div>
                  </div>
                </div>

                {/* Card Actions Footer */}
                <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={ExternalLink}
                      loading={actionLoading[`${hub.id}_sso`]}
                      onClick={(e) => handleOpenAdminSso(e, hub)}
                      title="Buka Dashboard Admin Hub langsung tanpa relogin (SSO)"
                    >
                      Admin SSO
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={Play}
                      loading={actionLoading[`${hub.id}_test_print`]}
                      onClick={(e) => handleCommand(e, hub.id, 'test_print', 'Test Print')}
                    >
                      {t.fleet?.btn_test_print || 'Test'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={RotateCcw}
                      loading={actionLoading[`${hub.id}_restart_cups`]}
                      onClick={(e) => handleCommand(e, hub.id, 'restart_cups', 'Restart CUPS')}
                    >
                      CUPS
                    </Button>
                  </div>

                  <span className="text-[11px] text-manta-400 font-semibold group-hover:underline flex items-center gap-0.5">
                    <span>Detail</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-white/[0.07] font-mono uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Device</th>
                <th className="py-3 px-4">IP Address</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Printer</th>
                <th className="py-3 px-4">SoC Temp</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] font-mono">
              {filteredHubs.map((hub) => (
                <tr
                  key={hub.id}
                  onClick={() => setInspectedHub(hub)}
                  className="hover:bg-white/[0.04] transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4 font-sans font-bold text-white">{hub.name}</td>
                  <td className="py-3 px-4 text-slate-300">{hub.ip_address}</td>
                  <td className="py-3 px-4">
                    <StatusPill tone={hub.is_online ? 'ok' : 'idle'} pulse={hub.is_online}>
                      {hub.is_online ? (t.status?.healthy || 'Online') : (t.status?.offline || 'Offline')}
                    </StatusPill>
                  </td>
                  <td className="py-3 px-4 text-slate-300 font-sans">{hub.printer_name || '-'}</td>
                  <td className="py-3 px-4 text-amber-300">{hub.cpu_temp || 45}°C</td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="primary"
                        size="sm"
                        icon={ExternalLink}
                        loading={actionLoading[`${hub.id}_sso`]}
                        onClick={(e) => handleOpenAdminSso(e, hub)}
                      >
                        Admin SSO
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInspectedHub(hub);
                        }}
                      >
                        Detail
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Hub Detail & Control Modal */}
      {inspectedHub && (
        <HubDetailModal
          hub={inspectedHub}
          sites={sites}
          isOpen={Boolean(inspectedHub)}
          onClose={() => setInspectedHub(null)}
          onRefresh={onRefresh}
          t={t}
        />
      )}
    </div>
  );
}
