/**
 * "Print a file" dialog: the fallback for devices that cannot add the printer.
 * Opened from a button on the homepage; the file is streamed to the hub as the raw body.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Printer, Upload, FileText, Minus, Plus, Loader2, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import { Button, Modal, Segmented, Field, TextInput, Select, EmptyState, formatBytes } from '../ui/index.js';
import { printFile, rememberMyJob } from '../shell/api.js';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/*,text/plain';
const DEFAULT_OPTS = { copies: 1, pages: 'all', range: '', media: 'A4', orientation: '', duplex: '' };

export function printerTone(p) {
  if (!p?.connected) return 'idle';
  if (p.state === 'stopped' || p.state === 'error') return 'danger';
  if (p.state === 'processing') return 'info';
  return 'ok';
}

export const printerLabel = (p) => p?.mdns_name || p?.display_name || p?.queue_name || '';

export default function PrintDialog({ open, onClose, printers, initialQueue, onJobSubmitted, showToast }) {
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState(null);
  const [queue, setQueue] = useState('');
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [sending, setSending] = useState(false);

  const available = printers.filter((p) => p.connected);
  const selected = available.find((p) => p.queue_name === queue) || available[0] || null;

  useEffect(() => {
    if (open) setQueue(initialQueue || '');
  }, [open, initialQueue]);

  const close = () => {
    if (sending) return;
    setFile(null);
    setOpts(DEFAULT_OPTS);
    onClose?.();
  };

  const pick = (f) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { showToast?.(t('hub.print.tooLarge'), 'error'); return; }
    setFile(f);
  };

  const normalizedRange = opts.range.replace(/\s+/g, '');
  const rangeValid = opts.pages !== 'custom' || /^(\d+(-\d+)?)(,\d+(-\d+)?)*$/.test(normalizedRange);

  const submit = async () => {
    if (!file || !selected || !rangeValid) return;
    setSending(true);
    try {
      const res = await printFile(file, {
        printer: selected.queue_name,
        copies: opts.copies,
        media: opts.media,
        orientation: opts.orientation,
        duplex: opts.duplex,
        pageRanges: opts.pages === 'custom' ? normalizedRange : ''
      });
      rememberMyJob({ id: res.job_id, token: res.job_token, title: file.name, printer: printerLabel(selected) });
      onJobSubmitted?.();
      showToast?.(t('hub.print.sent', { name: file.name }), 'success');
      setSending(false);
      setFile(null);
      setOpts(DEFAULT_OPTS);
      onClose?.();
    } catch (err) {
      showToast?.(err.message || t('hub.print.failed'), 'error');
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('hub.print.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={sending}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={sending ? Loader2 : Printer} onClick={submit} disabled={sending || !selected || !file || !rangeValid}>
            {sending ? t('hub.print.sending') : t('hub.print.print')}
          </Button>
        </>
      }
    >
      {available.length === 0 ? (
        <EmptyState icon={Printer} title={t('hub.print.noPrinterTitle')} description={t('hub.print.noPrinterDesc')} />
      ) : (
        <div className="space-y-4">
          <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {file ? (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-black/20 border border-white/[0.08]">
              <FileText className="w-5 h-5 text-manta-300 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-100 truncate">{file.name}</div>
                <div className="text-[11px] text-slate-500">{formatBytes(file.size)}</div>
              </div>
              <button type="button" onClick={() => setFile(null)} disabled={sending} className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400" aria-label={t('hub.print.removeFile')} title={t('hub.print.removeFile')}>
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
              className={`rounded-xl border-2 border-dashed px-4 py-4 flex flex-wrap items-center gap-3 sm:gap-4 transition-colors ${over ? 'border-manta-400 bg-manta-500/10' : 'border-white/[0.12] bg-black/10'}`}
            >
              <Upload className="w-5 h-5 text-manta-300 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-100">{t('hub.print.drop')}</p>
                <p className="text-[11px] text-slate-500">{t('hub.print.formats')}</p>
              </div>
              <Button size="sm" icon={FileText} onClick={() => inputRef.current?.click()}>{t('hub.print.choose')}</Button>
            </div>
          )}

          <Field label={t('hub.print.printer')}>
            <Select value={selected?.queue_name || ''} onChange={(e) => setQueue(e.target.value)} aria-label={t('hub.print.printer')}>
              {printers.map((p) => (
                <option key={p.queue_name} value={p.queue_name} disabled={!p.connected}>
                  {printerLabel(p)}{p.connected ? '' : ` (${t('hub.printerState.offline')})`}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('hub.print.copies')}>
              <div className="flex items-center h-11 rounded-xl bg-white/[0.05] border border-white/10">
                <button type="button" aria-label="-" onClick={() => setOpts((o) => ({ ...o, copies: Math.max(1, o.copies - 1) }))} className="h-full w-11 flex items-center justify-center text-slate-300 hover:text-white"><Minus className="w-4 h-4" /></button>
                <span className="flex-1 text-center text-sm font-bold tabular-nums">{opts.copies}</span>
                <button type="button" aria-label="+" onClick={() => setOpts((o) => ({ ...o, copies: Math.min(99, o.copies + 1) }))} className="h-full w-11 flex items-center justify-center text-slate-300 hover:text-white"><Plus className="w-4 h-4" /></button>
              </div>
            </Field>
            <Field label={t('hub.print.paper')}>
              <Select value={opts.media} onChange={(e) => setOpts((o) => ({ ...o, media: e.target.value }))}>
                <option value="A4">A4</option>
                <option value="F4">F4 / Folio</option>
                <option value="Letter">Letter</option>
                <option value="Legal">Legal</option>
              </Select>
            </Field>
          </div>

          <Field label={t('hub.print.pages')}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented size="sm" value={opts.pages} onChange={(v) => setOpts((o) => ({ ...o, pages: v }))} options={[{ value: 'all', label: t('hub.print.allPages') }, { value: 'custom', label: t('hub.print.customPages') }]} />
              {opts.pages === 'custom' && (
                <TextInput className="!h-9 !w-40" placeholder="1-3, 5" value={opts.range} onChange={(e) => setOpts((o) => ({ ...o, range: e.target.value.replace(/[^\d,\- ]/g, '') }))} />
              )}
            </div>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('hub.print.orientation')}>
              <Segmented size="sm" value={opts.orientation} onChange={(v) => setOpts((o) => ({ ...o, orientation: v }))} options={[{ value: '', label: t('hub.print.auto') }, { value: 'portrait', label: t('hub.print.portrait') }, { value: 'landscape', label: t('hub.print.landscape') }]} />
            </Field>
            <Field label={t('hub.print.sides')}>
              <Segmented size="sm" value={opts.duplex} onChange={(v) => setOpts((o) => ({ ...o, duplex: v }))} options={[{ value: '', label: t('hub.print.oneSided') }, { value: 'two-sided-long-edge', label: t('hub.print.twoSided') }]} />
            </Field>
          </div>
          <p className="text-[11px] text-slate-500">{t('hub.print.privacyNote')}</p>
        </div>
      )}
    </Modal>
  );
}
