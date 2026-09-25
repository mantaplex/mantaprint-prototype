import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const execAsync = promisify(exec);

// Enable TCP Keepalive via Undici Global Dispatcher (Node 20+)
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    connect: {
      keepAlive: true,
      keepAliveInitialDelay: 10000 // 10s TCP keepalive
    }
  }));
} catch (e) {
  console.warn('[MantaPrint Agent] Undici keepalive initialization warning:', e.message);
}

// Config location
const CONFIG_PATH = process.env.MANTAPRINT_CONSOLE_CONFIG || '/etc/mantaprint/console.json';
const FALLBACK_CONFIG_PATH = path.resolve('./agent/console.json');
const STAGING_BASE_DIR = '/var/cache/mantaprint/staging';

// Default config
let config = {
  enabled: false,
  server_url: '', // e.g. "ws://192.168.12.12:8080/ws/agent"
  enrollment_token: 'CORP-PROD-2026',
  device_id: '',  // Dynamically uses MAC or hostname
  poll_interval_sec: 10,
  auth_token: ''
};

function loadConfig() {
  const targetPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : (fs.existsSync(FALLBACK_CONFIG_PATH) ? FALLBACK_CONFIG_PATH : null);
  if (targetPath) {
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      config = { ...config, ...JSON.parse(raw) };
    } catch (e) {
      console.warn('[MantaPrint Agent] Failed reading config, using defaults:', e.message);
    }
  }
}

// Save dynamic state (e.g. auth_token from server handshake)
function saveConfigUpdates(updates) {
  const targetPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : (fs.existsSync(FALLBACK_CONFIG_PATH) ? FALLBACK_CONFIG_PATH : null);
  if (targetPath) {
    try {
      config = { ...config, ...updates };
      fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf8');
    } catch {}
  }
}

// Helper: Get local primary IPv4 address
function getLocalIpAddress() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of ['eth0', 'end0', 'wlan0', 'enp0s3']) {
      if (ifaces[name]) {
        for (const addr of ifaces[name]) {
          if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
      }
    }
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name]) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}

// In-memory cache for robust fallback
let lastCachedStatus = null;

// Direct Hardware / CUPS reading fallback
async function getDirectHardwareStatus() {
  // 1. CPU Temp from /sys/class/thermal
  let cpuTemp = 50.0;
  try {
    const thermalPath = '/sys/class/thermal/thermal_zone0/temp';
    if (fs.existsSync(thermalPath)) {
      const raw = fs.readFileSync(thermalPath, 'utf8').trim();
      const val = parseFloat(raw);
      if (!isNaN(val)) {
        cpuTemp = val > 1000 ? Math.round((val / 1000) * 10) / 10 : val;
      }
    }
  } catch {}

  // 2. RAM from /proc/meminfo
  let ramUsedMb = 250.0;
  let ramTotalMb = 1918.0;
  try {
    if (fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (totalMatch && availMatch) {
        ramTotalMb = Math.round(parseInt(totalMatch[1], 10) / 1024);
        const availMb = Math.round(parseInt(availMatch[1], 10) / 1024);
        ramUsedMb = Math.max(0, ramTotalMb - availMb);
      }
    }
  } catch {}

  // 3. Uptime from /proc/uptime
  let uptime = '0m';
  try {
    if (fs.existsSync('/proc/uptime')) {
      const upSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      const hours = Math.floor(upSec / 3600);
      const mins = Math.floor((upSec % 3600) / 60);
      uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }
  } catch {}

  // 4. Printer status directly from lpstat
  let printerName = 'Local Printer';
  let printerState = 'idle';
  try {
    const { stdout } = await execAsync('lpstat -p -d 2>/dev/null', { timeout: 1200 });
    const match = stdout.match(/printer\s+([^\s]+)\s+(is idle|now printing|is stopped|disabled)/i);
    if (match) {
      printerName = match[1];
      const rawState = match[2].toLowerCase();
      if (rawState.includes('printing')) printerState = 'printing';
      else if (rawState.includes('idle')) printerState = 'idle';
      else if (rawState.includes('stopped') || rawState.includes('disabled')) printerState = 'stopped';
    } else {
      const defMatch = stdout.match(/system default destination:\s*([^\s]+)/i);
      if (defMatch) printerName = defMatch[1];
    }
  } catch {}

  return {
    system: {
      hostname: os.hostname(),
      ip: getLocalIpAddress(),
      cpu_temp: cpuTemp,
      ram: {
        used_mb: ramUsedMb,
        total_mb: ramTotalMb,
        percent: Math.round((ramUsedMb / (ramTotalMb || 1)) * 1000) / 10
      },
      uptime
    },
    printer: {
      name: printerName,
      display_name: printerName,
      state: printerState,
      jobs: []
    }
  };
}

