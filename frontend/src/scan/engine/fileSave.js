/**
 * Saving files on the device: File System Access API on Chromium (ChromeOS, Chrome, Edge)
 * with a download fallback everywhere else.
 */

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

const ACCEPT = {
  'application/pdf': { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
  'image/jpeg': { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  'image/png': { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  'image/tiff': { description: 'TIFF image', accept: { 'image/tiff': ['.tif', '.tiff'] } },
  'application/zip': { description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } },
  'text/plain': { description: 'Plain text', accept: { 'text/plain': ['.txt'] } },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    description: 'Word document',
    accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] }
  }
};

/**
 * Saves a blob. Returns { method: 'fs'|'download'|'cancelled' }.
 */
export async function saveBlob(blob, filename) {
  if (isFileSystemAccessSupported()) {
    try {
      const baseMime = String(blob.type || '').split(';')[0].trim();
      const type = ACCEPT[baseMime];
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: type ? [type] : undefined
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { method: 'fs' };
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' };
      console.warn('[fileSave] picker failed, falling back to download:', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { method: 'download' };
}

export function safeFilename(name, fallback = 'scan') {
  const cleaned = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
  return cleaned || fallback;
}
