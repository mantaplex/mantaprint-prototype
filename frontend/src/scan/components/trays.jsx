import React, { useEffect, useRef, useState } from 'react';
import { ScanLine, Loader2, AlertTriangle, RotateCcw, RotateCw, Ruler, Check, X, Sparkles, ImagePlus, Camera, CreditCard } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Button, Segmented, Slider, Field } from './ui.jsx';
import { PAPER_SIZES, PAPER_ORDER, DPI_OPTIONS, PRESETS, FILTERS } from '../engine/paper.js';
import { DEFAULT_EDITS } from '../db/studioDb.js';

export function ScanTray({ scanner, settings, onChange, onScan, scanning, phase, error, onRefreshScanner, presetId, onPreset }) {
  const { t } = useI18n();
  const connected = Boolean(scanner?.connected);
  const needsFirmware = !connected && scanner?.firmware_required;
  const needsPlugin = !connected && !needsFirmware && scanner?.plugin_required;
  const hasAdf = Boolean(scanner?.has_adf);
  const duplex = Boolean(scanner?.duplex_capable);

  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-2.5 p-2.5 rounded-xl border ${connected ? 'bg-manta-500/10 border-manta-500/25' : (needsFirmware || needsPlugin) ? 'bg-amber-500/10 border-amber-500/25' : 'bg-white/[0.04] border-white/10'}`}>
        <span className={`h-2 w-2 rounded-full shrink-0 ${connected ? 'bg-manta-400 animate-pulse' : (needsFirmware || needsPlugin) ? 'bg-amber-400' : 'bg-slate-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold text-slate-100 truncate">{connected ? (scanner?.name || t('studio.scanner.connected')) : needsFirmware ? t('studio.scanner.needsFirmware', { model: needsFirmware.model }) : needsPlugin ? t('studio.scanner.needsPlugin', { model: needsPlugin.model }) : t('studio.scanner.notConnected')}</div>
          <div className={`text-[10px] text-slate-500 ${(needsFirmware || needsPlugin) ? '' : 'truncate'}`}>{connected ? `${scanner?.driver || 'SANE'} · ${(scanner?.sources || ['Flatbed']).join(' / ')}` : needsFirmware ? t('studio.scanner.needsFirmwareHint') : needsPlugin ? t('studio.scanner.needsPluginHint') : t('studio.scanner.notConnectedHint')}</div>
        </div>
        <button type="button" onClick={onRefreshScanner} className="text-[11px] font-semibold text-manta-300 hover:text-manta-200 px-2 h-8 rounded-lg hover:bg-white/5">{t('common.refresh')}</button>
      </div>

      {scanner?.available_devices?.length > 1 && (
        <Field label={t('studio.scan.device')}>
          <select
            value={settings.deviceId || scanner.device_id}
            onChange={(e) => {
              const devId = e.target.value;
              const picked = scanner.available_devices.find((d) => d.device_id === devId);
              onChange({
                deviceId: devId,
                source: picked?.sources?.[0] || 'Flatbed'
              });
            }}
            className="studio-select"
          >
            {scanner.available_devices.map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.name} ({d.driver})
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label={t('studio.scan.preset')}>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id)}
              className={`text-left p-2.5 rounded-xl border transition-colors ${presetId === p.id ? 'border-manta-500/60 bg-manta-500/10' : 'border-white/10 hover:border-white/20 bg-white/[0.03]'}`}
            >
              <div className="text-xs font-bold text-slate-100">{t(`studio.presets.${p.id}.title`)}</div>
              <div className="text-[10px] text-slate-500 leading-snug mt-0.5">{t(`studio.presets.${p.id}.desc`)}</div>
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('studio.scan.paper')}>
          <select value={settings.paperSize} onChange={(e) => onChange({ paperSize: e.target.value })} className="studio-select">
            {PAPER_ORDER.map((k) => <option key={k} value={k}>{PAPER_SIZES[k].name} · {PAPER_SIZES[k].widthMm}×{PAPER_SIZES[k].heightMm}mm</option>)}
          </select>
        </Field>
        <Field label={t('studio.scan.dpi')}>
          <select value={settings.resolution} onChange={(e) => onChange({ resolution: Number(e.target.value) })} className="studio-select">
            {DPI_OPTIONS.map((d) => <option key={d} value={d}>{d} DPI{d === 300 ? ` · ${t('studio.scan.recommended')}` : ''}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('studio.scan.color')}>
          <Segmented size="sm" value={settings.mode} onChange={(v) => onChange({ mode: v })} options={[{ value: 'Color', label: t('studio.scan.colorMode') }, { value: 'Gray', label: t('studio.scan.gray') }]} />
        </Field>
        <Field label={t('studio.scan.source')}>
          <Segmented
            size="sm"
            value={settings.source}
            onChange={(v) => onChange({ source: v })}
            options={[
              { value: 'Flatbed', label: t('studio.scan.flatbed') },
              ...(hasAdf ? [{ value: 'ADF Front', label: 'ADF' }] : []),
              ...(duplex ? [{ value: 'ADF Duplex', label: 'Duplex' }] : [])
            ]}
          />
        </Field>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      <Button variant="primary" size="lg" className="w-full" onClick={onScan} disabled={!connected || scanning} icon={scanning ? Loader2 : ScanLine}>
        {scanning ? (phase || t('studio.scan.scanning')) : t('studio.scan.scanPage')}
      </Button>
      <p className="text-[10px] text-slate-500 text-center">{t('studio.scan.privacyNote')}</p>
    </div>
  );
}

