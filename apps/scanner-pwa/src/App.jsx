import React, { useState, useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { getHubCredentials, setHubCredentials, clearHubCredentials } from './services/db.js';
import { HubLocator } from './services/hubLocator.js';
import { ScannerClient } from './services/scannerClient.js';
import { usePwaUpdate } from './hooks/usePwaUpdate.js';
import PairingScreen from './components/PairingScreen.jsx';
import ScanningWorkbench from './components/ScanningWorkbench.jsx';
import FailSafeScreen from './components/FailSafeScreen.jsx';
import OfflineLibrary from './components/OfflineLibrary.jsx';

export default function App() {
  const [appState, setAppState] = useState('BOOTING'); // 'BOOTING', 'PAIRING', 'SEARCHING', 'WORKBENCH', 'LIBRARY', 'REVOKED', 'UNREACHABLE'
  const [credentials, setCredentials] = useState(null);
  const [hubInfo, setHubInfo] = useState(null);
  const [searchStatus, setSearchStatus] = useState('');
  const [scannerClient, setScannerClient] = useState(null);

  // PWA Service Worker in-app update detector
  const { isUpdateAvailable, updateApp, dismissUpdate, checkForUpdates, isChecking } = usePwaUpdate();

  // Initialize and check stored credentials in IndexedDB
  const initApp = async () => {
    try {
      const creds = await getHubCredentials();
      if (!creds || !creds.token) {
        setAppState('PAIRING');
        return;
      }
      setCredentials(creds);
      attemptConnect(creds);
    } catch (err) {
      console.warn('Init error:', err);
      setAppState('PAIRING');
    }
  };

  useEffect(() => {
    initApp();
  }, []);

  // Attempt 3-tiered auto-healing Hub discovery
  const attemptConnect = async (creds) => {
    setAppState('SEARCHING');
    setSearchStatus('Menghubungi MantaPrint Hub...');

    const result = await HubLocator.locateHub(
      creds.hub_endpoint,
      creds.hub_uuid,
      (progress) => setSearchStatus(progress.message)
    );

    if (result.reachable) {
      setHubInfo(result);

      // Create scanner client instance with onRevoked callback
      const client = new ScannerClient(result.endpoint, creds, handleRevoked);
      setScannerClient(client);

      // Update stored endpoint if it changed via DHCP
      if (result.endpoint !== creds.hub_endpoint) {
        const updated = { ...creds, hub_endpoint: result.endpoint };
        setCredentials(updated);
        await setHubCredentials(updated);
      }

      setAppState('WORKBENCH');
    } else {
      setAppState('UNREACHABLE');
    }
  };

  // Fail-safe callback when Hub returns 403 ERR_CLIENT_REVOKED
  const handleRevoked = async () => {
    await clearHubCredentials();
    setCredentials(null);
    setScannerClient(null);
    setAppState('REVOKED');
  };

  // Called when PairingScreen finishes successfully
  const handlePaired = async (newCreds) => {
    await setHubCredentials(newCreds);
    setCredentials(newCreds);
    attemptConnect(newCreds);
  };

  // Manual endpoint change fallback
  const handleManualEndpointChange = async (newEndpoint) => {
    if (!credentials) return;
    const updated = { ...credentials, hub_endpoint: newEndpoint };
    setCredentials(updated);
    await setHubCredentials(updated);
    attemptConnect(updated);
  };

  const renderContent = () => {
    if (appState === 'BOOTING') {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
          <div className="text-center">
            <div className="w-12 h-12 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center mx-auto mb-3 animate-pulse">
              <span className="font-mono font-bold text-lg">M</span>
            </div>
            <p className="text-xs text-slate-400">Memuat MantaPageScan Studio...</p>
          </div>
        </div>
      );
    }

    if (appState === 'PAIRING') {
      return <PairingScreen onPaired={handlePaired} />;
    }

    if (appState === 'REVOKED') {
      return (
        <FailSafeScreen
          type="REVOKED"
          onResetPairing={() => setAppState('PAIRING')}
          onOpenOfflineLibrary={() => setAppState('LIBRARY')}
        />
      );
    }

    if (appState === 'SEARCHING' || appState === 'UNREACHABLE') {
      return (
        <FailSafeScreen
          type="UNREACHABLE"
          searchStatus={searchStatus}
          onRetryDiscovery={() => credentials && attemptConnect(credentials)}
          onManualEndpointChange={handleManualEndpointChange}
          onOpenOfflineLibrary={() => setAppState('LIBRARY')}
        />
      );
    }

    if (appState === 'LIBRARY') {
      return (
        <OfflineLibrary
          onBack={() => setAppState(credentials && scannerClient ? 'WORKBENCH' : 'UNREACHABLE')}
        />
      );
    }

    if (appState === 'WORKBENCH' && scannerClient) {
      return (
        <ScanningWorkbench
          scannerClient={scannerClient}
          hubInfo={hubInfo}
          credentials={credentials}
          onOpenLibrary={() => setAppState('LIBRARY')}
          pwaUpdate={{ isUpdateAvailable, updateApp, checkForUpdates, isChecking }}
        />
      );
    }

    return null;
  };

  return (
    <div className="relative min-h-screen bg-slate-950">
      {/* Floating In-App Update Prompt Bar */}
      {isUpdateAvailable && (
        <div className="sticky top-0 left-0 right-0 z-50 bg-gradient-to-r from-cyan-600 via-indigo-600 to-cyan-600 text-white px-4 py-2.5 shadow-xl flex items-center justify-between gap-3 text-xs animate-in slide-in-from-top duration-300">
          <div className="flex items-center gap-2 min-w-0">
            <span className="p-1 rounded-md bg-white/20 shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-cyan-200 animate-pulse" />
            </span>
            <span className="truncate">
              <strong>Pembaruan MantaPageScan Tersedia!</strong> Versi baru siap diterapkan.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={updateApp}
              className="px-3 py-1 rounded-lg bg-white text-slate-900 font-bold hover:bg-cyan-50 text-[11px] transition-colors shadow-sm"
            >
              Segarkan Sekarang
            </button>
            <button
              type="button"
              onClick={dismissUpdate}
              className="p-1 rounded-lg hover:bg-white/20 transition-colors text-white/80"
              title="Tutup pemberitahuan"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {renderContent()}
    </div>
  );
}
