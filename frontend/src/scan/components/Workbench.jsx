import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Undo2, Redo2, Check, Loader2, AlertTriangle, PanelLeft, Languages, Printer, Download, Search
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useStudioDocument } from '../hooks/useStudioDocument.js';
import * as db from '../db/studioDb.js';
import { presetById, PAPER_SIZES } from '../engine/paper.js';
import { acquireScan, printBlob } from '../engine/hubClient.js';
import { renderPageBlob, renderPagePixels, composeKtp2in1 } from '../engine/renderClient.js';
import { renderToCanvas, decodeBlob, mainThreadCanvasFactory } from '../engine/render.js';
import { detectSkewAngle } from '../../utils/documentProcessor.js';
import { copyTextToClipboard } from '../../shell/api.js';
import { exportPagesToPdf } from '../engine/pdfExport.js';
import { pagesToText, pagesToDocx } from '../engine/textExport.js';
import { encodeMultiPageTiff } from '../engine/tiff.js';
import { createZip } from '../engine/zip.js';
import { saveBlob, safeFilename } from '../engine/fileSave.js';
import { annotationId, translate, redactionRects, overlaps } from '../engine/annotations.js';
import { DEFAULT_TOOL_OPTIONS, pageFrame, ptToFrac, FONT_SIZES } from '../engine/annotationStyles.js';
import { ocrPage, ocrSupported, ocrState, DEFAULT_OCR_LANG } from '../engine/ocr.js';
import { findMatches, visibleWords } from '../engine/ocrText.js';
import { IconButton, Button, Tray, Modal, Segmented, useIsPhone } from './ui.jsx';
import PagesRail from './PagesRail.jsx';
import Stage from './Stage.jsx';
import DocumentView from './DocumentView.jsx';
import ToolDock from './ToolDock.jsx';
import ExportSheet from './ExportSheet.jsx';
import ObjectsPanel from './ObjectsPanel.jsx';
import FindBar from './FindBar.jsx';
import SignaturePad, { imageFileToDataUrl } from './SignaturePad.jsx';
import { ScanTray, ImportTray, EnhanceTray, CropTray, KtpTray } from './trays.jsx';
import { DrawTray, ShapesTray, SignTray, RedactTray, OcrTray, AdjustTray } from './editTrays.jsx';
import { PrototypeBadge } from '../../shell/Prototype.jsx';

const QUALITY = { high: 0.93, balanced: 0.86, small: 0.72 };
const FOCUS_TRAYS = new Set(['crop', 'enhance']);
const MAX_SAVED_SIGNATURES = 4;