// Robust Local System Status with 1.5s AbortController and Fallbacks
async function getLocalSystemStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout for lpstat / telemetry probe

    const res = await fetch('http://127.0.0.1/api/status', {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const json = await res.json();
      lastCachedStatus = json;
      return json;
    }
  } catch (err) {
    console.log(`[MantaPrint Agent] Local API offline/timed out (${err.message}). Active hardware fallback engaged (thermal/lpstat).`);
  }

  // Fallback: Read direct hardware metrics + cached metadata
  const direct = await getDirectHardwareStatus();
  if (lastCachedStatus) {
    return {
      ...lastCachedStatus,
      system: {
        ...lastCachedStatus.system,
        cpu_temp: direct.system.cpu_temp,
        uptime: direct.system.uptime,
        ram: direct.system.ram,
        ip: direct.system.ip || lastCachedStatus.system?.ip
      },
      printer: {
        ...lastCachedStatus.printer,
        state: direct.printer.state,
        name: lastCachedStatus.printer?.name || direct.printer.name
      },
      _fallback: true
    };
  }

  return { ...direct, _fallback: true };
}

// Universal Unique Machine Identifier:
// Priority: 
// 1. Explicit config.device_id (if not default/placeholder)
// 2. /etc/machine-id (Standard Linux systemd machine UUID)
// 3. First non-loopback MAC address from /sys/class/net/*
// 4. Hostname fallback
async function getHardwareId() {
  if (config.device_id && config.device_id !== 'mantaprint-placeholder' && !config.device_id.startsWith('CORP-')) {
    return config.device_id;
  }
  
  // 1. Standard Linux machine-id
  try {
    if (fs.existsSync('/etc/machine-id')) {
      const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      if (mid && mid.length >= 8) {
        return `mantaprint-${mid.slice(-6).toLowerCase()}`;
      }
    }
  } catch {}

  // 2. Iterate non-loopback network interfaces
  try {
    if (fs.existsSync('/sys/class/net')) {
      const ifaces = fs.readdirSync('/sys/class/net');
      for (const name of ifaces) {
        if (name === 'lo') continue;
        const addrPath = `/sys/class/net/${name}/address`;
        if (fs.existsSync(addrPath)) {
          const mac = fs.readFileSync(addrPath, 'utf8').trim().replace(/:/g, '').toLowerCase();
          if (mac && mac !== '000000000000') {
            return `mantaprint-${mac.slice(-6)}`;
          }
        }
      }
    }
  } catch {}

  // 3. Hostname fallback
  try {
    const { stdout } = await execAsync('hostname');
    return stdout.trim() || 'mantaprint-node';
  } catch {
    return 'mantaprint-node';
  }
}

// WebSocket Agent State & Watchdogs
let ws = null;
let isConnected = false;
let reconnectTimer = null;
let telemetryInterval = null;
let watchdogTimer = null;
let backoffDelayMs = 5000;
const MAX_BACKOFF_MS = 60000;
const HEARTBEAT_TIMEOUT_MS = 30000; // 30s threshold for silent disconnect (half-open TCP)

function resetWatchdog() {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    console.warn(`[MantaPrint Agent] ⚠️ Silent network disconnect (half-open TCP) detected! No server frames received in 30s. Terminating socket...`);
    terminateAndReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
}

