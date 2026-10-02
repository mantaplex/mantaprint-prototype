/**
 * MantaPrint Hub - HTTP streaming, SSE backpressure, and static asset cache guards.
 *
 * Extracted as testable helpers so resource cleanup (file descriptors, tmpfs spool
 * files, SSE socket buffers) and static cache headers can be verified directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Transform, pipeline as cbPipeline } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_SSE_BUFFER_BYTES = 256 * 1024;
export const MAX_SSE_CLIENTS = 32;

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip'
});

const ASSET_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.map', '.wasm', '.png', '.jpg', '.jpeg', '.webp',
  '.svg', '.ico', '.woff2', '.ttf', '.otf', '.json', '.webmanifest', '.gz', '.txt'
]);

/**
 * Registers an SSE response stream while capping concurrent connections.
 * Evicts and destroys the oldest client if the cap is reached.
 */
export function registerSseClient(clients, res, maxClients = MAX_SSE_CLIENTS) {
  while (clients.size >= maxClients) {
    const oldest = clients.values().next().value;
    if (!oldest) break;
    clients.delete(oldest);
    try { oldest.destroy(); } catch {}
  }
  clients.add(res);
}

/**
 * Broadcasts an SSE message to all connected clients, dropping any client whose
 * write buffer exceeds maxBufferBytes so stalled sockets cannot exhaust heap.
 */
export function writeSseBroadcast(clients, payload, maxBufferBytes = MAX_SSE_BUFFER_BYTES) {
  if (!clients || clients.size === 0) return 0;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;
  for (const client of [...clients]) {
    try {
      if (client.writableEnded || client.destroyed || (client.writableLength || 0) > maxBufferBytes) {
        clients.delete(client);
        try { client.destroy(); } catch {}
        continue;
      }
      const ok = client.write(msg);
      if (!ok && (client.writableLength || 0) > maxBufferBytes) {
        clients.delete(client);
        try { client.destroy(); } catch {}
        continue;
      }
      delivered += 1;
    } catch {
      clients.delete(client);
      try { client.destroy(); } catch {}
    }
  }
  return delivered;
}

/**
 * Streams a request body into destPath with a strict byte limit.
 * Always closes the destination file descriptor and deletes destPath on abort
 * or overflow so tmpfs pages and fds never leak.
 */
export async function streamToFileWithLimit(req, destPath, maxBytes) {
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error('Payload exceeds maximum size limit');
        err.code = 'LIMIT_EXCEEDED';
        cb(err);
        return;
      }
      cb(null, chunk);
    }
  });

  const fileStream = fs.createWriteStream(destPath);
  const onAbort = () => {
    const err = new Error('Request aborted by client');
    err.code = 'ECONNRESET';
    limiter.destroy(err);
    fileStream.destroy(err);
  };
  req.once('aborted', onAbort);

  try {
    await pipeline(req, limiter, fileStream);
    return totalBytes;
  } catch (err) {
    try { fileStream.destroy(); } catch {}
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    throw err;
  } finally {
    req.removeListener('aborted', onAbort);
  }
}

/**
 * Streams a byte range [start, endInclusive] from srcPath to destPath via pipeline()
 * so file descriptors are guaranteed to close on error.
 */
export async function sliceFileRange(srcPath, destPath, start, endInclusive) {
  const rStream = fs.createReadStream(srcPath, { start, end: endInclusive, autoClose: true });
  const wStream = fs.createWriteStream(destPath, { autoClose: true });
  await pipeline(rStream, wStream);
}


/**
 * Opens filePath before sending headers and streams it to res via pipeline()
 * so client disconnects immediately close the underlying file descriptor.
 */
export async function streamFileResponse(req, res, filePath, headers = {}, { statusCode = 200, onComplete } = {}) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stat = await fh.stat();
    if (!stat.isFile()) {
      await fh.close();
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
      return false;
    }

    const outHeaders = {
      'Content-Length': String(stat.size),
      ...headers
    };

    if (req.method === 'HEAD') {
      await fh.close();
      res.writeHead(statusCode, outHeaders);
      res.end();
      return true;
    }

    const readStream = fh.createReadStream({ autoClose: true });
    res.writeHead(statusCode, outHeaders);

    await new Promise((resolve) => {
      cbPipeline(readStream, res, (err) => {
        if (err) {
          try { readStream.destroy(); } catch {}
          if (!res.writableEnded && !res.destroyed) {
            try { res.destroy(); } catch {}
          }
          resolve(false);
          return;
        }
        if (typeof onComplete === 'function') {
          try { onComplete(); } catch {}
        }
        resolve(true);
      });
    });
    return true;
  } catch {
    if (fh) {
      try { await fh.close(); } catch {}
    }
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } else if (!res.writableEnded && !res.destroyed) {
      try { res.destroy(); } catch {}
    }
    return false;
  }
}

/**
 * Resolves a static asset request inside distDir with separator-safe traversal
 * checks, proper Cache-Control headers, weak ETag / 304 support, and 404s for
 * missing hashed/static assets instead of returning index.html.
 */
export function resolveStaticAsset(distDir, pathname, reqHeaders = {}) {
  const rootDir = path.resolve(distDir);
  const normalizedRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidatePath = path.resolve(rootDir, normalizedRel);

  const relFromRoot = path.relative(rootDir, candidatePath);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Forbidden' };
  }

  let filePath = candidatePath;
  let stat = null;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const dirIndex = path.join(filePath, 'index.html');
      if (fs.existsSync(dirIndex) && fs.statSync(dirIndex).isFile()) {
        filePath = dirIndex;
        stat = fs.statSync(filePath);
      } else {
        stat = null;
      }
    }
  } catch {
    stat = null;
  }

  if (!stat || !stat.isFile()) {
    const reqExt = path.extname(pathname).toLowerCase();
    const isAssetPath =
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/hdmi/assets/') ||
      pathname.startsWith('/ocr/') ||
      (reqExt !== '' && reqExt !== '.html' && ASSET_EXTENSIONS.has(reqExt));

    if (isAssetPath) {
      return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'Not Found' };
    }

    // SPA route fallback (e.g. /scan, /admin)
    if (pathname.startsWith('/hdmi')) {
      const hdmiFile = path.join(rootDir, 'hdmi', 'index.html');
      filePath = fs.existsSync(hdmiFile) ? hdmiFile : path.join(rootDir, 'index.html');
    } else {
      filePath = path.join(rootDir, 'index.html');
    }

    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
    }
  }

  const servedRel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;

  let cacheControl;
  if (
    servedRel.startsWith('assets/') ||
    servedRel.startsWith('hdmi/assets/') ||
    servedRel.startsWith('ocr/')
  ) {
    cacheControl = 'public, max-age=31536000, immutable';
  } else if (
    ext === '.html' ||
    servedRel === 'sw.js' ||
    servedRel === 'manifest.json' ||
    ext === '.webmanifest'
  ) {
    cacheControl = 'no-cache, must-revalidate';
  } else {
    cacheControl = 'public, max-age=3600, must-revalidate';
  }

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    ETag: etag
  };

  const ifNoneMatch = reqHeaders['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { status: 304, headers, filePath: null };
  }

  return { status: 200, headers, filePath, stat };
}
