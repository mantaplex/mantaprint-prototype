import React, { useState, useEffect } from 'react';
import { 
  ScanLine, 
  Settings2, 
  FileText, 
  Layers, 
  Zap, 
  Lock, 
  Unlock, 
  RotateCw, 
  Download, 
  Trash2, 
  Sparkles, 
  FolderOpen, 
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Sliders
} from 'lucide-react';
import { applySauvolaBinarization, rotateImage, mergeKtp2In1, compilePdfFromPages } from '../utils/imageOps.js';
import { saveOfflineScan } from '../services/db.js';

export default function ScanningWorkbench({
  scannerClient,
  hubInfo,
  credentials,
  onOpenLibrary,
  onOpenSettings,
  pwaUpdate
}) {
  const [scannerStatus, setScannerStatus] = useState(null);
  const [mutexStatus, setMutexStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  // Scan Parameters
  const [paperSize, setPaperSize] = useState('A4');
  const [mode, setMode] = useState('Color');
  const [resolution, setResolution] = useState(300);
  const [source, setSource] = useState('Flatbed');

  // Scanning Execution State
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [scannedPages, setScannedPages] = useState([]);
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [processingOffline, setProcessingOffline] = useState(false);
  const [busyCooldown, setBusyCooldown] = useState(0);

  // Fetch Hardware Status periodically
  const refreshStatus = async () => {
    try {
      setLoadingStatus(true);
      const res = await scannerClient.getStatus();
      if (res) {
        setScannerStatus(res.scanner);
        setMutexStatus(res.mutex);
      }
    } catch (err) {
      if (err.message === 'ERR_CLIENT_REVOKED') return;
      console.warn('Status poll error:', err);
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 8000);
    return () => clearInterval(interval);
  }, []);

  // Countdown timer if scanner is busy
  useEffect(() => {
    if (busyCooldown > 0) {
      const t = setTimeout(() => setBusyCooldown(c => c - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [busyCooldown]);

  const handleStartScan = async () => {
    setScanning(true);
    setScanMessage('Mengirim perintah pindai ke hardware...');

    try {
      const result = await scannerClient.acquireScan({
        paperSize,
        mode,
        resolution,
        source
      });

      if (result && result.success && result.downloadUrl) {
        setScanMessage('Mengunduh hasil pindaian dari Hub...');
        const blob = await scannerClient.downloadScanBlob(result.downloadUrl);
        const objectUrl = URL.createObjectURL(blob);

        const newPage = {
          id: `page_${Date.now()}`,
          blob,
          url: objectUrl,
          paperSize,
          resolution,
          mode,
          timestamp: new Date().toISOString()
        };

        setScannedPages(prev => [...prev, newPage]);
        setSelectedPageIndex(scannedPages.length);

        // Auto-save to offline IndexedDB
        await saveOfflineScan({
          id: newPage.id,
          name: `Scan ${new Date().toLocaleTimeString('id-ID')}`,
          pages: [blob],
          created_at: newPage.timestamp
        });

        setScanMessage('');
      } else {
        alert(result?.message || 'Pemindaian gagal.');
      }
    } catch (err) {
      if (err.isBusy) {
        setBusyCooldown(err.estimatedRemainingSec || 15);
        alert(`Scanner sedang digunakan oleh "${err.holder}". Silakan coba lagi dalam beberapa detik.`);
      } else if (err.message !== 'ERR_CLIENT_REVOKED') {
        alert(`Gagal memindai: ${err.message}`);
      }
    } finally {
      setScanning(false);
    }
  };

  // Offline Image Processing: Sauvola
  const handleSauvola = async () => {
    const page = scannedPages[selectedPageIndex];
    if (!page) return;

    try {
      setProcessingOffline(true);
      const binarizedBlob = await applySauvolaBinarization(page.blob);
      const newUrl = URL.createObjectURL(binarizedBlob);

      const updated = [...scannedPages];
      updated[selectedPageIndex] = {
        ...page,
        blob: binarizedBlob,
        url: newUrl,
        mode: 'Sauvola B&W'
      };
      setScannedPages(updated);
    } catch (err) {
      alert(`Gagal memproses Sauvola: ${err.message}`);
    } finally {
      setProcessingOffline(false);
    }
  };

  // Offline Image Processing: Rotate 90
  const handleRotate = async () => {
    const page = scannedPages[selectedPageIndex];
    if (!page) return;

    try {
      setProcessingOffline(true);
      const rotatedBlob = await rotateImage(page.blob, 90);
      const newUrl = URL.createObjectURL(rotatedBlob);

      const updated = [...scannedPages];
      updated[selectedPageIndex] = {
        ...page,
        blob: rotatedBlob,
        url: newUrl
      };
      setScannedPages(updated);
    } catch (err) {
      alert(`Gagal memutar gambar: ${err.message}`);
    } finally {
      setProcessingOffline(false);
    }
  };

  // Export All Pages as Single PDF
  const handleExportPdf = async () => {
    if (scannedPages.length === 0) return;

    try {
      setProcessingOffline(true);
      const pdfBlob = await compilePdfFromPages(scannedPages.map(p => p.blob));
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MantaPageScan_${Date.now()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Gagal membuat PDF: ${err.message}`);
    } finally {
      setProcessingOffline(false);
    }
  };

  // Delete page
  const handleDeletePage = (index) => {
    const updated = scannedPages.filter((_, i) => i !== index);
    setScannedPages(updated);
    if (selectedPageIndex >= updated.length) {
      setSelectedPageIndex(Math.max(0, updated.length - 1));
    }
  };

  const activePage = scannedPages[selectedPageIndex];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top App Header */}
      <header className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <ScanLine className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-white">MantaPageScan Studio</span>
              <span title="Prototype - not for production or sensitive data" className="px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider rounded bg-amber-400/15 text-amber-300 border border-amber-400/40">PROTOTYPE</span>
              <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-950 text-emerald-400 border border-emerald-800/60 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Terhubung
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              {credentials?.device_name} • Hub: {scannerClient.endpoint}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {pwaUpdate && (
            <button
              type="button"
              onClick={pwaUpdate.checkForUpdates}
              disabled={pwaUpdate.isChecking}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 text-xs flex items-center gap-1.5 transition-colors"
              title="Periksa Pembaruan PWA MantaPageScan"
            >
              <RefreshCw className={`w-3 h-3 text-cyan-400 ${pwaUpdate.isChecking ? 'animate-spin' : ''}`} />
              <span className="font-mono text-[11px] text-slate-300">v0.2.3</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenLibrary}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs flex items-center gap-1.5 transition-colors"
            title="Buka Dokumen Tersimpan"
          >
            <FolderOpen className="w-4 h-4" />
            <span className="hidden sm:inline">Pustaka</span>
          </button>
        </div>
      </header>

      {/* Hardware Mutex Busy Banner */}
      {mutexStatus?.is_busy && (
        <div className="bg-amber-950/80 border-b border-amber-800/60 px-4 py-2.5 text-xs text-amber-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Hardware Sedang Dipakai:</strong> Sedang digunakan oleh "{mutexStatus?.holder}".
            </span>
          </div>
          <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-amber-900/60 text-amber-300">
            {mutexStatus?.elapsed_sec}s
          </span>
        </div>
      )}

      {/* Main Workspace Layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* Left Control Panel */}
        <div className="lg:col-span-4 p-4 sm:p-5 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-900/50 space-y-5 overflow-y-auto">
          {/* Hardware Detection Card */}
          <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className={`w-2.5 h-2.5 rounded-full ${scannerStatus?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pemindai Hardware</div>
                <div className="text-xs font-semibold text-white truncate max-w-[200px]">
                  {scannerStatus?.connected ? (scannerStatus?.model || scannerStatus?.name) : 'Tidak Terhubung'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={refreshStatus}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"
              title="Segarkan hardware"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Scanner Controls Form */}
          <div className="space-y-4">
            {/* Paper Size Preset */}
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Ukuran Dokumen
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'A4', label: 'A4' },
                  { id: 'F4', label: 'F4 / Folio' },
                  { id: 'ID_CARD', label: 'KTP / ID' }
                ].map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPaperSize(p.id)}
                    className={`py-2 text-xs font-semibold rounded-xl border transition-all ${
                      paperSize === p.id 
                        ? 'bg-rose-600 border-rose-500 text-white shadow-md' 
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Color Mode */}
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Mode Warna
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'Color', label: 'Warna (RGB)' },
                  { id: 'Gray', label: 'Grayscale' },
                  { id: 'Lineart', label: 'B&W (Teks)' }
                ].map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMode(m.id)}
                    className={`py-2 text-[11px] font-semibold rounded-xl border transition-all ${
                      mode === m.id 
                        ? 'bg-rose-600 border-rose-500 text-white shadow-md' 
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Resolution DPI */}
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Resolusi (DPI)
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[150, 200, 300].map(dpi => (
                  <button
                    key={dpi}
                    type="button"
                    onClick={() => setResolution(dpi)}
                    className={`py-2 text-xs font-semibold rounded-xl border transition-all ${
                      resolution === dpi 
                        ? 'bg-rose-600 border-rose-500 text-white shadow-md' 
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {dpi} DPI
                  </button>
                ))}
              </div>
            </div>

            {/* Source / Feeder */}
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Sumber Kertas
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { id: 'Flatbed', label: 'Kaca Flatbed' },
                  { id: 'ADF', label: 'Feeder (ADF)' }
                ].map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSource(s.id)}
                    className={`py-2 text-xs font-semibold rounded-xl border transition-all ${
                      source === s.id 
                        ? 'bg-rose-600 border-rose-500 text-white shadow-md' 
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action Button: Start Scan */}
            <button
              type="button"
              onClick={handleStartScan}
              disabled={scanning || busyCooldown > 0}
              className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold text-xs shadow-xl shadow-rose-950/60 flex items-center justify-center gap-2 transition-all scale-[1.01] active:scale-[0.99] disabled:opacity-50 mt-4"
            >
              {scanning ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>{scanMessage || 'Sedang Memindai...'}</span>
                </>
              ) : busyCooldown > 0 ? (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Scanner Sibuk ({busyCooldown}s)</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  <span>Pindai Sekarang</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Preview & Workbench */}
        <div className="lg:col-span-8 p-4 sm:p-6 flex flex-col bg-slate-950">
          {scannedPages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center border-2 border-dashed border-slate-800/80 rounded-3xl">
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-slate-600 mb-3">
                <FileText className="w-10 h-10" />
              </div>
              <h3 className="text-sm font-semibold text-slate-300">Belum Ada Dokumen yang Dipindai</h3>
              <p className="text-xs text-slate-500 max-w-sm mt-1">
                Letakkan dokumen pada kaca scanner lalu tekan tombol "Pindai Sekarang" di sisi kiri.
              </p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col space-y-4">
              {/* Studio Toolbar (Client-Side Pure JS Operations) */}
              <div className="p-2 rounded-2xl bg-slate-900 border border-slate-800 flex flex-wrap items-center justify-between gap-2 shadow-lg">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleSauvola}
                    disabled={processingOffline}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
                    title="Sauvola Local Adaptive Binarization (Otomatis bersihkan background kotor)"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                    <span>Sauvola B&W</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleRotate}
                    disabled={processingOffline}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
                    title="Putar 90 derajat searah jarum jam"
                  >
                    <RotateCw className="w-3.5 h-3.5 text-slate-300" />
                    <span>Putar 90°</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDeletePage(selectedPageIndex)}
                    className="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 hover:border-rose-800 transition-colors"
                    title="Hapus Halaman Ini"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportPdf}
                    disabled={processingOffline}
                    className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow flex items-center gap-1.5 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh PDF ({scannedPages.length} Halaman)</span>
                  </button>
                </div>
              </div>

              {/* Active Document Viewer */}
              <div className="flex-1 bg-slate-900/60 rounded-3xl border border-slate-800 p-4 flex items-center justify-center overflow-hidden min-h-[360px]">
                {activePage && (
                  <img
                    src={activePage.url}
                    alt="Scanned Document Preview"
                    className="max-h-full max-w-full object-contain rounded-xl shadow-2xl transition-all"
                  />
                )}
              </div>

              {/* Scanned Pages Filmstrip */}
              {scannedPages.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto py-2">
                  {scannedPages.map((page, idx) => (
                    <button
                      key={page.id}
                      type="button"
                      onClick={() => setSelectedPageIndex(idx)}
                      className={`relative shrink-0 w-16 h-20 rounded-xl overflow-hidden border-2 transition-all ${
                        selectedPageIndex === idx 
                          ? 'border-rose-500 shadow-md scale-105' 
                          : 'border-slate-800 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img src={page.url} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
                      <span className="absolute bottom-1 right-1 px-1 rounded bg-black/80 text-[9px] font-mono font-bold text-white">
                        {idx + 1}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
