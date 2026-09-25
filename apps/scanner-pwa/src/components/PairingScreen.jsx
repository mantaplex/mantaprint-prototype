import React, { useState, useRef, useEffect } from 'react';
import { 
  QrCode, 
  KeyRound, 
  Camera, 
  Smartphone, 
  AlertCircle, 
  CheckCircle2, 
  RefreshCw, 
  ArrowRight,
  Wifi,
  Sparkles
} from 'lucide-react';
import jsQR from 'jsqr';

export default function PairingScreen({ onPaired }) {
  const [mode, setMode] = useState('pin'); // 'qr' or 'pin'
  const [hubHost, setHubHost] = useState(window.location.hostname || 'mantaprint.local');
  const [pin, setPin] = useState('');
  const [deviceName, setDeviceName] = useState(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    if (isIOS) return 'Apple iOS Device';
    if (isAndroid) return 'Android Scanner';
    return 'Workstation Client';
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Camera & Video stream refs for QR scanner
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);

  const startCamera = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        scanIntervalRef.current = requestAnimationFrame(scanQrFrame);
      }
    } catch (err) {
      console.warn('Camera access error:', err);
      setError('Kamera tidak dapat diakses. Silakan masukkan PIN 6-digit secara manual.');
      setMode('pin');
    }
  };

  const stopCamera = () => {
    if (scanIntervalRef.current) {
      cancelAnimationFrame(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    try {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash) {
        const params = new URLSearchParams(hash);
        const token = params.get('pairing') || params.get('pair') || params.get('token');
        const pin = params.get('pin');
        const host = params.get('host') || params.get('hub') || window.location.host;
        if (token || pin) {
          handleVerifyPairing({
            endpoint: `http://${host}`,
            pairing_token: token || pin
          });
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (mode === 'qr') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [mode]);

  const scanQrFrame = () => {
    if (!videoRef.current || !canvasRef.current) return;
    if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });

      if (code && code.data) {
        try {
          let payload = null;
          if (code.data.startsWith('http://') || code.data.startsWith('https://')) {
            const parsedUrl = new URL(code.data);
            const hash = parsedUrl.hash.replace(/^#/, '');
            const search = parsedUrl.search.replace(/^\?/, '');
            const params = new URLSearchParams(hash || search);
            const token = params.get('pairing') || params.get('pair') || params.get('token');
            const pin = params.get('pin');
            if (token || pin) {
              payload = {
                app: 'mantaprint-scanner',
                host: parsedUrl.host,
                pairing_token: token || pin
              };
            }
          } else {
            payload = JSON.parse(code.data);
          }

          const isMantaPrint = payload && (payload.app === 'mantaprint-scanner' || payload.action === 'mantaprint_pairing');
          if (isMantaPrint && (payload.pairing_token || payload.pin)) {
            stopCamera();
            const resolvedEndpoint = payload.host ? `http://${payload.host}` : (payload.ip ? `http://${payload.ip}` : `http://${hubHost}`);
            handleVerifyPairing({
              endpoint: resolvedEndpoint,
              pairing_token: payload.pairing_token || payload.pin
            });
            return;
          }
        } catch {
          // Not JSON or non-mantaprint QR, continue scanning
        }
      }
    }
    scanIntervalRef.current = requestAnimationFrame(scanQrFrame);
  };

  const handleVerifyPairing = async ({ endpoint, pairing_token, manualPin }) => {
    setLoading(true);
    setError('');

    const targetUrl = (endpoint || `http://${hubHost}`).replace(/\/+$/, '');
    const verifyUrl = `${targetUrl}/api/scanner/pairing/verify`;

    try {
      const platform = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iOS' :
                       /Android/.test(navigator.userAgent) ? 'Android' : 'Desktop';

      const res = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_token: pairing_token || undefined,
          pin: manualPin || pin.replace(/\s+/g, ''),
          device_name: deviceName.trim() || 'PWA Scanner',
          platform
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        onPaired({
          hub_endpoint: targetUrl,
          hub_uuid: data.hub_uuid,
          client_id: data.client_id,
          token: data.token,
          device_name: data.device_name || deviceName,
          paired_at: new Date().toISOString()
        });
      } else {
        setError(data.message || 'Kode pairing atau PIN tidak valid / kedaluwarsa.');
      }
    } catch {
      setError(`Gagal menghubungi Hub di ${targetUrl}. Pastikan Anda terhubung ke Wi-Fi yang sama.`);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    if (!pin.trim()) {
      setError('Masukkan 6-digit PIN dari Admin Console.');
      return;
    }
    handleVerifyPairing({ manualPin: pin.trim() });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl p-6 sm:p-8">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 mx-auto flex items-center justify-center mb-3">
            <Smartphone className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Pasangkan MantaPageScan PWA</h1>
          <p className="mt-2 inline-block px-2 py-0.5 text-[10px] font-extrabold tracking-wider rounded bg-amber-400/15 text-amber-300 border border-amber-400/40">PROTOTYPE - NOT FOR SENSITIVE DATA</p>
          <p className="text-xs text-slate-400 mt-1">
            Hubungkan smartphone atau tablet Anda ke MantaPrint Hub lokal untuk memindai dokumen tanpa batas.
          </p>
        </div>

        {/* Mode Switcher */}
        <div className="flex rounded-xl bg-slate-950 p-1 border border-slate-800 mb-6">
          <button
            type="button"
            onClick={() => setMode('pin')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${
              mode === 'pin' ? 'bg-rose-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>PIN 6-Digit</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('qr')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${
              mode === 'qr' ? 'bg-rose-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <QrCode className="w-4 h-4" />
            <span>Scan QR Code</span>
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-800/60 text-xs text-rose-200 mb-4 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Mode 1: Camera QR Scan */}
        {mode === 'qr' && (
          <div className="space-y-4">
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-square flex items-center justify-center border border-slate-800">
              <video ref={videoRef} className="w-full h-full object-cover" />
              <canvas ref={canvasRef} className="hidden" />
              
              {/* Scan Overlay Reticle */}
              <div className="absolute inset-8 border-2 border-dashed border-rose-400/70 rounded-2xl pointer-events-none flex items-center justify-center">
                <div className="w-full h-0.5 bg-rose-500 animate-pulse shadow-[0_0_8px_#f43f5e]" />
              </div>
            </div>
            <p className="text-[11px] text-center text-slate-400 font-mono">
              Arahkan kamera ke QR Code di layar Admin Console Hub
            </p>
          </div>
        )}

        {/* Mode 2: Manual PIN Entry */}
        {mode === 'pin' && (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Alamat MantaPrint Hub
              </label>
              <input
                type="text"
                value={hubHost}
                onChange={e => setHubHost(e.target.value)}
                placeholder="mantaprint.local atau 192.168.1.xxx"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white font-mono text-xs focus:outline-none focus:border-rose-500 transition-colors"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                PIN Pairing (6-Digit)
              </label>
              <input
                type="text"
                value={pin}
                onChange={e => setPin(e.target.value)}
                placeholder="Misal: 489 201"
                maxLength={8}
                className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 text-rose-400 font-mono font-black text-xl tracking-widest text-center focus:outline-none focus:border-rose-500 transition-colors"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1 tracking-wider">
                Nama Perangkat Ini
              </label>
              <input
                type="text"
                value={deviceName}
                onChange={e => setDeviceName(e.target.value)}
                placeholder="Misal: iPad Kasir Utama"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs focus:outline-none focus:border-rose-500 transition-colors"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !pin.trim()}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold text-xs shadow-lg shadow-rose-950/50 flex items-center justify-center gap-2 transition-all scale-[1.01] active:scale-[0.99] disabled:opacity-50"
            >
              {loading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Mengautentikasi...</span>
                </>
              ) : (
                <>
                  <span>Hubungkan Sekarang</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        )}

        <div className="mt-6 pt-5 border-t border-slate-800/80 text-center">
          <span className="text-[10px] text-slate-500">
            MantaPrint Native PWA v1.0 • Otorisasi Lokal Kriptografis HMAC-SHA256
          </span>
        </div>
      </div>
    </div>
  );
}
