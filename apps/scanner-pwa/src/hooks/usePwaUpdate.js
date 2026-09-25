import { useState, useEffect, useCallback } from 'react';

/**
 * Hook to manage PWA Service Worker lifecycle & in-app updates.
 * Provides update detection, skip-waiting trigger, and smooth reloading.
 */
export function usePwaUpdate() {
  const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState(null);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleRegistration = (reg) => {
      if (!reg) return;

      // Check if a worker is already waiting in the background
      if (reg.waiting) {
        setWaitingWorker(reg.waiting);
        setIsUpdateAvailable(true);
      }

      // Check when a new worker begins installing
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            setWaitingWorker(newWorker);
            setIsUpdateAvailable(true);
          }
        });
      });
    };

    navigator.serviceWorker.getRegistration().then(handleRegistration);

    // Reload once the new service worker activates and claims clients
    let refreshing = false;
    const handleControllerChange = () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  const updateApp = useCallback(() => {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }, [waitingWorker]);

  const checkForUpdates = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return false;
    setIsChecking(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) {
          setWaitingWorker(reg.waiting);
          setIsUpdateAvailable(true);
          return true;
        }
      }
      return false;
    } catch (err) {
      console.warn('Check update error:', err);
      return false;
    } finally {
      setIsChecking(false);
    }
  }, []);

  return {
    isUpdateAvailable,
    updateApp,
    checkForUpdates,
    isChecking,
    dismissUpdate: () => setIsUpdateAvailable(false)
  };
}
