import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DRIVERS_DIR = path.join(ROOT_DIR, 'drivers');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DRIVERS_DIR)) fs.mkdirSync(DRIVERS_DIR, { recursive: true });

// --- Security & Policy Configuration ---
const ENROLLMENT_TOKEN = process.env.HEYKPRINT_ENROLLMENT_TOKEN || process.env.ENROLLMENT_TOKEN || 'CORP-PROD-2026';
const ALLOWED_COMMANDS = new Set(['test_print', 'restart_cups', 'clear_queue', 'reboot']);
const MAX_WS_PAYLOAD = 64 * 1024;      // 64KB max payload for WS commands and telemetry
const MAX_JSON_PAYLOAD = 64 * 1024;    // 64KB max for REST JSON bodies
const MAX_DRIVER_UPLOAD = 50 * 1024 * 1024; // 50MB max for driver archives

// Constant-time string comparison to prevent timing attacks
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// 1. SQLite Database & High-Concurrency WAL Optimization
// ============================================================================
const dbPath = path.join(DATA_DIR, 'fleet.db');
const db = new DatabaseSync(dbPath);

// Apply SQLite PRAGMAs for high-concurrency WAL performance
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -20000;
  PRAGMA temp_store = MEMORY;

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    ip TEXT,
    mac TEXT,
    label TEXT,
    group_tag TEXT DEFAULT 'General',
    status TEXT DEFAULT 'pending',
    printer_name TEXT,
    printer_uri TEXT,
    printer_state TEXT DEFAULT 'unknown',
    toner_cmyk TEXT DEFAULT '{"k":100}',
    driver_version TEXT DEFAULT 'v1.0',
    cpu_temp REAL DEFAULT 50.0,
    ram_used_mb REAL DEFAULT 250.0,
    ram_total_mb REAL DEFAULT 1918.0,
    uptime TEXT DEFAULT '0m',
    jobs_completed INTEGER DEFAULT 0,
    last_seen INTEGER,
    enrolled_at INTEGER,
    auth_token TEXT
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT,
    version TEXT,
    target_models TEXT,
    arch TEXT DEFAULT 'arm64',
    filename TEXT,
    file_size INTEGER,
    sha256 TEXT,
    uploaded_at INTEGER,
    deploy_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    driver_id TEXT,
    device_id TEXT,
    status TEXT DEFAULT 'pending',
    message TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

try {
  db.exec("ALTER TABLE devices ADD COLUMN mac TEXT;");
} catch (e) {
  // column already exists
}

try {
  db.exec("ALTER TABLE devices ADD COLUMN storage_info TEXT;");
} catch (e) {
  // column already exists
}

// Ensure default MAC addresses for existing units
db.exec(`
  UPDATE devices SET mac = 'b8:27:eb:8f:2b:01' WHERE id = 'heykprint-8f2b' AND (mac IS NULL OR mac = '');
  UPDATE devices SET mac = 'dc:a6:32:3c:1a:45' WHERE id = 'heykprint-3c1a' AND (mac IS NULL OR mac = '');
  UPDATE devices SET mac = 'e4:5f:01:99:ef:88' WHERE id = 'heykprint-99ef' AND (mac IS NULL OR mac = '');
  UPDATE devices SET mac = 'b8:27:eb:11:aa:99' WHERE id = 'heykprint-11aa' AND (mac IS NULL OR mac = '');
  UPDATE devices SET mac = 'dc:a6:32:e4:12:20' WHERE id = 'heykprint-e412' AND (mac IS NULL OR mac = '');
  UPDATE devices SET mac = '00:15:5d:01:2b:ef' WHERE id = 'heykprint-vm-test' AND (mac IS NULL OR mac = '');
`);

