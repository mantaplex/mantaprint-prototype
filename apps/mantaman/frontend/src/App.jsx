import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { FleetOverview } from './components/FleetOverview';
import { PeripheralsView } from './components/PeripheralsView';
import { AdoptionCenter } from './components/AdoptionCenter';
import { SitesManager } from './components/SitesManager';
import { BatchOperations } from './components/BatchOperations';
import { AuditLedger } from './components/AuditLedger';
import { UpdateManager } from './components/UpdateManager';
import { translations } from './i18n/translations';
import { MantaClient } from './utils/api';
import { ToastProvider } from './ui/Toast';

export default function App() {
  const [activeTab, setActiveTab] = useState('fleet');
  const [lang, setLang] = useState(() => localStorage.getItem('mantaman_lang') || 'en');
  const [hubs, setHubs] = useState([]);
  const [sites, setSites] = useState([]);
  const [isWsConnected, setIsWsConnected] = useState(false);

  const t = translations[lang] || translations.en;

  const handleLangChange = (newLang) => {
    setLang(newLang);
    localStorage.setItem('mantaman_lang', newLang);
  };

  const loadData = useCallback(async () => {
    try {
      const [hubsRes, sitesRes] = await Promise.all([
        MantaClient.listHubs(),
        MantaClient.listSites()
      ]);
      if (hubsRes.hubs) setHubs(hubsRes.hubs);
      if (sitesRes.sites) setSites(sitesRes.sites);
    } catch (err) {
      console.warn('Initial data load warning:', err.message);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Setup live WebSocket console conduit
    let ws = null;
    let reconnectTimer = null;
    let isDisposed = false;

    const connectWs = () => {
      if (isDisposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/console`;
      
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          if (!isDisposed) setIsWsConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'snapshot' && Array.isArray(data.hubs)) {
              setHubs(data.hubs);
            } else if (data.type === 'hub_connected' || data.type === 'hub_disconnected') {
              loadData();
            } else if (data.type === 'telemetry' && data.hubId && data.telemetry) {
              setHubs(prev => prev.map(h => {
                if (h && h.id === data.hubId) {
                  return {
                    ...h,
                    is_online: true,
                    cpu_temp: data.telemetry.system?.cpu_temp ?? h.cpu_temp,
                    ram_used_mb: data.telemetry.system?.ram_used_mb ?? h.ram_used_mb,
                    ram_total_mb: data.telemetry.system?.ram_total_mb ?? h.ram_total_mb,
                    cups_state: data.telemetry.printer?.state ?? h.cups_state,
                    printer_name: data.telemetry.printer?.name ?? h.printer_name,
                    toner_cmyk: data.telemetry.toner ?? h.toner_cmyk
                  };
                }
                return h;
              }));
            }
          } catch {}
        };

        ws.onclose = () => {
          if (!isDisposed) {
            setIsWsConnected(false);
            reconnectTimer = setTimeout(connectWs, 3000);
          }
        };

        ws.onerror = () => {
          if (!isDisposed) setIsWsConnected(false);
        };
      } catch {
        if (!isDisposed) {
          setIsWsConnected(false);
          reconnectTimer = setTimeout(connectWs, 3000);
        }
      }
    };

    connectWs();

    // Polling fallback every 15s
    const pollInterval = setInterval(loadData, 15000);

    return () => {
      isDisposed = true;
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pollInterval);
    };
  }, [loadData]);

  const unadoptedCount = hubs.filter(h => h && h.status === 'unadopted').length;
  const managedCount = hubs.filter(h => h && h.status === 'managed').length;

  return (
    <ToastProvider>
      <div className="min-h-screen bg-[#070a11] text-slate-100 flex flex-col font-sans selection:bg-manta-600 selection:text-white">
        <div role="note" className="bg-amber-400/15 border-b border-amber-400/30 text-amber-200 text-[11px] sm:text-xs px-4 py-1.5 text-center">
          <strong className="font-extrabold tracking-wider">PROTOTYPE</strong> - MantaPool has incomplete authentication and talks to hubs over unencrypted HTTP.
          Not for production, sensitive data or untrusted networks.{' '}
          <a className="underline" href="https://github.com/mantaplex/mantaprint-prototype/blob/main/docs/KNOWN-LIMITATIONS.md" target="_blank" rel="noreferrer">Known limitations</a>
        </div>
        <Navbar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab} 
          lang={lang} 
          setLang={handleLangChange} 
          t={t}
          isWsConnected={isWsConnected}
          unadoptedCount={unadoptedCount}
          managedCount={managedCount}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 animate-pop-up">
          {activeTab === 'fleet' && (
            <FleetOverview 
              hubs={hubs} 
              sites={sites} 
              onRefresh={loadData} 
              onNavigateTab={setActiveTab} 
              t={t} 
            />
          )}
          {activeTab === 'peripherals' && (
            <PeripheralsView hubs={hubs} sites={sites} onRefresh={loadData} t={t} />
          )}
          {activeTab === 'adoption' && (
            <AdoptionCenter hubs={hubs} sites={sites} onRefresh={loadData} t={t} />
          )}
          {activeTab === 'sites' && (
            <SitesManager sites={sites} hubs={hubs} onRefresh={loadData} t={t} />
          )}
          {activeTab === 'batch' && (
            <BatchOperations sites={sites} t={t} />
          )}
          {activeTab === 'audit' && (
            <AuditLedger t={t} />
          )}
          {activeTab === 'updates' && (
            <UpdateManager t={t} onRefresh={loadData} />
          )}
        </main>

        <footer className="border-t border-white/[0.05] py-5 px-6 text-center text-xs text-slate-500 font-mono">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>MantaPool Console v0.3.0 (Prototype) • Multi-Hub Orchestration Engine</span>
            <span className="text-slate-600">Built for MantaPrint Hub STBs &amp; SBCs</span>
          </div>
        </footer>
      </div>
    </ToastProvider>
  );
}
