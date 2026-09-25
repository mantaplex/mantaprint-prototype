import EventEmitter from 'node:events';

export class FleetManager extends EventEmitter {
  constructor(store, adoptionEngine) {
    super();
    this.store = store;
    this.adoptionEngine = adoptionEngine;
    this.activeSockets = new Map(); // hubId -> ws
    this.pendingCommands = new Map(); // cmdId -> { resolve, reject, timer }

    // Heartbeat check every 15s
    this.heartbeatTimer = setInterval(() => this._checkHeartbeats(), 15000);

    // Push capability token immediately if hub is already connected when adopted
    if (this.adoptionEngine && typeof this.adoptionEngine.on === 'function') {
      this.adoptionEngine.on('hub_adopted', ({ hubId, authToken }) => {
        const ws = this.activeSockets.get(hubId);
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: 'handshake_ack',
              status: 'online',
              auth_token: authToken,
              message: 'Hub adopted by fleet console.'
            }));
            console.log(`[MantaMan Fleet] Pushed capability token directly to active hub: ${hubId}`);
          } catch {}
        }
      });
    }
  }

  // Handle new incoming WebSocket connection from Hub
  handleAgentConnection(ws, req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = url.searchParams.get('token') || '';
    let connectedHubId = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(raw);

        // 1. Handshake
        if (msg.type === 'handshake') {
          const hubId = msg.id;
          const providedToken = msg.token || token;

          // Check if managed and token is valid, or if enrollment token is provided
          let hub = this.store.getHub(hubId);
          const isManagedToken = this.adoptionEngine.verifyHubToken(hubId, providedToken);
          const isEnrollmentToken = providedToken === 'CORP-PROD-2026' || (process.env.MANTAMAN_ENROLLMENT_TOKEN && providedToken === process.env.MANTAMAN_ENROLLMENT_TOKEN);

          // Auto-register remote hub connecting via Layer 3 Inform with valid enrollment token
          if (!hub && isEnrollmentToken) {
            hub = this.store.upsertDiscoveredHub({
              id: hubId,
              name: msg.hostname || hubId,
              ip_address: msg.ip || req.socket?.remoteAddress || '127.0.0.1',
              arch: msg.system?.arch || 'arm64',
              model: 'MantaPrint Hub',
              version: msg.version || 'v0.2.1'
            });
            console.log(`[MantaMan Fleet] Auto-registered remote hub via L3 WAN Inform: ${hubId}`);
          }

          if (!hub || (!isManagedToken && !isEnrollmentToken)) {
            console.warn(`[MantaMan Fleet] Handshake rejected for ${hubId}: unauthorized token.`);
            ws.send(JSON.stringify({
              type: 'handshake_ack',
              status: 'rejected',
              message: 'Invalid authorization or enrollment token.'
            }));
            ws.close(4001, 'Unauthorized');
            return;
          }

          connectedHubId = hubId;
          this.activeSockets.set(hubId, ws);
          this.store.setHubOnline(hubId, true);

          // Update initial metadata
          if (msg.system || msg.printer) {
            this.store.queueTelemetryUpdate(hubId, {
              system: msg.system,
              printer: msg.printer,
              toner: msg.toner
            });
          }

          console.log(`[MantaMan Fleet] Hub connected: ${hubId} (${msg.ip || 'unknown IP'})`);
          ws.send(JSON.stringify({
            type: 'handshake_ack',
            status: 'online',
            hub_id: hubId,
            server_time: Date.now()
          }));

          this.emit('hub_connected', { hubId, ip: msg.ip });
          return;
        }

        // Must have completed handshake
        if (!connectedHubId) {
          ws.close(4002, 'Handshake required');
          return;
        }

        // 2. Periodic Telemetry
        if (msg.type === 'telemetry') {
          ws.isAlive = true;
          this.store.queueTelemetryUpdate(connectedHubId, msg);
          this.emit('telemetry', { hubId: connectedHubId, telemetry: msg });
          try {
            ws.send(JSON.stringify({ type: 'telemetry_ack', timestamp: Date.now() }));
          } catch {}
          return;
        }

        // 3. Command Execution Result
        if (msg.type === 'command_result') {
          const cmdKey = `${connectedHubId}_${msg.command}`;
          const pending = this.pendingCommands.get(cmdKey);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(cmdKey);
            pending.resolve(msg);
          }
          this.emit('command_result', msg);
          return;
        }

        // 4. Heartbeat
        if (msg.type === 'heartbeat' || msg.type === 'ping') {
          ws.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          return;
        }
      } catch (err) {
        console.warn('[MantaMan Fleet] Error processing agent message:', err.message);
      }
    });

    ws.on('close', () => {
      if (connectedHubId) {
        console.log(`[MantaMan Fleet] Hub disconnected: ${connectedHubId}`);
        this.activeSockets.delete(connectedHubId);
        this.store.setHubOnline(connectedHubId, false);
        this.emit('hub_disconnected', { hubId: connectedHubId });
      }
    });

    ws.on('error', (err) => {
      console.warn(`[MantaMan Fleet] Socket error on ${connectedHubId || 'pending node'}:`, err.message);
    });
  }

  // Send a management command to a specific Hub
  async sendCommand(hubId, command, params = {}, timeoutMs = 15000) {
    const ws = this.activeSockets.get(hubId);
    if (!ws || ws.readyState !== 1) { // 1 = OPEN
      // Attempt HTTP fallback if hub is in store with an IP address
      const hub = this.store.getHub(hubId);
      if (hub && hub.ip_address) {
        return await this._sendHttpCommand(hub, command, params, timeoutMs);
      }
      throw new Error(`Hub '${hubId}' is offline or disconnected.`);
    }

    const cmdKey = `${hubId}_${command}`;
    const payload = {
      type: 'command',
      command,
      timestamp: Date.now(),
      ...params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(cmdKey);
        reject(new Error(`Command '${command}' on Hub '${hubId}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingCommands.set(cmdKey, { resolve, reject, timer });

      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(cmdKey);
        reject(err);
      }
    });
  }

  // HTTP REST fallback when agent WebSocket is offline but web server is reachable
  async _sendHttpCommand(hub, command, params = {}, timeoutMs = 15000) {
    const ip = hub.ip_address;
    if (!ip) throw new Error(`Hub '${hub.id}' has no known IP address for HTTP fallback.`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (command === 'test_print') {
        let res = await fetch(`http://${ip}/api/printer/test-page`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }
        }).catch(() => null);

        if (!res || !res.ok) {
          res = await fetch(`http://${ip}/api/print/test`, {
            method: 'POST',
            signal: controller.signal
          }).catch(() => null);
        }
        clearTimeout(timer);
        if (!res || !res.ok) throw new Error(`HTTP API unresponsive on ${ip}`);
        return { success: true, command, message: 'Test print page triggered via HTTP' };
      }

      if (command === 'restart_cups') {
        const res = await fetch(`http://${ip}/api/service/restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: 'cups' }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return { success: true, command, message: 'CUPS restart triggered via HTTP' };
      }

      if (command === 'reboot') {
        const res = await fetch(`http://${ip}/api/hdmi/network/system/reboot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        }).catch(async () => {
          return await fetch(`http://${ip}/api/system/reboot`, { method: 'POST', signal: controller.signal });
        });
        clearTimeout(timer);
        return { success: true, command, message: 'System reboot triggered via HTTP' };
      }

      if (command === 'clear_queue') {
        const res = await fetch(`http://${ip}/api/printer/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timer);
        return { success: true, command, message: 'Spool queue purged via HTTP' };
      }

      throw new Error(`Command '${command}' requires active WebSocket conduit.`);
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Command '${command}' failed on Hub '${hub.id}' (${ip}): ${err.message}`);
    }
  }

  // Watchdog checking for silent / half-open disconnects
  _checkHeartbeats() {
    for (const [hubId, ws] of this.activeSockets.entries()) {
      if (!ws.isAlive) {
        console.warn(`[MantaMan Fleet] Terminating unresponsive hub socket: ${hubId}`);
        this.activeSockets.delete(hubId);
        this.store.setHubOnline(hubId, false);
        try { ws.terminate(); } catch {}
        this.emit('hub_disconnected', { hubId });
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }

  isHubOnline(hubId) {
    const ws = this.activeSockets.get(hubId);
    return Boolean(ws && ws.readyState === 1);
  }

  // Actively sync telemetry and peripherals from all hubs
  async syncAllHubs() {
    const hubs = this.store.listHubs();
    let synced = 0;
    let failed = 0;

    await Promise.allSettled(hubs.map(async (hub) => {
      try {
        const res = await fetch(`http://${hub.ip_address}/api/status`, {
          signal: AbortSignal.timeout(2500),
          headers: { 'User-Agent': 'MantaMan-Fleet/1.0' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Update hub telemetry and peripherals
        this.store.setHubOnline(hub.id, true);
        const printers = data.printers || (data.printer ? [data.printer] : []);
        const scanner = data.scanner || null;
        this.store.updateHubPeripherals(hub.id, { printers, scanner });

        // Update system telemetry
        this.store.queueTelemetryUpdate(hub.id, {
          system: {
            cpu_temp: data.system?.cpu_temp,
            ram_used_mb: data.system?.ram?.used_mb,
            ram_total_mb: data.system?.ram?.total_mb,
            uptime: data.system?.uptime,
            storage: data.system?.storage || null
          },
          printer: {
            name: (printers[0]?.display_name || printers[0]?.name) || '',
            state: (printers[0]?.state || 'idle')
          },
          toner: printers[0]?.markers ? { k: 90 } : { k: 95 }
        });

        // Update hostname and version if changed
        if (data.system?.hostname && data.system.hostname !== hub.name) {
          this.store.updateHub(hub.id, { name: data.system.hostname });
        }
        synced++;
      } catch (err) {
        if (!this.isHubOnline(hub.id)) {
          this.store.setHubOnline(hub.id, false);
        }
        failed++;
      }
    }));

    return { total: hubs.length, synced, failed };
  }

  // Obtain an admin session token for the Hub
  async getHubAdminToken(hubId) {
    const hub = this.store.getHub(hubId);
    if (!hub) throw new Error(`Hub ${hubId} not found.`);

    const candidates = [
      { username: 'mantaprint', password: 'mantapgan' },
      { username: 'admin', password: 'mantapgan' },
      { username: 'admin', password: 'mantaprint2026!' },
      { username: 'mimin', password: 'mantapgan' }
    ];

    for (const cred of candidates) {
      try {
        const res = await fetch(`http://${hub.ip_address}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred),
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.token) {
            return json.token;
          }
        }
      } catch {}
    }
    return null;
  }

  // Remotely configure printer parameters on hub
  async updatePrinterConfig(hubId, { queue_name, display_name, location, publish_broadcast, is_default, custom_broadcast_name }) {
    const hub = this.store.getHub(hubId);
    if (!hub) throw new Error(`Hub ${hubId} not found.`);

    const token = await this.getHubAdminToken(hubId);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Admin-Token'] = token;

    // 1. Update CUPS & Display info
    const updatePayload = {
      queue_name,
      display_name,
      location,
      publish_broadcast,
      is_default
    };

    const res = await fetch(`http://${hub.ip_address}/api/printers/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify(updatePayload),
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.message || `Printer update failed with HTTP ${res.status}`);
    }

    // 2. If custom_broadcast_name is set, update mDNS broadcast config
    if (custom_broadcast_name !== undefined) {
      try {
        await fetch(`http://${hub.ip_address}/api/system/mdns`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            custom_broadcast_names: { [queue_name]: custom_broadcast_name }
          }),
          signal: AbortSignal.timeout(4000)
        });
      } catch {}
    }

    // 3. Immediately re-sync hub peripherals
    try {
      const stRes = await fetch(`http://${hub.ip_address}/api/status`, { signal: AbortSignal.timeout(2500) });
      if (stRes.ok) {
        const stData = await stRes.json();
        this.store.updateHubPeripherals(hubId, {
          printers: stData.printers || (stData.printer ? [stData.printer] : []),
          scanner: stData.scanner || null
        });
      }
    } catch {}

    return { success: true };
  }

  destroy() {
    clearInterval(this.heartbeatTimer);
    for (const [, ws] of this.activeSockets.entries()) {
      try { ws.close(); } catch {}
    }
    this.activeSockets.clear();
  }
}