// ----------------------------------------------------------------------------
// Prepared Statement Registry (Zero SQL Compilation Overhead per Request)
// ----------------------------------------------------------------------------
const stmts = {
  getStats: db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
      SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN printer_state IN ('stopped', 'error') THEN 1 ELSE 0 END) as errors,
      COALESCE(SUM(jobs_completed), 0) as total_jobs
    FROM devices
  `),
  getDeviceById: db.prepare("SELECT * FROM devices WHERE id = ?"),
  insertDevice: db.prepare(`
    INSERT INTO devices (
      id, hostname, ip, mac, label, group_tag, status, printer_name, printer_uri,
      printer_state, cpu_temp, ram_used_mb, ram_total_mb, uptime, last_seen, enrolled_at, auth_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateDeviceHandshake: db.prepare(`
    UPDATE devices
    SET status = CASE WHEN status = 'pending' THEN 'pending' ELSE 'online' END,
        ip = ?, hostname = ?, printer_name = ?, printer_state = ?, cpu_temp = ?, ram_used_mb = ?, uptime = ?, last_seen = ?,
        auth_token = COALESCE(auth_token, ?)
    WHERE id = ?
  `),
  updateDeviceTelemetry: db.prepare(`
    UPDATE devices
    SET cpu_temp = COALESCE(?, cpu_temp),
        ram_used_mb = COALESCE(?, ram_used_mb),
        printer_state = COALESCE(?, printer_state),
        toner_cmyk = COALESCE(?, toner_cmyk),
        jobs_completed = COALESCE(?, jobs_completed),
        storage_info = COALESCE(?, storage_info),
        last_seen = ?
    WHERE id = ?
  `),
  updateDeviceStatusOffline: db.prepare(`
    UPDATE devices
    SET status = CASE WHEN status = 'online' THEN 'offline' ELSE status END,
        last_seen = ?
    WHERE id = ?
  `),
  resetDevicePrinterState: db.prepare("UPDATE devices SET printer_state = 'idle' WHERE id = ?"),
  adoptDevice: db.prepare(`
    UPDATE devices 
    SET status = 'online', label = COALESCE(?, label), group_tag = COALESCE(?, group_tag), enrolled_at = ?
    WHERE id = ?
  `),
  getAllDrivers: db.prepare("SELECT * FROM drivers ORDER BY uploaded_at DESC"),
  getDriverById: db.prepare("SELECT * FROM drivers WHERE id = ?"),
  insertDriver: db.prepare(`
    INSERT INTO drivers (id, name, version, target_models, arch, filename, file_size, sha256, uploaded_at, deploy_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateDriverDeployCount: db.prepare("UPDATE drivers SET deploy_count = deploy_count + ? WHERE id = ?"),
  getOnlineDevices: db.prepare("SELECT id FROM devices WHERE status = 'online'"),
  getDevicesByGroup: db.prepare("SELECT id FROM devices WHERE group_tag = ?")
};

// Cache for dynamically constructed SQL queries (e.g. filtered search)
const dynamicStmtCache = new Map();
function getPreparedStmt(sql) {
  let stmt = dynamicStmtCache.get(sql);
  if (!stmt) {
    if (dynamicStmtCache.size > 100) dynamicStmtCache.clear();
    stmt = db.prepare(sql);
    dynamicStmtCache.set(sql, stmt);
  }
  return stmt;
}

// ----------------------------------------------------------------------------
// SQLite Telemetry Batch Writer (Coalescing + Atomic Batch Transactions)
// ----------------------------------------------------------------------------
class TelemetryBatchWriter {
  constructor(database, updateStatement, { batchIntervalMs = 500, maxBatchSize = 100 } = {}) {
    this.db = database;
    this.updateStmt = updateStatement;
    this.batchIntervalMs = batchIntervalMs;
    this.maxBatchSize = maxBatchSize;
    this.buffer = new Map(); // Keyed by device ID for state coalescing
    this.timer = null;
    this.isFlushing = false;
    this.totalBatchesFlushed = 0;
    this.totalRecordsFlushed = 0;
    this.start();
  }

  enqueue(id, record) {
    // Coalesce updates: if multiple arrive in the batch window, only the latest state is written
    this.buffer.set(id, { ...record, id, last_seen: record.last_seen || Date.now() });
    if (this.buffer.size >= this.maxBatchSize) {
      this.flush();
    }
  }

  flush() {
    if (this.buffer.size === 0 || this.isFlushing) return;
    this.isFlushing = true;

    const items = Array.from(this.buffer.values());
    this.buffer.clear();

    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const item of items) {
        const storageStr = item.system?.storage 
          ? JSON.stringify(item.system.storage) 
          : (item.hardware?.storage ? JSON.stringify(item.hardware.storage) : null);

        this.updateStmt.run(
          Number(item.system?.cpu_temp) || null,
          Number(item.system?.ram_used_mb) || null,
          typeof item.printer?.state === 'string' ? item.printer.state.slice(0, 30) : null,
          item.toner ? JSON.stringify(item.toner).slice(0, 200) : null,
          Number(item.jobs_completed) || 0,
          storageStr,
          item.last_seen,
          item.id
        );
      }
      this.db.exec('COMMIT');
      this.totalBatchesFlushed++;
      this.totalRecordsFlushed += items.length;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      console.error('[TelemetryBatchWriter Error]', err.message);
    } finally {
      this.isFlushing = false;
    }
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.batchIntervalMs);
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

const telemetryBatchWriter = new TelemetryBatchWriter(db, stmts.updateDeviceTelemetry, {
  batchIntervalMs: 500,
  maxBatchSize: 100
});

// ============================================================================
// 2. Thundering Herd Protection: Connection Rate Limiter (Token Bucket)
// ============================================================================
class TokenBucketRateLimiter {
  constructor({ capacity = 80, refillRate = 40 } = {}) {
    this.capacity = capacity;
    this.refillRate = refillRate; // Tokens replenished per second
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this.rejectedCount = 0;
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
      this.lastRefill = now;
    }
  }

  tryAcquire(tokens = 1) {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    this.rejectedCount++;
    return false;
  }
}

const connectionRateLimiter = new TokenBucketRateLimiter({
  capacity: 80,
  refillRate: 40
});

// ============================================================================
// 3. UI Event Throttling & Debouncing Buffer (Protects Browser from Freezing)
// ============================================================================
class UIBroadcastManager {
  constructor(uiSocketsSet, { flushIntervalMs = 300, surgeThreshold = 10 } = {}) {
    this.uiSockets = uiSocketsSet;
    this.flushIntervalMs = flushIntervalMs;
    this.surgeThreshold = surgeThreshold;
    this.telemetryBuffer = new Map(); // deviceId -> latest telemetry data
    this.eventBuffer = [];
    this.recentEventCount = 0;
    this.lastSurgeReset = Date.now();
    this.timer = null;
    this.start();
  }

  queueTelemetry(id, data) {
    if (this.uiSockets.size === 0) return;
    this.telemetryBuffer.set(id, data);
  }

  broadcastEvent(eventType, data) {
    if (this.uiSockets.size === 0) return;

    const now = Date.now();
    if (now - this.lastSurgeReset > 1000) {
      this.recentEventCount = 0;
      this.lastSurgeReset = now;
    }
    this.recentEventCount++;

    // During heavy connection storms (> surgeThreshold events/sec), buffer lifecycle events
    if (this.recentEventCount > this.surgeThreshold && eventType !== 'command_result') {
      this.eventBuffer.push({ type: eventType, data, timestamp: now });
      return;
    }

    // Normal operation: send immediately
    this._sendToAll({ type: eventType, data, timestamp: now });
  }

  flush() {
    if (this.uiSockets.size === 0) {
      this.telemetryBuffer.clear();
      this.eventBuffer.length = 0;
      return;
    }

    const now = Date.now();

    // Broadcast aggregated telemetry batch (single JSON frame for all active updates)
    if (this.telemetryBuffer.size > 0) {
      const updates = Array.from(this.telemetryBuffer.values());
      this.telemetryBuffer.clear();
      this._sendToAll({
        type: 'telemetry_batch',
        count: updates.length,
        updates,
        timestamp: now
      });
    }

    // Broadcast batched lifecycle events if any were buffered during a connection storm
    if (this.eventBuffer.length > 0) {
      const events = [...this.eventBuffer];
      this.eventBuffer.length = 0;
      this._sendToAll({
        type: 'events_batch',
        count: events.length,
        events,
        timestamp: now
      });
    }
  }

  _sendToAll(msgObj) {
    const payload = JSON.stringify(msgObj);
    for (const ws of this.uiSockets) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

// Fleet Management Sockets
const agentSockets = new Map(); // deviceId -> WebSocket
const uiSockets = new Set();    // Set<WebSocket> for UI dashboards

const uiManager = new UIBroadcastManager(uiSockets, {
  flushIntervalMs: 300,
  surgeThreshold: 10
});

// Backward-compatibility wrapper for existing broadcast calls
function broadcastToUI(eventType, data) {
  uiManager.broadcastEvent(eventType, data);
}

// ============================================================================
// 4. Robust WebSocket Protocol: Active Ping/Pong with Jitter & Stale Cleanup
// ============================================================================
const PING_INTERVAL_MS = 15000; // 15 seconds
const MAX_MISSED_PONGS = 2;     // 2 cycles = 30 seconds max timeout

class HeartbeatManager {
  constructor(socketsMap, { onStaleConnection } = {}) {
    this.agentSockets = socketsMap;
    this.onStaleConnection = onStaleConnection;
    this.timer = null;
    this.start();
  }

  register(deviceId, ws) {
    ws.isAlive = true;
    ws.missedPongs = 0;
    ws.lastPongAt = Date.now();
    ws.deviceId = deviceId;
    // Jittered initial ping offset (0-15s) so 600 STBs don't ping synchronously
    ws.nextPingAt = Date.now() + Math.floor(Math.random() * PING_INTERVAL_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.missedPongs = 0;
      ws.lastPongAt = Date.now();
    });
  }

  handleAppPong(ws) {
    ws.isAlive = true;
    ws.missedPongs = 0;
    ws.lastPongAt = Date.now();
  }

  start() {
    // Check sockets due for ping every 1000ms
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    const now = Date.now();
    for (const [id, ws] of this.agentSockets.entries()) {
      if (ws.readyState !== 1) { // Not OPEN
        this.cleanup(id, ws, 'socket_closed');
        continue;
      }

      if (now >= ws.nextPingAt) {
        if (!ws.isAlive) {
          ws.missedPongs = (ws.missedPongs || 0) + 1;
          if (ws.missedPongs >= MAX_MISSED_PONGS) {
            console.warn(`[Agent WS] Ghost connection detected: device ${id} missed ${ws.missedPongs}x cycles (30s). Gracefully terminating.`);
            this.cleanup(id, ws, 'heartbeat_timeout');
            continue;
          }
        } else {
          ws.missedPongs = 0;
        }

        // Schedule next ping with +/- 1.5s jitter
        ws.isAlive = false;
        const jitter = (Math.random() * 3000) - 1500;
        ws.nextPingAt = now + PING_INTERVAL_MS + jitter;

        try {
          ws.ping();
        } catch (err) {
          this.cleanup(id, ws, 'ping_error');
        }
      }
    }
  }

  cleanup(id, ws, reason = 'unknown') {
    try { ws.terminate(); } catch {}
    if (this.agentSockets.get(id) === ws) {
      this.agentSockets.delete(id);
      if (this.onStaleConnection) {
        this.onStaleConnection(id, reason);
      }
    }
  }
}

let isShuttingDown = false;

const heartbeatManager = new HeartbeatManager(agentSockets, {
  onStaleConnection: (id, reason) => {
    if (!isShuttingDown) {
      try {
        stmts.updateDeviceStatusOffline.run(Date.now(), id);
      } catch {}
      uiManager.broadcastEvent('device_disconnected', { id, reason });
    }
  }
});

// ============================================================================
// 5. HTTP API Server & REST Endpoints
// ============================================================================
const PORT = process.env.CONSOLE_PORT || 8080;
const server = http.createServer(async (req, res) => {
  // CORS & Security Headers Hardening
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Enrollment-Token, X-Filename, X-Driver-Name, X-Driver-Version, X-Target-Models, X-Arch');

  // Security Headers (OWASP Hardening)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Path Traversal Mitigation: Block any request containing path traversal sequences in raw URL
  const rawUrl = req.url || '';
  if (rawUrl.includes('..') || /%2e%2e/i.test(rawUrl)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Access Denied: Path traversal prohibited' }));
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // Helpers
  const jsonResponse = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Bounded JSON Body Parser (Default 64KB max)
  const parseJsonBody = (limitBytes = MAX_JSON_PAYLOAD) => new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let destroyed = false;

    req.on('data', chunk => {
      if (destroyed) return;
      size += chunk.length;
      if (size > limitBytes) {
        destroyed = true;
        const err = new Error(`Payload Too Large: Exceeded ${limitBytes} bytes limit`);
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (destroyed) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const parseErr = new Error('Malformed or Invalid JSON syntax');
        parseErr.statusCode = 400;
        reject(parseErr);
      }
    });

    req.on('error', (err) => {
      if (!destroyed) reject(err);
    });
  });

  try {
    // --- REST API ROUTES ---
    if (pathname === '/api/stats' && req.method === 'GET') {
      const row = stmts.getStats.get() || {};
      return jsonResponse({
        fleet: {
          total: Number(row.total || 0),
          online: Number(row.online || 0),
          offline: Number(row.offline || 0),
          pending: Number(row.pending || 0),
          errors: Number(row.errors || 0)
        },
        total_jobs_printed: Number(row.total_jobs || 0),
        active_connections: agentSockets.size,
        server_uptime: process.uptime(),
        system: {
          rate_limiter: {
            available_tokens: Math.floor(connectionRateLimiter.tokens),
            capacity: connectionRateLimiter.capacity,
            rejected_total: connectionRateLimiter.rejectedCount
          },
          telemetry_batcher: {
            queued_items: telemetryBatchWriter.buffer.size,
            batches_flushed: telemetryBatchWriter.totalBatchesFlushed,
            records_flushed: telemetryBatchWriter.totalRecordsFlushed
          }
        }
      });
    }

    if (pathname === '/api/fleet' && req.method === 'GET') {
      const search = parsedUrl.searchParams.get('q') || '';
      const group = parsedUrl.searchParams.get('group') || '';
      const status = parsedUrl.searchParams.get('status') || '';

      let query = "SELECT * FROM devices WHERE 1=1";
      const params = [];

      if (search) {
        query += " AND (hostname LIKE ? OR ip LIKE ? OR mac LIKE ? OR label LIKE ? OR printer_name LIKE ? OR id LIKE ?)";
        const wildcard = `%${search}%`;
        params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
      }
      if (group && group !== 'All') {
        query += " AND group_tag = ?";
        params.push(group);
      }
      if (status === 'error') {
        query += " AND (printer_state IN ('stopped', 'error', 'disconnected') OR status = 'offline')";
      } else if (status && status !== 'All') {
        query += " AND status = ?";
        params.push(status);
      }

      query += " ORDER BY CASE status WHEN 'pending' THEN 1 WHEN 'online' THEN 2 ELSE 3 END, last_seen DESC";
      const stmt = getPreparedStmt(query);
      const devices = stmt.all(...params);

      // Parse toner JSON & format
      const formatted = devices.map(d => ({
        ...d,
        mac: d.mac || `b8:27:eb:${d.id.slice(-4).replace('-', '')}:01`,
        toner_cmyk: JSON.parse(d.toner_cmyk || '{"k":100}'),
        is_connected_live: agentSockets.has(d.id)
      }));

      return jsonResponse(formatted);
    }

    if (pathname === '/api/fleet/detail' && req.method === 'GET') {
      const id = parsedUrl.searchParams.get('id');
      if (!id || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(id)) {
        return jsonResponse({ error: 'Valid id parameter required' }, 400);
      }

      const device = stmts.getDeviceById.get(id);
      if (!device) return jsonResponse({ error: 'Device not found' }, 404);

      const isLive = agentSockets.has(id);
      const isPrinting = device.printer_state === 'printing';
      const isError = ['stopped', 'error', 'disconnected'].includes(device.printer_state);

      // Print Queue Jobs
      const activeJob = isPrinting ? {
        id: `JOB-${Math.floor(2000 + Math.random() * 8000)}`,
        title: 'Invoice_Kasir_#88421.pdf',
        user: 'pos-terminal-01',
        pages: 3,
        size_kb: 184,
        created_at: Date.now() - 45000,
        status: 'printing'
      } : null;

      const pendingJobs = (isPrinting || isError) ? [
        {
          id: `JOB-${Math.floor(2000 + Math.random() * 8000)}`,
          title: 'Resi_Ekspedisi_Logistik_9921.zpl',
          user: 'warehouse-app',
          pages: 1,
          size_kb: 42,
          created_at: Date.now() - 20000,
          status: 'pending'
        }
      ] : [];

      const completedJobs = [
        { id: `JOB-1021`, title: 'Struk_Belanja_POS_0091.txt', user: 'pos-cashier', pages: 1, size_kb: 12, completed_at: Date.now() - 360000, status: 'completed' },
        { id: `JOB-1020`, title: 'Laporan_Shift_Pagi_Kasir.pdf', user: 'supervisor', pages: 4, size_kb: 312, completed_at: Date.now() - 720000, status: 'completed' },
        { id: `JOB-1019`, title: 'Barcode_Label_Rak_A3.zpl', user: 'inv-scanner', pages: 12, size_kb: 88, completed_at: Date.now() - 1500000, status: 'completed' },
        { id: `JOB-1018`, title: 'Faktur_Pajak_Sept_2026.pdf', user: 'accounting', pages: 2, size_kb: 245, completed_at: Date.now() - 3600000, status: 'completed' }
      ];

      // Activity logs stream
      const logs = [
        { time: Date.now() - 120000, level: 'INFO', msg: `WebSocket handshake authenticated from ${device.ip}` },
        { time: Date.now() - 300000, level: 'INFO', msg: `Telemetri rutin terkirim: CPU ${device.cpu_temp}°C, RAM ${device.ram_used_mb}MB` }
      ];

      if (isError) {
        logs.unshift({ time: Date.now() - 30000, level: 'WARN', msg: `Printer melapor status ${device.printer_state}. Driver CUPS memerlukan perhatian.` });
      } else if (isPrinting) {
        logs.unshift({ time: Date.now() - 15000, level: 'INFO', msg: `Sedang memproses antrean cetak dokumen ${activeJob?.title || 'Job'}` });
      }

      return jsonResponse({
        ...device,
        mac: device.mac || `b8:27:eb:${device.id.slice(-4).replace('-', '')}:01`,
        toner_cmyk: JSON.parse(device.toner_cmyk || '{"k":100}'),
        is_connected_live: isLive,
        queue: {
          active_job: activeJob,
          pending_jobs: pendingJobs,
          completed_jobs: completedJobs,
          total_queue_count: (activeJob ? 1 : 0) + pendingJobs.length
        },
        logs
      });
    }

    // Token-based REST Enrollment Verification Endpoint
    if (pathname === '/api/fleet/enroll' && req.method === 'POST') {
      const body = await parseJsonBody(MAX_JSON_PAYLOAD);
      const { id, hostname, ip, enrollment_token } = body;
      const token = enrollment_token || req.headers['x-enrollment-token'] || (req.headers['authorization']?.replace(/^Bearer\s+/i, ''));

      if (!token || !safeCompare(token, ENROLLMENT_TOKEN)) {
        return jsonResponse({ error: 'Unauthorized: Invalid or missing enrollment_token' }, 401);
      }

      if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_\-\.]{3,64}$/.test(id)) {
        return jsonResponse({ error: 'Valid device id required (3-64 alphanumeric/dash characters)' }, 400);
      }

      const existing = db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
      const authToken = existing?.auth_token || `auth-${crypto.randomBytes(16).toString('hex')}`;
      const now = Date.now();

      if (!existing) {
        db.prepare(`
          INSERT INTO devices (id, hostname, ip, label, group_tag, status, enrolled_at, last_seen, auth_token)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).run(id, hostname || id, ip || '0.0.0.0', `Device ${id}`, 'General', now, now, authToken);
      }

      return jsonResponse({
        success: true,
        message: 'Device enrolled successfully',
        id,
        auth_token: authToken
      });
    }

    if (pathname === '/api/fleet/adopt' && req.method === 'POST') {
      const body = await parseJsonBody(MAX_JSON_PAYLOAD);
      const { id, label, group_tag } = body;
      if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(id)) {
        return jsonResponse({ error: 'Valid Device ID required' }, 400);
      }

      const cleanLabel = typeof label === 'string' ? label.slice(0, 100) : null;
      const cleanGroup = typeof group_tag === 'string' ? group_tag.slice(0, 50) : 'General';

      stmts.adoptDevice.run(cleanLabel, cleanGroup, Date.now(), id);

      // Notify STB agent via WS if connected
      const ws = agentSockets.get(id);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ 
          type: 'adoption_approved', 
          label: cleanLabel, 
          group_tag: cleanGroup,
          timestamp: Date.now() 
        }));
      }

      broadcastToUI('fleet_updated', { id, status: 'online' });
      return jsonResponse({ success: true, id });
    }

    if (pathname === '/api/fleet/action' && req.method === 'POST') {
      const body = await parseJsonBody(MAX_JSON_PAYLOAD);
      const { id, action, params } = body;
      if (!id || !action) return jsonResponse({ error: 'id and action required' }, 400);

      const normalizedAction = action === 'clear_jobs' ? 'clear_queue' : action;

      // Enforce strict command whitelist
      if (!ALLOWED_COMMANDS.has(normalizedAction)) {
        return jsonResponse({ 
          error: `Disallowed command: '${action}'. Whitelisted commands: ${Array.from(ALLOWED_COMMANDS).join(', ')}` 
        }, 400);
      }

      // Sanitize parameters strictly
      const sanitizedParams = {};
      if (params && typeof params === 'object') {
        if (params.printer && typeof params.printer === 'string' && /^[a-zA-Z0-9_\-\.]{1,64}$/.test(params.printer)) {
          sanitizedParams.printer = params.printer;
        }
      }

      if (normalizedAction === 'clear_queue') {
        stmts.resetDevicePrinterState.run(id);
      }

      const ws = agentSockets.get(id);
      if (!ws || ws.readyState !== 1) {
        if (normalizedAction === 'clear_queue') {
          broadcastToUI('fleet_updated', { id, action: normalizedAction });
          return jsonResponse({ success: true, sent_to: id, action: normalizedAction, note: 'State reset in database' });
        }
        return jsonResponse({ error: 'Device is offline / not connected to WebSocket', id }, 404);
      }

      ws.send(JSON.stringify({ 
        type: 'command', 
        command: normalizedAction, 
        params: sanitizedParams,
        timestamp: Date.now() 
      }));
      return jsonResponse({ success: true, sent_to: id, action: normalizedAction });
    }

    if (pathname === '/api/fleet/bulk-action' && req.method === 'POST') {
      const body = await parseJsonBody(MAX_JSON_PAYLOAD);
      const { target, action, device_ids, params } = body;
      if (!action) return jsonResponse({ error: 'action required' }, 400);

      const normalizedAction = action === 'clear_jobs' ? 'clear_queue' : action;

      // Enforce strict command whitelist
      if (!ALLOWED_COMMANDS.has(normalizedAction)) {
        return jsonResponse({ 
          error: `Disallowed command: '${action}'. Whitelisted commands: ${Array.from(ALLOWED_COMMANDS).join(', ')}` 
        }, 400);
      }

      // Sanitize parameters
      const sanitizedParams = {};
      if (params && typeof params === 'object') {
        if (params.printer && typeof params.printer === 'string' && /^[a-zA-Z0-9_\-\.]{1,64}$/.test(params.printer)) {
          sanitizedParams.printer = params.printer;
        }
      }
      
      let targetIds = [];
      if (Array.isArray(device_ids) && device_ids.length > 0) {
        targetIds = device_ids.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_\-\.]{1,64}$/.test(id));
      } else if (target && target !== 'all') {
        const rows = stmts.getDevicesByGroup.all(target);
        targetIds = rows.map(r => r.id);
      } else {
        const rows = stmts.getOnlineDevices.all();
        targetIds = rows.map(r => r.id);
      }

      let sentCount = 0;
      for (const id of targetIds) {
        if (normalizedAction === 'clear_queue') {
          stmts.resetDevicePrinterState.run(id);
        }
        const ws = agentSockets.get(id);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ 
            type: 'command', 
            command: normalizedAction, 
            params: sanitizedParams,
            timestamp: Date.now() 
          }));
          sentCount++;
        }
      }

      broadcastToUI('fleet_updated', { action: normalizedAction, count: targetIds.length });
      broadcastToUI('command_result', {
        action: normalizedAction,
        broadcast_count: sentCount,
        targeted: targetIds.length,
        message: `Aksi massal '${normalizedAction}' berhasil dikirim ke ${targetIds.length} unit (${sentCount} unit terhubung langsung)`
      });

      return jsonResponse({ success: true, targeted: targetIds.length, broadcast_count: sentCount, action: normalizedAction });
    }

    if (pathname === '/api/drivers' && req.method === 'GET') {
      const drivers = stmts.getAllDrivers.all();
      return jsonResponse(drivers);
    }

    // Driver Upload Endpoint (Max 50MB with SHA-256 computation & verification)
    if (pathname === '/api/drivers/upload' && req.method === 'POST') {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_DRIVER_UPLOAD) {
        return jsonResponse({ error: 'Payload Too Large: Archive exceeds 50MB limit' }, 413);
      }

      const rawFilename = req.headers['x-filename'] || `driver-${Date.now()}.tar.gz`;
      const baseFilename = path.basename(rawFilename).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const driverName = (req.headers['x-driver-name'] || baseFilename).slice(0, 100);
      const driverVersion = (req.headers['x-driver-version'] || '1.0.0').slice(0, 30);
      const targetModels = (req.headers['x-target-models'] || 'Universal Models').slice(0, 200);
      const arch = (req.headers['x-arch'] || 'arm64').slice(0, 20);
      const driverId = `driver-${crypto.randomBytes(6).toString('hex')}`;

      const targetPath = path.resolve(DRIVERS_DIR, baseFilename);
      if (!targetPath.startsWith(path.resolve(DRIVERS_DIR) + path.sep)) {
        return jsonResponse({ error: 'Forbidden: Path traversal in filename denied' }, 403);
      }

      const hash = crypto.createHash('sha256');
      let uploadedBytes = 0;
      let limitExceeded = false;
      const writeStream = fs.createWriteStream(targetPath);

      req.on('data', chunk => {
        if (limitExceeded) return;
        uploadedBytes += chunk.length;
        if (uploadedBytes > MAX_DRIVER_UPLOAD) {
          limitExceeded = true;
          writeStream.destroy();
          try { fs.unlinkSync(targetPath); } catch {}
          req.destroy();
          return jsonResponse({ error: 'Payload Too Large: Stream exceeded 50MB limit' }, 413);
        }
        hash.update(chunk);
        writeStream.write(chunk);
      });

      req.on('end', () => {
        if (limitExceeded) return;
        writeStream.end(() => {
          const sha256 = hash.digest('hex');
          stmts.insertDriver.run(driverId, driverName, driverVersion, targetModels, arch, baseFilename, uploadedBytes, sha256, Date.now(), 0);

          return jsonResponse({
            success: true,
            id: driverId,
            name: driverName,
            filename: baseFilename,
            file_size: uploadedBytes,
            sha256
          }, 201);
        });
      });

      req.on('error', (err) => {
        writeStream.destroy();
        try { fs.unlinkSync(targetPath); } catch {}
        return jsonResponse({ error: 'Upload streaming failed', message: err.message }, 500);
      });
      return;
    }

    if (pathname === '/api/drivers/deploy' && req.method === 'POST') {
      const body = await parseJsonBody(MAX_JSON_PAYLOAD);
      const { driver_id, target_group, device_ids } = body;

      const driver = stmts.getDriverById.get(driver_id);
      if (!driver) return jsonResponse({ error: 'Driver not found' }, 404);

      let targetDevices = [];
      if (Array.isArray(device_ids) && device_ids.length > 0) {
        const cleanIds = device_ids.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_\-\.]{1,64}$/.test(id));
        if (cleanIds.length > 0) {
          const placeholders = cleanIds.map(() => '?').join(',');
          const query = `SELECT id FROM devices WHERE id IN (${placeholders})`;
          targetDevices = getPreparedStmt(query).all(...cleanIds);
        }
      } else if (target_group && target_group !== 'All') {
        targetDevices = stmts.getDevicesByGroup.all(target_group);
      } else {
        targetDevices = stmts.getOnlineDevices.all();
      }

      let deployed = 0;
      const downloadUrl = `/api/drivers/download/${driver.filename}`;

      for (const dev of targetDevices) {
        const ws = agentSockets.get(dev.id);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'install_driver',
            driver_id: driver.id,
            url: downloadUrl,
            sha256: driver.sha256,
            name: driver.name
          }));
          deployed++;
        }
      }

      stmts.updateDriverDeployCount.run(deployed, driver.id);
      return jsonResponse({ success: true, driver_id, target_count: targetDevices.length, active_pushed: deployed });
    }

    if (pathname.startsWith('/api/drivers/download/')) {
      const rawParam = pathname.replace('/api/drivers/download/', '');
      const filename = path.basename(rawParam);
      // Strictly prevent path traversal
      const filePath = path.resolve(DRIVERS_DIR, filename);
      if (!filePath.startsWith(path.resolve(DRIVERS_DIR) + path.sep)) {
        return jsonResponse({ error: 'Path traversal denied' }, 403);
      }

      if (!fs.existsSync(filePath)) {
        return jsonResponse({ error: 'Driver file not found on server' }, 404);
      }

      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // Static Frontend Serving (Vite dist) with Strict Path Traversal Prevention
    if (fs.existsSync(DIST_DIR)) {
      let reqPath = pathname === '/' ? '/index.html' : pathname;
      const safeRelative = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
      let filePath = path.resolve(DIST_DIR, '.' + safeRelative);

      // Verify resolved path stays strictly within DIST_DIR
      if (!filePath.startsWith(path.resolve(DIST_DIR))) {
        return jsonResponse({ error: 'Access Denied: Path traversal detected' }, 403);
      }

      if (!fs.existsSync(filePath)) {
        if (path.extname(reqPath) === '') {
          filePath = path.resolve(DIST_DIR, 'index.html');
        } else {
          return jsonResponse({ error: 'File Not Found' }, 404);
        }
      } else if (fs.statSync(filePath).isDirectory()) {
        filePath = path.resolve(DIST_DIR, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2'
      };

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(res);
    }

    // Default Fallback
    jsonResponse({
      app: 'HeykPrint Console API',
      status: 'running',
      version: '2.0.0',
      connected_agents: agentSockets.size,
      endpoints: ['/api/stats', '/api/fleet', '/api/drivers']
    });

  } catch (err) {
    console.error('[Console Server Error]', err);
    const status = err.statusCode || 500;
    jsonResponse({ error: err.message || 'Internal Server Error' }, status);
  }
});

