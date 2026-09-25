import React, { useRef, useState } from 'react';
import { RotateCw, RotateCcw, Trash2, Copy, CheckSquare, Square, GripVertical, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';

const ROLE_STYLE = {
  front: 'bg-sky-500 text-slate-950',
  back: 'bg-violet-500 text-slate-950',
  sheet: 'bg-manta-600 text-white'
};

/**
 * Left rail: page thumbnails with selection, drag-and-drop reordering and per-page actions.
 * Tap selects; long press (touch) or Ctrl/Shift+click (mouse) starts multi-select.
 */
export default function PagesRail({
  pages, activeId, selectedIds, onSelect, onToggleSelect, onSelectRange, onReorder,
  onRotate, onDelete, onDuplicate, onClearSelection, onSelectAll, compact = false
}) {
  const { t } = useI18n();
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const longPress = useRef(null);
  const lastIndex = useRef(0);

  const multi = selectedIds.size > 1 || (selectedIds.size === 1 && !selectedIds.has(activeId));

  const handleClick = (e, page, idx) => {
    if (e.shiftKey) { onSelectRange(lastIndex.current, idx); return; }
    if (e.ctrlKey || e.metaKey) { onToggleSelect(page.id); lastIndex.current = idx; return; }
    lastIndex.current = idx;
    if (multi) onToggleSelect(page.id);
    else onSelect(page.id);
  };

  const onPointerDown = (e, page) => {
    if (e.pointerType === 'mouse') return;
    longPress.current = setTimeout(() => { onToggleSelect(page.id); longPress.current = null; }, 500);
  };
  const cancelLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };

  const move = (from, to) => {
    if (from === to || from < 0 || to < 0 || to >= pages.length) return;
    const ids = pages.map((p) => p.id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    onReorder(ids);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-white/[0.06]">
        <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wide">{t('studio.rail.pages')} ({pages.length})</span>
        {pages.length > 0 && (
          <button type="button" onClick={selectedIds.size === pages.length ? onClearSelection : onSelectAll} className="text-[11px] font-semibold text-manta-400 hover:text-manta-300">
            {selectedIds.size === pages.length ? t('studio.rail.clear') : t('studio.rail.selectAll')}
          </button>
        )}
      </div>

      {multi && (
        <div className="px-3 py-2 flex items-center gap-1.5 bg-manta-500/10 border-b border-manta-500/20 text-[11px] font-semibold text-manta-200">
          <span className="mr-auto">{selectedIds.size} {t('studio.rail.selected')}</span>
          <button type="button" title={t('studio.tools.rotateLeft')} onClick={() => onRotate([...selectedIds], -90)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center"><RotateCcw className="w-4 h-4" /></button>
          <button type="button" title={t('studio.tools.rotateRight')} onClick={() => onRotate([...selectedIds], 90)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center"><RotateCw className="w-4 h-4" /></button>
          <button type="button" title={t('common.delete')} onClick={() => onDelete([...selectedIds])} className="h-8 w-8 rounded-lg hover:bg-rose-500/20 text-rose-300 flex items-center justify-center"><Trash2 className="w-4 h-4" /></button>
        </div>
      )}

      <div className={`flex-1 overflow-y-auto p-3 ${compact ? 'grid grid-cols-3 gap-3 content-start' : 'space-y-3'}`}>
        {pages.length === 0 && (
          <p className="text-[11px] text-slate-500 text-center py-8 px-2">{t('studio.rail.empty')}</p>
        )}
        {pages.map((p, idx) => {
          const isActive = p.id === activeId;
          const isSelected = selectedIds.has(p.id);
          return (
            <div
              key={p.id}
              draggable
              onDragStart={(e) => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); if (overIdx !== idx) setOverIdx(idx); }}
              onDragLeave={() => setOverIdx(null)}
              onDrop={(e) => { e.preventDefault(); if (dragIdx !== null) move(dragIdx, idx); setDragIdx(null); setOverIdx(null); }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              className={`relative rounded-xl border transition-all ${
                overIdx === idx && dragIdx !== idx ? 'border-manta-400 scale-[1.02]' : isActive ? 'border-manta-500/70 bg-manta-500/5' : 'border-white/[0.06] hover:border-white/20'
              } ${dragIdx === idx ? 'opacity-40' : ''}`}
            >
              <button
                type="button"
                onClick={(e) => handleClick(e, p, idx)}
                onPointerDown={(e) => onPointerDown(e, p)}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onContextMenu={(e) => e.preventDefault()}
                className="block w-full p-2 text-left"
                aria-label={`${t('studio.rail.page')} ${idx + 1}`}
                aria-current={isActive ? 'true' : undefined}
              >
                <div className="relative rounded-lg bg-white overflow-hidden aspect-[3/4] shadow-[0_8px_20px_-10px_rgba(0,0,0,0.9)]">
                  {p.thumbUrl ? (
                    <img src={p.thumbUrl} alt="" className="w-full h-full object-contain bg-white" draggable={false} />
                  ) : (
                    <div className="w-full h-full bg-slate-200 animate-pulse" />
                  )}
                  {p.role && p.role !== 'normal' && (
                    <span className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide ${ROLE_STYLE[p.role] || 'bg-slate-500 text-white'}`}>
                      {t(`studio.roles.${p.role}`)}
                    </span>
                  )}
                  <span
                    className={`absolute top-1.5 right-1.5 h-6 w-6 rounded-md flex items-center justify-center ${isSelected ? 'bg-manta-600 text-white' : 'bg-black/50 text-white/80'}`}
                    onClick={(e) => { e.stopPropagation(); onToggleSelect(p.id); lastIndex.current = idx; }}
                    role="checkbox"
                    aria-checked={isSelected}
                  >
                    {isSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between px-0.5">
                  <span className="text-[11px] font-bold text-slate-300">{idx + 1}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{p.edits?.rotation ? `${p.edits.rotation}°` : ''}{p.edits?.crop ? ' ✂' : ''}</span>
                </div>
              </button>

              {isActive && !compact && (
                <div className="px-2 pb-2 flex items-center gap-1">
                  <span className="text-slate-600 cursor-grab mr-auto" title={t('studio.rail.dragHint')}><GripVertical className="w-4 h-4" /></span>
                  <button type="button" title={t('studio.rail.moveUp')} onClick={() => move(idx, idx - 1)} disabled={idx === 0} className="h-8 w-8 rounded-lg hover:bg-white/10 disabled:opacity-30 flex items-center justify-center text-slate-300"><ChevronLeft className="w-4 h-4 rotate-90" /></button>
                  <button type="button" title={t('studio.rail.moveDown')} onClick={() => move(idx, idx + 1)} disabled={idx === pages.length - 1} className="h-8 w-8 rounded-lg hover:bg-white/10 disabled:opacity-30 flex items-center justify-center text-slate-300"><ChevronRight className="w-4 h-4 rotate-90" /></button>
                  <button type="button" title={t('studio.tools.rotateRight')} onClick={() => onRotate([p.id], 90)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-300"><RotateCw className="w-4 h-4" /></button>
                  <button type="button" title={t('studio.rail.duplicate')} onClick={() => onDuplicate(p.id)} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-300"><Copy className="w-4 h-4" /></button>
                  <button type="button" title={t('common.delete')} onClick={() => onDelete([p.id])} className="h-8 w-8 rounded-lg hover:bg-rose-500/20 flex items-center justify-center text-rose-300"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
