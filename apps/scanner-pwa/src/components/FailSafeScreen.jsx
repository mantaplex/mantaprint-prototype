import React, { useState } from 'react';
import { 
  ShieldAlert, 
  WifiOff, 
  RefreshCw, 
  FolderOpen, 
  ArrowRight, 
  RotateCcw,
  Edit2,
  Check
} from 'lucide-react';

export default function FailSafeScreen({
  type, // 'REVOKED' or 'UNREACHABLE'
  searchStatus,
  onRetryDiscovery,
  onManualEndpointChange,
  onOpenOfflineLibrary,
  onResetPairing
}) {
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [endpointInput, setEndpointInput] = useState('');

  const handleSaveEndpoint = (e) => {
    e.preventDefault();
    if (!endpointInput.trim()) return;
    onManualEndpointChange(endpointInput.trim());
    setEditingEndpoint(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl p-6 sm:p-8 text-center">
        {type === 'REVOKED' ? (
          <div>
            <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 mx-auto flex items-center justify-center mb-4">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Akses Perangkat Dicabut oleh Admin
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Administrator Hub telah menonaktifkan otorisasi perangkat ini. Semua kunci enkripsi telah dihapus demi keamanan.
            </p>

            <div className="mt-6 space-y-3">
              <button
                type="button"
                onClick={onResetPairing}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold text-xs shadow-lg shadow-rose-950/50 flex items-center justify-center gap-2 transition-all scale-[1.01] active:scale-[0.99]"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Pasangkan Ulang Perangkat</span>
              </button>

              <button
                type="button"
                onClick={onOpenOfflineLibrary}
                className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                <span>Buka Dokumen Tersimpan (Offline)</span>
              </button>
            </div>
          </div>
        ) : (
          <div>
            {/* Radar Pulse Animation */}
            <div className="relative w-20 h-20 mx-auto mb-4 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-rose-500/20 animate-ping" />
              <div className="absolute inset-2 rounded-full bg-rose-500/10 animate-pulse" />
              <div className="relative w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/30 text-rose-400 flex items-center justify-center shadow-lg shadow-rose-950/60">
                <WifiOff className="w-6 h-6" />
              </div>
            </div>

            <h2 className="text-lg font-bold text-white tracking-tight">
              Menghubungkan ke MantaPrint Hub...
            </h2>
            <p className="text-xs text-slate-400 mt-2">
              {searchStatus || 'Sedang mencari Hub pada jaringan lokal Anda...'}
            </p>

            {editingEndpoint ? (
              <form onSubmit={handleSaveEndpoint} className="mt-4 space-y-2">
                <input
                  type="text"
                  value={endpointInput}
                  onChange={e => setEndpointInput(e.target.value)}
                  placeholder="Misal: http://192.0.2.10"
                  className="w-full px-3 py-2 text-xs rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-center focus:outline-none focus:border-rose-500"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg"
                  >
                    Simpan & Hubungkan
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingEndpoint(false)}
                    className="py-2 px-3 bg-slate-800 text-slate-400 text-xs rounded-lg"
                  >
                    Batal
                  </button>
                </div>
              </form>
            ) : null}

            <div className="mt-6 space-y-2.5">
              <button
                type="button"
                onClick={onRetryDiscovery}
                className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold text-xs shadow-lg shadow-rose-950/50 flex items-center justify-center gap-2 transition-all scale-[1.01] active:scale-[0.99]"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Cari Otomatis Ulang</span>
              </button>

              {!editingEndpoint && (
                <button
                  type="button"
                  onClick={() => setEditingEndpoint(true)}
                  className="w-full py-2 px-4 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  <span>Ubah Alamat IP Manual</span>
                </button>
              )}

              <button
                type="button"
                onClick={onOpenOfflineLibrary}
                className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                <span>Lanjutkan Mode Offline (Studio Mandiri)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