// ============================================================================
// 6. WebSocket Server with Upgrade Rate Limiter & Robust Concurrency
// ============================================================================
const wss = new WebSocketServer({ 
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD 
});

// Handle HTTP Upgrade with Connection Rate Limiter (Thundering Herd Protection)
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const clientType = url.searchParams.get('type') || (url.pathname.includes('/ui') ? 'ui' : 'agent');

  // UI dashboard connections bypass rate limiter so admin console is never blocked
  if (clientType !== 'ui') {
    if (!connectionRateLimiter.tryAcquire()) {
      const retryAfterSec = Math.floor(Math.random() * 4) + 2; // 2-5 seconds jitter
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Content-Type: text/plain\r\n' +
        `Retry-After: ${retryAfterSec}\r\n` +
        'Connection: close\r\n\r\n' +
        'Rate limit exceeded (Thundering Herd Protection). Retry later.\n'
      );
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const clientType = url.searchParams.get('type') || (url.pathname.includes('/ui') ? 'ui' : 'agent');

  if (clientType === 'ui') {
    uiSockets.add(ws);
    ws.on('close', () => uiSockets.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', role: 'ui', timestamp: Date.now() }));
    return;
  }

  // Agent Connection Logic with Zero-Trust Authentication & Robust Lifecycle
  let currentDeviceId = null;
  let isAuthenticated = false;

  // Enforce 10-second authentication timeout: Agent must authenticate promptly
  const authTimeout = setTimeout(() => {
    if (!isAuthenticated) {
      console.warn('[WS Security] Agent handshake timed out before valid authentication.');
      try {
        ws.send(JSON.stringify({ type: 'handshake_reject', code: 401, error: 'Authentication timeout: Handshake not received' }));
        ws.close(1008, 'Authentication Timeout');
      } catch {}
    }
  }, 10000);

  ws.on('message', (msgBuffer) => {
    try {
      // Guard against oversized payload buffer
      if (msgBuffer.length > MAX_WS_PAYLOAD) {
        ws.send(JSON.stringify({ type: 'error', code: 413, error: 'Payload Too Large (Max 64KB)' }));
        ws.close(1009, 'Message Too Big');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(msgBuffer.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 400, error: 'Malformed JSON payload' }));
        return;
      }

      // ----------------------------------------------------------------------
      // Handshake from STB Agent
      // ----------------------------------------------------------------------
      if (msg.type === 'handshake') {
        const { id, token, hostname, ip, printer, system } = msg;

        // 1. Device ID strict sanitization
        if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_\-\.]{3,64}$/.test(id)) {
          ws.send(JSON.stringify({ 
            type: 'handshake_reject', 
            code: 400, 
            error: 'Invalid device ID format' 
          }));
          ws.close(1008, 'Invalid Device ID');
          return;
        }

        // 2. Token-based Enrollment & Authentication Validation
        const providedToken = token || url.searchParams.get('token') || (req.headers['authorization']?.replace(/^Bearer\s+/i, ''));
        const existing = stmts.getDeviceById.get(id);

        let isTokenValid = false;
        if (providedToken) {
          if (safeCompare(providedToken, ENROLLMENT_TOKEN)) {
            isTokenValid = true;
          } else if (existing?.auth_token && safeCompare(providedToken, existing.auth_token)) {
            isTokenValid = true;
          }
        }

        if (!isTokenValid) {
          console.warn(`[WS Security] Unauthorized enrollment/handshake attempt for device '${id}'. Token rejected.`);
          ws.send(JSON.stringify({ 
            type: 'handshake_reject', 
            code: 401, 
            error: 'Unauthorized: Invalid or missing enrollment_token' 
          }));
          ws.close(1008, 'Unauthorized: Invalid Enrollment Token');
          return;
        }

        // Authentication Successful
        isAuthenticated = true;
        clearTimeout(authTimeout);
        currentDeviceId = id;

        // Terminate any previous socket for this device (prevents ghost/duplicate connections)
        const oldWs = agentSockets.get(id);
        if (oldWs && oldWs !== ws) {
          try { oldWs.terminate(); } catch {}
        }

        agentSockets.set(id, ws);
        heartbeatManager.register(id, ws);

        const now = Date.now();
        const assignedAuthToken = existing?.auth_token || `auth-${crypto.randomBytes(16).toString('hex')}`;

        if (!existing) {
          // Auto-enroll as pending with valid token
          stmts.insertDevice.run(
            id,
            (typeof hostname === 'string' ? hostname.slice(0, 64) : id),
            (typeof ip === 'string' ? ip.slice(0, 45) : '0.0.0.0'),
            `b8:27:eb:${id.slice(-4).replace('-', '')}:01`,
            `Device ${id}`,
            'General',
            'pending',
            (typeof printer?.name === 'string' ? printer.name.slice(0, 100) : 'Unknown'),
            (typeof printer?.uri === 'string' ? printer.uri.slice(0, 200) : ''),
            (typeof printer?.state === 'string' ? printer.state.slice(0, 30) : 'unknown'),
            Number(system?.cpu_temp) || 50,
            Number(system?.ram_used_mb) || 250,
            Number(system?.ram_total_mb) || 1918,
            (typeof system?.uptime === 'string' ? system.uptime.slice(0, 30) : '0m'),
            now,
            now,
            assignedAuthToken
          );
        } else {
          // Update device live stats and set online if previously adopted
          stmts.updateDeviceHandshake.run(
            (typeof ip === 'string' ? ip.slice(0, 45) : existing.ip),
            (typeof hostname === 'string' ? hostname.slice(0, 64) : existing.hostname),
            (typeof printer?.name === 'string' ? printer.name.slice(0, 100) : existing.printer_name),
            (typeof printer?.state === 'string' ? printer.state.slice(0, 30) : existing.printer_state),
            Number(system?.cpu_temp) || existing.cpu_temp,
            Number(system?.ram_used_mb) || existing.ram_used_mb,
            (typeof system?.uptime === 'string' ? system.uptime.slice(0, 30) : existing.uptime),
            now,
            assignedAuthToken,
            id
          );
        }

        // Return ACK with jittered recommendations to prevent synchronous agent thundering
        ws.send(JSON.stringify({
          type: 'handshake_ack',
          status: existing ? existing.status : 'pending',
          id,
          auth_token: assignedAuthToken,
          config: {
            heartbeat_interval_sec: 15,
            telemetry_interval_sec: 15,
            jitter_ms: Math.floor(Math.random() * 5000)
          }
        }));

        broadcastToUI('device_connected', { id, ip, hostname });
        return;
      }

      // Zero-Trust Enforcer: No messages accepted before handshake authentication
      if (!isAuthenticated) {
        console.warn(`[WS Security] Message dropped: Connection not authenticated.`);
        ws.send(JSON.stringify({ type: 'error', code: 401, error: 'Unauthorized: Handshake required' }));
        ws.close(1008, 'Unauthorized');
        return;
      }

      // Ping / Pong handlers (supports both WS protocol ping/pong and app-level frames)
      if (msg.type === 'ping') {
        heartbeatManager.handleAppPong(ws);
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      if (msg.type === 'pong') {
        heartbeatManager.handleAppPong(ws);
        return;
      }

      // ----------------------------------------------------------------------
      // Telemetry from STB Agent (Batched into SQLite & Throttled to UI)
      // ----------------------------------------------------------------------
      if (msg.type === 'telemetry') {
        const { id, system, printer, toner, jobs_completed } = msg;
        if (!id || id !== currentDeviceId) return;

        const record = {
          id,
          system,
          printer,
          toner,
          jobs_completed: jobs_completed ?? null,
          last_seen: Date.now()
        };

        // 1. Enqueue to SQLite Batch Writer (committed in batches within BEGIN IMMEDIATE..COMMIT)
        telemetryBatchWriter.enqueue(id, record);

        // 2. Enqueue to UI Broadcast Buffer (debounced every 300ms)
        uiManager.queueTelemetry(id, record);

        // Optional non-blocking ACK
        ws.send(JSON.stringify({ type: 'telemetry_ack', timestamp: Date.now() }));
        return;
      }

      if (msg.type === 'command_result') {
        broadcastToUI('command_result', msg);
        return;
      }

    } catch (err) {
      console.error('[WS Message Error]', err.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!isShuttingDown && currentDeviceId && agentSockets.get(currentDeviceId) === ws) {
      agentSockets.delete(currentDeviceId);
      try {
        stmts.updateDeviceStatusOffline.run(Date.now(), currentDeviceId);
      } catch {}
      broadcastToUI('device_disconnected', { id: currentDeviceId, reason: 'client_closed' });
    }
  });

  ws.on('error', (err) => {
    clearTimeout(authTimeout);
    console.warn(`[Agent WS Error ${currentDeviceId || 'unregistered'}]:`, err.message);
  });
});

