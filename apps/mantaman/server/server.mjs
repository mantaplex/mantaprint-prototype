import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { MantaStore } from './db/store.mjs';
import { AdoptionEngine } from './controller/adoption-engine.mjs';
import { FleetManager } from './controller/fleet-manager.mjs';
import { BatchExecutor } from './controller/batch-executor.mjs';
import { UdpBeaconListener } from './discovery/udp-beacon.mjs';
import { SubnetScanner } from './discovery/subnet-scanner.mjs';

import { registerHubRoutes } from './routes/api-hubs.mjs';
import { registerSiteRoutes } from './routes/api-sites.mjs';
import { registerBatchRoutes } from './routes/api-batch.mjs';
import { registerAuthRoutes } from './routes/api-auth.mjs';
import { registerUpdateRoutes } from './routes/api-updates.mjs';
import { registerPeripheralRoutes } from './routes/api-peripherals.mjs';
import { MantaPoolUpdater } from './updater/manta-pool-updater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.MANTAMAN_PORT || process.env.PORT || '8443', 10);
const HOST = process.env.MANTAMAN_HOST || '0.0.0.0';

// 1. Storage & Controller Initializations
const store = new MantaStore();
const adoptionEngine = new AdoptionEngine(store);
const fleetManager = new FleetManager(store, adoptionEngine);
const batchExecutor = new BatchExecutor(store, fleetManager);
const updater = new MantaPoolUpdater(store);

// 2. Discovery Subsystems
const udpBeacon = new UdpBeaconListener({
  port: 9876,
  onDiscoveredHub: (hubInfo) => {
    store.upsertDiscoveredHub(hubInfo);
  }
});

const subnetScanner = new SubnetScanner({
  onDiscoveredHub: (hubInfo) => {
    store.upsertDiscoveredHub(hubInfo);
  }
});

// Simple Router implementation for native HTTP
class SimpleRouter {
  constructor() {
    this.routes = { GET: [], POST: [], PUT: [], DELETE: [] };
  }

  get(path, handler) { this._add('GET', path, handler); }
  post(path, handler) { this._add('POST', path, handler); }
  put(path, handler) { this._add('PUT', path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  _add(method, path, handler) {
    const paramNames = [];
    const regexStr = '^' + path.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    }) + '$';
    this.routes[method].push({ regex: new RegExp(regexStr), paramNames, handler });
  }