export default function Workbench({ docId, initialTray = null, initialFiles = null, onBack, scanner, onRefreshScanner, showToast, printerQueue }) {
  const { t, lang, setLanguage } = useI18n();
  const isPhone = useIsPhone();
  const studio = useStudioDocument(docId);
  const { doc, pages, loading } = studio;

  const [activeId, setActiveId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [openTray, setOpenTray] = useState(initialTray);
  const [railOpen, setRailOpen] = useState(true);
  const [cropDraft, setCropDraft] = useState(null);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [printCopies, setPrintCopies] = useState(1);
  const [printing, setPrinting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanPhase, setScanPhase] = useState('');
  const [scanError, setScanError] = useState('');
  const [presetId, setPresetId] = useState(doc?.preset || 'office');
  const [scanSettings, setScanSettings] = useState({ resolution: 300, mode: 'Color', source: 'Flatbed', paperSize: 'A4' });
  const [ktpDpi, setKtpDpi] = useState(300);
  const [composing, setComposing] = useState(false);
  const [deskewing, setDeskewing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(null);

  // Editing
  const [tool, setTool] = useState('select');
  const [drawTool, setDrawTool] = useState('pen');
  const [toolOpts, setToolOpts] = useState(() => JSON.parse(JSON.stringify(DEFAULT_TOOL_OPTIONS)));
  const [selection, setSelection] = useState(null); // { pageId, id }
  const [editing, setEditing] = useState(null); // { pageId, id }
  const [signatures, setSignatures] = useState([]);
  const [sigPadOpen, setSigPadOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);

  // OCR
  const [ocrPrefs, setOcrPrefs] = useState({ lang: DEFAULT_OCR_LANG, auto: true });
  const [ocrProgress, setOcrProgress] = useState({}); // pageId -> -1 (queued) | 0..1
  const ocrQueued = useRef(new Set());

  // Find
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  const buttonRefs = useRef({});
  const docZoom = useRef(null);
  const stageZoom = useRef(null);
  const dragRecorded = useRef(false);
  const initialFilesHandled = useRef(false);
  const clipboard = useRef(null);
  const prefsLoaded = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  const activePage = useMemo(() => pages.find((p) => p.id === activeId) || null, [pages, activeId]);
  const activeIndex = pages.findIndex((p) => p.id === activeId);
  const focusMode = FOCUS_TRAYS.has(openTray) && Boolean(activePage);
  const zoomApi = focusMode ? stageZoom : docZoom;

  // ---- persisted preferences ---------------------------------------------------
  useEffect(() => {
    let active = true;
    (async () => {
      const [saved, savedDpi, opts, sigs, ocr] = await Promise.all([
        db.getSetting('scanSettings'),
        db.getSetting('ktpDpi'),
        db.getSetting('toolOptions'),
        db.getSetting('signatures'),
        db.getSetting('ocrPrefs')
      ]);
      if (!active) return;
      if (saved) setScanSettings((s) => ({ ...s, ...saved }));
      if (savedDpi) setKtpDpi(savedDpi);
      if (opts) setToolOpts((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, ...(opts[k] || {}) }])));
      if (Array.isArray(sigs)) setSignatures(sigs);
      if (ocr) setOcrPrefs((p) => ({ ...p, ...ocr }));
      prefsLoaded.current = true;
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { if (prefsLoaded.current) db.setSetting('scanSettings', scanSettings); }, [scanSettings]);
  useEffect(() => { if (prefsLoaded.current) db.setSetting('ktpDpi', ktpDpi); }, [ktpDpi]);
  useEffect(() => { if (prefsLoaded.current) db.setSetting('toolOptions', toolOpts); }, [toolOpts]);
  useEffect(() => { if (prefsLoaded.current) db.setSetting('ocrPrefs', ocrPrefs); }, [ocrPrefs]);
  useEffect(() => { if (doc?.preset) setPresetId(doc.preset); }, [doc?.preset]);

  // Keep an active page
  useEffect(() => {
    if (!pages.length) { setActiveId(null); return; }
    if (!pages.some((p) => p.id === activeId)) setActiveId(pages[pages.length - 1].id);
  }, [pages, activeId]);

  // Drop a selection whose page or object is gone (undo, delete)
  useEffect(() => {
    if (!selection) return;
    const p = pages.find((x) => x.id === selection.pageId);
    if (!p || !(p.annotations || []).some((a) => a.id === selection.id)) setSelection(null);
  }, [pages, selection]);

  // Import files handed over by the library
  useEffect(() => {
    if (loading || !doc || !initialFiles?.length || initialFilesHandled.current) return;
    initialFilesHandled.current = true;
    importFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, doc]);

  const anchorRef = useMemo(() => ({ get current() { return buttonRefs.current[openTray] || buttonRefs.current.adjust || null; } }), [openTray]);

  // ---- page navigation / selection ---------------------------------------------
  const goToPage = useCallback((id, opts) => {
    setActiveId(id);
    requestAnimationFrame(() => docZoom.current?.scrollToPage(id, opts));
  }, []);
  const select = useCallback((id) => { setSelectedIds(new Set()); goToPage(id); }, [goToPage]);
  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    setActiveId(id);
  }, []);
  const selectRange = useCallback((from, to) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelectedIds(new Set(pages.slice(a, b + 1).map((p) => p.id)));
  }, [pages]);
  const targetIds = useCallback(() => (selectedIds.size ? [...selectedIds] : activeId ? [activeId] : []), [selectedIds, activeId]);
  const onActivateFromView = useCallback((id) => setActiveId(id), []);

  // ---- object API for the view, toolbar and objects panel ------------------------
  const selectObject = useCallback((pageId, id) => {
    setSelection(pageId && id ? { pageId, id } : null);
    if (pageId) setActiveId(pageId);
  }, []);
  const api = useMemo(() => ({
    add: (pageId, ann) => studio.addAnnotation(pageId, ann),
    update: (pageId, id, patch, opts) => studio.updateAnnotation(pageId, id, patch, opts),
    remove: (pageId, id, opts) => {
      studio.setAnnotations(pageId, (list) => list.filter((a) => a.id !== id), opts);
      setSelection((s) => (s && s.id === id ? null : s));
    },
    beginChange: () => studio.beginChange(),
    setTool: (tl) => setTool(tl),
    select: selectObject
  }), [studio, selectObject]);

  const onEditText = useCallback((pageId, id, isNew) => {
    if (!pageId || !id) { setEditing(null); return; }
    if (!isNew) studio.beginChange();
    setSelection({ pageId, id });
    setEditing({ pageId, id });
  }, [studio]);

  const changeTool = useCallback((tl) => {
    setTool(tl);
    if (tl === 'pen' || tl === 'highlighter' || tl === 'eraser') setDrawTool(tl);
    if (tl !== 'select') setSelection(null);
    setEditing(null);
  }, []);
  const setOpt = useCallback((key, patch) => setToolOpts((o) => ({ ...o, [key]: { ...o[key], ...patch } })), []);

  // ---- OCR -----------------------------------------------------------------------
  const runOcr = useCallback(async (ids, { silent = false } = {}) => {
    if (!ocrSupported()) { if (!silent) showToast?.(t('studio.ocr.unsupported'), 'error'); return; }
    const fresh = ids.filter((id) => !ocrQueued.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => ocrQueued.current.add(id));
    setOcrProgress((p) => ({ ...p, ...Object.fromEntries(fresh.map((id) => [id, -1])) }));
    let done = 0;
    await Promise.all(fresh.map(async (id) => {
      try {
        const res = await ocrPage(() => (unmountedRef.current ? null : studio.getPageRecord(id)), {
          lang: ocrPrefs.lang,
          onProgress: (v) => { if (!unmountedRef.current) setOcrProgress((p) => ({ ...p, [id]: v })); }
        });
        if (!unmountedRef.current && res && studio.getPageRecord(id)) { studio.setOcr(id, res); done += 1; }
      } catch (err) {
        console.error('[OCR]', err);
        if (!silent && !unmountedRef.current) showToast?.(t('studio.ocr.failed', { msg: err?.message || '?' }), 'error');
      } finally {
        ocrQueued.current.delete(id);
        if (!unmountedRef.current) setOcrProgress((p) => { const n = { ...p }; delete n[id]; return n; });
      }
    }));
    if (!silent && done && !unmountedRef.current) showToast?.(t('studio.ocr.done', { n: done }), 'success');
  }, [studio, ocrPrefs.lang, showToast, t]);

  // Re-recognise pages whose geometry changed after OCR (auto mode)
  useEffect(() => {
    if (!ocrPrefs.auto) return undefined;
    const stale = pages.filter((p) => ocrState(p) === 'stale' && !ocrQueued.current.has(p.id)).map((p) => p.id);
    if (!stale.length) return undefined;
    const timer = setTimeout(() => runOcr(stale, { silent: true }), 1500);
    return () => clearTimeout(timer);
  }, [pages, ocrPrefs.auto, runOcr]);

  const ocrBusy = Object.keys(ocrProgress).length > 0;
  const ocrMissingIds = (ids) => ids.filter((id) => { const p = pages.find((x) => x.id === id); return p && ocrState(p) !== 'done'; });

  const copyText = async (text) => {
    const ok = await copyTextToClipboard(text);
    if (ok) showToast?.(t('studio.ocr.copied'), 'success');
    else showToast?.('Clipboard blocked', 'error');
  };

  // ---- import ------------------------------------------------------------------
  const afterAdd = useCallback((added) => {
    if (!added.length) return;
    setSelectedIds(new Set());
    goToPage(added[added.length - 1].id);
    if (ocrPrefs.auto) runOcr(added.map((p) => p.id), { silent: true });
  }, [goToPage, ocrPrefs.auto, runOcr]);

  const importFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type));
    if (!list.length) { showToast?.(t('studio.toasts.noImages'), 'error'); return; }
    const preset = presetById(presetId);
    const items = list.map((f) => ({ blob: f, name: f.name, dpi: 300, edits: preset.edits, role: 'normal' }));
    const added = await studio.addPagesFromBlobs(items, { source: 'import' });
    afterAdd(added);
    showToast?.(t('studio.toasts.imported', { n: added.length }), 'success');
    setOpenTray(null);
  }, [studio, presetId, showToast, t, afterAdd]);

  // ---- scan --------------------------------------------------------------------
  const nextKtpRole = () => {
    if (presetId !== 'ktp') return 'normal';
    if (!pages.some((p) => p.role === 'front')) return 'front';
    if (!pages.some((p) => p.role === 'back')) return 'back';
    return 'normal';
  };

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setScanError('');
    setScanPhase(t('studio.scan.phasePrepare'));
    const t1 = setTimeout(() => setScanPhase(t('studio.scan.phaseScanning')), 1200);
    const t2 = setTimeout(() => setScanPhase(t('studio.scan.phaseTransfer')), 7000);
    try {
      const avail = Array.isArray(scanner?.available_devices) ? scanner.available_devices : [];
      const validDevice = !scanSettings.deviceId || !avail.length || avail.some((d) => d.id === scanSettings.deviceId);
      const effectiveSettings = validDevice ? scanSettings : { ...scanSettings, deviceId: '' };
      const { blob } = await acquireScan(effectiveSettings);
      const preset = presetById(presetId);
      const role = nextKtpRole();
      const added = await studio.addPagesFromBlobs([{ blob, dpi: scanSettings.resolution, edits: preset.edits, role }], { source: 'scan' });
      afterAdd(added);
      showToast?.(t('studio.toasts.scanned', { n: pages.length + 1 }), 'success');
    } catch (err) {
      const msg = err?.code === 'SCANNER_BUSY'
        ? t('studio.scan.busy', { holder: err.holder || '?', sec: err.retryAfter || 15 })
        : (err?.message || t('studio.scan.failed'));
      setScanError(msg);
      showToast?.(msg, 'error');
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setScanning(false);
      setScanPhase('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, scanSettings, scanner?.available_devices, presetId, studio, pages.length, showToast, t, afterAdd]);

  const applyPreset = (id) => {
    const p = presetById(id);
    setPresetId(id);
    setScanSettings((s) => ({ ...s, ...p.scan }));
    studio.patchDoc({ preset: id, paperSize: p.scan.paperSize });
  };

  // ---- enhance -------------------------------------------------------------------
  const onEnhanceChange = (patch) => {
    if (!activeId) return;
    const record = !dragRecorded.current;
    dragRecorded.current = true;
    studio.updateEdits(activeId, patch, { record });
  };
  const onEnhanceCommit = (patch) => {
    if (!activeId) return;
    const record = !dragRecorded.current;
    dragRecorded.current = false;
    if (Object.keys(patch).length) studio.updateEdits(activeId, patch, { record });
    else if (record) studio.updateEdits(activeId, {}, { record: false });
  };
  const applyToneToAll = () => {
    if (!activePage) return;
    const { filter, bgClean, contrast, brightness } = activePage.edits;
    const targets = pages.filter((p) => p.id !== activeId);
    if (targets.length) {
      studio.beginChange();
      for (const p of targets) studio.updateEdits(p.id, { filter, bgClean, contrast, brightness }, { record: false });
    }
    showToast?.(t('studio.toasts.appliedAll'), 'success');
  };

  // ---- crop / rotate / deskew -----------------------------------------------------
  const enterCrop = () => {
    if (!activePage) return;
    setCropDraft(activePage.edits.crop || { x: 0, y: 0, w: 1, h: 1 });
    setOpenTray('crop');
  };
  const applyCrop = () => {
    if (!activeId || !cropDraft) return;
    const full = cropDraft.x <= 0.001 && cropDraft.y <= 0.001 && cropDraft.w >= 0.999 && cropDraft.h >= 0.999;
    studio.updateEdits(activeId, { crop: full ? null : cropDraft });
    setCropDraft(null);
    setOpenTray(null);
  };
  const cancelCrop = () => { setCropDraft(null); setOpenTray(null); };
  const rotate = (delta) => {
    const ids = targetIds();
    if (!ids.length) return;
    studio.rotatePages(ids, delta);
    if (openTray === 'crop' && cropDraft) setCropDraft({ x: 0, y: 0, w: 1, h: 1 });
  };
  const onDeskewChange = (v, commit = false) => {
    if (!activeId) return;
    const record = !dragRecorded.current;
    dragRecorded.current = !commit;
    studio.updateEdits(activeId, { deskew: Math.max(-10, Math.min(10, v)) }, { record });
  };
  const autoDeskew = async () => {
    const rec = studio.getPageRecord(activeId);
    if (!rec) return;
    setDeskewing(true);
    try {
      const bmp = await decodeBlob(rec.blob);
      const canvas = renderToCanvas(bmp, { ...rec.edits, deskew: 0, crop: null, filter: 'none', bgClean: 0, brightness: 1, contrast: 1 }, { canvasFactory: mainThreadCanvasFactory, maxDim: 700, skipPixelPasses: true });
      bmp.close?.();
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const res = detectSkewAngle(img, { maxAngle: 10 });
      const angle = Number(res?.angleDegrees || 0);
      studio.updateEdits(activeId, { deskew: Math.max(-10, Math.min(10, -angle)) });
      showToast?.(t('studio.toasts.deskewed', { deg: Math.abs(angle).toFixed(1) }), 'success');
    } catch (e) {
      showToast?.(t('studio.toasts.deskewFailed'), 'error');
    } finally {
      setDeskewing(false);
    }
  };

  // ---- KTP -----------------------------------------------------------------------
  const composeKtp = async () => {
    const front = pages.find((p) => p.role === 'front');
    const back = pages.find((p) => p.role === 'back');
    if (!front || !back) return;
    setComposing(true);
    try {
      const res = await composeKtp2in1(studio.getPageRecord(front.id), studio.getPageRecord(back.id), { dpi: ktpDpi, autoDetect: true });
      const added = await studio.addPagesFromBlobs([{ blob: res.blob, dpi: ktpDpi, role: 'sheet', edits: {}, width: res.width, height: res.height }], { source: 'ktp2in1' });
      afterAdd(added);
      setOpenTray(null);
      showToast?.(t('studio.toasts.ktpDone'), 'success');
    } catch (e) {
      console.error(e);
      showToast?.(t('studio.toasts.ktpFailed'), 'error');
    } finally {
      setComposing(false);
    }
  };

  // ---- sign / marks / images ------------------------------------------------------
  const placeObject = useCallback((make) => {
    const page = activePage ? studio.getPageRecord(activePage.id) : null;
    if (!page) return;
    const center = docZoom.current?.visibleCenter(page.id) || { x: 0.5, y: 0.5 };
    const frame = pageFrame(page);
    const ann = make(page, frame, center);
    ann.x = Math.max(0, Math.min(1 - ann.w, ann.x));
    ann.y = Math.max(0, Math.min(1 - ann.h, ann.y));
    studio.addAnnotation(page.id, ann);
    setSelection({ pageId: page.id, id: ann.id });
    setTool('select');
    setOpenTray(null);
    return ann;
  }, [activePage, studio]);

  const placeImage = useCallback((img, kind, inches) => placeObject((page, frame, c) => {
    const w = Math.min(0.7, inches / frame.inW);
    const h = (w * frame.pxW * (img.height / img.width)) / frame.pxH;
    return { id: annotationId(), type: 'image', kind, src: img.src, x: c.x - w / 2, y: c.y - h / 2, w, h };
  }), [placeObject]);

  const placeSignature = (sig) => { placeImage(sig, 'signature', 2.0); showToast?.(t('studio.sign.placeHint'), 'info'); };
  const onSignatureDone = (res) => {
    setSigPadOpen(false);
    if (res.save) {
      const next = [{ id: annotationId(), src: res.src, width: res.width, height: res.height }, ...signatures].slice(0, MAX_SAVED_SIGNATURES);
      setSignatures(next);
      db.setSetting('signatures', next);
    }
    placeSignature(res);
  };
  const removeSignature = (id) => {
    const next = signatures.filter((s) => s.id !== id);
    setSignatures(next);
    db.setSetting('signatures', next);
  };
  const insertMark = (kind) => {
    if (kind === 'date') {
      const text = new Date().toLocaleDateString(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
      placeObject((page, frame, c) => {
        const fontSize = ptToFrac(FONT_SIZES[1], page);
        const w = Math.min(0.6, 2.2 / frame.inW);
        const h = (fontSize * Math.hypot(frame.pxW, frame.pxH) * 1.25) / frame.pxH;
        return { id: annotationId(), type: 'text', text, x: c.x - w / 2, y: c.y - h / 2, w, h, color: toolOpts.text.color, fontSize, bold: false, align: 'left' };
      });
      return;
    }
    placeObject((page, frame, c) => {
      const w = 0.3 / frame.inW;
      const h = (w * frame.pxW) / frame.pxH;
      return { id: annotationId(), type: 'mark', kind, x: c.x - w / 2, y: c.y - h / 2, w, h, color: toolOpts.mark.color };
    });
  };
  const insertImageFile = async (file) => {
    try { placeImage(await imageFileToDataUrl(file, 1600), 'image', 3); } catch { showToast?.(t('studio.toasts.noImages'), 'error'); }
  };
  const clearPageDrawings = () => {
    if (!activeId) return;
    studio.setAnnotations(activeId, (list) => list.filter((a) => a.type !== 'ink'));
    showToast?.(t('studio.toasts.drawingsCleared', { n: activeIndex + 1 }), 'success');
  };

  // ---- find ----------------------------------------------------------------------
  const findWords = useCallback((p) => (ocrState(p) === 'done' ? visibleWords(p.ocr.words, redactionRects(p.annotations), overlaps) : []), []);
  const matches = useMemo(() => (findOpen ? findMatches(pages, findQuery, findWords) : []), [findOpen, pages, findQuery, findWords]);
  const findHits = useMemo(() => {
    const out = {};
    matches.forEach((m, i) => { (out[m.pageId] ||= []).push(...m.rects.map((r) => ({ ...r, current: i === findIndex }))); });
    return out;
  }, [matches, findIndex]);
  useEffect(() => { setFindIndex(0); }, [findQuery]);
  const stepFind = (dir) => {
    if (!matches.length) return;
    const i = (findIndex + dir + matches.length) % matches.length;
    setFindIndex(i);
    const m = matches[i];
    setActiveId(m.pageId);
    docZoom.current?.scrollToPage(m.pageId, { offsetFrac: m.y });
  };
  useEffect(() => {
    if (!findOpen || !matches.length) return;
    const m = matches[Math.min(findIndex, matches.length - 1)];
    docZoom.current?.scrollToPage(m.pageId, { offsetFrac: m.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, matches.length]);

  // ---- export / print ---------------------------------------------------------------
  const exportPagesFor = (scope) => {
    const ids = scope === 'selected' ? targetIds() : pages.map((p) => p.id);
    return ids.map((id) => studio.getPageRecord(id)).filter(Boolean);
  };

  const buildPdf = async (recs, { paperSize, fitMode, quality, title, onProgress, searchable = true }) =>
    exportPagesToPdf(recs, { paperSize, fitMode, quality: QUALITY[quality] || 0.9, title, onProgress, searchable });

  const handleExport = async (opts, onProgress) => {
    const recs = exportPagesFor(opts.scope);
    if (!recs.length) return { method: 'cancelled' };
    const base = safeFilename(opts.filename, doc?.title || 'scan');
    const q = QUALITY[opts.quality] || 0.9;
    let blob;
    let name;
    if (opts.format === 'pdf') {
      const bytes = await buildPdf(recs, { ...opts, title: base, onProgress });
      blob = new Blob([bytes], { type: 'application/pdf' });
      name = `${base}.pdf`;
    } else if (opts.format === 'txt') {
      blob = new Blob([pagesToText(recs)], { type: 'text/plain;charset=utf-8' });
      name = `${base}.txt`;
    } else if (opts.format === 'docx') {
      blob = await pagesToDocx(recs, base);
      name = `${base}.docx`;
    } else if (opts.format === 'tiff') {
      const pix = [];
      for (let i = 0; i < recs.length; i++) {
        onProgress?.(i, recs.length);
        const r = await renderPagePixels(recs[i]);
        pix.push({ data: r.data, width: r.width, height: r.height, dpi: recs[i].dpi || 300 });
      }
      blob = encodeMultiPageTiff(pix);
      name = `${base}.tif`;
    } else {
      const mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
      const ext = opts.format === 'png' ? 'png' : 'jpg';
      const outs = [];
      for (let i = 0; i < recs.length; i++) {
        onProgress?.(i, recs.length);
        const r = await renderPageBlob(recs[i], { mime, quality: q });
        outs.push({ name: `${base}_${String(i + 1).padStart(2, '0')}.${ext}`, blob: r.blob });
      }
      if (outs.length === 1) { blob = outs[0].blob; name = `${base}.${ext}`; }
      else { blob = await createZip(outs); name = `${base}.zip`; }
    }
    const res = await saveBlob(blob, name);
    if (res.method !== 'cancelled') showToast?.(t('studio.toasts.exported', { name }), 'success');
    return { ...res, size: blob.size };
  };

  const handlePrint = async () => {
    const recs = exportPagesFor(selectedIds.size ? 'selected' : 'all');
    if (!recs.length) return;
    setPrinting(true);
    try {
      const bytes = await buildPdf(recs, { paperSize: doc?.paperSize || 'A4', fitMode: 'paper', quality: 'balanced', title: doc?.title, searchable: false });
      const blob = new Blob([bytes], { type: 'application/pdf' });
      await printBlob(blob, { filename: `${safeFilename(doc?.title)}.pdf`, printer: printerQueue || '', copies: printCopies, media: doc?.paperSize || 'A4' });
      showToast?.(t('studio.toasts.printed'), 'success');
      setPrintOpen(false);
    } catch (e) {
      showToast?.(e?.message || t('studio.toasts.printFailed'), 'error');
    } finally {
      setPrinting(false);
    }
  };

  // ---- dock ---------------------------------------------------------------------------
  const onOpenTray = (id) => {
    if (openTray === 'crop' && id !== 'crop') setCropDraft(null);
    if (id === 'crop') { enterCrop(); return; }
    setOpenTray(id);
  };

  // ---- keyboard ------------------------------------------------------------------------
  const selectedObject = useMemo(() => {
    if (!selection) return null;
    const p = pages.find((x) => x.id === selection.pageId);
    return p ? (p.annotations || []).find((a) => a.id === selection.id) || null : null;
  }, [pages, selection]);

  useEffect(() => {
    const onKey = (e) => {
      if (exportOpen || printOpen || sigPadOpen) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); studio.undo(); return; }
      if ((mod && key === 'y') || (mod && e.shiftKey && key === 'z')) { e.preventDefault(); studio.redo(); return; }
      if (mod && key === 's') { e.preventDefault(); if (pages.length) setExportOpen(true); return; }
      if (mod && key === 'p') { e.preventDefault(); if (pages.length) setPrintOpen(true); return; }
      if (mod && key === 'f') { e.preventDefault(); if (pages.length) setFindOpen(true); return; }
      if (mod && key === 'c' && selectedObject) { e.preventDefault(); clipboard.current = selectedObject; return; }
      if (mod && key === 'v' && clipboard.current && activeId) {
        e.preventDefault();
        const copy = { ...translate(clipboard.current, 0.02, 0.02), id: annotationId() };
        clipboard.current = copy;
        studio.addAnnotation(activeId, copy);
        setSelection({ pageId: activeId, id: copy.id });
        return;
      }
      if (mod && key === 'd' && selectedObject) {
        e.preventDefault();
        const copy = { ...translate(selectedObject, 0.02, 0.02), id: annotationId() };
        studio.addAnnotation(selection.pageId, copy);
        setSelection({ pageId: selection.pageId, id: copy.id });
        return;
      }
      if (mod && key === 'a') { e.preventDefault(); setSelectedIds(new Set(pages.map((p) => p.id))); return; }
      if (mod) return;
      if (e.key === 'Escape') {
        if (openTray === 'crop') cancelCrop();
        else if (openTray) setOpenTray(null);
        else if (findOpen) setFindOpen(false);
        else if (selection) setSelection(null);
        else if (tool !== 'select') changeTool('select');
        setSelectedIds(new Set());
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedObject) { api.remove(selection.pageId, selection.id); return; }
        const ids = targetIds();
        if (ids.length) studio.removePages(ids);
        return;
      }
      if (selectedObject && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : 0.002;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        api.update(selection.pageId, selection.id, translate(selectedObject, dx, dy), { record: !e.repeat });
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (activeIndex < pages.length - 1) { e.preventDefault(); select(pages[activeIndex + 1].id); } return; }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (activeIndex > 0) { e.preventDefault(); select(pages[activeIndex - 1].id); } return; }
      if (!pages.length) return;
      if (key === 'v') { changeTool('select'); return; }
      if (key === 'h') { changeTool('pan'); return; }
      if (key === 'p') { changeTool('pen'); return; }
      if (key === 'e') { changeTool('eraser'); return; }
      if (key === 't') { changeTool('text'); return; }
      if (key === 'r') { rotate(e.shiftKey ? -90 : 90); return; }
      if (key === 'c') { enterCrop(); return; }
      if (e.key === '+' || e.key === '=') { zoomApi.current?.zoomBy(1.25); return; }
      if (e.key === '-') { zoomApi.current?.zoomBy(1 / 1.25); return; }
      if (e.key === '0') { zoomApi.current?.fit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- render ------------------------------------------------------------------------
  if (loading) {
    return <div className="h-[100dvh] flex items-center justify-center text-slate-400 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" />{t('common.loading')}</div>;
  }
  if (!doc) {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center text-center p-8">
        <AlertTriangle className="w-8 h-8 text-amber-400" />
        <p className="mt-3 text-sm text-slate-300">{t('studio.workbench.notFound')}</p>
        <Button className="mt-4" onClick={onBack} icon={ArrowLeft}>{t('studio.workbench.backToLibrary')}</Button>
      </div>
    );
  }

  const saveLabel = studio.saveState === 'saving' ? t('studio.header.saving') : studio.saveState === 'error' ? t('studio.header.saveError') : t('studio.header.saved');
  const labels = {
    duplicate: t('studio.obj.duplicate'), delete: t('studio.obj.delete'), bold: t('studio.obj.bold'), align: t('studio.obj.align'),
    smaller: t('studio.obj.smaller'), larger: t('studio.obj.larger'), editText: t('studio.obj.editText'), fill: t('studio.obj.fill'),
    noFill: t('studio.obj.noFill'), blackout: t('studio.obj.blackout'), whiteout: t('studio.obj.whiteout'), typeHere: t('studio.obj.typeHere')
  };
  const railProps = {
    pages, activeId, selectedIds,
    onToggleSelect: toggleSelect,
    onSelectRange: selectRange,
    onReorder: studio.reorder,
    onRotate: (ids, d) => studio.rotatePages(ids, d),
    onDelete: (ids) => { studio.removePages(ids); setSelectedIds(new Set()); },
    onDuplicate: async (id) => { const p = await studio.duplicate(id); if (p) select(p.id); },
    onClearSelection: () => setSelectedIds(new Set()),
    onSelectAll: () => setSelectedIds(new Set(pages.map((p) => p.id)))
  };
  const exportScopeIds = { all: pages.map((p) => p.id), selected: targetIds() };
  const activeOcrState = activePage ? ocrState(activePage) : 'none';

  return (
    <div className="h-[100dvh] flex flex-col bg-[#070a11] text-slate-100 overflow-hidden">
      {/* Header */}
      <header className="h-14 shrink-0 px-2 sm:px-3 flex items-center gap-1.5 bg-[#0b0f18]/90 backdrop-blur-xl border-b border-white/[0.06] z-30">
        <IconButton icon={ArrowLeft} label={t('studio.workbench.backToLibrary')} onClick={onBack} />
        {!isPhone && <IconButton icon={PanelLeft} label={t('studio.header.togglePages')} active={railOpen} onClick={() => setRailOpen((v) => !v)} size="md" />}
        <div className="min-w-0 flex-1 flex items-center gap-2 px-1">
          {titleDraft !== null ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => { studio.rename(titleDraft.trim() || doc.title); setTitleDraft(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setTitleDraft(null); }}
              className="h-9 w-full max-w-md px-3 rounded-lg bg-white/[0.06] border border-manta-500/40 text-sm font-semibold focus:outline-none"
            />
          ) : (
            <button type="button" onClick={() => setTitleDraft(doc.title)} className="min-w-0 h-9 px-2.5 rounded-lg hover:bg-white/[0.06] flex items-center gap-2 text-left" title={t('studio.header.renameHint')}>
              <span className="truncate text-sm font-bold">{doc.title}</span>
              <span className="hidden sm:inline shrink-0 px-1.5 py-0.5 rounded-md bg-white/[0.06] text-[10px] font-semibold text-slate-400">{pages.length} {t('studio.common.pages')}</span>
            </button>
          )}
          <span className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-medium ${studio.saveState === 'error' ? 'text-rose-400' : 'text-slate-500'}`}>
            {studio.saveState === 'saving' ? <Loader2 className="w-3 h-3 animate-spin" /> : studio.saveState === 'error' ? <AlertTriangle className="w-3 h-3" /> : <Check className="w-3 h-3 text-manta-500" />}
            {saveLabel}
          </span>
          <PrototypeBadge className="hidden sm:inline-flex" />
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon={Undo2} label={`${t('studio.header.undo')} (Ctrl+Z)`} onClick={studio.undo} disabled={!studio.canUndo} size="sm" />
          {!isPhone && <IconButton icon={Redo2} label={`${t('studio.header.redo')} (Ctrl+Y)`} onClick={studio.redo} disabled={!studio.canRedo} size="sm" />}
          <IconButton icon={Search} label={`${t('studio.tools.find')} (Ctrl+F)`} onClick={() => setFindOpen((v) => !v)} active={findOpen} disabled={!pages.length} size="sm" />
          <div className="hidden sm:block h-5 w-px bg-white/10 mx-1" />
          {isPhone
            ? <IconButton icon={Printer} label={t('studio.tools.print')} onClick={() => setPrintOpen(true)} disabled={!pages.length} size="sm" />
            : <Button size="sm" variant="secondary" icon={Printer} disabled={!pages.length} onClick={() => setPrintOpen(true)}>{t('studio.tools.print')}</Button>}
          <Button size="sm" variant="primary" icon={Download} disabled={!pages.length} onClick={() => setExportOpen(true)}>{t('studio.header.export')}</Button>
          <button type="button" onClick={() => setLanguage(lang === 'id' ? 'en' : 'id')} className="hidden md:flex h-9 px-2 rounded-lg hover:bg-white/10 items-center gap-1 text-[11px] font-bold text-slate-300" title={t('studio.header.language')}>
            <Languages className="w-4 h-4" />{lang.toUpperCase()}
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex relative">
        {!isPhone && railOpen && (
          <aside className="w-[216px] shrink-0 border-r border-white/[0.06] bg-[#0b0f18]/60 flex flex-col">
            <PagesRail {...railProps} onSelect={select} />
          </aside>
        )}

        <div className="flex-1 min-w-0 relative bg-[#0a0d14]">
          {pages.length > 0 ? (
            <DocumentView
              pages={pages}
              activeId={activeId}
              onActivate={onActivateFromView}
              tool={tool}
              toolOpts={toolOpts}
              selection={selection}
              onSelect={selectObject}
              editing={editing}
              onEditText={onEditText}
              api={api}
              zoomApi={docZoom}
              findHits={findOpen ? findHits : null}
              isTouch={isPhone}
              labels={labels}
              onZoomChange={(z) => setZoomPct(Math.round(z * 100))}
            />
          ) : (
            <Stage page={null} zoomApi={stageZoom} onToggleCompare={() => {}} />
          )}

          {focusMode && (
            <div className="absolute inset-0 z-20 bg-[#0a0d14]">
              <Stage
                page={studio.getPageRecord(activePage.id)}
                cropMode={openTray === 'crop'}
                cropDraft={cropDraft}
                onCropDraft={setCropDraft}
                compareOriginal={compareOriginal}
                onToggleCompare={setCompareOriginal}
                zoomApi={stageZoom}
              />
            </div>
          )}

          {!focusMode && pages.length > 0 && (
            <ObjectsPanel
              pages={pages}
              activeId={activeId}
              selection={selection}
              onSelect={selectObject}
              onReveal={(pageId, y) => docZoom.current?.scrollToPage(pageId, { offsetFrac: y })}
              api={api}
            />
          )}
          {!focusMode && findOpen && (
            <FindBar
              query={findQuery}
              onQuery={setFindQuery}
              count={matches.length}
              index={Math.min(findIndex, Math.max(0, matches.length - 1))}
              onStep={stepFind}
              onClose={() => setFindOpen(false)}
              hasOcr={pages.some((p) => ocrState(p) === 'done')}
            />
          )}

          {activePage && (
            <div className="absolute bottom-[96px] left-3 z-20 px-2.5 py-1 rounded-full bg-black/70 border border-white/10 text-[11px] font-mono text-slate-200 pointer-events-none flex items-center gap-2">
              {activeIndex + 1} / {pages.length}
              {ocrProgress[activeId] !== undefined && <Loader2 className="w-3 h-3 animate-spin text-sky-300" />}
            </div>
          )}

          <ToolDock
            tool={tool}
            onTool={changeTool}
            openTray={openTray}
            onOpenTray={onOpenTray}
            isPhone={isPhone}
            buttonRefs={buttonRefs}
            pageCount={pages.length}
            shape={toolOpts.shape.shape}
            drawTool={drawTool}
            zoomPct={focusMode ? Math.round((stageZoom.current?.scale || 1) * 100) : zoomPct}
            onZoomIn={() => zoomApi.current?.zoomBy(1.25)}
            onZoomOut={() => zoomApi.current?.zoomBy(1 / 1.25)}
            onFit={() => zoomApi.current?.fit()}
            ocrBusy={ocrBusy}
          />

          {/* Trays */}
          <Tray open={openTray === 'scan'} onClose={() => setOpenTray(null)} title={t('studio.tools.scan')} anchorRef={anchorRef} isPhone={isPhone} width={380}>
            <ScanTray
              scanner={scanner}
              settings={scanSettings}
              onChange={(patch) => setScanSettings((s) => ({ ...s, ...patch }))}
              onScan={runScan}
              scanning={scanning}
              phase={scanPhase}
              error={scanError}
              onRefreshScanner={onRefreshScanner}
              presetId={presetId}
              onPreset={applyPreset}
            />
          </Tray>
          <Tray open={openTray === 'import'} onClose={() => setOpenTray(null)} title={t('studio.tools.import')} anchorRef={anchorRef} isPhone={isPhone} width={340}>
            <ImportTray onFiles={importFiles} />
          </Tray>
          <Tray open={openTray === 'draw'} onClose={() => setOpenTray(null)} title={t('studio.tools.draw')} anchorRef={anchorRef} isPhone={isPhone} width={360}>
            <DrawTray tool={tool} onTool={changeTool} opts={toolOpts} onOpts={setOpt} onClearPage={clearPageDrawings} pageNumber={activeIndex + 1} />
          </Tray>
          <Tray open={openTray === 'shapes'} onClose={() => setOpenTray(null)} title={t('studio.tools.shapes')} anchorRef={anchorRef} isPhone={isPhone} width={400}>
            <ShapesTray opts={toolOpts} onOpts={setOpt} onPick={(shape) => { setOpt('shape', { shape }); changeTool('shape'); setOpenTray(null); }} />
          </Tray>
          <Tray open={openTray === 'sign'} onClose={() => setOpenTray(null)} title={t('studio.tools.sign')} anchorRef={anchorRef} isPhone={isPhone} width={360}>
            <SignTray signatures={signatures} onUseSignature={placeSignature} onRemoveSignature={removeSignature} onNewSignature={() => { setOpenTray(null); setSigPadOpen(true); }} onMark={insertMark} onImage={insertImageFile} />
          </Tray>
          <Tray open={openTray === 'redact'} onClose={() => setOpenTray(null)} title={t('studio.tools.redact')} anchorRef={anchorRef} isPhone={isPhone} width={340}>
            <RedactTray opts={toolOpts} onOpts={setOpt} />
          </Tray>
          <Tray open={openTray === 'ocr'} onClose={() => setOpenTray(null)} title={t('studio.ocr.title')} anchorRef={anchorRef} isPhone={isPhone} width={380}>
            <OcrTray
              supported={ocrSupported()}
              page={activePage}
              state={activeOcrState}
              progress={ocrProgress[activeId]}
              queuedCount={Object.keys(ocrProgress).length}
              remaining={ocrMissingIds(pages.map((p) => p.id)).length}
              busy={ocrBusy}
              lang={ocrPrefs.lang}
              onLang={(l) => setOcrPrefs((p) => ({ ...p, lang: l }))}
              auto={ocrPrefs.auto}
              onAuto={(v) => setOcrPrefs((p) => ({ ...p, auto: v }))}
              onRunPage={() => activeId && runOcr([activeId])}
              onRunAll={() => runOcr(ocrMissingIds(pages.map((p) => p.id)))}
              onCopyPage={() => copyText(pagesToText([studio.getPageRecord(activeId)]))}
              onCopyAll={() => copyText(pagesToText(pages.map((p) => studio.getPageRecord(p.id))))}
            />
          </Tray>
          <Tray open={openTray === 'adjust'} onClose={() => setOpenTray(null)} title={t('studio.adjust.title')} anchorRef={anchorRef} isPhone={isPhone} width={380}>
            <AdjustTray hasPage={Boolean(activePage)} onRotate={rotate} onOpen={(id) => onOpenTray(id)} />
          </Tray>
          <Tray open={openTray === 'enhance' && Boolean(activePage)} onClose={() => setOpenTray(null)} title={t('studio.tools.enhance')} anchorRef={anchorRef} isPhone={isPhone} width={380} persistent>
            <EnhanceTray edits={activePage?.edits} onChange={onEnhanceChange} onCommit={onEnhanceCommit} onApplyAll={applyToneToAll} pageCount={pages.length} />
          </Tray>
          <Tray open={openTray === 'crop' && Boolean(activePage)} onClose={cancelCrop} title={t('studio.tools.crop')} anchorRef={anchorRef} isPhone={isPhone} width={360} persistent>
            <CropTray
              page={activePage}
              edits={activePage?.edits}
              draft={cropDraft}
              onDraft={setCropDraft}
              onApply={applyCrop}
              onCancel={cancelCrop}
              onAutoDeskew={autoDeskew}
              deskewing={deskewing}
              onDeskewChange={onDeskewChange}
              onRotate={rotate}
            />
          </Tray>
          <Tray open={openTray === 'ktp'} onClose={() => setOpenTray(null)} title={t('studio.tools.ktp')} anchorRef={anchorRef} isPhone={isPhone} width={380} persistent>
            <KtpTray pages={pages} activeId={activeId} onSetRole={(id, role) => { for (const p of pages) if (p.role === role && p.id !== id) studio.setRole(p.id, 'normal'); studio.setRole(id, role); }} onCompose={composeKtp} composing={composing} dpi={ktpDpi} onDpi={setKtpDpi} />
          </Tray>
          <Tray open={openTray === 'pages' && isPhone} onClose={() => setOpenTray(null)} title={t('studio.tools.pages')} anchorRef={anchorRef} isPhone={isPhone}>
            <div className="h-[46vh]">
              <PagesRail compact {...railProps} onSelect={(id) => { select(id); setOpenTray(null); }} />
            </div>
          </Tray>
        </div>
      </div>

      <ExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        doc={doc}
        pageCount={pages.length}
        selectedCount={selectedIds.size || (activeId ? 1 : 0)}
        onExport={handleExport}
        ocrMissing={{ all: ocrMissingIds(exportScopeIds.all).length, selected: ocrMissingIds(exportScopeIds.selected).length }}
        onRunOcr={(scope) => runOcr(ocrMissingIds(exportScopeIds[scope] || exportScopeIds.all))}
        ocrBusy={ocrBusy}
      />

      <SignaturePad open={sigPadOpen} onClose={() => setSigPadOpen(false)} onDone={onSignatureDone} />

      <Modal
        open={printOpen}
        onClose={() => !printing && setPrintOpen(false)}
        title={t('studio.print.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPrintOpen(false)} disabled={printing}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={printing ? Loader2 : Printer} onClick={handlePrint} disabled={printing || !pages.length}>{printing ? t('studio.print.sending') : t('studio.print.send')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-300">{t('studio.print.desc', { n: selectedIds.size || pages.length, paper: PAPER_SIZES[doc.paperSize]?.name || 'A4' })}</p>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{t('studio.print.copies')}</span>
            <Segmented size="sm" value={printCopies} onChange={setPrintCopies} options={[1, 2, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
          </div>
          {!printerQueue && <p className="text-[11px] text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{t('studio.print.noPrinter')}</p>}
        </div>
      </Modal>
    </div>
  );
}
