/**
 * MantaPageScan Studio — entry point for /scan.
 *
 *   /scan            → Library (documents stored on this device)
 *   /scan/<docId>    → Workbench for one document
 *
 * Everything is processed and stored in the browser; the hub is used only to acquire
 * pages from the USB scanner and to print.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Library from './components/Library.jsx';
import Workbench from './components/Workbench.jsx';
import * as db from './db/studioDb.js';

function parseRoute() {
  if (typeof window === 'undefined') return { mode: 'library' };
  const m = window.location.pathname.match(/^\/scan\/([A-Za-z0-9_-]+)/);
  return m ? { mode: 'workbench', docId: m[1] } : { mode: 'library' };
}

export default function ScanStudio({ scanner, onRefreshScanner, showToast, onNavigateHome, printerQueue }) {
  const [route, setRoute] = useState(parseRoute);
  const [handoff, setHandoff] = useState(null); // { tray, files } for a freshly created document

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((path, next) => {
    window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  const openDocument = useCallback((doc, extra = null) => {
    setHandoff(extra);
    go(`/scan/${doc.id}`, { mode: 'workbench', docId: doc.id });
  }, [go]);

  const newScan = useCallback(async () => {
    const doc = await db.createDocument({ preset: 'office' });
    openDocument(doc, { tray: 'scan' });
  }, [openDocument]);

  const importFiles = useCallback(async (files) => {
    const first = files[0]?.name?.replace(/\.[^.]+$/, '');
    const doc = await db.createDocument({ preset: 'office', title: first || undefined });
    openDocument(doc, { files });
  }, [openDocument]);

  const back = useCallback(() => {
    setHandoff(null);
    go('/scan', { mode: 'library' });
  }, [go]);

  if (route.mode === 'workbench') {
    return (
      <Workbench
        key={route.docId}
        docId={route.docId}
        initialTray={handoff?.tray || null}
        initialFiles={handoff?.files || null}
        onBack={back}
        scanner={scanner}
        onRefreshScanner={onRefreshScanner}
        showToast={showToast}
        printerQueue={printerQueue}
      />
    );
  }

  return (
    <Library
      onOpenDocument={(d) => openDocument(d)}
      onNewScan={newScan}
      onImport={importFiles}
      onNavigateHome={onNavigateHome}
      scanner={scanner}
      showToast={showToast}
    />
  );
}
