import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import {
  registerSseClient,
  writeSseBroadcast,
  streamToFileWithLimit,
  sliceFileRange,
  streamFileResponse,
  resolveStaticAsset
} from '../src/web/server/lib/http-guards.mjs';

function makeFakeSseClient({ writableLength = 0, writeReturns = true } = {}) {
  let destroyed = false;
  const written = [];
  return {
    writableLength,
    writableEnded: false,
    get destroyed() {
      return destroyed;
    },
    write(chunk) {
      written.push(chunk);
      return writeReturns;
    },
    destroy() {
      destroyed = true;
    },
    written
  };
}

describe('HTTP resource & static caching guards', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-http-guards-'));
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'hdmi', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'ocr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html><html><body>Hub</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{"name":"MantaPrint"}');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'index-abc123.js'), 'console.log("bundle");');
    fs.writeFileSync(path.join(tmpDir, 'hdmi', 'index.html'), '<!doctype html><html><body>HDMI</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'hdmi', 'assets', 'kiosk-999.css'), 'body{margin:0}');
    fs.writeFileSync(path.join(tmpDir, 'ocr', 'eng.traineddata.gz'), 'ocr-data');
    fs.writeFileSync(path.join(tmpDir, 'favicon.svg'), '<svg></svg>');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps SSE clients and evicts stalled sockets on backpressure', () => {
    const clients = new Set();
    const c1 = makeFakeSseClient();
    const c2 = makeFakeSseClient();
    const c3 = makeFakeSseClient();

    registerSseClient(clients, c1, 2);
    registerSseClient(clients, c2, 2);
    registerSseClient(clients, c3, 2);

    assert.equal(clients.size, 2);
    assert.equal(c1.destroyed, true, 'oldest client should be destroyed when cap exceeded');
    assert.equal(clients.has(c2), true);
    assert.equal(clients.has(c3), true);

    // Simulate c2 stalling beyond maxBufferBytes
    c2.writableLength = 512 * 1024;
    const delivered = writeSseBroadcast(clients, { printers: [] }, 256 * 1024);
    assert.equal(delivered, 1);
    assert.equal(c2.destroyed, true, 'stalled client should be destroyed');
    assert.equal(clients.has(c2), false);
    assert.equal(c3.written.length, 1);
  });

  it('streamToFileWithLimit unlinks temp file on byte limit overflow and on abort', async () => {
    const overPath = path.join(tmpDir, 'over-limit.dat');
    const reqOver = new PassThrough();

    const pOver = streamToFileWithLimit(reqOver, overPath, 1024);
    reqOver.write(Buffer.alloc(600, 0x41));
    reqOver.write(Buffer.alloc(600, 0x42));
    reqOver.end();

    await assert.rejects(pOver, (err) => err.code === 'LIMIT_EXCEEDED');
    assert.equal(fs.existsSync(overPath), false, 'overflowed temp file must be removed');

    const abortPath = path.join(tmpDir, 'aborted.dat');
    const reqAbort = new PassThrough();
    const pAbort = streamToFileWithLimit(reqAbort, abortPath, 10 * 1024);
    reqAbort.write(Buffer.alloc(512, 0x43));
    setImmediate(() => reqAbort.emit('aborted'));

    await assert.rejects(pAbort, (err) => err.code === 'ECONNRESET');
    assert.equal(fs.existsSync(abortPath), false, 'aborted temp file must be removed');
  });

  it('sliceFileRange extracts exact byte range without leaking descriptors', async () => {
    const src = path.join(tmpDir, 'multipart-raw.dat');
    const dst = path.join(tmpDir, 'multipart-sliced.dat');
    fs.writeFileSync(src, Buffer.from('HEADER\r\n\r\nHELLO_PAYLOAD\r\n--BOUNDARY--'));
    await sliceFileRange(src, dst, 10, 22);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'HELLO_PAYLOAD');
  });

  it('streamFileResponse closes file descriptor when client aborts mid-download', async () => {
    const bigFile = path.join(tmpDir, 'big-scan.pdf');
    fs.writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024, 0x25));

    let wiped = false;
    const server = http.createServer(async (req, res) => {
      await streamFileResponse(
        req,
        res,
        bigFile,
        { 'Content-Type': 'application/pdf' },
        { onComplete: () => { wiped = true; } }
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/big-scan.pdf' }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => resolve());
      });

      // Give event loop a tick to close the pipeline stream
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(wiped, false, 'onComplete must not fire when download was aborted');

      if (fs.existsSync('/proc/self/fd')) {
        const openTargets = fs.readdirSync('/proc/self/fd').map((fd) => {
          try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; }
        });
        assert.equal(
          openTargets.some((t) => t.includes('big-scan.pdf')),
          false,
          'file descriptor for big-scan.pdf must be closed after client abort'
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('resolveStaticAsset sets immutable cache for hashed assets, no-cache+ETag for HTML, and 404s missing assets', () => {
    // 1. Hashed JS bundle -> immutable 1 year cache
    const assetRes = resolveStaticAsset(tmpDir, '/assets/index-abc123.js', {});
    assert.equal(assetRes.status, 200);
    assert.equal(assetRes.headers['Cache-Control'], 'public, max-age=31536000, immutable');
    assert.equal(assetRes.headers['Content-Type'], 'application/javascript; charset=utf-8');
    assert.ok(assetRes.headers.ETag);

    // 2. OCR traineddata -> immutable 1 year cache
    const ocrRes = resolveStaticAsset(tmpDir, '/ocr/eng.traineddata.gz', {});
    assert.equal(ocrRes.status, 200);
    assert.equal(ocrRes.headers['Cache-Control'], 'public, max-age=31536000, immutable');

    // 3. Missing hashed asset -> 404 (NEVER 200 index.html!)
    const missingAsset = resolveStaticAsset(tmpDir, '/assets/index-stale-hash.js', {});
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers['Cache-Control'], 'no-store');

    // 4. Root / and SPA routes (/scan, /admin) -> index.html with no-cache + ETag + 304 support
    const spaRes = resolveStaticAsset(tmpDir, '/scan', {});
    assert.equal(spaRes.status, 200);
    assert.equal(spaRes.headers['Cache-Control'], 'no-cache, must-revalidate');
    assert.ok(spaRes.filePath.endsWith('index.html'));

    const notModified = resolveStaticAsset(tmpDir, '/scan', { 'if-none-match': spaRes.headers.ETag });
    assert.equal(notModified.status, 304);

    // 5. Path traversal attempt -> 403
    const traversal = resolveStaticAsset(tmpDir, '/../../etc/passwd', {});
    assert.equal(traversal.status, 403);
  });

  it('caches lockdown default PIN scrypt hash so repeated status checks do not block CPU', async () => {
    const lockdown = await import('../src/web/server/lockdown.mjs');
    // Warm up initial scrypt hash once
    lockdown.loadConfig();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      lockdown.loadConfig();
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 50, `100 lockdown.loadConfig() calls took ${elapsedMs.toFixed(1)}ms (expected < 50ms)`);
  });
});
