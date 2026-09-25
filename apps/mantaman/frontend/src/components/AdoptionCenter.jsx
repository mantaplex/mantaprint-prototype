import React, { useState } from 'react';
import { 
  Radar, 
  CheckCircle2, 
  ShieldCheck, 
  KeyRound, 
  Search, 
  Sparkles, 
  Server,
  Network,
  Radio,
  ArrowRight,
  Shield,
  Wifi,
  Laptop,
  Trash2,
  RefreshCw
} from 'lucide-react';
import { Card, CardHeader, PageHeader, StatusPill, Badge, SectionLabel, Modal } from '../ui/surfaces';
import { Button, Field } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function AdoptionCenter({ hubs = [], sites = [], onRefresh, t }) {
  const { showToast } = useToast();
  const [selectedHub, setSelectedHub] = useState(null);
  const [pin, setPin] = useState('');
  const [customName, setCustomName] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState('site_default');
  const [isAdopting, setIsAdopting] = useState(false);
  const [cidr, setCidr] = useState('192.168.1.0/24');
  const [probeIp, setProbeIp] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [scanMessage, setScanMessage] = useState('');

  const pendingHubs = hubs.filter(h => h && h.status === 'unadopted');

  const openAdoptModal = (hub) => {
    setSelectedHub(hub);
    setCustomName(hub?.name || `MantaPrint Hub (${hub?.ip_address})`);
    setSelectedSiteId(hub?.site_id || (sites[0]?.id || 'site_default'));
    setPin('');
  };

  const handleConfirmAdopt = async () => {
    if (!selectedHub) return;
    setIsAdopting(true);
    const hasPin = Boolean(pin && pin.trim());
    try {
      await MantaClient.adoptHub({
        hubId: selectedHub.id,
        pin: hasPin ? pin.trim() : undefined,
        siteId: selectedSiteId,
        customName: (customName || '').trim(),
        forceAdopt: !hasPin // 1-click frictionless adoption for internal LAN
      });
      showToast(t.adoption?.adopt_success || `Hub '${selectedHub.id}' successfully adopted!`, 'success');
      setSelectedHub(null);
      onRefresh();
    } catch (err) {
      showToast(`Adoption failed: ${err.message}`, 'error');
    } finally {
      setIsAdopting(false);
    }
  };

  const handleProbeSingleNode = async (e) => {
    e.preventDefault();
    if (!probeIp.trim()) return;
    setIsProbing(true);
    try {
      const res = await MantaClient.probeNode(probeIp.trim());
      showToast(res.message || `Discovered hub at ${probeIp}`, 'success');
      setProbeIp('');
      onRefresh();
    } catch (err) {
      showToast(`Probe failed: ${err.message}`, 'error');
    } finally {
      setIsProbing(false);
    }
  };

  const handleSubnetScan = async (e) => {
    e.preventDefault();
    setIsScanning(true);
    setScanMessage(`Scanning subnet range ${cidr}...`);
    try {
      await MantaClient.scanSubnet(cidr);
      setScanMessage(`Subnet sweep initiated for ${cidr}. Active nodes will populate below.`);
      setTimeout(() => {
        onRefresh();
        setIsScanning(false);
      }, 3500);
    } catch (err) {
      setScanMessage(`Scan error: ${err.message}`);
      setIsScanning(false);
    }
  };

  const handleDeleteNode = async (hubId) => {
    if (!window.confirm(`Hapus node pending '${hubId}' secara permanen dari radar?`)) return;
    try {
      await MantaClient.deleteHub(hubId);
      showToast(`Node ${hubId} berhasil dihapus dari radar`, 'info');
      if (typeof onRefresh === 'function') onRefresh();
    } catch (err) {
      showToast(`Gagal menghapus node: ${err.message}`, 'error');
    }
  };

  const handlePurgeStale = async () => {
    try {
      showToast('Membersihkan node offline yang kadaluarsa...', 'info');
      const res = await MantaClient.purgeStaleHubs();
      showToast(`Berhasil membersihkan ${res.deleted || 0} node kadaluarsa.`, 'success');
      if (typeof onRefresh === 'function') onRefresh();
    } catch (err) {
      showToast(`Gagal membersihkan: ${err.message}`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t.adoption?.title || 'Adoption Radar'}
        description={t.adoption?.subtitle || 'Autonomous L2 discovery and cryptographic onboarding of appliance hubs.'}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={Trash2}
              onClick={handlePurgeStale}
              title="Bersihkan node offline yang tidak terhubung lagi"
            >
              Purge Stale Nodes
            </Button>
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              {t.common?.refresh || 'Refresh Radar'}
            </Button>
          </div>
        }
      />

      {/* Discovery Control Center */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1: Direct Probe by IP / Hostname */}
        <Card>
          <CardHeader
            icon={Laptop}
            title="Direct Node Probe"
            description="Add or discover a known hub directly by its LAN IP or Hostname without waiting for sweep."
          />
          <form onSubmit={handleProbeSingleNode} className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={probeIp}
                onChange={(e) => setProbeIp(e.target.value)}
                placeholder="e.g. 192.168.1.114 or heykprint-ssh"
                className="flex-1 px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50 font-mono"
              />
              <Button
                variant="primary"
                size="md"
                loading={isProbing}
                onClick={handleProbeSingleNode}
              >
                Probe & Connect
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Sends an immediate probe beacon to verify MantaPrint Web API and hardware presence.
            </p>
          </form>
        </Card>

        {/* Card 2: Subnet CIDR Range Sweep */}
        <Card>
          <CardHeader
            icon={Network}
            title={t.adoption?.sweep_title || 'Subnet CIDR Range Sweep'}
            description={t.adoption?.sweep_desc || 'Probe local subnet ranges to locate reachable appliance hubs.'}
          />
          <form onSubmit={handleSubnetScan} className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
                placeholder="e.g. 192.168.1.0/24"
                className="flex-1 px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50 font-mono"
              />
              <Button
                variant="secondary"
                size="md"
                loading={isScanning}
                onClick={handleSubnetScan}
              >
                {isScanning ? (t.adoption?.scanning || 'Scanning...') : (t.adoption?.btn_scan || 'Scan Subnet')}
              </Button>
            </div>
            {scanMessage ? (
              <p className="text-[11px] text-manta-400 font-medium">{scanMessage}</p>
            ) : (
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Parallel async discovery scanning ports 80, 8443, and 631 for MantaPrint signatures.
              </p>
            )}
          </form>
        </Card>
      </div>

      {/* Discovered Nodes List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>
            {t.adoption?.pending_title || 'Discovered Nodes Pending Adoption'} ({pendingHubs.length})
          </SectionLabel>
          <span className="text-[11px] text-slate-500">
            Auto-enrollment enabled for trusted LAN
          </span>
        </div>

        {pendingHubs.length === 0 ? (
          <Card className="text-center py-14">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/10 text-slate-500 flex items-center justify-center mx-auto mb-3">
              <Radar className="w-6 h-6 animate-pulse text-manta-400" />
            </div>
            <h4 className="text-sm font-bold text-white">
              {t.adoption?.pending_empty || 'No unmanaged hubs currently waiting for adoption.'}
            </h4>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 leading-relaxed">
              Hubs connected to the same network will broadcast auto-discovery beacons. You can also probe a node directly above.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingHubs.map((hub) => (
              <Card
                key={hub.id}
                className="hover:border-manta-500/30 transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <h4 className="font-bold text-sm text-white">{hub.name || hub.id}</h4>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        {hub.ip_address}
                      </div>
                    </div>
                    <StatusPill tone="warn" pulse>
                      {t.status?.unadopted || 'Pending Adoption'}
                    </StatusPill>
                  </div>

                  <div className="space-y-1.5 p-3 rounded-xl bg-slate-950/40 border border-white/[0.05] text-xs font-mono">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Device ID:</span>
                      <span className="text-slate-300 truncate max-w-[150px]">{hub.id}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>MAC:</span>
                      <span className="text-slate-300">{hub.mac_address || 'Unavailable'}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>SoC / Arch:</span>
                      <span className="text-slate-300">{hub.arch || 'arm64'} ({hub.model || 'MantaPrint STB'})</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleDeleteNode(hub.id)}
                    className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 text-xs"
                    title="Hapus ghost node ini dari radar"
                  >
                    Hapus
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={Sparkles}
                    onClick={() => openAdoptModal(hub)}
                  >
                    {t.adoption?.btn_adopt || 'Adopt Hub'}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Modern Adoption Modal (Optional PIN, 1-Click Support) */}
      {selectedHub && (
        <Modal
          isOpen={Boolean(selectedHub)}
          onClose={() => setSelectedHub(null)}
          title={t.adoption?.modal_title || 'Adopt MantaPrint Hub'}
          subtitle={`Node: ${selectedHub.id} (${selectedHub.ip_address})`}
          footer={
            <div className="flex items-center justify-end gap-2.5 w-full">
              <Button variant="secondary" size="sm" onClick={() => setSelectedHub(null)}>
                {t.common?.cancel || 'Cancel'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={ShieldCheck}
                loading={isAdopting}
                onClick={handleConfirmAdopt}
              >
                {t.adoption?.btn_confirm_adopt || 'Confirm & Adopt'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label={t.adoption?.input_name || 'Friendly Device Name'}>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. 1st Floor Reception Printer"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>

            <Field label={t.adoption?.input_site || 'Assign to Site / Branch'}>
              <select
                value={selectedSiteId}
                onChange={(e) => setSelectedSiteId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white focus:outline-none focus:border-manta-500/50"
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.slug})
                  </option>
                ))}
              </select>
            </Field>

            {/* Optional Challenge PIN */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-white/[0.08] space-y-2">
              <Field
                label={`${t.adoption?.input_pin || 'Challenge PIN'} (Optional)`}
                hint="Jika layar HDMI Hub menampilkan 6-digit PIN tantangan, masukkan di sini. Pada jaringan internal terpercaya, biarkan kosong untuk adopsi langsung 1-klik."
              >
                <input
                  type="text"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="e.g. 849201 (optional)"
                  className="w-full px-3.5 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-manta-500/50 font-mono tracking-widest text-center"
                />
              </Field>
            </div>

            <div className="text-[11px] text-slate-400 bg-manta-500/10 border border-manta-500/20 p-3 rounded-xl flex items-start gap-2.5">
              <Shield className="w-4 h-4 text-manta-400 shrink-0 mt-0.5" />
              <span>
                Adopsi akan menerbitkan token kapabilitas SHA-256 berkode aman yang dikirimkan langsung ke hub untuk enkripsi komunikasi dua arah.
              </span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
