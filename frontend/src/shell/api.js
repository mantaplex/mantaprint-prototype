/** Small fetch helpers shared by Home and Admin. */

export const ADMIN_TOKEN_KEY = 'mantaprint_admin_token';

export function getAdminToken() {
  try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
}

/**
 * JSON request with the admin token attached. Resolves to the parsed body and throws an
 * Error carrying the server message when the response is not ok / success is false.
 */
export async function adminFetch(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Admin-Token': getAdminToken(),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (res.status === 401) {
    try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mantaprint:unauthorized'));
    }
  }
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(json?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json || {};
}

/**
 * Copies text to the clipboard with an HTTP (non-secure context) fallback
 * for LAN appliance access (e.g. http://192.168.x.x).
 */
export async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  if (typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch {}
  }
  return false;
}

// ---- Jobs submitted from this browser -------------------------------------------------
const MY_JOBS_KEY = 'mantaprint_my_jobs';
const MY_JOBS_TTL = 24 * 60 * 60 * 1000;

export function loadMyJobs() {
  try {
    const list = JSON.parse(localStorage.getItem(MY_JOBS_KEY) || '[]');
    const now = Date.now();
    return Array.isArray(list) ? list.filter((j) => j && j.id && now - (j.at || 0) < MY_JOBS_TTL) : [];
  } catch {
    return [];
  }
}

export function saveMyJobs(list) {
  try { localStorage.setItem(MY_JOBS_KEY, JSON.stringify(list.slice(0, 10))); } catch {}
}

export function rememberMyJob(job) {
  const list = loadMyJobs().filter((j) => j.id !== job.id);
  list.unshift({ ...job, at: Date.now() });
  saveMyJobs(list);
  return list;
}

/** Prints a file by streaming it as the raw request body (no multipart). */
export async function printFile(file, { printer, copies = 1, media = 'A4', orientation = '', duplex = '', pageRanges = '' }) {
  const params = new URLSearchParams();
  if (printer) params.set('printer', printer);
  if (copies > 1) params.set('copies', String(copies));
  if (media) params.set('media', media);
  if (orientation) params.set('orientation', orientation);
  if (duplex) params.set('duplex', duplex);
  if (pageRanges) params.set('page_ranges', pageRanges);
  const res = await fetch(`/api/print/upload?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Document-Name': encodeURIComponent(file.name || 'document')
    },
    body: file
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || !json.success) throw new Error(json.message || `Print failed (${res.status})`);
  return json;
}
