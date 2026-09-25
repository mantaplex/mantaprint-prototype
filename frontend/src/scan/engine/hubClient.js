/**
 * The only two things the hub is used for: acquiring a page from the USB scanner and
 * printing. The image is pulled with `?wipe=true`, so the hub shreds its RAM copy the
 * moment the download finishes and keeps nothing.
 */

export class ScanError extends Error {
  constructor(message, { code = 'ERR_SCAN_FAILED', status = 0, retryAfter = 0, holder = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.holder = holder;
  }
}

/**
 * @param {object} params { resolution, mode, source, paperSize }
 * @returns {Promise<{ blob: Blob, meta: object }>}
 */
export async function acquireScan(params, { signal } = {}) {
  const res = await fetch('/api/scanner/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'jpeg', ...params }),
    signal
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok || !json?.success) {
    throw new ScanError(json?.message || `Scanner request failed (${res.status})`, {
      code: json?.error_code || 'ERR_SCAN_FAILED',
      status: res.status,
      retryAfter: Number(res.headers.get('Retry-After') || json?.retry_after || 0),
      holder: json?.holder || null
    });
  }
  const url = json.downloadUrl.includes('?') ? `${json.downloadUrl}&wipe=true` : `${json.downloadUrl}?wipe=true`;
  const fileRes = await fetch(url, { signal, cache: 'no-store' });
  if (!fileRes.ok) throw new ScanError('Could not download the scanned page from the hub.', { status: fileRes.status });
  const blob = await fileRes.blob();
  return { blob, meta: json };
}

export async function fetchScannerStatus() {
  const res = await fetch('/api/scanner/status', { cache: 'no-store' });
  const json = await res.json();
  return json?.scanner || null;
}

/**
 * Sends a PDF straight to the hub's print queue as a raw body (no multipart), which is
 * the streaming path the hub handles reliably.
 */
export async function printBlob(blob, { filename = 'scan.pdf', printer = '', copies = 1, media = 'A4' } = {}) {
  const params = new URLSearchParams();
  if (printer) params.set('printer', printer);
  if (copies > 1) params.set('copies', String(copies));
  if (media) params.set('media', media);
  const res = await fetch(`/api/print/upload?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'application/pdf',
      'X-Document-Name': encodeURIComponent(filename)
    },
    body: blob
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || `Print failed (${res.status})`);
  return json;
}