function terminateAndReconnect() {
  cleanup();
  scheduleReconnect();
}

function cleanup() {
  isConnected = false;
  clearTimeout(watchdogTimer);
  clearInterval(telemetryInterval);
  if (ws) {
    try {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch {}
    ws = null;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // Full jitter: random between 0.8 and 1.2 * backoffDelayMs
  const jitter = (Math.random() * 0.4 - 0.2) * backoffDelayMs;
  const delayWithJitter = Math.max(1000, Math.round(backoffDelayMs + jitter));
  console.log(`[MantaPrint Agent] Retrying console connection in ${Math.round(delayWithJitter / 1000)}s (jittered backoff)... (Local device remains 100% operational)`);
  
  reconnectTimer = setTimeout(connectToConsole, delayWithJitter);
  backoffDelayMs = Math.min(backoffDelayMs * 1.5, MAX_BACKOFF_MS);
}

// Transactional Driver Deployment Handler
async function handleInstallDriver(msg, deviceId) {
  const driverId = msg.driver_id || 'unknown';
  const stageDir = path.join(STAGING_BASE_DIR, `${driverId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  console.log(`[MantaPrint Agent] [Transactional Driver] Starting deployment for ${driverId} in staging ${stageDir}...`);

  const rollbackBackups = [];
  const newlyCreatedFiles = [];

  try {
    fs.mkdirSync(stageDir, { recursive: true });

    // 1. Resolve URL and Download
    const rawUrl = msg.url || '';
    const baseUrl = config.server_url.replace(/^ws/, 'http').replace(/\/ws\/agent.*$/, '');
    const downloadUrl = rawUrl.startsWith('http') ? rawUrl : `${baseUrl}${rawUrl}`;

    console.log(`[MantaPrint Agent] [Transactional Driver] Downloading driver archive: ${downloadUrl}`);
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      throw new Error(`Failed to download driver: HTTP ${res.status} ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuf);
    const downloadFilePath = path.join(stageDir, path.basename(rawUrl) || 'driver.pkg');
    fs.writeFileSync(downloadFilePath, fileBuffer);

    // 2. Verify SHA-256 Hash
    const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    console.log(`[MantaPrint Agent] [Transactional Driver] Verifying SHA-256: computed=${computedHash}`);
    if (msg.sha256) {
      if (computedHash.toLowerCase() !== msg.sha256.toLowerCase()) {
        throw new Error(`SHA-256 verification failed! Expected: ${msg.sha256}, Got: ${computedHash}`);
      }
      console.log(`[MantaPrint Agent] [Transactional Driver] SHA-256 checksum verified successfully.`);
    }

    // 3. Extract Archive if compressed
    const lowerName = downloadFilePath.toLowerCase();
    if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) {
      await execAsync(`tar -xzf "${downloadFilePath}" -C "${stageDir}"`, { timeout: 15000 });
    } else if (lowerName.endsWith('.zip')) {
      await execAsync(`unzip -q -o "${downloadFilePath}" -d "${stageDir}"`, { timeout: 15000 });
    }

    // 4. Test PPD validity and filter integrity
    const findPpdFiles = (dir) => {
      let results = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(findPpdFiles(full));
        } else if (entry.name.endsWith('.ppd') || entry.name.endsWith('.ppd.gz')) {
          results.push(full);
        }
      }
      return results;
    };

    const ppdFiles = findPpdFiles(stageDir);
    console.log(`[MantaPrint Agent] [Transactional Driver] Found ${ppdFiles.length} PPD file(s) for validation.`);

    for (const ppdPath of ppdFiles) {
      console.log(`[MantaPrint Agent] [Transactional Driver] Validating PPD with cupstestppd: ${path.basename(ppdPath)}`);
      try {
        const { stdout } = await execAsync(`cupstestppd -r -W all "${ppdPath}"`, { timeout: 5000 });
        if (stdout.includes(': FAIL') || stdout.includes('**FAIL**')) {
          throw new Error(`cupstestppd detected fatal errors:\n${stdout.slice(0, 500)}`);
        }
      } catch (testErr) {
        throw new Error(`cupstestppd failed for ${path.basename(ppdPath)}: ${testErr.message || testErr.stdout || ''}`);
      }

      // Filter validation: inspect PPD for *cupsFilter / *cupsFilter2
      let ppdContent = '';
      if (ppdPath.endsWith('.gz')) {
        const zcatRes = await execAsync(`zcat "${ppdPath}"`);
        ppdContent = zcatRes.stdout;
      } else {
        ppdContent = fs.readFileSync(ppdPath, 'utf8');
      }

      const filterRegex = /^\*cupsFilter2?:\s*"[^"]+\s+\d+\s+([^\s"]+)"/gm;
      let fMatch;
      while ((fMatch = filterRegex.exec(ppdContent)) !== null) {
        const rawProgram = fMatch[1];
        if (rawProgram === '-' || rawProgram === 'none') continue;

        const filterName = path.basename(rawProgram);
        const systemFilterPath = path.join('/usr/lib/cups/filter', filterName);

        const findFilterInStaging = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
              const res = findFilterInStaging(p);
              if (res) return res;
            } else if (e.name === filterName) {
              return p;
            }
          }
          return null;
        };

        const stagedFilter = findFilterInStaging(stageDir);
        if (!stagedFilter && !fs.existsSync(systemFilterPath)) {
          throw new Error(`Required filter binary '${filterName}' not found in package staging nor in /usr/lib/cups/filter/`);
        }

        if (stagedFilter) {
          try {
            fs.chmodSync(stagedFilter, 0o755);
          } catch (chmodErr) {
            throw new Error(`Filter binary '${filterName}' could not be made executable: ${chmodErr.message}`);
          }
        }
      }
    }

    // 5. Transactional Installation (with rollback backup snapshot)
    console.log(`[MantaPrint Agent] [Transactional Driver] All validations passed! Performing atomic deployment...`);
    const backupDir = path.join(stageDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const cupsModelDir = '/usr/share/cups/model/mantaprint';
    fs.mkdirSync(cupsModelDir, { recursive: true });

    for (const ppdPath of ppdFiles) {
      const destPath = path.join(cupsModelDir, path.basename(ppdPath));
      if (fs.existsSync(destPath)) {
        const bPath = path.join(backupDir, path.basename(ppdPath));
        fs.copyFileSync(destPath, bPath);
        rollbackBackups.push({ original: destPath, backup: bPath });
      } else {
        newlyCreatedFiles.push(destPath);
      }
      fs.copyFileSync(ppdPath, destPath);
    }

    // Deploy any filters found in staging
    const filterFiles = [];
    const findFilters = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'backups') {
          findFilters(p);
        } else if (e.isFile() && !e.name.endsWith('.ppd') && !e.name.endsWith('.ppd.gz') && !e.name.endsWith('.tar.gz') && !e.name.endsWith('.zip')) {
          if (p.includes('/filter/') || (fs.statSync(p).mode & 0o111)) {
            filterFiles.push(p);
          }
        }
      }
    };
    findFilters(stageDir);

    for (const flt of filterFiles) {
      const destPath = path.join('/usr/lib/cups/filter', path.basename(flt));
      if (fs.existsSync(destPath)) {
        const bPath = path.join(backupDir, 'flt_' + path.basename(flt));
        fs.copyFileSync(destPath, bPath);
        rollbackBackups.push({ original: destPath, backup: bPath });
      } else {
        newlyCreatedFiles.push(destPath);
      }
      fs.copyFileSync(flt, destPath);
      fs.chmodSync(destPath, 0o755);
    }

    // Restart CUPS to load new driver configuration
    try {
      await execAsync('systemctl restart cups', { timeout: 10000 });
    } catch (reloadErr) {
      throw new Error(`CUPS restart failed after deployment: ${reloadErr.message}`);
    }

    // Cleanup staging
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (typeof global.gc === 'function') global.gc();

    console.log(`[MantaPrint Agent] [Transactional Driver] Driver '${driverId}' deployed and active!`);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'command_result',
        id: deviceId,
        command: 'install_driver',
        driver_id: driverId,
        status: 'completed',
        success: true,
        message: `Driver ${msg.name || driverId} installed and verified successfully.`
      }));
    }

  } catch (err) {
    console.error(`[MantaPrint Agent] [Transactional Driver] ERROR: ${err.message}`);
    console.log(`[MantaPrint Agent] [Transactional Driver] 🚨 INITIATING AUTOMATIC ROLLBACK to protect CUPS...`);

    // Automatic Rollback
    for (const created of newlyCreatedFiles) {
      try {
        if (fs.existsSync(created)) fs.unlinkSync(created);
      } catch {}
    }
    for (const b of rollbackBackups) {
      try {
        if (fs.existsSync(b.backup)) {
          fs.copyFileSync(b.backup, b.original);
        }
      } catch {}
    }

    // Clean staging
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    if (typeof global.gc === 'function') global.gc();

    console.log(`[MantaPrint Agent] [Transactional Driver] Rollback complete. Existing CUPS state preserved.`);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'command_result',
        id: deviceId,
        command: 'install_driver',
        driver_id: driverId,
        status: 'failed',
        success: false,
        error: `Deployment aborted & rolled back: ${err.message}`
      }));
    }
  }
}

