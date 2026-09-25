import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, X, Search, Trash2, Copy, PenTool, Highlighter, Square, Type, FileSignature, Image as ImageIcon, Check, ShieldCheck, Layers } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { annotationId, translate, getBounds } from '../engine/annotations.js';

function describe(a, t) {
  switch (a.type) {
    case 'ink': return a.tool === 'highlighter'
      ? { icon: Highlighter, label: t('studio.objects.types.highlighter'), color: a.color }
      : { icon: PenTool, label: t('studio.objects.types.ink'), color: a.color };
    case 'shape': return { icon: Square, label: t(`studio.shapes.${a.shape}`), color: a.stroke };
    case 'text': return { icon: Type, label: t('studio.objects.types.text'), color: a.color, preview: a.text };
    case 'image': return a.kind === 'signature'
      ? { icon: FileSignature, label: t('studio.objects.types.signature'), color: '#1d4ed8' }
      : { icon: ImageIcon, label: t('studio.objects.types.image'), color: '#64748b' };
    case 'mark': return { icon: Check, label: t(`studio.sign.${a.kind}`), color: a.color };
    case 'redact': return { icon: ShieldCheck, label: t('studio.objects.types.redact'), color: '#0f172a', preview: a.label || (a.style === 'white' ? t('studio.redact.whiteout') : t('studio.redact.blackout')) };
    default: return { icon: Layers, label: a.type, color: '#64748b' };
  }
}

/**
 * "Objects" badge at the top right of the document with a flyout listing every object on
 * every page: jump to it, duplicate, delete and edit its basic properties.
 */
