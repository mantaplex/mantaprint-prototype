import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScanLine, Upload, FolderOpen, MoreHorizontal, Pin, PinOff, Copy, Trash2, Pencil,
  HardDrive, FileText, Search, ShieldCheck, Home, Languages, Plus, ImagePlus
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import * as db from '../db/studioDb.js';
import { Button, Modal, formatBytes, formatDate, useIsPhone } from './ui.jsx';
import { PrototypeBadge } from '../../shell/Prototype.jsx';

function CoverThumb({ blob, title }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-600">
        <FileText className="w-10 h-10" />
      </div>
    );
  }
  return <img src={url} alt={title} className="w-full h-full object-cover" draggable={false} />;
}

function DocCard({ doc, onOpen, onRename, onDuplicate, onDelete, onPin, lang, t }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menu]);

  return (
    <div className="group relative rounded-2xl bg-slate-900/70 border border-white/[0.07] hover:border-manta-500/40 hover:shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_20px_40px_-20px_rgba(0,0,0,0.8)] transition-all duration-200 overflow-hidden">
      <button type="button" onClick={() => onOpen(doc)} className="block w-full text-left" aria-label={`${t('studio.library.open')} ${doc.title}`}>
        <div className="aspect-[3/4] bg-[#0a0d14] overflow-hidden relative">
          <div className="absolute inset-3 rounded-md bg-white shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)] overflow-hidden">
            <CoverThumb blob={doc.cover} title={doc.title} />
          </div>
          {doc.pinned && (
            <span className="absolute top-2 left-2 h-6 w-6 rounded-full bg-manta-600 text-white flex items-center justify-center shadow"><Pin className="w-3 h-3" /></span>
          )}
          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-[10px] font-semibold text-slate-200 border border-white/10">
            {doc.pageCount || 0} {t('studio.common.pages')}
          </span>
        </div>
        <div className="px-3.5 pt-3 pb-3.5">
          <div className="text-sm font-semibold text-slate-100 truncate" title={doc.title}>{doc.title}</div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5">
            <span>{formatDate(doc.updatedAt, lang)}</span>
            <span aria-hidden>·</span>
            <span>{formatBytes(doc.sizeBytes)}</span>
          </div>
        </div>
      </button>
      <div ref={menuRef} className="absolute top-2 right-2">
        <button
          type="button"
          aria-label={t('studio.library.more')}
          onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}
          className={`h-8 w-8 rounded-lg bg-black/60 border border-white/10 text-slate-200 flex items-center justify-center transition-opacity ${menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'}`}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {menu && (
          <div className="absolute right-0 mt-1 w-44 rounded-xl bg-slate-900 border border-white/10 shadow-2xl p-1 z-20 animate-pop-up">
            {[
              { icon: FolderOpen, label: t('studio.library.open'), fn: () => onOpen(doc) },
              { icon: Pencil, label: t('studio.library.rename'), fn: () => onRename(doc) },
              { icon: doc.pinned ? PinOff : Pin, label: doc.pinned ? t('studio.library.unpin') : t('studio.library.pin'), fn: () => onPin(doc) },
              { icon: Copy, label: t('studio.library.duplicate'), fn: () => onDuplicate(doc) },
              { icon: Trash2, label: t('studio.library.delete'), fn: () => onDelete(doc), danger: true }
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => { setMenu(false); item.fn(); }}
                className={`w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-xs font-medium text-left ${item.danger ? 'text-rose-300 hover:bg-rose-500/10' : 'text-slate-200 hover:bg-white/10'}`}
              >
                <item.icon className="w-4 h-4" />{item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Library({ onOpenDocument, onNewScan, onImport, onNavigateHome, scanner, showToast }) {
  const { t, lang, setLanguage } = useI18n();
  const isPhone = useIsPhone();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [renameDoc, setRenameDoc] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteDoc, setDeleteDoc] = useState(null);
  const importRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await db.listDocuments();
      setDocs(list);
      setStorage(await db.getStorageEstimate());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return db.subscribe(() => refresh());
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q)) : docs;
  }, [docs, query]);

  const handleFiles = (files) => {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type));
    if (!list.length) { showToast?.(t('studio.toasts.noImages'), 'error'); return; }
    onImport(list);
  };

  const scannerConnected = Boolean(scanner?.connected);
  const usedPct = storage.quota ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : 0;

  return (
    <div className="min-h-[100dvh] bg-[#070a11] text-slate-100 flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-30 h-14 px-4 sm:px-6 flex items-center gap-3 bg-[#070a11]/85 backdrop-blur-xl border-b border-white/[0.06]">
        <button type="button" onClick={onNavigateHome} className="h-10 px-2.5 rounded-xl hover:bg-white/10 flex items-center gap-2 text-slate-300" title={t('studio.header.home')}>
          <Home className="w-4 h-4" />
          <span className="hidden sm:inline text-xs font-semibold">MantaPrint Hub</span>
        </button>
        <div className="h-5 w-px bg-white/10" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-8 w-8 rounded-lg bg-manta-500/15 border border-manta-500/30 text-manta-300 flex items-center justify-center"><ScanLine className="w-4 h-4" /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold leading-tight truncate">MantaPageScan Studio</span>
              <PrototypeBadge />
            </div>
            <div className="text-[10px] text-slate-500 leading-tight hidden sm:block">{t('studio.library.tagline')}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`hidden md:inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full text-[11px] font-semibold border ${scannerConnected ? 'bg-manta-500/10 border-manta-500/30 text-manta-300' : scanner?.firmware_required ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${scannerConnected ? 'bg-manta-400 animate-pulse' : scanner?.firmware_required ? 'bg-amber-400' : 'bg-slate-500'}`} />
            {scannerConnected ? (scanner?.name || t('studio.scanner.connected')) : scanner?.firmware_required ? t('studio.scanner.needsFirmware', { model: scanner.firmware_required.model }) : t('studio.scanner.notConnected')}
          </span>
          <button
            type="button"
            onClick={() => setLanguage(lang === 'id' ? 'en' : 'id')}
            className="h-9 px-2.5 rounded-xl hover:bg-white/10 flex items-center gap-1.5 text-xs font-bold text-slate-300"
            title={t('studio.header.language')}
          >
            <Languages className="w-4 h-4" />{lang.toUpperCase()}
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Hero / actions */}
        <section
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          className={`relative rounded-3xl border p-5 sm:p-7 overflow-hidden transition-colors ${dragOver ? 'border-manta-400 bg-manta-500/10' : 'border-white/[0.08] bg-gradient-to-br from-slate-900/80 to-slate-900/30'}`}
        >
          <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-manta-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col lg:flex-row lg:items-center gap-5">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">{t('studio.library.heroTitle')}</h1>
              <p className="text-sm text-slate-400 mt-1 max-w-xl">{t('studio.library.heroDesc')}</p>
              <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-manta-500/10 border border-manta-500/25 text-manta-300 text-[11px] font-semibold">
                <ShieldCheck className="w-3.5 h-3.5" />{t('studio.library.localBadge')}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5 shrink-0">
              <Button variant="primary" size="lg" icon={ScanLine} onClick={onNewScan} disabled={!scannerConnected && false}>
                {t('studio.library.newScan')}
              </Button>
              <Button variant="secondary" size="lg" icon={ImagePlus} onClick={() => importRef.current?.click()}>
                {t('studio.library.importImages')}
              </Button>
              <input
                ref={importRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
          </div>
        </section>

        {/* Toolbar */}
        <div className="mt-7 flex flex-col sm:flex-row sm:items-center gap-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            {t('studio.library.recent')}
            <span className="px-1.5 py-0.5 rounded-md bg-white/5 text-[10px] text-slate-400 font-semibold">{docs.length}</span>
          </h2>
          <div className="sm:ml-auto flex items-center gap-3">
            <label className="relative">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('studio.library.search')}
                className="h-10 w-full sm:w-64 pl-9 pr-3 rounded-xl bg-white/[0.05] border border-white/10 text-sm placeholder:text-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </label>
            <div className="hidden md:flex items-center gap-2 text-[11px] text-slate-400" title={t('studio.library.storageHint')}>
              <HardDrive className="w-4 h-4" />
              <div className="w-24 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-manta-500" style={{ width: `${usedPct}%` }} />
              </div>
              <span className="font-mono">{formatBytes(storage.usage)}</span>
            </div>
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="aspect-[3/4] rounded-2xl bg-white/[0.04] animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-6 rounded-3xl border border-dashed border-white/10 p-10 text-center">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-white/[0.04] flex items-center justify-center text-slate-500"><Plus className="w-6 h-6" /></div>
            <h3 className="mt-4 text-sm font-bold text-slate-200">{query ? t('studio.library.noResults') : t('studio.library.emptyTitle')}</h3>
            <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">{query ? '' : t('studio.library.emptyDesc')}</p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map((d) => (
              <DocCard
                key={d.id}
                doc={d}
                lang={lang}
                t={t}
                onOpen={onOpenDocument}
                onRename={(doc) => { setRenameDoc(doc); setRenameValue(doc.title); }}
                onDuplicate={async (doc) => { await db.duplicateDocument(doc.id); showToast?.(t('studio.toasts.duplicated'), 'success'); }}
                onDelete={(doc) => setDeleteDoc(doc)}
                onPin={(doc) => db.updateDocument(doc.id, { pinned: !doc.pinned })}
              />
            ))}
          </div>
        )}

        <p className="mt-10 text-[11px] text-slate-600 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" />{t('studio.library.footerPrivacy')}
        </p>
      </main>

      <Modal
        open={Boolean(renameDoc)}
        onClose={() => setRenameDoc(null)}
        title={t('studio.library.rename')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameDoc(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={async () => { await db.updateDocument(renameDoc.id, { title: renameValue.trim() || renameDoc.title }); setRenameDoc(null); }}>{t('common.save')}</Button>
          </>
        }
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={async (e) => { if (e.key === 'Enter') { await db.updateDocument(renameDoc.id, { title: renameValue.trim() || renameDoc.title }); setRenameDoc(null); } }}
          className="h-11 w-full px-3 rounded-xl bg-white/[0.05] border border-white/10 text-sm focus:outline-none focus:border-manta-500/50"
        />
      </Modal>

      <Modal
        open={Boolean(deleteDoc)}
        onClose={() => setDeleteDoc(null)}
        title={t('studio.library.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteDoc(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" icon={Trash2} onClick={async () => { await db.deleteDocument(deleteDoc.id); setDeleteDoc(null); showToast?.(t('studio.toasts.deleted'), 'info'); }}>{t('common.delete')}</Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{t('studio.library.deleteDesc', { title: deleteDoc?.title || '' })}</p>
      </Modal>
    </div>
  );
}
