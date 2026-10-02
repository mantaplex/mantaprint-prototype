import { useState, useEffect, useRef, useCallback } from 'react';

export function useApplianceUpdater() {
  const [updaterState, setUpdaterState] = useState('IDLE');
  const [currentStep, setCurrentStep] = useState('System Ready');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [versionInfo, setVersionInfo] = useState(null);
  const [backups, setBackups] = useState([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isRestartingAppliance, setIsRestartingAppliance] = useState(false);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);

  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const backoffRef = useRef(1000);
  const isUpdatingRef = useRef(false);
  const isRestartingRef = useRef(false);
  const healthPollIntervalRef = useRef(null);
  const failSafeTimerRef = useRef(null);

  const getAdminToken = () => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('mantaprint_admin_token') || '';
    }
    return '';
  };

  // Automated health polling and clean page refresh once service is back online
  const triggerHealthPollAndReload = useCallback(() => {
    if (healthPollIntervalRef.current) return;
    
    // Lock the UI into restarting mode until the browser physically navigates / reloads
    isRestartingRef.current = true;
    isUpdatingRef.current = true;
    setIsRestartingAppliance(true);
    setUpdaterState('RESTARTING');
    setProgress(100);

    const forceHardReload = () => {
      if (failSafeTimerRef.current) {
        clearTimeout(failSafeTimerRef.current);
        failSafeTimerRef.current = null;
      }
      if (healthPollIntervalRef.current) {
        clearInterval(healthPollIntervalRef.current);
        healthPollIntervalRef.current = null;
      }
      
      // Keep isRestartingAppliance = true so UI does not flicker to IDLE 0% while document unloads
      const targetUrl = window.location.pathname + '?updated=' + Date.now();
      try {
        window.location.href = targetUrl;
      } catch {
        try {
          window.location.replace(targetUrl);
        } catch {}
      }
      setTimeout(() => {
        try {
          window.location.reload();
        } catch {}
      }, 500);
    };

    // Fail-safe maximum timeout: if health check does not conclude in 12s, force hard reload
    if (failSafeTimerRef.current) clearTimeout(failSafeTimerRef.current);
    failSafeTimerRef.current = setTimeout(forceHardReload, 12000);

    let attempts = 0;
    const maxAttempts = 30; // 30 * 1s = 30s max wait

    healthPollIntervalRef.current = setInterval(async () => {
      attempts++;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`/api/health?t=${Date.now()}`, { 
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
          const health = await res.json();
          if (health.status === 'healthy') {
            if (failSafeTimerRef.current) {
              clearTimeout(failSafeTimerRef.current);
              failSafeTimerRef.current = null;
            }
            if (healthPollIntervalRef.current) {
              clearInterval(healthPollIntervalRef.current);
              healthPollIntervalRef.current = null;
            }

            // Clear Service Worker caches safely with a strict 1-second timeout
            if (typeof window !== 'undefined' && window.isSecureContext && 'caches' in window) {
              try {
                const cachePromise = (async () => {
                  const keys = await window.caches.keys();
                  await Promise.all(keys.map(k => window.caches.delete(k)));
                })();
                const timeoutPromise = new Promise(resolve => setTimeout(resolve, 1000));
                await Promise.race([cachePromise, timeoutPromise]);
              } catch {}
            }

            // Service is fully online! Execute immediate smooth reload with cache buster
            setTimeout(forceHardReload, 300);
            return;
          }
        }
      } catch {
        // Still rebooting / restarting, wait for next tick
      }

      if (attempts >= maxAttempts) {
        if (failSafeTimerRef.current) {
          clearTimeout(failSafeTimerRef.current);
          failSafeTimerRef.current = null;
        }
        forceHardReload();
      }
    }, 1000);
  }, []);

  // SSE Stream Connection with Exponential Backoff
  const connectStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource('/api/system/updates/stream');
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      backoffRef.current = 1000;
      // If we reconnected after initiating an update or restart, trigger reload
      if (isUpdatingRef.current || isRestartingRef.current) {
        triggerHealthPollAndReload();
      }
    };

    es.addEventListener('init', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Protect UI from resetting to IDLE (0%) while restart reload is in-flight
        if (isUpdatingRef.current || isRestartingRef.current) {
          triggerHealthPollAndReload();
          return;
        }
        if (data.state) setUpdaterState(data.state);
        if (data.step || data.phase) setCurrentStep(data.step || data.phase);
        if (typeof data.progress === 'number') setProgress(data.progress);
        if (data.updateInfo) setVersionInfo(data.updateInfo);
        if (data.recentLogs && Array.isArray(data.recentLogs)) {
          setLogs(data.recentLogs);
        }
      } catch {}
    });

    es.addEventListener('state', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.state === 'FAILED') {
          isUpdatingRef.current = false;
          isRestartingRef.current = false;
          setIsRestartingAppliance(false);
        }
        if (isUpdatingRef.current || isRestartingRef.current) {
          if (data.state === 'COMPLETED' || data.state === 'RESTARTING') {
            setUpdaterState('COMPLETED');
            setProgress(100);
            setCurrentStep(data.step || data.phase || 'Update applied successfully.');
            triggerHealthPollAndReload();
            return;
          }
          if (data.state === 'IDLE' || data.state === 'UPDATE_AVAILABLE') {
            triggerHealthPollAndReload();
            return;
          }
        }
        if (data.state) setUpdaterState(data.state);
        if (data.step || data.phase) setCurrentStep(data.step || data.phase);
        if (typeof data.progress === 'number') setProgress(data.progress);
        if (data.updateInfo) setVersionInfo(data.updateInfo);
        if (data.error) setError(data.error);

        if ((data.state === 'RESTARTING' || data.state === 'COMPLETED') && isUpdatingRef.current) {
          triggerHealthPollAndReload();
        }
      } catch {}
    });

    es.addEventListener('log', (e) => {
      try {
        const entry = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-499), entry]);
      } catch {}
    });

    es.addEventListener('complete', () => {
      if (isUpdatingRef.current || isRestartingRef.current) {
        triggerHealthPollAndReload();
      } else {
        fetchVersion();
        fetchBackups();
      }
    });

    es.onerror = () => {
      setConnected(false);
      es.close();

      if (isUpdatingRef.current || isRestartingRef.current) {
        triggerHealthPollAndReload();
      }

      const delay = Math.min(backoffRef.current, 15000);
      backoffRef.current *= 1.5;
      reconnectTimeoutRef.current = setTimeout(connectStream, delay);
    };
  }, [triggerHealthPollAndReload]);

  const fetchVersion = useCallback(async () => {
    try {
      const res = await fetch('/api/system/version');
      if (res.ok) {
        const data = await res.json();
        setVersionInfo(prev => ({ ...(prev || {}), ...data }));
      }
    } catch {}
  }, []);

  const checkForUpdates = useCallback(async (force = true) => {
    setIsChecking(true);
    setError(null);
    const token = getAdminToken();
    try {
      const res = await fetch(`/api/system/updates/check?force=${force}`, {
        headers: token ? { 'X-Admin-Token': token } : {}
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setVersionInfo(prev => ({ ...(prev || {}), ...data }));
      } else {
        setError(data.message || 'Failed to check updates');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsChecking(false);
    }
  }, []);

  const fetchBackups = useCallback(async () => {
    const token = getAdminToken();
    if (!token) return;
    try {
      const res = await fetch('/api/system/updates/backups', {
        headers: { 'X-Admin-Token': token }
      });
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch {}
  }, []);

  const startUpdate = useCallback(async (options = {}) => {
    setError(null);
    isUpdatingRef.current = true;
    const token = getAdminToken();
    try {
      const res = await fetch('/api/system/updates/install', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token
        },
        body: JSON.stringify({ backup: options.backup !== false })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        isUpdatingRef.current = false;
        throw new Error(data.message || 'Failed to trigger update');
      }
      return data;
    } catch (err) {
      isUpdatingRef.current = false;
      setError(err.message);
      throw err;
    }
  }, []);

  const rollback = useCallback(async (snapshotId) => {
    setError(null);
    isUpdatingRef.current = true;
    const token = getAdminToken();
    try {
      const res = await fetch('/api/system/updates/rollback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token
        },
        body: JSON.stringify({ snapshotId })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        isUpdatingRef.current = false;
        throw new Error(data.message || 'Failed to trigger rollback');
      }
      triggerHealthPollAndReload();
      return data;
    } catch (err) {
      isUpdatingRef.current = false;
      setError(err.message);
      throw err;
    }
  }, [triggerHealthPollAndReload]);

  const clearLogs = () => setLogs([]);

  useEffect(() => {
    fetchVersion();
    fetchBackups();
    connectStream();

    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (!isRestartingRef.current) {
        if (healthPollIntervalRef.current) {
          clearInterval(healthPollIntervalRef.current);
          healthPollIntervalRef.current = null;
        }
        if (failSafeTimerRef.current) {
          clearTimeout(failSafeTimerRef.current);
          failSafeTimerRef.current = null;
        }
      }
    };
  }, [connectStream, fetchVersion, fetchBackups]);

  const isUpdating = ['PREFLIGHT', 'BACKING_UP', 'DOWNLOADING', 'INSTALLING', 'RESTARTING', 'VERIFYING', 'ROLLING_BACK'].includes(updaterState) || isRestartingAppliance;

  return {
    state: updaterState,
    currentStep,
    progress,
    logs,
    versionInfo,
    backups,
    isChecking,
    isUpdating,
    isRestartingAppliance,
    connected,
    error,
    checkForUpdates,
    startUpdate,
    rollback,
    fetchBackups,
    clearLogs
  };
}
