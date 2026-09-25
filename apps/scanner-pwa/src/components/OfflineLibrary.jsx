import React, { useState, useEffect } from 'react';
import { 
  FolderOpen, 
  ArrowLeft, 
  Trash2, 
  Download, 
  Calendar, 
  FileText, 
  Layers, 
  Sparkles,
  CreditCard
} from 'lucide-react';
import { getOfflineScans, deleteOfflineScan } from '../services/db.js';
import { mergeKtp2In1, compilePdfFromPages } from '../utils/imageOps.js';

export default function OfflineLibrary({ onBack }) {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedScan, setSelectedScan] = useState(null);
  const [previewUrls, setPreviewUrls] = useState([]);

  // KTP 2-in-1 selection state
  const [ktpFront, setKtpFront] = useState(null);
  const [ktpBack, setKtpBack] = useState(null);
  const [mergingKtp, setMergingKtp] = useState(false);

  const loadScans = async () => {
    try {
      setLoading(true);
      const items = await getOfflineScans();
      setScans(items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScans();
  }, []);

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (confirm('Hapus dokumen ini dari penyimpanan lokal?')) {
      await deleteOfflineScan(id);
      if (selectedScan?.id === id) {
        setSelectedScan(null);
        setPreviewUrls([]);
      }
      loadScans();
    }
  };

  const handleSelectScan = (scan) => {
    setSelectedScan(scan);
    const urls = (scan.pages || []).map(p => URL.createObjectURL(p));
    setPreviewUrls(urls);
  };

  // Merge selected KTP Front & Back
  const handleMergeKtp = async () => {
    if (!ktpFront || !ktpBack) {
      alert('Pilih foto sisi depan dan sisi belakang KTP terlebih dahulu.');
      return;
    }
    try {
      setMergingKtp(true);
      const mergedBlob = await mergeKtp2In1(ktpFront, ktpBack);
      const url = URL.createObjectURL(mergedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `KTP_2in1_${Date.now()}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Gagal menggabungkan KTP: ${err.message}`);
    } finally {
      setMergingKtp(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-base font-bold text-white flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-rose-400" />
              Pustaka Dokumen Tersimpan (Offline IndexedDB)
            </h1>
            <p className="text-[10px] text-slate-400">
              Dokumen tersimpan langsung pada memori perangkat ini dan dapat diakses tanpa koneksi internet.
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* Left List */}
        <div className="lg:col-span-5 p-4 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-900/40 overflow-y-auto space-y-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Daftar Hasil Pindaian ({scans.length})
            </span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-xs text-slate-500">Memuat berkas lokal...</div>
          ) : scans.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Belum ada dokumen yang tersimpan.
            </div>
          ) : (
            scans.map(scan => {
              const isSelected = selectedScan?.id === scan.id;
              return (
                <div
                  key={scan.id}
                  onClick={() => handleSelectScan(scan)}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    isSelected 
                      ? 'bg-rose-950/30 border-rose-500/50 shadow-md' 
                      : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-bold text-white">{scan.name || 'Dokumen Pindaian'}</div>
                      <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2">
                        <Calendar className="w-3 h-3" />
                        <span>{new Date(scan.saved_at || scan.created_at).toLocaleString('id-ID')}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(scan.id, e)}
                      className="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                      title="Hapus"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Preview */}
        <div className="lg:col-span-7 p-6 flex flex-col bg-slate-950 overflow-y-auto">
          {selectedScan && previewUrls.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">{selectedScan.name}</h3>
                  <div className="text-xs text-slate-400">{previewUrls.length} Halaman</div>
                </div>
                <div className="flex gap-2">
                  <a
                    href={previewUrls[0]}
                    download={`${selectedScan.name || 'scan'}.jpg`}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-700 flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh Gambar</span>
                  </a>
                </div>
              </div>

              {/* Preview Image */}
              <div className="p-4 rounded-3xl bg-slate-900/60 border border-slate-800 flex items-center justify-center min-h-[300px]">
                <img
                  src={previewUrls[0]}
                  alt="Document Preview"
                  className="max-h-[480px] max-w-full object-contain rounded-xl shadow-xl"
                />
              </div>

              {/* KTP 2-in-1 Quick Action */}
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard className="w-4 h-4 text-rose-400" />
                  <span className="text-xs font-bold text-white">Alat Gabung KTP 2-in-1</span>
                </div>
                <p className="text-[11px] text-slate-400 mb-3">
                  Gunakan gambar ini sebagai sisi Depan atau Belakang untuk digabungkan menjadi salinan A4 siap cetak.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setKtpFront(selectedScan.pages[0])}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-700"
                  >
                    Set Sisi Depan {ktpFront && '✓'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKtpBack(selectedScan.pages[0])}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-700"
                  >
                    Set Sisi Belakang {ktpBack && '✓'}
                  </button>
                  {ktpFront && ktpBack && (
                    <button
                      type="button"
                      onClick={handleMergeKtp}
                      disabled={mergingKtp}
                      className="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-bold text-white"
                    >
                      {mergingKtp ? 'Menggabungkan...' : 'Gabungkan & Unduh A4'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-500">
              <FolderOpen className="w-12 h-12 text-slate-700 mb-2" />
              <p className="text-xs">Pilih dokumen di sebelah kiri untuk melihat pratinjau.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
