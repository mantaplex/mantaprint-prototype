import React, { useState, useEffect, useCallback } from 'react';
import Home from './hub/Home.jsx';
import AdminApp from './admin/AdminApp.jsx';
import Login from './admin/Login.jsx';
import ScanStudio from './scan/ScanStudio.jsx';
import Toast from './components/Toast.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { I18nProvider, useI18n } from './i18n/I18nContext.jsx';
import { ADMIN_TOKEN_KEY, getAdminToken } from './shell/api.js';

function routeOf(path) {
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/scan')) return 'scan';
  return 'home';
}

function AppContent({ data, isConnected, fetchStatus, showToast, toast, setToast }) {
  const { t } = useI18n();
  const [route, setRoute] = useState(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has('token') || sp.has('admin_token') || window.location.hash.includes('admin')) {
        return 'admin';
      }
    } catch {}
    return routeOf(window.location.pathname);
  });
  const [adminToken, setAdminToken] = useState(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const urlTok = sp.get('token') || sp.get('admin_token');
      if (urlTok) {
        localStorage.setItem(ADMIN_TOKEN_KEY, urlTok);
        return urlTok;
      }
    } catch {}
    return getAdminToken() || null;
  });
  const [adminUser, setAdminUser] = useState(null);
  const [initialSection, setInitialSection] = useState(null);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has('token') || sp.has('admin_token')) {
        sp.delete('token');
        sp.delete('admin_token');
        const qs = sp.toString() ? `?${sp.toString()}` : '';
        window.history.replaceState({}, '', `${window.location.pathname}${qs}${window.location.hash}`);
      }
    } catch {}
  }, []);

  const navigateTo = useCallback((path) => {
    window.history.pushState(null, '', path);
    setRoute(routeOf(path));
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Validate a stored admin token once
  useEffect(() => {
    if (!adminToken) return;
    fetch('/api/auth/check', { headers: { 'X-Admin-Token': adminToken } })
      .then((r) => r.json())
      .then((r) => {
        if (!r.authenticated) {
          try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
          setAdminToken(null);
          setAdminUser(null);
        } else {
          setAdminUser(r.user || 'admin');
        }
      })
      .catch(() => {});
  }, [adminToken]);

  // After an appliance update the updater reloads with ?updated=<version>
  useEffect(() => {
    if (window.location.search.includes('updated=')) {
      setInitialSection('updates');
      showToast(t('adm.updates.done'), 'success');
      try { window.history.replaceState({}, '', window.location.pathname); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Admin-Token': adminToken || '' } }); } catch {}
    try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
    setAdminToken(null);
    setAdminUser(null);
    showToast(t('adm.header.loggedOut'), 'info');
    navigateTo('/');
  };

  const serverIp = data?.system?.broadcast_ip || data?.system?.ip || window.location.hostname;

  let page;
  if (route === 'scan') {
    page = (
      <ScanStudio
        scanner={data?.scanner}
        onRefreshScanner={fetchStatus}
        showToast={showToast}
        onNavigateHome={() => navigateTo('/')}
        printerQueue={data?.printer?.connected ? (data?.printer?.queue_name || '') : ''}
      />
    );
  } else if (route === 'admin') {
    page = adminToken ? (
      <AdminApp
        data={data}
        adminUser={adminUser}
        onLogout={logout}
        onNavigateHome={() => navigateTo('/')}
        refresh={fetchStatus}
        showToast={showToast}
        initialSection={initialSection}
      />
    ) : (
      <Login onSuccess={(token, user) => { setAdminToken(token); setAdminUser(user); }} onCancel={() => navigateTo('/')} />
    );
  } else {
    page = (
      <Home
        data={data}
        isConnected={isConnected}
        serverIp={serverIp}
        onNavigateScan={() => navigateTo('/scan')}
        onNavigateAdmin={() => navigateTo('/admin')}
        showToast={showToast}
      />
    );
  }

  return (
    <>
      <Toast toast={toast} onClose={() => setToast(null)} placement={route === 'scan' ? 'above-dock' : 'default'} />
      {page}
    </>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast((prev) => (prev?.message === message ? null : prev)), 4500);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        setData(await res.json());
        setIsConnected(true);
      } else {
        setIsConnected(false);
      }
    } catch (err) {
      setIsConnected(false);
      console.warn('Status fetch error:', err);
    }
  }, []);

  // Live status over Server-Sent Events with a polling fallback
  useEffect(() => {
    fetchStatus();
    let es = null;
    let poll = null;
    try {
      es = new EventSource('/api/events');
      es.onopen = () => { setIsConnected(true); if (poll) { clearInterval(poll); poll = null; } };
      es.onmessage = (e) => {
        try { setData(JSON.parse(e.data)); setIsConnected(true); } catch {}
      };
      es.onerror = () => {
        // Keep the last known state; the polling fallback decides whether the hub is reachable.
        es.close();
        if (!poll) poll = setInterval(fetchStatus, 3000);
      };
    } catch {
      poll = setInterval(fetchStatus, 3000);
    }
    return () => {
      if (es) es.close();
      if (poll) clearInterval(poll);
    };
  }, [fetchStatus]);

  return (
    <ErrorBoundary>
      <I18nProvider initialLanguage={data?.system?.language || 'en'}>
        <AppContent data={data} isConnected={isConnected} fetchStatus={fetchStatus} showToast={showToast} toast={toast} setToast={setToast} />
      </I18nProvider>
    </ErrorBoundary>
  );
}