/** Input with local state so typing is never slowed or cut by store round-trips. */
function LocalField({ as: Tag = 'input', value, onValue, ...rest }) {
  const [v, setV] = useState(value || '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value || ''); }, [value]);
  return (
    <Tag
      {...rest}
      value={v}
      onFocus={(e) => { focused.current = true; rest.onFocus?.(e); }}
      onBlur={() => { focused.current = false; }}
      onChange={(e) => { setV(e.target.value); onValue(e.target.value); }}
    />
  );
}

export default function ObjectsPanel({ pages, activeId, selection, onSelect, onReveal, api }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('all');
  const [q, setQ] = useState('');
  const ref = useRef(null);

  const all = useMemo(() => {
    const out = [];
    pages.forEach((p, i) => (p.annotations || []).forEach((a) => out.push({ a, pageId: p.id, pageNo: i + 1, page: p })));
    return out;
  }, [pages]);

  const list = useMemo(() => all.filter(({ a, pageId }) => {
    if (scope === 'page' && pageId !== activeId) return false;
    if (!q.trim()) return true;
    const d = describe(a, t);
    return `${d.label} ${d.preview || ''}`.toLowerCase().includes(q.trim().toLowerCase());
  }), [all, scope, activeId, q, t]);

  const selected = selection ? all.find((x) => x.pageId === selection.pageId && x.a.id === selection.id) : null;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!all.length) return null;

  const pick = (item) => {
    onSelect(item.pageId, item.a.id);
    onReveal(item.pageId, getBounds(item.a).y);
  };

  const duplicate = (item) => {
    const copy = { ...translate(item.a, 0.02, 0.02), id: annotationId() };
    api.add(item.pageId, copy);
    onSelect(item.pageId, copy.id);
  };

  const sd = selected ? describe(selected.a, t) : null;

  return (
    <div ref={ref} className="absolute top-3 right-3 z-30" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`h-9 px-3 rounded-full flex items-center gap-2 text-xs font-bold shadow-lg backdrop-blur border transition-colors ${
          open ? 'bg-sky-600 text-white border-sky-500' : selected ? 'bg-slate-900/95 text-white border-sky-500/80 ring-2 ring-sky-500/30' : 'bg-slate-900/90 text-slate-200 border-white/10 hover:bg-slate-800'
        }`}
        title={t('studio.objects.title')}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span className="hidden sm:inline max-w-40 truncate">{sd ? sd.label : t('studio.objects.button')}</span>
        <span className={`px-1.5 rounded-full text-[10px] font-mono ${open ? 'bg-white/20' : 'bg-white/10'}`}>{all.length}</span>
      </button>

      {open && (
        <div className="absolute top-11 right-0 w-[min(340px,calc(100vw-24px))] max-h-[70vh] flex flex-col rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl overflow-hidden animate-pop-up">
          <div className="p-3 border-b border-white/5 flex items-center justify-between">
            <span className="text-xs font-black text-slate-100 flex items-center gap-2"><SlidersHorizontal className="w-4 h-4 text-sky-400" />{t('studio.objects.title')}<span className="px-1.5 rounded-full bg-white/10 text-[10px] font-mono">{all.length}</span></span>
            <div className="flex items-center gap-1">
              {selected && <button type="button" onClick={() => onSelect(null, null)} className="text-[10px] font-bold text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-white/10">{t('studio.objects.deselect')}</button>}
              <button type="button" onClick={() => setOpen(false)} className="h-7 w-7 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={t('studio.find.close')}><X className="w-3.5 h-3.5" /></button>
            </div>
          </div>
          <div className="p-2 border-b border-white/5 space-y-2">
            <div className="flex gap-1.5">
              {[['all', `${t('studio.objects.all')} (${all.length})`], ['page', `${t('studio.objects.thisPage')} (${all.filter((x) => x.pageId === activeId).length})`]].map(([v, label]) => (
                <button key={v} type="button" onClick={() => setScope(v)} className={`flex-1 py-1 rounded-lg text-[10px] font-bold border ${scope === v ? 'bg-sky-500/15 text-sky-200 border-sky-500/40' : 'text-slate-400 border-transparent hover:bg-white/5'}`}>{label}</button>
              ))}
            </div>
            {all.length > 3 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('studio.objects.filter')} className="w-full h-8 pl-8 pr-2 rounded-lg bg-black/30 border border-white/10 text-[11px] text-slate-100 focus:outline-none focus:border-sky-500/50" />
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
            {list.length === 0 ? (
              <div className="py-8 text-center px-4">
                <Layers className="w-7 h-7 mx-auto mb-2 text-slate-600" />
                <p className="text-xs font-bold text-slate-300">{q ? t('studio.objects.noMatch') : t('studio.objects.empty')}</p>
                {!q && <p className="text-[10px] text-slate-500 mt-1">{t('studio.objects.emptyHint')}</p>}
              </div>
            ) : list.map((item) => {
              const d = describe(item.a, t);
              const isSel = selected && selected.a.id === item.a.id && selected.pageId === item.pageId;
              return (
                <div
                  key={`${item.pageId}:${item.a.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(item)}
                  onKeyDown={(e) => { if (e.key === 'Enter') pick(item); }}
                  className={`group p-2 rounded-xl border flex items-center gap-2.5 cursor-pointer ${isSel ? 'border-sky-500 bg-sky-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/15'}`}
                >
                  <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0 border border-white/10" style={{ background: `${d.color}22`, color: d.color === '#0f172a' ? '#cbd5e1' : d.color }}>
                    <d.icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-slate-100 truncate">{d.label}</span>
                      <span className="text-[9px] font-mono px-1 rounded bg-white/10 text-slate-400 shrink-0">{t('studio.objects.page', { n: item.pageNo })}</span>
                    </span>
                    {d.preview && <span className="block text-[10px] text-slate-500 truncate">{d.preview}</span>}
                  </span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); duplicate(item); }} className="h-7 w-7 rounded-md text-slate-500 hover:text-sky-300 hover:bg-white/10 flex items-center justify-center" title={t('studio.obj.duplicate')} aria-label={t('studio.obj.duplicate')}><Copy className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); api.remove(item.pageId, item.a.id); }} className="h-7 w-7 rounded-md text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 flex items-center justify-center" title={t('studio.obj.delete')} aria-label={t('studio.obj.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              );
            })}
          </div>
          {selected && (
            <div className="p-3 border-t border-white/5 space-y-2 bg-black/20">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('studio.objects.properties')} · {sd.label}</div>
              {selected.a.type === 'text' && (
                <LocalField
                  as="textarea"
                  key={selected.a.id}
                  value={selected.a.text}
                  rows={3}
                  onFocus={() => api.beginChange()}
                  onValue={(text) => api.update(selected.pageId, selected.a.id, { text }, { record: false })}
                  className="w-full rounded-lg bg-black/30 border border-white/10 text-xs text-slate-100 p-2 focus:outline-none focus:border-sky-500/50"
                  aria-label={t('studio.objects.text')}
                />
              )}
              {selected.a.type === 'redact' && (
                <LocalField
                  key={selected.a.id}
                  value={selected.a.label || ''}
                  maxLength={40}
                  onFocus={() => api.beginChange()}
                  onValue={(label) => api.update(selected.pageId, selected.a.id, { label }, { record: false })}
                  placeholder={t('studio.redact.label')}
                  className="w-full h-8 px-2 rounded-lg bg-black/30 border border-white/10 text-xs text-slate-100 focus:outline-none focus:border-sky-500/50"
                  aria-label={t('studio.objects.label')}
                />
              )}
              {selected.a.type !== 'redact' && (
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="w-20 shrink-0">{t('studio.objects.opacity')}</span>
                  <input
                    type="range" min="10" max="100" step="5"
                    value={Math.round((selected.a.opacity ?? 1) * 100)}
                    onFocus={() => api.beginChange()}
                    onChange={(e) => api.update(selected.pageId, selected.a.id, { opacity: Number(e.target.value) / 100 }, { record: false })}
                    className="flex-1 accent-sky-500"
                  />
                  <span className="w-9 text-right font-mono text-slate-300">{Math.round((selected.a.opacity ?? 1) * 100)}%</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
