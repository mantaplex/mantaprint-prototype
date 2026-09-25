import React, { useState, useEffect } from 'react';
import { 
  Printer, 
  Cpu, 
  HardDrive, 
  Clock, 
  Play, 
  RotateCcw, 
  Trash2, 
  Power, 
  ExternalLink,
  Building2,
  Network,
  Save,
  CheckCircle2,
  AlertTriangle,
  Radio,
  Scan,
  Settings,
  Server
} from 'lucide-react';
import { Modal, StatusPill, Card, SectionLabel, Meter, Badge } from '../ui/surfaces';
import { Button, Field } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function HubDetailModal({ hub, sites = [], isOpen, onClose, onRefresh, t }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  useEffect(() => {
    if (hub) {
      setName(hub.name || '');
      setSiteId(hub.site_id || 'site_default');
    }
  }, [hub]);

  if (!hub) return null;

  const isOnline = hub.is_online;
  const tonerK = hub.toner_cmyk?.k ?? 90;
  const currentSite = sites.find(s => s.id === hub.site_id);

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await MantaClient.updateHub(hub.id, {
        name: name.trim(),
        site_id: siteId
      });
      showToast(t.common?.save_success || 'Hub settings updated successfully', 'success');
      onRefresh();
    } catch (err) {
      showToast(`Failed to update Hub: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCommand = async (cmd, label) => {
    setActionLoading(prev => ({ ...prev, [cmd]: true }));
    try {
      await MantaClient.sendCommand(hub.id, cmd);
      showToast(`${label} executed successfully on ${hub.name}`, 'success');
      onRefresh();
    } catch (err) {
      showToast(`Error executing ${label}: ${err.message}`, 'error');
    } finally {
      setActionLoading(prev => ({ ...prev, [cmd]: false }));
    }
  };

  const handleOpenAdminSso = async () => {
    setActionLoading(prev => ({ ...prev, sso: true }));
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
      setActionLoading(prev => ({ ...prev, sso: false }));
    }
  };

  const handleUnadopt = async () => {
    if (!window.confirm(t.common?.confirm || `Are you sure you want to release ${hub.name} from fleet management?`)) return;
    try {
      await MantaClient.unadoptHub(hub.id);
      showToast(`Hub ${hub.name} unadopted`, 'info');
      onClose();
      onRefresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={hub.name || 'Hub Details'}
      subtitle={`Device ID: ${hub.id} • IP: ${hub.ip_address}`}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center justify-between w-full">
          <button
            type="button"
            onClick={handleUnadopt}
            className="text-xs text-rose-400 hover:text-rose-300 font-semibold px-2 py-1 rounded transition-colors"
          >
            {t.fleet?.btn_unadopt || 'Unadopt Node'}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t.common?.cancel || 'Close'}
            </Button>
            <Button variant="primary" size="sm" icon={Save} loading={isSaving} onClick={handleSave}>
              {t.common?.save || 'Save Changes'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Top Status & Portals Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-950/60 border border-white/[0.07]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-manta-500/10 border border-manta-500/20 text-manta-400 flex items-center justify-center shrink-0">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{hub.model || 'MantaPrint Hub'}</span>
                <StatusPill tone={isOnline ? 'ok' : 'idle'} pulse={isOnline}>
                  {isOnline ? (t.status?.healthy || 'Online') : (t.status?.offline || 'Offline')}
                </StatusPill>
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                Arch: {hub.arch || 'arm64'} • Version: {hub.version || 'v0.2.1'}
              </div>
            </div>
          </div>

          {/* Quick Direct Links to Edge Portals */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              variant="primary"
              size="sm"
              icon={ExternalLink}
              loading={actionLoading.sso}
              onClick={handleOpenAdminSso}
              title="Buka Dashboard Admin Hub langsung tanpa relogin"
            >
              Buka Admin (SSO)
            </Button>
            <a
              href={`http://${hub.ip_address}:80/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] font-semibold text-slate-200 border border-white/10 transition-colors"
              title="Open Web Dashboard"
            >
              <span>Web UI</span>
            </a>
            <a
              href={`http://${hub.ip_address}:80/scan`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] font-semibold text-slate-200 border border-white/10 transition-colors"
              title="Open Scanner Studio"
            >
              <Scan className="w-3 h-3 text-cyan-400" />
              <span>Scanner</span>
            </a>
            <a
              href={`http://${hub.ip_address}:631/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] font-semibold text-slate-200 border border-white/10 transition-colors"
              title="Open CUPS Administration"
            >
              <Printer className="w-3 h-3 text-indigo-400" />
              <span>CUPS</span>
            </a>
          </div>
        </div>

        {/* Printer & Hardware Telemetry Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {/* Printer Box */}
          <div className="p-3.5 rounded-xl bg-slate-950/40 border border-white/[0.07] space-y-2.5">
            <SectionLabel>{t.fleet?.printer || 'Attached Printer'}</SectionLabel>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Model:</span>
              <span className="font-semibold text-slate-200 truncate max-w-[170px]">
                {hub.printer_name || 'Generic Printer / Not Detected'}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Queue State:</span>
              <span className="font-mono text-xs uppercase text-manta-400 font-semibold">
                {hub.cups_state || 'idle'}
              </span>
            </div>
            <div className="pt-1">
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-slate-400">{t.fleet?.toner_level || 'Toner / Ink Level'}</span>
                <span className="font-mono font-bold text-manta-300">{tonerK}%</span>
              </div>
              <Meter value={tonerK} tone={tonerK > 20 ? 'ok' : 'danger'} />
            </div>
          </div>

          {/* Hardware SoC Box */}
          <div className="p-3.5 rounded-xl bg-slate-950/40 border border-white/[0.07] space-y-2.5">
            <SectionLabel>Hardware Telemetry</SectionLabel>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-amber-400" />
                <span>SoC Temp</span>
              </span>
              <span className="font-mono text-amber-300 font-semibold">{hub.cpu_temp || 45}°C</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-indigo-400" />
                <span>RAM Usage</span>
              </span>
              <span className="font-mono text-slate-300">
                {hub.ram_used_mb || 240}MB / {hub.ram_total_mb || 1918}MB
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                <span>Uptime</span>
              </span>
              <span className="font-mono text-slate-300">{hub.uptime || '0m'}</span>
            </div>
          </div>
        </div>

        {/* Hardware Action Buttons */}
        <div>
          <SectionLabel>{t.fleet?.actions_title || 'Direct Appliance Commands'}</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={Play}
              loading={actionLoading['test_print']}
              onClick={() => handleCommand('test_print', t.fleet?.btn_test_print || 'Test Print')}
            >
              {t.fleet?.btn_test_print || 'Test Print'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              loading={actionLoading['restart_cups']}
              onClick={() => handleCommand('restart_cups', t.fleet?.btn_restart_cups || 'Restart CUPS')}
            >
              {t.fleet?.btn_restart_cups || 'Restart CUPS'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Trash2}
              loading={actionLoading['clear_queue']}
              onClick={() => handleCommand('clear_queue', t.fleet?.btn_clear_queue || 'Clear Queue')}
            >
              {t.fleet?.btn_clear_queue || 'Clear Queue'}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={Power}
              loading={actionLoading['reboot']}
              onClick={() => {
                if (window.confirm(`Reboot appliance hub ${hub.name}? Printing will be temporarily interrupted.`)) {
                  handleCommand('reboot', t.fleet?.btn_reboot || 'Reboot Hub');
                }
              }}
            >
              {t.fleet?.btn_reboot || 'Reboot Hub'}
            </Button>
          </div>
        </div>

        {/* Configuration & Site Assignment */}
        <div className="p-4 rounded-xl bg-slate-950/50 border border-white/[0.07] space-y-3.5">
          <SectionLabel>Device Configuration</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t.adoption?.input_name || 'Friendly Device Name'}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Front Office Printer Hub"
                className="w-full px-3 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>

            <Field label={t.adoption?.input_site || 'Site / Branch Location'}>
              <select
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white focus:outline-none focus:border-manta-500/50"
              >
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.slug})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
            <span>MAC Address: <code className="font-mono text-slate-300">{hub.mac_address || 'Unavailable'}</code></span>
            <span>Last Seen: <span className="font-mono text-slate-300">{hub.last_seen_at ? new Date(hub.last_seen_at).toLocaleTimeString() : 'Never'}</span></span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