export function ImportTray({ onFiles }) {
  const { t } = useI18n();
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const [over, setOver] = useState(false);
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
        className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${over ? 'border-manta-400 bg-manta-500/10' : 'border-white/15'}`}
      >
        <ImagePlus className="w-7 h-7 mx-auto text-slate-500" />
        <p className="mt-2 text-xs text-slate-300 font-semibold">{t('studio.import.drop')}</p>
        <p className="text-[10px] text-slate-500 mt-0.5">JPG · PNG · WEBP · HEIC*</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" icon={ImagePlus} onClick={() => fileRef.current?.click()}>{t('studio.import.browse')}</Button>
        <Button variant="secondary" icon={Camera} onClick={() => camRef.current?.click()}>{t('studio.import.camera')}</Button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      <p className="text-[10px] text-slate-500">{t('studio.import.note')}</p>
    </div>
  );
}

export function EnhanceTray({ edits, onChange, onCommit, onApplyAll, pageCount }) {
  const { t } = useI18n();
  const e = { ...DEFAULT_EDITS, ...edits };
  const quick = [
    { id: 'office', edits: PRESETS[0].edits },
    { id: 'archive', edits: PRESETS[2].edits },
    { id: 'photo', edits: PRESETS[3].edits }
  ];
  return (
    <div className="space-y-4">
      <Field label={t('studio.enhance.quick')}>
        <div className="grid grid-cols-3 gap-1.5">
          {quick.map((q) => (
            <button key={q.id} type="button" onClick={() => onCommit(q.edits)} className="h-9 rounded-lg bg-white/[0.05] border border-white/10 hover:border-manta-500/50 text-[11px] font-semibold text-slate-200">
              {t(`studio.presets.${q.id}.title`)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('studio.enhance.mode')}>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => onCommit({ filter: f })} className={`h-8 px-2.5 rounded-lg text-[11px] font-semibold border ${e.filter === f ? 'bg-manta-600 text-white border-manta-600' : 'bg-white/[0.04] border-white/10 text-slate-300 hover:border-white/25'}`}>
              {t(`studio.filters.${f}`)}
            </button>
          ))}
        </div>
      </Field>
      <Slider label={t('studio.enhance.bgClean')} value={e.bgClean} min={0} max={100} step={1} onChange={(v) => onChange({ bgClean: v })} onCommit={() => onCommit({})} format={(v) => `${v}%`} />
      <Slider label={t('studio.enhance.contrast')} value={e.contrast} min={0.5} max={2.5} step={0.01} onChange={(v) => onChange({ contrast: v })} onCommit={() => onCommit({})} format={(v) => v.toFixed(2)} />
      <Slider label={t('studio.enhance.brightness')} value={e.brightness} min={0.5} max={1.8} step={0.01} onChange={(v) => onChange({ brightness: v })} onCommit={() => onCommit({})} format={(v) => v.toFixed(2)} />
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onCommit({ filter: 'none', bgClean: 0, contrast: 1, brightness: 1 })}>{t('studio.enhance.reset')}</Button>
        {pageCount > 1 && <Button size="sm" variant="secondary" icon={Sparkles} className="ml-auto" onClick={onApplyAll}>{t('studio.enhance.applyAll')}</Button>}
      </div>
    </div>
  );
}

export function CropTray({ edits, draft, onDraft, onApply, onCancel, onAutoDeskew, deskewing, onDeskewChange, onRotate }) {
  const { t } = useI18n();
  const e = { ...DEFAULT_EDITS, ...edits };
  const presetsCrop = [
    { id: 'full', rect: null },
    { id: 'a4', ratio: 210 / 297 },
    { id: 'card', ratio: 85.6 / 54 },
    { id: 'square', ratio: 1 }
  ];
  const applyRatio = (ratio) => {
    if (!ratio) { onDraft({ x: 0, y: 0, w: 1, h: 1 }); return; }
    const cur = draft || { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    // keep width, derive height in frame fractions using frame aspect (unknown here -> assume A4 portrait 1:1.414)
    const frameAspect = 210 / 297;
    let w = cur.w;
    let h = (w * frameAspect) / ratio;
    if (h > 1) { h = 1; w = (h * ratio) / frameAspect; }
    const x = Math.min(1 - w, Math.max(0, cur.x + (cur.w - w) / 2));
    const y = Math.min(1 - h, Math.max(0, cur.y + (cur.h - h) / 2));
    onDraft({ x, y, w, h });
  };
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-slate-400">{t('studio.crop.hint')}</p>
      <Field label={t('studio.crop.rotate')}>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => onRotate(-90)}>−90°</Button>
          <Button size="sm" variant="secondary" icon={RotateCw} onClick={() => onRotate(90)}>+90°</Button>
          <Button size="sm" variant="secondary" icon={Ruler} className="ml-auto" onClick={onAutoDeskew} disabled={deskewing}>{deskewing ? t('studio.crop.deskewing') : t('studio.crop.autoDeskew')}</Button>
        </div>
      </Field>
      <Slider label={t('studio.crop.straighten')} value={e.deskew} min={-10} max={10} step={0.1} onChange={onDeskewChange} onCommit={() => onDeskewChange(e.deskew, true)} format={(v) => `${v.toFixed(1)}°`} />
      <Field label={t('studio.crop.ratio')}>
        <div className="flex flex-wrap gap-1.5">
          {presetsCrop.map((p) => (
            <button key={p.id} type="button" onClick={() => applyRatio(p.ratio)} className="h-8 px-2.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] border border-white/10 text-slate-300 hover:border-white/25">
              {t(`studio.crop.presets.${p.id}`)}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>{t('common.cancel')}</Button>
        {e.crop && <Button size="sm" variant="ghost" onClick={() => { onDraft({ x: 0, y: 0, w: 1, h: 1 }); }}>{t('studio.crop.clear')}</Button>}
        <Button size="sm" variant="primary" icon={Check} className="ml-auto" onClick={onApply}>{t('studio.crop.apply')}</Button>
      </div>
    </div>
  );
}

export function KtpTray({ pages, activeId, onSetRole, onCompose, composing, dpi, onDpi }) {
  const { t } = useI18n();
  const front = pages.find((p) => p.role === 'front');
  const back = pages.find((p) => p.role === 'back');
  const active = pages.find((p) => p.id === activeId);
  const Slot = ({ label, page, role }) => (
    <div className={`flex-1 rounded-xl border p-2.5 ${page ? 'border-manta-500/40 bg-manta-500/5' : 'border-dashed border-white/15'}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 aspect-[1.586] rounded-md bg-white/[0.04] overflow-hidden flex items-center justify-center">
        {page?.thumbUrl ? <img src={page.thumbUrl} alt="" className="w-full h-full object-contain bg-white" /> : <CreditCard className="w-6 h-6 text-slate-600" />}
      </div>
      <button type="button" disabled={!active} onClick={() => onSetRole(active.id, role)} className="mt-2 w-full h-8 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] font-semibold text-slate-200 disabled:opacity-40">
        {t('studio.ktp.useCurrent')}
      </button>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-slate-400">{t('studio.ktp.hint')}</p>
      <div className="flex gap-2.5">
        <Slot label={t('studio.roles.front')} page={front} role="front" />
        <Slot label={t('studio.roles.back')} page={back} role="back" />
      </div>
      <Field label={t('studio.ktp.outputDpi')}>
        <Segmented size="sm" value={dpi} onChange={onDpi} options={[{ value: 150, label: '150' }, { value: 200, label: '200' }, { value: 300, label: '300' }]} />
      </Field>
      <Button variant="primary" className="w-full" disabled={!front || !back || composing} onClick={onCompose} icon={composing ? Loader2 : CreditCard}>
        {composing ? t('studio.ktp.composing') : t('studio.ktp.compose')}
      </Button>
    </div>
  );
}