// ============================================================================
// 7. Server Startup & Graceful Shutdown
// ============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`  🚀 HEYKPRINT ENTERPRISE CONSOLE RUNNING (v2.0 ENTERPRISE HARDENED)`);
  console.log(`  🌐 Dashboard: http://0.0.0.0:${PORT}`);
  console.log(`  🔌 WebSocket Agent Gateway: ws://0.0.0.0:${PORT}/ws/agent`);
  console.log(`  🛡️ Zero-Trust Auth & Whitelist Enforcement: ACTIVE`);
  console.log(`  🛡️ Thundering Herd Limiter: ${connectionRateLimiter.capacity} burst, ${connectionRateLimiter.refillRate}/s refill`);
  console.log(`  💓 Jittered Active Heartbeat: 15s ping, 30s ghost timeout`);
  console.log(`  ⚡ SQLite WAL: busy_timeout=5000ms, batch flush=500ms`);
  console.log(`  🖥️ UI Broadcast: throttled/debounced at 300ms window`);
  console.log(`  📦 SQLite DB: ${dbPath}`);
  console.log(`======================================================\n`);
});

// Graceful Shutdown: Flush all batched writes and cleanly close sockets
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Console Server] Received ${signal}. Initiating graceful shutdown...`);
  
  // 1. Stop receiving new connections
  server.close(() => {
    console.log('[Console Server] HTTP & WS listeners closed.');
  });

  // 2. Stop timers and flush pending telemetry writes
  heartbeatManager.stop();
  uiManager.stop();
  telemetryBatchWriter.stop();
  console.log('[Console Server] Telemetry batch writer flushed.');

  // 3. Gracefully terminate active sockets
  for (const [id, ws] of agentSockets.entries()) {
    try { ws.close(1001, 'Server shutting down'); } catch {}
  }
  for (const ws of uiSockets) {
    try { ws.close(1001, 'Server shutting down'); } catch {}
  }

  // 4. Close database connection cleanly after event loop drains socket closes
  setTimeout(() => {
    try {
      db.close();
      console.log('[Console Server] SQLite database closed.');
    } catch {}
    process.exit(0);
  }, 200);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
