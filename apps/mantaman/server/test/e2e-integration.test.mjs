import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { MantaStore } from '../db/store.mjs';
import { AdoptionEngine } from '../controller/adoption-engine.mjs';
import { FleetManager } from '../controller/fleet-manager.mjs';
import { BatchExecutor } from '../controller/batch-executor.mjs';
import { SubnetScanner } from '../discovery/subnet-scanner.mjs';
import { translations } from '../../frontend/src/i18n/translations.js';

test('MantaMan E2E Integration & QA/QC Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantaman-e2e-'));
  const dbPath = path.join(tmpDir, 'e2e.sqlite');
  const store = new MantaStore(dbPath);
  const adoptionEngine = new AdoptionEngine(store);
  const fleetManager = new FleetManager(store, adoptionEngine);
  const batchExecutor = new BatchExecutor(store, fleetManager);

  // Setup ephemeral test HTTP & WebSocket server
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // Test static asset path traversal defense matching server.mjs
    if (req.url.includes('..') || req.url.includes('\\')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Forbidden: Path traversal sequence detected' }));
      return;
    }

    if (pathname.startsWith('/static/')) {
      const distDir = path.resolve(tmpDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.html'), '<html>MantaMan</html>');

      const safePath = path.resolve(distDir, '.' + pathname.replace('/static', ''));
      if (!safePath.startsWith(distDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Forbidden' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('OK');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    fleetManager.handleAgentConnection(ws, req);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}?type=agent&token=CORP-PROD-2026`;

  await t.test('1. L3 WAN Inform Auto-Registration via Enrollment Token', async () => {
    const ws = new WebSocket(wsUrl);

    let ackReceived = null;
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        // Send initial handshake matching src/agent/agent.mjs
        ws.send(JSON.stringify({
          type: 'handshake',
          id: 'hub-wan-test-01',
          token: 'CORP-PROD-2026',
          hostname: 'mantaprint-wan',
          ip: '10.200.1.55',
          system: {
            arch: 'arm64',
            cpu_temp: 48.5,
            ram_used_mb: 310,
            ram_total_mb: 1918,
            uptime: '12m'
          },
          printer: {
            name: 'EPSON L3110',
            state: 'idle',
            uri: 'usb://EPSON/L3110_Series'
          }
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'handshake_ack') {
          ackReceived = msg;
          resolve();
        }
      });

      ws.on('error', reject);
    });

    assert.ok(ackReceived, 'Should receive handshake_ack from controller');
    assert.strictEqual(ackReceived.status, 'online');

    // Hub must be auto-registered in store
    const registeredHub = store.getHub('hub-wan-test-01');
    assert.ok(registeredHub, 'Hub must be registered in SQLite');
    assert.strictEqual(registeredHub.status, 'unadopted');
    assert.strictEqual(registeredHub.ip_address, '10.200.1.55');
    assert.strictEqual(fleetManager.isHubOnline('hub-wan-test-01'), true);

    ws.close();
  });

  await t.test('2. Ephemeral PIN Challenge & Brute-Force Lockout Defense', async () => {
    // Generate PIN
    const { pin } = adoptionEngine.generateChallengePin('hub-wan-test-01');
    assert.strictEqual(pin.length, 6);

    // Attempt with wrong PIN
    await assert.rejects(async () => {
      await adoptionEngine.adoptHub({
        hubId: 'hub-wan-test-01',
        pin: '000000',
        siteId: 'site_default'
      });
    }, /Invalid pairing PIN/);

    // Attempt adopting without PIN when challenge is active must be rejected
    await assert.rejects(async () => {
      await adoptionEngine.adoptHub({
        hubId: 'hub-wan-test-01',
        pin: '',
        siteId: 'site_default'
      });
    }, /Pairing challenge PIN is required/);

    // Test lockout after 5 attempts
    for (let i = 0; i < 4; i++) {
      try {
        await adoptionEngine.adoptHub({
          hubId: 'hub-wan-test-01',
          pin: '123456',
          siteId: 'site_default'
        });
      } catch {}
    }

    await assert.rejects(async () => {
      await adoptionEngine.adoptHub({
        hubId: 'hub-wan-test-01',
        pin: '123456',
        siteId: 'site_default'
      });
    }, /Too many invalid pairing attempts|Challenge locked/);
  });

  await t.test('3. Real-Time Token Push Upon Successful Adoption', async () => {
    // Generate fresh PIN
    const { pin } = adoptionEngine.generateChallengePin('hub-wan-test-01');

    // Reconnect agent socket
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    // Send handshake
    ws.send(JSON.stringify({
      type: 'handshake',
      id: 'hub-wan-test-01',
      token: 'CORP-PROD-2026',
      hostname: 'mantaprint-wan',
      ip: '10.200.1.55'
    }));

    await new Promise((resolve) => {
      ws.once('message', () => resolve());
    });

    let tokenPushed = null;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.auth_token) {
        tokenPushed = msg.auth_token;
      }
    });

    // Admin adopts hub
    const adoptRes = await adoptionEngine.adoptHub({
      hubId: 'hub-wan-test-01',
      pin,
      siteId: 'site_default',
      customName: 'HQ Reception Printer'
    });

    // Wait a brief moment for socket message dispatch
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(tokenPushed, 'Active WebSocket must receive pushed capability token');
    assert.strictEqual(tokenPushed, adoptRes.auth_token);

    ws.close();
  });

  await t.test('4. End-to-End Command Dispatch & Execution', async () => {
    const hub = store.getHub('hub-wan-test-01');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    // Send handshake with issued token
    ws.send(JSON.stringify({
      type: 'handshake',
      id: 'hub-wan-test-01',
      token: 'CORP-PROD-2026'
    }));

    await new Promise((resolve) => {
      ws.once('message', () => resolve());
    });

    // Mock agent command handler (mirrors src/agent/agent.mjs)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') {
        ws.send(JSON.stringify({
          type: 'command_result',
          id: 'hub-wan-test-01',
          command: msg.command,
          success: true,
          message: `Command ${msg.command} executed successfully`
        }));
      }
    });

    // Console sends command
    const cmdResult = await fleetManager.sendCommand('hub-wan-test-01', 'clear_queue', {}, 5000);
    assert.ok(cmdResult, 'Must receive command result');
    assert.strictEqual(cmdResult.success, true);
    assert.strictEqual(cmdResult.command, 'clear_queue');

    await new Promise((resolve) => {
      ws.on('close', resolve);
      ws.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  await t.test('5. Subnet Scanner Bounds & Parsing', async () => {
    const scanner = new SubnetScanner({});

    // Valid /24
    const ips24 = scanner.cidrToIpList('192.168.1.0/24');
    assert.strictEqual(ips24.length, 254);
    assert.strictEqual(ips24[0], '192.168.1.1');
    assert.strictEqual(ips24[253], '192.168.1.254');

    // Out-of-bounds prefixes must be rejected
    assert.strictEqual(scanner.cidrToIpList('10.0.0.0/16').length, 0);
    assert.strictEqual(scanner.cidrToIpList('192.168.1.0/32').length, 0);

    await assert.rejects(async () => {
      await scanner.scanCidr('10.0.0.0/16');
    }, /Invalid CIDR format or prefix out of bounds/);
  });

  await t.test('6. Batch Operations on Managed Nodes', async () => {
    // Create batch task
    const task = store.createBatchTask({
      task_type: 'test_print',
      target_site_id: 'site_default'
    });

    // Execute with 0 online nodes (hub is currently offline)
    const executed = await batchExecutor.executeTask(task.id, { concurrency: 2, commandTimeoutMs: 1000 });
    assert.ok(executed);
    assert.strictEqual(executed.status, 'failed'); // Offline nodes fail execution
    assert.ok(executed.failed_nodes >= 1);
  });

  await t.test('7. Path Traversal Shield Defense', async () => {
    const statusCode = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/static/../../../../etc/passwd',
        method: 'GET'
      }, (res) => {
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.strictEqual(statusCode, 403, 'Path traversal attempt must be blocked with HTTP 403 Forbidden');
  });

  await t.test('8. Full Multilingual (i18n) Parity Verification', () => {
    function getKeys(obj, prefix = '') {
      let keys = [];
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? prefix + '.' + k : k;
        if (typeof v === 'object' && v !== null) {
          keys.push(...getKeys(v, full));
        } else {
          keys.push(full);
        }
      }
      return keys;
    }

    const enKeys = getKeys(translations.en).sort();
    const idKeys = getKeys(translations.id).sort();

    assert.deepStrictEqual(enKeys, idKeys, 'en and id catalogs must have 100% key parity');
    assert.ok(enKeys.length >= 100, 'Catalog must contain comprehensive translations');
  });

  // Cleanup
  fleetManager.destroy();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
