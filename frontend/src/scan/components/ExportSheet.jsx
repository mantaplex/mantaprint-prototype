import React, { useState } from 'react';
import { Download, Loader2, FileText, Image as ImageIcon, FileArchive, HardDriveDownload, FileType, FileType2, ScanText } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Button, Field, Segmented, Modal, formatBytes } from './ui.jsx';
import { PAPER_SIZES, PAPER_ORDER } from '../engine/paper.js';
import { isFileSystemAccessSupported } from '../engine/fileSave.js';

const FORMATS = [
  { id: 'pdf', label: 'PDF', icon: FileText },
  { id: 'jpeg', label: 'JPG', icon: ImageIcon },
  { id: 'png', label: 'PNG', icon: ImageIcon },
  { id: 'tiff', label: 'TIFF', icon: FileArchive },
  { id: 'docx', label: 'Word', icon: FileType2 },
  { id: 'txt', label: 'TXT', icon: FileType }
];
const TEXT_FORMATS = new Set(['txt', 'docx']);

export default function ExportSheet({ open, onClose, doc, pageCount, selectedCount, onExport, ocrMissing = { all: 0, selected: 0 }, onRunOcr, ocrBusy }) {
  const { t } = useI18n();
  const [format, setFormat] = useState('pdf');
  const [scope, setScope] = useState('all');
  const [paperSize, setPaperSize] = useState(doc?.paperSize || 'A4');
  const [fitMode, setFitMode] = useState('paper');
  const [quality, setQuality] = useState('high');
  const [searchable, setSearchable] = useState(true);
  const [filename, setFilename] = useState(doc?.title || 'scan');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await onExport({ format, scope, paperSize, fitMode, quality, filename, searchable }, (i, n) => setProgress({ i, n }));
      setResult(r);
      if (r?.method !== 'cancelled') setTimeout(onClose, 900);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const fsa = isFileSystemAccessSupported();
  const missing = scope === 'selected' ? ocrMissing.selected : ocrMissing.all;

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title={t('studio.export.title')} width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={busy ? Loader2 : (fsa ? HardDriveDownload : Download)} onClick={run} disabled={busy || !pageCount}>
            {busy ? (progress ? `${progress.i}/${progress.n}` : t('studio.export.working')) : (fsa ? t('studio.export.saveAs') : t('studio.export.download'))}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('studio.export.format')}>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {FORMATS.map((f) => (
              <button key={f.id} type="button" onClick={() => setFormat(f.id)} className={`h-14 rounded-xl border flex flex-col items-center justify-center gap-1 text-[11px] font-bold ${format === f.id ? 'border-manta-500 bg-manta-500/10 text-manta-200' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25'}`}>
                <f.icon className="w-4 h-4" />{f.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t('studio.export.scope')}>
            <Segmented size="sm" value={scope} onChange={setScope} options={[
              { value: 'all', label: `${t('studio.export.allPages')} (${pageCount})` },
              { value: 'selected', label: `${t('studio.export.selected')} (${selectedCount || 1})` }
            ]} />
          </Field>
          {!TEXT_FORMATS.has(format) && <Field label={t('studio.export.quality')}>
            <Segmented size="sm" value={quality} onChange={setQuality} options={[{ value: 'high', label: t('studio.export.qHigh') }, { value: 'balanced', label: t('studio.export.qBalanced') }, { value: 'small', label: t('studio.export.qSmall') }]} />
          </Field>}
        </div>

        {format === 'pdf' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('studio.export.pageSize')}>
              <Segmented size="sm" value={fitMode} onChange={setFitMode} options={[{ value: 'paper', label: t('studio.export.fitPaper') }, { value: 'image', label: t('studio.export.trueSize') }]} />
            </Field>
            {fitMode === 'paper' && (
              <Field label={t('studio.scan.paper')}>
                <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)} className="studio-select">
                  {PAPER_ORDER.filter((k) => k !== 'CR80').map((k) => <option key={k} value={k}>{PAPER_SIZES[k].name}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}

        {format === 'pdf' && (
          <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} className="accent-sky-500 h-4 w-4 mt-0.5" />
            <span><span className="font-semibold text-slate-100">{t('studio.export.searchable')}</span><span className="block text-[11px] text-slate-500">{t('studio.export.searchableHint')}</span></span>
          </label>
        )}
        {TEXT_FORMATS.has(format) && <p className="text-[11px] text-slate-400">{t('studio.export.textOnlyHint')}</p>}
        {(TEXT_FORMATS.has(format) || (format === 'pdf' && searchable)) && missing > 0 && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200">
            <ScanText className="w-4 h-4 shrink-0" />
            <span className="flex-1">{t('studio.export.ocrMissing', { n: missing })}</span>
            <Button size="sm" variant="secondary" icon={ocrBusy ? Loader2 : undefined} disabled={ocrBusy} onClick={() => onRunOcr?.(scope)}>{t('studio.export.runOcr')}</Button>
          </div>
        )}
        {!TEXT_FORMATS.has(format) && <p className="text-[11px] text-slate-500">{t('studio.export.objectsNote')}</p>}

        <Field label={t('studio.export.filename')} hint={(format === 'jpeg' || format === 'png') && (scope === 'all' ? pageCount : selectedCount || 1) > 1 ? t('studio.export.zipHint') : undefined}>
          <input value={filename} onChange={(e) => setFilename(e.target.value)} className="h-11 w-full px-3 rounded-xl bg-white/[0.05] border border-white/10 text-sm focus:outline-none focus:border-manta-500/50" />
        </Field>

        {result && result.method !== 'cancelled' && (
          <div className="text-xs text-manta-300 font-semibold">{t('studio.export.done')} {result.size ? `· ${formatBytes(result.size)}` : ''}</div>
        )}
        <p className="text-[10px] text-slate-500">{fsa ? t('studio.export.fsaNote') : t('studio.export.downloadNote')}</p>
      </div>
    </Modal>
  );
}