  match(method, pathname) {
    const list = this.routes[method] || [];
    for (const r of list) {
      const m = pathname.match(r.regex);
      if (m) {
        const params = {};
        r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

const router = new SimpleRouter();
registerHubRoutes(router, { store, adoptionEngine, fleetManager, subnetScanner });
registerSiteRoutes(router, { store });
registerBatchRoutes(router, { store, batchExecutor });
registerAuthRoutes(router, { store });
registerUpdateRoutes(router, { updater });
registerPeripheralRoutes(router, { store, fleetManager });

// 3. HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Handle API Requests
  if (pathname.startsWith('/api/')) {
    const match = router.match(method, pathname);
    if (match) {
      // Parse JSON body if present (guarded against unbounded payload DOS)
      let body = null;
      if (method === 'POST' || method === 'PUT') {
        try {
          const buffers = [];
          let totalBytes = 0;
          const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB ceiling
          for await (const chunk of req) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_BODY_BYTES) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Payload Too Large: Maximum 2MB allowed' }));
              return;
            }
            buffers.push(chunk);
          }
          const raw = Buffer.concat(buffers).toString('utf8');
          if (raw) body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid JSON payload' }));
          return;
        }
      }

      const reqWrapper = {
        params: match.params,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        body,
        headers: req.headers,
        user: { username: 'admin' }, // Default session wrapper
        ip: req.socket.remoteAddress,
        rawReq: req
      };

      const resWrapper = {
        statusCode: 200,
        rawRes: res,
        status(code) { this.statusCode = code; return this; }
      };

      try {
        const result = await match.handler(reqWrapper, resWrapper);
        if (!res.headersSent && result !== undefined) {
          res.writeHead(resWrapper.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'API route not found' }));
    return;
  }

  // Static Assets Serving (Guarded against Path Traversal & Symlink Attacks)
  if (req.url.includes('..') || req.url.includes('\\')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Forbidden: Path traversal sequence detected' }));
    return;
  }

  const distDir = path.resolve(__dirname, 'dist');
  const safePath = path.resolve(distDir, '.' + (pathname === '/' ? '/index.html' : pathname));

  if (safePath !== distDir && !safePath.startsWith(distDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Forbidden' }));
    return;
  }

  let filePath = safePath;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf'
    };

    const headers = {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    };

    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else if (pathname.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback Splash when frontend is not built yet
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>MantaMan Controller</title>
      <style>
        body { background: #070A0F; color: #E2E8F0; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #0B0F19; border: 1px solid #1E293B; border-radius: 12px; padding: 2rem; max-width: 500px; text-align: center; }
        h1 { color: #06B6D4; margin-bottom: 0.5rem; }
        p { color: #94A3B8; font-size: 0.95rem; }
        .badge { display: inline-block; padding: 0.25rem 0.75rem; background: rgba(6, 182, 212, 0.1); color: #06B6D4; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; margin-bottom: 1rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">FLEET CONTROLLER ACTIVE</div>
        <h1>MantaMan Console</h1>
        <p>Centralized Fleet Orchestration & Autonomous Adoption for MantaPrint Hubs.</p>
        <p>API Endpoint: <code>/api/v1/hubs</code> | WebSocket: <code>/ws/agent</code></p>
      </div>
    </body>
    </html>
  `);
});

// 4. WebSocket Multiplexing
// Route 1: /ws/agent -> Connected Edge Hubs (MantaPrint Hubs running mantaprint-agent)
// Route 2: /ws/console -> Connected Admin UI Browser Sessions
const wssAgent = new WebSocketServer({ noServer: true });
const wssConsole = new WebSocketServer({ noServer: true });

wssAgent.on('connection', (ws, req) => {
  fleetManager.handleAgentConnection(ws, req);
});

wssConsole.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Broadcast initial hubs snapshot
  const hubs = store.listHubs();
  ws.send(JSON.stringify({ type: 'snapshot', hubs }));

  // Forward fleet events to console
  const onTelemetry = (e) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'telemetry', ...e }));
  };
  const onHubConnect = (e) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hub_connected', ...e }));
  };
  const onHubDisconnect = (e) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hub_disconnected', ...e }));
  };

  fleetManager.on('telemetry', onTelemetry);
  fleetManager.on('hub_connected', onHubConnect);
  fleetManager.on('hub_disconnected', onHubDisconnect);

  let cleanedUp = false;
  const cleanupListeners = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    fleetManager.off('telemetry', onTelemetry);
    fleetManager.off('hub_connected', onHubConnect);
    fleetManager.off('hub_disconnected', onHubDisconnect);
  };

  ws.on('close', cleanupListeners);
  ws.on('error', cleanupListeners);
});

// Periodic Watchdog Heartbeat for Console WebSockets (30s interval)
const consoleHeartbeat = setInterval(() => {
  wssConsole.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
consoleHeartbeat.unref();

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;

  if (pathname === '/ws/agent') {
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      wssAgent.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/console') {
    wssConsole.handleUpgrade(req, socket, head, (ws) => {
      wssConsole.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 5. Start Server
server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🌊 MantaMan (Manta Manager) Enterprise Fleet Controller`);
  console.log(`   Version: 1.0.0`);
  console.log(`   Web Console: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`   Agent WebSocket: ws://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/ws/agent`);
  console.log(`   Database: ${store.dbPath}`);
  console.log(`=======================================================`);

  // Start UDP Discovery
  udpBeacon.start();
});

// 6. Graceful Shutdown
function handleShutdown() {
  console.log('\n[MantaMan] Gracefully shutting down fleet controller...');
  try { clearInterval(consoleHeartbeat); } catch {}
  try { udpBeacon.stop(); } catch {}
  try { fleetManager.destroy(); } catch {}
  try { wssAgent.close(); } catch {}
  try { wssConsole.close(); } catch {}
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
  const forceTimer = setTimeout(() => {
    console.log('[MantaMan] Exiting supervisor...');
    process.exit(0);
  }, 1500);
  forceTimer.unref();

  server.close(() => {
    clearTimeout(forceTimer);
    console.log('[MantaMan] Server stopped cleanly.');
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
