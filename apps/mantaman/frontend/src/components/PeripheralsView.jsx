import React, { useState, useEffect } from 'react';
import { 
  Printer, 
  Scan, 
  MapPin, 
  Tag, 
  Share2, 
  Play, 
  RotateCcw, 
  ExternalLink, 
  Settings2, 
  Search, 
  Building2, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw,
  Server,
  Layers,
  Sliders,
  Save,
  Radio
} from 'lucide-react';
import { Card, CardHeader, PageHeader, StatusPill, Badge, SectionLabel, Modal, Meter } from '../ui/surfaces';
import { Button, Field, Segmented } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function PeripheralsView({ hubs = [], sites = [], onRefresh, t }) {
  const { showToast } = useToast();
  const [peripheralsData, setPeripheralsData] = useState({ printers: [], scanners: [] });
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState('all');
  const [filterType, setFilterType] = useState('all'); // 'all', 'printers', 'scanners'
  const [editingPrinter, setEditingPrinter] = useState(null);
  const [printerForm, setPrinterForm] = useState({ info: '', location: '', shared: true });
  const [savingConfig, setSavingConfig] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  const fetchPeripherals = async () => {
    setLoading(true);
    try {
      const data = await MantaClient.listPeripherals();
      setPeripheralsData(data || { printers: [], scanners: [] });
    } catch (err) {
      showToast(`Gagal memuat periferal: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPeripherals();
  }, [hubs]);

  const handleOpenEditModal = (printer) => {
    setEditingPrinter(printer);
    setPrinterForm({
      display_name: printer.display_name || printer.info || printer.queue_name || printer.name || '',
      location: printer.location || '',
      custom_broadcast_name: printer.custom_broadcast_name || '',
      publish_broadcast: printer.is_published !== false,
      is_default: Boolean(printer.is_default)
    });
  };

  const handleSavePrinterConfig = async (e) => {
    e.preventDefault();
    if (!editingPrinter) return;
    setSavingConfig(true);
    const qName = editingPrinter.queue_name || editingPrinter.name;
    try {
      await MantaClient.updatePrinter({
        hub_id: editingPrinter.hub_id,
        queue_name: qName,
        display_name: (printerForm.display_name || '').trim(),
        location: (printerForm.location || '').trim(),
        custom_broadcast_name: (printerForm.custom_broadcast_name || '').trim(),
        publish_broadcast: printerForm.publish_broadcast,
        is_default: printerForm.is_default
      });
      showToast(`Konfigurasi printer '${qName}' berhasil disimpan!`, 'success');
      setEditingPrinter(null);
      fetchPeripherals();
      if (typeof onRefresh === 'function') onRefresh();
    } catch (err) {
      showToast(`Gagal menyimpan konfigurasi: ${err.message}`, 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleTestPrint = async (printer) => {
    const qName = printer.queue_name || printer.name;
    const key = `test_${printer.hub_id}_${qName}`;
    setActionLoading(prev => ({ ...prev, [key]: true }));
    try {
      await MantaClient.testPrintPrinter(printer.hub_id, qName);
      showToast(`Test page dikirim ke printer '${qName}' di hub ${printer.hub_name}!`, 'success');
    } catch (err) {
      showToast(`Gagal cetak test page: ${err.message}`, 'error');
    } finally {
      setActionLoading(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleClearQueue = async (printer) => {
    const qName = printer.queue_name || printer.name;
    if (!window.confirm(`Bersihkan semua antrian spool pada printer '${qName}'?`)) return;
    const key = `clear_${printer.hub_id}_${qName}`;
    setActionLoading(prev => ({ ...prev, [key]: true }));
    try {
      await MantaClient.clearPrinterQueue(printer.hub_id, qName);
      showToast(`Antrian printer '${qName}' berhasil dibersihkan!`, 'info');
      fetchPeripherals();
    } catch (err) {
      showToast(`Gagal membersihkan antrian: ${err.message}`, 'error');
    } finally {
      setActionLoading(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleOpenHubAdminSso = async (hubId, hubName, hubIp) => {
    const key = `sso_${hubId}`;
    setActionLoading(prev => ({ ...prev, [key]: true }));
    try {
      showToast(`Menyiapkan sesi SSO untuk ${hubName || hubId}...`, 'info');
      const res = await MantaClient.getHubSso(hubId);
      if (res && res.url) {
        window.open(res.url, '_blank', 'noopener,noreferrer');
        showToast(`Membuka Dashboard Admin ${hubName || hubId} (SSO Aktif)`, 'success');
      } else {
        window.open(`http://${hubIp}/admin`, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      showToast(`Gagal SSO: ${err.message}. Membuka admin standar...`, 'warning');
      window.open(`http://${hubIp}/admin`, '_blank', 'noopener,noreferrer');
    } finally {
      setActionLoading(prev => ({ ...prev, [key]: false }));
    }
  };

  // Filter printers
  const filteredPrinters = (peripheralsData.printers || []).filter(p => {
    const matchesSearch = 
      (p.name && p.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.info && p.info.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.make_and_model && p.make_and_model.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.location && p.location.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.hub_name && p.hub_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.hub_ip && p.hub_ip.includes(searchTerm));

    if (!matchesSearch) return false;
    if (selectedSiteId !== 'all') {
      const hub = hubs.find(h => h.id === p.hub_id);
      if (hub && hub.site_id !== selectedSiteId) return false;
    }
    return true;
  });

  // Filter scanners
  const filteredScanners = (peripheralsData.scanners || []).filter(s => {
    const matchesSearch = 
      (s.name && s.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.model && s.model.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.vendor && s.vendor.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.hub_name && s.hub_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.hub_ip && s.hub_ip.includes(searchTerm));

    if (!matchesSearch) return false;
    if (selectedSiteId !== 'all') {
      const hub = hubs.find(h => h.id === s.hub_id);
      if (hub && hub.site_id !== selectedSiteId) return false;
    }
    return true;
  });

  const totalPrinters = peripheralsData.printers?.length || 0;
  const totalScanners = peripheralsData.scanners?.length || 0;
  const sharedPrintersCount = (peripheralsData.printers || []).filter(p => p.shared).length;
  const printingCount = (peripheralsData.printers || []).filter(p => p.state === 'processing' || p.state === 'printing').length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Fleet Peripherals & Attached Devices"
        description="Pantau dan kelola semua Printer CUPS dan Dokumen Scanner yang terhubung ke seluruh armada MantaPrint Hub secara terpusat."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={loading}
              onClick={fetchPeripherals}
            >
              Refresh Periferal
            </Button>
          </div>
        }
      />

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Printer Terpasang</div>
          <div className="mt-1 text-2xl font-extrabold text-white font-mono flex items-center gap-2">
            <Printer className="w-5 h-5 text-manta-400" />
            <span>{totalPrinters}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400 font-sans">
            Terhubung di seluruh node armada
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Scanner Aktif</div>
          <div className="mt-1 text-2xl font-extrabold text-cyan-300 font-mono flex items-center gap-2">
            <Scan className="w-5 h-5 text-cyan-400" />
            <span>{totalScanners}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            SANE Backend & Web Studio ready
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">AirPrint / Shared</div>
          <div className="mt-1 text-2xl font-extrabold text-indigo-300 font-mono flex items-center gap-2">
            <Share2 className="w-5 h-5 text-indigo-400" />
            <span>{sharedPrintersCount}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Broadcasting via Avahi / mDNS
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Sedang Mencetak</div>
          <div className="mt-1 text-2xl font-extrabold text-amber-400 font-mono flex items-center gap-2">
            <Radio className="w-5 h-5 text-amber-500 animate-pulse" />
            <span>{printingCount}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {printingCount > 0 ? 'Engine aktif mencetak' : 'Semua antrian idle'}
          </div>
        </Card>
      </div>

      {/* Control Bar: Search, Site Filter, and Type Segment */}
      <Card padded={false} className="p-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Cari printer, model, lokasi, atau hostname hub..."
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
                  <option value="all" className="bg-slate-900 text-white">Semua Cabang / Site</option>
                  {sites.map(s => (
                    <option key={s.id} value={s.id} className="bg-slate-900 text-white">
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Type Segmented */}
            <Segmented
              size="sm"
              value={filterType}
              onChange={setFilterType}
              options={[
                { value: 'all', label: `Semua (${totalPrinters + totalScanners})` },
                { value: 'printers', label: `Printer (${totalPrinters})` },
                { value: 'scanners', label: `Scanner (${totalScanners})` }
              ]}
            />
          </div>
        </div>
      </Card>

      {/* Printers Section */}
      {(filterType === 'all' || filterType === 'printers') && (
        <div className="space-y-3">
          <SectionLabel right={<span className="text-xs text-slate-500">{filteredPrinters.length} antrian printer</span>}>
            Daftar Printer CUPS Armada
          </SectionLabel>

          {filteredPrinters.length === 0 ? (
            <Card className="text-center py-10">
              <Printer className="w-10 h-10 mx-auto text-slate-600 mb-2" />
              <div className="text-sm font-bold text-white">Tidak Ada Printer Ditemukan</div>
              <div className="text-xs text-slate-400 mt-1">
                Pastikan printer USB atau Network terhubung ke MantaPrint Hub dan driver telah diprovisi.
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredPrinters.map((printer) => {
                const qName = printer.queue_name || printer.name;
                const displayName = printer.display_name || printer.info || qName;
                const modelName = printer.model || printer.make_and_model || printer.driver || 'Generic Driver';
                const isShared = printer.is_published ?? printer.shared;
                const isOnline = printer.hub_online !== false && printer.hub_is_online !== false;
                const isPrinting = printer.state === 'processing' || printer.state === 'printing';
                const testLoading = actionLoading[`test_${printer.hub_id}_${qName}`];
                const clearLoading = actionLoading[`clear_${printer.hub_id}_${qName}`];
                const ssoLoading = actionLoading[`sso_${printer.hub_id}`];

                return (
                  <Card
                    key={`${printer.hub_id}-${qName}`}
                    className="hover:border-manta-500/30 transition-all flex flex-col justify-between"
                  >
                    <div>
                      {/* Header */}
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-sm text-white truncate" title={displayName}>
                            {displayName}
                          </h4>
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">
                            Queue: <span className="text-manta-300">{qName}</span>
                          </div>
                        </div>

                        <StatusPill tone={isPrinting ? 'warn' : isOnline ? 'ok' : 'idle'} pulse={isPrinting}>
                          {isPrinting ? 'Printing' : isOnline ? 'Ready' : 'Offline'}
                        </StatusPill>
                      </div>

                      {/* Detail Specs */}
                      <div className="space-y-2 p-3 rounded-xl bg-slate-950/40 border border-white/[0.05] text-xs">
                        {/* Make & Model */}
                        <div className="flex items-center justify-between text-slate-400">
                          <span>Driver / Model:</span>
                          <span className="text-slate-200 font-medium truncate max-w-[170px]" title={modelName}>
                            {modelName}
                          </span>
                        </div>

                        {/* Location */}
                        <div className="flex items-center justify-between text-slate-400">
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-amber-400" />
                            <span>Lokasi:</span>
                          </span>
                          <span className="text-slate-200 font-medium truncate max-w-[170px]">
                            {printer.location || 'Belum diatur'}
                          </span>
                        </div>

                        {/* Attached Hub */}
                        <div className="flex items-center justify-between text-slate-400">
                          <span className="flex items-center gap-1">
                            <Server className="w-3 h-3 text-indigo-400" />
                            <span>Hub Host:</span>
                          </span>
                          <span className="text-slate-200 font-mono">
                            {printer.hub_name || printer.hub_id} ({printer.hub_ip})
                          </span>
                        </div>

                        {/* Sharing Status */}
                        <div className="flex items-center justify-between text-slate-400 pt-1 border-t border-white/[0.04]">
                          <span className="flex items-center gap-1">
                            <Share2 className="w-3 h-3 text-emerald-400" />
                            <span>AirPrint / Sharing:</span>
                          </span>
                          <Badge tone={isShared ? 'ok' : 'idle'}>
                            {isShared ? 'Shared & AirPrint' : 'Local Only'}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    {/* Actions Footer */}
                    <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-1.5 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={Play}
                          loading={testLoading}
                          onClick={() => handleTestPrint(printer)}
                          title="Cetak Halaman Uji CUPS"
                        >
                          Test
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={RotateCcw}
                          loading={clearLoading}
                          onClick={() => handleClearQueue(printer)}
                          title="Bersihkan Spool Queue"
                        >
                          Clear
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={Settings2}
                          onClick={() => handleOpenEditModal(printer)}
                          title="Ubah Nama, Lokasi, dan Sharing Printer"
                        >
                          Atur
                        </Button>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          variant="primary"
                          size="sm"
                          icon={ExternalLink}
                          loading={ssoLoading}
                          onClick={() => handleOpenHubAdminSso(printer.hub_id, printer.hub_name, printer.hub_ip)}
                          title="Buka Dashboard Admin Hub langsung tanpa relogin"
                        >
                          Admin SSO
                        </Button>
                        <a
                          href={`http://${printer.hub_ip}:631/printers/${qName}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
                          title="Buka Halaman CUPS Langsung"
                        >
                          <Printer className="w-3.5 h-3.5 text-indigo-400" />
                        </a>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Scanners Section */}
      {(filterType === 'all' || filterType === 'scanners') && (
        <div className="space-y-3 pt-2">
          <SectionLabel right={<span className="text-xs text-slate-500">{filteredScanners.length} scanner terdeteksi</span>}>
            Daftar Scanner Dokumen Armada
          </SectionLabel>

          {filteredScanners.length === 0 ? (
            <Card className="text-center py-10">
              <Scan className="w-10 h-10 mx-auto text-slate-600 mb-2" />
              <div className="text-sm font-bold text-white">Tidak Ada Scanner Dokumen Terdeteksi</div>
              <div className="text-xs text-slate-400 mt-1">
                Hubungkan scanner dokumen USB ke MantaPrint Hub untuk mengaktifkan pemindaian dokumen Zero-Trace.
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredScanners.map((scanner) => {
                const isOnline = scanner.hub_is_online !== false;
                const ssoLoading = actionLoading[`sso_${scanner.hub_id}`];

                return (
                  <Card
                    key={`${scanner.hub_id}-${scanner.name || scanner.model}`}
                    className="hover:border-cyan-500/30 transition-all flex flex-col justify-between"
                  >
                    <div>
                      {/* Header */}
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-sm text-white truncate">
                            {scanner.model || scanner.name || 'Dokumen Scanner'}
                          </h4>
                          <div className="text-[11px] text-cyan-300 font-mono mt-0.5 truncate">
                            Vendor: {scanner.vendor || 'Generic SANE'}
                          </div>
                        </div>

                        <StatusPill tone={isOnline ? 'ok' : 'idle'} pulse={isOnline}>
                          {isOnline ? 'Ready' : 'Offline'}
                        </StatusPill>
                      </div>

                      {/* Detail Specs */}
                      <div className="space-y-2 p-3 rounded-xl bg-slate-950/40 border border-white/[0.05] text-xs">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>Device ID / Name:</span>
                          <span className="text-slate-200 font-mono text-[11px] truncate max-w-[170px]" title={scanner.name}>
                            {scanner.name || 'sane-device'}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-slate-400">
                          <span className="flex items-center gap-1">
                            <Server className="w-3 h-3 text-indigo-400" />
                            <span>Hub Host:</span>
                          </span>
                          <span className="text-slate-200 font-mono">
                            {scanner.hub_name || scanner.hub_id} ({scanner.hub_ip})
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-slate-400 pt-1 border-t border-white/[0.04]">
                          <span>Security Policy:</span>
                          <Badge tone="ok">Zero-Trace Ephemeral RAM</Badge>
                        </div>
                      </div>
                    </div>

                    {/* Actions Footer */}
                    <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
                      <a
                        href={`http://${scanner.hub_ip}/scan`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition-colors"
                        title="Buka Studio Pemindaian Dokumen"
                      >
                        <Scan className="w-3.5 h-3.5" />
                        <span>Buka Studio Scan</span>
                      </a>

                      <Button
                        variant="primary"
                        size="sm"
                        icon={ExternalLink}
                        loading={ssoLoading}
                        onClick={() => handleOpenHubAdminSso(scanner.hub_id, scanner.hub_name, scanner.hub_ip)}
                        title="Buka Dashboard Admin Hub langsung tanpa relogin"
                      >
                        Admin SSO
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Edit Printer Configuration Modal */}
      {editingPrinter && (
        <Modal
          isOpen={Boolean(editingPrinter)}
          onClose={() => setEditingPrinter(null)}
          title={`Konfigurasi Printer: ${editingPrinter.name}`}
          subtitle={`Hub Host: ${editingPrinter.hub_name || editingPrinter.hub_id} (${editingPrinter.hub_ip})`}
          maxWidth="max-w-md"
          footer={
            <div className="flex items-center justify-end gap-2 w-full">
              <Button variant="secondary" size="sm" onClick={() => setEditingPrinter(null)}>
                Batal
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                loading={savingConfig}
                onClick={handleSavePrinterConfig}
              >
                Simpan Perubahan
              </Button>
            </div>
          }
        >
          <form onSubmit={handleSavePrinterConfig} className="space-y-4">
            <Field label="Display Name (Nama Tampilan)">
              <input
                type="text"
                value={printerForm.display_name}
                onChange={(e) => setPrinterForm(prev => ({ ...prev, display_name: e.target.value }))}
                placeholder="e.g. HP LaserJet Pro M130 Kasir Depan"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Nama deskriptif yang dilihat pelanggan saat memilih printer di Web App dan AirPrint.
              </p>
            </Field>

            <Field label="Lokasi Fisik (CUPS Location)">
              <input
                type="text"
                value={printerForm.location}
                onChange={(e) => setPrinterForm(prev => ({ ...prev, location: e.target.value }))}
                placeholder="e.g. Kasir Utama Meja 1, Lantai Dasar"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Membantu teknisi dan kasir mengenali lokasi printer di outlet.
              </p>
            </Field>

            <Field label="Nama Siaran mDNS / Bonjour (AirPrint Hostname)">
              <input
                type="text"
                value={printerForm.custom_broadcast_name}
                onChange={(e) => setPrinterForm(prev => ({ ...prev, custom_broadcast_name: e.target.value }))}
                placeholder="e.g. mantaprint-kasir-depan"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50 font-mono"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Nama service mDNS/Avahi broadcast di jaringan lokal untuk deteksi otomatis oleh iPhone/Mac/Android.
              </p>
            </Field>

            <div className="p-3.5 rounded-xl bg-slate-950/40 border border-white/[0.07] space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={printerForm.publish_broadcast}
                  onChange={(e) => setPrinterForm(prev => ({ ...prev, publish_broadcast: e.target.checked }))}
                  className="rounded border-white/20 bg-slate-900 text-manta-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-xs font-semibold text-white">
                  Bagikan Printer (Share via CUPS & AirPrint)
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer pt-2 border-t border-white/[0.05]">
                <input
                  type="checkbox"
                  checked={printerForm.is_default}
                  onChange={(e) => setPrinterForm(prev => ({ ...prev, is_default: e.target.checked }))}
                  className="rounded border-white/20 bg-slate-900 text-manta-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-xs font-semibold text-white">
                  Jadikan Printer Default di Hub Ini
                </span>
              </label>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