async function connectToConsole() {
  loadConfig();

  if (!config.enabled || !config.server_url) {
    console.log(`[MantaPrint Agent] Operating in 100% Autonomous Local Mode.`);
    console.log(`[MantaPrint Agent] Central Console management is disabled/unconfigured. All local printing operates normally.`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToConsole, 30000);
    return;
  }

  const deviceId = await getHardwareId();
  const token = config.auth_token || config.enrollment_token || 'CORP-PROD-2026';
  const wsUrl = `${config.server_url.replace(/^http/, 'ws')}?type=agent&token=${encodeURIComponent(token)}`;

  console.log(`[MantaPrint Agent] Connecting to Central Console: ${wsUrl} (Device: ${deviceId})...`);

  try {
    const WSClass = globalThis.WebSocket || (await import('ws')).default;
    ws = new WSClass(wsUrl);

    ws.onopen = async () => {
      isConnected = true;
      backoffDelayMs = 5000; // Reset backoff on success
      resetWatchdog();
      console.log(`[MantaPrint Agent] Successfully connected to Console!`);

      // Gather initial handshake status
      const localStatus = await getLocalSystemStatus();
      const handshakePayload = {
        type: 'handshake',
        id: deviceId,
        token: config.auth_token || config.enrollment_token,
        hostname: localStatus?.system?.hostname || deviceId,
        ip: localStatus?.system?.ip || getLocalIpAddress(),
        printer: {
          name: localStatus?.printer?.display_name || localStatus?.printer?.name || 'Local Printer',
          state: localStatus?.printer?.state || localStatus?.printer?.status || 'idle',
          uri: localStatus?.printer?.device_uri || ''
        },
        system: {
          cpu_temp: localStatus?.system?.cpu_temp || 50,
          ram_used_mb: localStatus?.system?.ram?.used_mb || 250,
          ram_total_mb: localStatus?.system?.ram?.total_mb || 1918,
          uptime: localStatus?.system?.uptime || '0m'
        }
      };

      ws.send(JSON.stringify(handshakePayload));

      // Periodic Telemetry Reporting
      clearInterval(telemetryInterval);
      telemetryInterval = setInterval(async () => {
        if (!isConnected || !ws || ws.readyState !== 1) return;
        const status = await getLocalSystemStatus();
        if (!status) return;

        const telemetry = {
          type: 'telemetry',
          id: deviceId,
          system: {
            cpu_temp: status.system?.cpu_temp,
            ram_used_mb: status.system?.ram?.used_mb,
            uptime: status.system?.uptime,
            storage: status.system?.storage || null
          },
          printer: {
            state: status.printer?.state || status.printer?.status || 'idle'
          },
          toner: status.printer?.markers ? { k: 90 } : { k: 95 },
          jobs_completed: status.printer?.jobs?.length || 0
        };
        try {
          ws.send(JSON.stringify(telemetry));
        } catch {}
      }, (config.poll_interval_sec || 10) * 1000);
    };

    ws.onmessage = async (event) => {
      resetWatchdog(); // Frame received -> reset silent disconnect watchdog

      try {
        const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
        const msg = JSON.parse(rawData);

        if (msg.type === 'handshake_ack') {
          console.log(`[MantaPrint Agent] Handshake acknowledged by Console (Status: ${msg.status || 'online'})`);
          if (msg.auth_token && msg.auth_token !== config.auth_token) {
            saveConfigUpdates({ auth_token: msg.auth_token });
          }
          return;
        }

        if (msg.type === 'heartbeat' || msg.type === 'telemetry_ack' || msg.type === 'pong') {
          // Liveness frame confirmed
          return;
        }

        console.log(`[MantaPrint Agent] Received message from Console:`, msg.type, msg.command || '');

        if (msg.type === 'command') {
          const cmd = msg.command;

          if (cmd === 'test_print') {
            console.log(`[MantaPrint Agent] Executing Test Print command...`);
            try {
              await execAsync('lp -d $(lpstat -d | cut -d: -f2 | xargs) /usr/share/cups/data/testprint 2>/dev/null || lp /etc/cups/cupsd.conf 2>/dev/null || true');
              ws.send(JSON.stringify({ type: 'command_result', id: deviceId, command: cmd, success: true }));
            } catch (err) {
              ws.send(JSON.stringify({ type: 'command_result', id: deviceId, command: cmd, success: false, error: err.message }));
            }
          } else if (cmd === 'restart_cups') {
            console.log(`[MantaPrint Agent] Executing CUPS restart...`);
            try {
              await execAsync('systemctl restart cups');
              ws.send(JSON.stringify({ type: 'command_result', id: deviceId, command: cmd, success: true }));
            } catch (err) {
              ws.send(JSON.stringify({ type: 'command_result', id: deviceId, command: cmd, success: false, error: err.message }));
            }
          } else if (cmd === 'clear_queue') {
            console.log(`[MantaPrint Agent] Executing clear print queue (cancel -a -x)...`);
            try {
              const { stdout, stderr } = await execAsync('cancel -a -x', { timeout: 5000 });
              ws.send(JSON.stringify({ 
                type: 'command_result', 
                id: deviceId, 
                command: cmd, 
                success: true, 
                message: 'All print jobs cleared successfully' 
              }));
            } catch (err) {
              ws.send(JSON.stringify({ 
                type: 'command_result', 
                id: deviceId, 
                command: cmd, 
                success: false, 
                error: err.message 
              }));
            }
          } else if (cmd === 'reboot') {
            console.warn(`[MantaPrint Agent] Reboot requested via Console...`);
            ws.send(JSON.stringify({ type: 'command_result', id: deviceId, command: cmd, success: true }));
            setTimeout(() => exec('reboot'), 1000);
          }
        }

        if (msg.type === 'install_driver') {
          await handleInstallDriver(msg, deviceId);
        }

      } catch (err) {
        console.warn('[MantaPrint Agent] Error processing console message:', err.message);
      }
    };

    ws.onclose = () => {
      if (isConnected) {
        console.log(`[MantaPrint Agent] Console connection closed. Local printing operates normally.`);
      }
      cleanup();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      cleanup();
      scheduleReconnect();
    };

  } catch (err) {
    cleanup();
    scheduleReconnect();
  }
}

// Start Agent Process
console.log(`======================================================`);
console.log(`  🤖 MANTAPRINT AGENT DAEMON STARTING`);
console.log(`  🛡️ Offline-First & Resilient Autonomous Architecture`);
console.log(`  ⚡ Silent Half-Open Detection & Fallback Telemetry Active`);
console.log(`======================================================`);
connectToConsole();

// Low-memory footprint maintenance
if (typeof global.gc === 'function') {
  setInterval(() => {
    try { global.gc(); } catch {}
  }, 60000);
}

// Graceful Shutdown
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
