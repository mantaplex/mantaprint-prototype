/**
 * MantaPrint Hub - Scanner Pairing, Client Session & Hardware Mutex Manager
 * Provides:
 * 1. ScannerHardwareLock: Asynchronous mutual exclusion lock with watchdog for physical SANE USB scanners.
 * 2. ScannerPairingManager: Ephemeral QR code / 6-digit PIN pairing, HMAC-SHA256 durable capability tokens,
 *    persistent paired clients registry, atomic persistence, and 1-click revocation/re-authorization.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Primary & Fallback paths for pairing records and secret
const PRIMARY_CLIENTS_PATH = '/mnt/data/config/paired_clients.json';
const SECONDARY_CLIENTS_PATH = '/etc/mantaprint/paired_clients.json';
const FALLBACK_CLIENTS_PATH = path.resolve(process.cwd(), 'config/paired_clients.json');

const PRIMARY_SECRET_PATH = '/mnt/data/config/.hub_secret';
const SECONDARY_SECRET_PATH = '/etc/mantaprint/.hub_secret';
const FALLBACK_SECRET_PATH = path.resolve(process.cwd(), 'config/.hub_secret');

/**
 * ScannerHardwareLock
 * Prevents concurrent SANE process execution which causes LIBUSB_ERROR_BUSY and motor jams.
 */
export class ScannerHardwareLock {
  constructor(timeoutMs = 90000) {
    this.locked = false;
    this.currentJob = null;
    this.lockAcquiredAt = 0;
    this.lockTimeoutMs = timeoutMs; // 90-second hardware watchdog
    this.activeProcess = null;
    this.watchdogTimer = null;
  }

  acquire(clientId, clientName = 'PWA Client', options = {}) {
    const now = Date.now();

    // Auto-clear stale lock if previous scan timed out
    if (this.locked && (now - this.lockAcquiredAt > this.lockTimeoutMs)) {
      console.warn(`[ScannerLock] Auto-releasing stale scanner lock held by: ${this.currentJob?.clientName || 'Unknown'}`);
      this.forceRelease();
    }

    if (this.locked) {
      const elapsedSec = Math.round((now - this.lockAcquiredAt) / 1000);
      const estRemainingSec = Math.max(1, Math.round((this.lockTimeoutMs / 1000) - elapsedSec));
      return {
        acquired: false,
        error: 'SCANNER_BUSY',
        message: 'Scanner sedang digunakan oleh perangkat lain.',
        holder: this.currentJob?.clientName || 'Perangkat lain',
        elapsedSec,
        estimatedRemainingSec: estRemainingSec
      };
    }

    this.locked = true;
    this.lockAcquiredAt = now;
    this.currentJob = {
      jobId: `scan_${now}_${crypto.randomBytes(3).toString('hex')}`,
      clientId,
      clientName,
      options,
      startedAt: new Date(now).toISOString()
    };

    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.locked) {
        console.warn(`[ScannerLock] Watchdog timer fired: auto-releasing lock for ${this.currentJob?.clientName}`);
        this.forceRelease();
      }
    }, this.lockTimeoutMs);

    return { acquired: true, job: this.currentJob };
  }

  registerActiveProcess(proc) {
    this.activeProcess = proc;
    if (proc && typeof proc.once === 'function') {
      proc.once('close', () => {
        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }
      });
    }
  }

  release(clientId = null) {
    if (!this.locked) return true;
    if (clientId && this.currentJob && this.currentJob.clientId !== clientId) {
      console.warn(`[ScannerLock] Refusing release: Client ${clientId} is not lock holder (${this.currentJob.clientId})`);
      return false;
    }
    this.forceRelease();
    return true;
  }

  forceRelease() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.activeProcess && !this.activeProcess.killed) {
      try {
        this.activeProcess.kill('SIGKILL');
      } catch {}
    }
    this.locked = false;
    this.currentJob = null;
    this.lockAcquiredAt = 0;
    this.activeProcess = null;
  }

  getStatus() {
    if (!this.locked) {
      return { is_busy: false, holder: null };
    }
    const elapsedSec = Math.round((Date.now() - this.lockAcquiredAt) / 1000);
    return {
      is_busy: true,
      holder: this.currentJob?.clientName || 'Perangkat lain',
      job_id: this.currentJob?.jobId,
      elapsed_sec: elapsedSec
    };
  }
}

/**
 * ScannerPairingManager
 */
export class ScannerPairingManager {
  constructor() {
    this.secretPath = this.resolveSecretPath();
    this.clientsPath = this.resolveClientsPath();
    this.hubSecret = this.initHubSecret();
    this.pendingPairings = new Map(); // pin/token -> { pin, token, expiresAt, hubInfo, failedAttempts }
    this.pairingFailedAttempts = new Map(); // ip -> { count, lastAttempt }
    this.store = this.loadStore();
  }

  resolveSecretPath() {
    try {
      if (fs.existsSync('/mnt/data/config')) return PRIMARY_SECRET_PATH;
      if (fs.existsSync('/etc/mantaprint')) return SECONDARY_SECRET_PATH;
    } catch {}
    return FALLBACK_SECRET_PATH;
  }

  resolveClientsPath() {
    try {
      if (fs.existsSync('/mnt/data/config')) return PRIMARY_CLIENTS_PATH;
      if (fs.existsSync('/etc/mantaprint')) return SECONDARY_CLIENTS_PATH;
    } catch {}
    return FALLBACK_CLIENTS_PATH;
  }

  initHubSecret() {
    try {
      if (fs.existsSync(this.secretPath)) {
        const secret = fs.readFileSync(this.secretPath, 'utf8').trim();
        if (secret.length >= 32) return secret;
      }
      const dir = path.dirname(this.secretPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const newSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(this.secretPath, newSecret, { encoding: 'utf8', mode: 0o600 });
      return newSecret;
    } catch (e) {
      console.warn('[PairingManager] Fallback in-memory secret in use:', e.message);
      return crypto.randomBytes(32).toString('hex');
    }
  }

  loadStore() {
    try {
      if (fs.existsSync(this.clientsPath)) {
        const raw = fs.readFileSync(this.clientsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            hub_uuid: parsed.hub_uuid || `hub_${crypto.randomBytes(8).toString('hex')}`,
            clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {}
          };
        }
      }
    } catch (e) {
      console.warn('[PairingManager] Re-initializing paired clients store:', e.message);
    }

    const defaultStore = {
      hub_uuid: `hub_${crypto.randomBytes(8).toString('hex')}`,
      clients: {}
    };
    this.saveStore(defaultStore);
    return defaultStore;
  }

  saveStore(storeToSave = this.store) {
    try {
      const dir = path.dirname(this.clientsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const tmpPath = `${this.clientsPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(storeToSave, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, this.clientsPath);
      return true;
    } catch (e) {
      console.error('[PairingManager] Failed to persist paired clients:', e.message);
      return false;
    }
  }

  getHubUuid() {
    return this.store.hub_uuid;
  }

  /**
   * Generates a dynamic ephemeral pairing code (QR payload + 6-digit PIN)
   * TTL: 300 seconds (5 minutes)
   */
  generatePairingCode(hubHost = 'mantaprint.local', hubIp = '127.0.0.1', hubPort = 80) {
    // Clean expired entries
    const now = Date.now();
    for (const [key, data] of this.pendingPairings.entries()) {
      if (now > data.expiresAt) {
        this.pendingPairings.delete(key);
      }
    }

    const pin = crypto.randomInt(100000, 1000000).toString();
    const pairingToken = `pt_${crypto.randomBytes(16).toString('hex')}`;
    const ttlMs = 300000; // 5 minutes
    const expiresAt = now + ttlMs;

    const qrPayload = JSON.stringify({
      app: 'mantaprint-scanner',
      action: 'mantaprint_pairing',
      hub_id: this.store.hub_uuid,
      host: hubHost,
      ip: hubIp,
      port: hubPort,
      pairing_token: pairingToken,
      pin,
      exp: Math.floor(expiresAt / 1000)
    });

    const entry = {
      pin,
      pairing_token: pairingToken,
      expiresAt,
      hubHost,
      hubIp,
      hubPort,
      failedAttempts: 0
    };

    this.pendingPairings.set(pin, entry);
    this.pendingPairings.set(pairingToken, entry);

    return {
      pin,
      pairing_token: pairingToken,
      expires_at: new Date(expiresAt).toISOString(),
      expires_in_sec: 300,
      qr_payload: qrPayload,
      hub_uuid: this.store.hub_uuid
    };
  }

  /**
   * Generates a multi-year HMAC capability token for an authorized client
   */
  createDurableClientToken(clientId, flags = '01') {
    const epoch = Math.floor(Date.now() / 1000);
    const payload = `mp_tok_v1.${clientId}.${epoch}.${flags}`;
    const hmac = crypto.createHmac('sha256', this.hubSecret).update(payload).digest('hex');
    return `${payload}.${hmac}`;
  }

  /**
   * Validates pairing attempt by PIN or ephemeral pairing token
   */
  verifyPairing(pinOrToken, clientInfo = {}) {
    if (!pinOrToken || typeof pinOrToken !== 'string') {
      return { success: false, error: 'MISSING_CODE', message: 'Kode pairing wajib diisi.' };
    }

    const ip = clientInfo.ip || '127.0.0.1';
    const ipTracking = this.pairingFailedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (ipTracking.count >= 10 && (Date.now() - ipTracking.lastAttempt < 60000)) {
      return {
        success: false,
        error: 'RATE_LIMITED',
        message: 'Terlalu banyak percobaan pairing gagal. Coba lagi dalam 1 menit.'
      };
    }

    const cleanInput = pinOrToken.trim();
    const entry = this.pendingPairings.get(cleanInput);

    if (!entry) {
      ipTracking.count++;
      ipTracking.lastAttempt = Date.now();
      this.pairingFailedAttempts.set(ip, ipTracking);
      return {
        success: false,
        error: 'INVALID_OR_EXPIRED_CODE',
        message: 'Kode pairing tidak valid atau telah kedaluwarsa. Silakan muat ulang kode di Konsol Admin.'
      };
    }

    entry.failedAttempts = (entry.failedAttempts || 0) + 1;
    if (entry.failedAttempts > 5) {
      this.pendingPairings.delete(entry.pin);
      this.pendingPairings.delete(entry.pairing_token);
      return {
        success: false,
        error: 'PAIRING_LOCKED',
        message: 'Kode pairing dibatalkan otomatis karena melebihi batas percobaan gagal (5x).'
      };
    }

    if (Date.now() > entry.expiresAt) {
      this.pendingPairings.delete(entry.pin);
      this.pendingPairings.delete(entry.pairing_token);
      return {
        success: false,
        error: 'CODE_EXPIRED',
        message: 'Kode pairing telah kedaluwarsa. Silakan buat kode baru di Konsol Admin.'
      };
    }

    // Success: Consume pending code and reset failed attempts
    this.pendingPairings.delete(entry.pin);
    this.pendingPairings.delete(entry.pairing_token);
    this.pairingFailedAttempts.delete(ip);

    const clientId = `c_${crypto.randomBytes(8).toString('hex')}`;
    const durableToken = this.createDurableClientToken(clientId);
    const tokenHash = crypto.createHash('sha256').update(durableToken).digest('hex');

    const clientRecord = {
      client_id: clientId,
      device_name: clientInfo.device_name || clientInfo.userAgent || 'PWA Scanner Client',
      platform: clientInfo.platform || 'Web',
      user_agent: clientInfo.userAgent || '',
      token_hash: tokenHash,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_seen_ip: clientInfo.ip || '127.0.0.1',
      capabilities: ['scan_flatbed', 'scan_adf', 'scan_duplex', 'stream_raw']
    };

    this.store.clients[clientId] = clientRecord;
    this.saveStore();

    return {
      success: true,
      client_id: clientId,
      token: durableToken,
      hub_uuid: this.store.hub_uuid,
      capabilities: clientRecord.capabilities
    };
  }

  /**
   * Cryptographically verifies an incoming client capability token
   */
  verifyClientToken(token, clientIp = '127.0.0.1') {
    if (!token || typeof token !== 'string') {
      return { valid: false, code: 'ERR_TOKEN_MISSING', message: 'Token otorisasi diperlukan.' };
    }

    const cleanToken = token.replace(/^(Bearer|Token)\s+/i, '').trim();
    const parts = cleanToken.split('.');

    if (parts.length !== 5 || parts[0] !== 'mp_tok_v1') {
      return { valid: false, code: 'ERR_TOKEN_FORMAT', message: 'Format token tidak valid.' };
    }

    const [prefix, clientId, epoch, flags, signature] = parts;
    const payload = `${prefix}.${clientId}.${epoch}.${flags}`;
    const expectedHmac = crypto.createHmac('sha256', this.hubSecret).update(payload).digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, code: 'ERR_INVALID_SIGNATURE', message: 'Tanda tangan kriptografi token tidak valid.' };
    }

    const tokenEpoch = parseInt(epoch, 10);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const MAX_TOKEN_AGE_SEC = 365 * 24 * 60 * 60; // 1 year TTL
    if (isNaN(tokenEpoch) || tokenEpoch > nowEpoch + 300 || (nowEpoch - tokenEpoch) > MAX_TOKEN_AGE_SEC) {
      return { valid: false, code: 'ERR_TOKEN_EXPIRED', message: 'Token telah kedaluwarsa. Perangkat perlu dipasangkan ulang.' };
    }

    if (!/^c_[a-f0-9]{16}$/.test(clientId) || !Object.prototype.hasOwnProperty.call(this.store.clients, clientId)) {
      return { valid: false, code: 'ERR_CLIENT_UNKNOWN', message: 'Perangkat tidak terdaftar di Hub.' };
    }

    const clientRecord = this.store.clients[clientId];

    if (clientRecord.status === 'REVOKED') {
      return {
        valid: false,
        code: 'ERR_CLIENT_REVOKED',
        message: 'Akses perangkat ini telah dicabut oleh Administrator Hub.',
        client: clientRecord
      };
    }

    // Refresh presence telemetry
    clientRecord.last_seen_at = new Date().toISOString();
    clientRecord.last_seen_ip = clientIp;

    return { valid: true, client: clientRecord };
  }

  revokeClient(clientId, adminUser = 'admin') {
    if (!/^c_[a-f0-9]{16}$/.test(clientId)) return false;
    if (Object.prototype.hasOwnProperty.call(this.store.clients, clientId)) {
      this.store.clients[clientId].status = 'REVOKED';
      this.store.clients[clientId].revoked_at = new Date().toISOString();
      this.store.clients[clientId].revoked_by = adminUser;
      this.saveStore();
      return true;
    }
    return false;
  }

  reauthorizeClient(clientId) {
    if (!/^c_[a-f0-9]{16}$/.test(clientId)) return false;
    if (Object.prototype.hasOwnProperty.call(this.store.clients, clientId)) {
      this.store.clients[clientId].status = 'ACTIVE';
      delete this.store.clients[clientId].revoked_at;
      delete this.store.clients[clientId].revoked_by;
      this.saveStore();
      return true;
    }
    return false;
  }

  renameClient(clientId, newName) {
    if (!/^c_[a-f0-9]{16}$/.test(clientId)) return false;
    if (Object.prototype.hasOwnProperty.call(this.store.clients, clientId) && typeof newName === 'string' && newName.trim()) {
      this.store.clients[clientId].device_name = newName.trim();
      this.saveStore();
      return true;
    }
    return false;
  }

  deleteClient(clientId) {
    if (!/^c_[a-f0-9]{16}$/.test(clientId)) return false;
    if (Object.prototype.hasOwnProperty.call(this.store.clients, clientId)) {
      delete this.store.clients[clientId];
      this.saveStore();
      return true;
    }
    return false;
  }

  listClients() {
    return Object.values(this.store.clients).map(c => ({
      client_id: c.client_id,
      device_name: c.device_name,
      platform: c.platform,
      user_agent: c.user_agent,
      status: c.status,
      created_at: c.created_at,
      last_seen_at: c.last_seen_at,
      last_seen_ip: c.last_seen_ip,
      revoked_at: c.revoked_at || null,
      capabilities: c.capabilities || []
    }));
  }
}

// Global Singletons
export const scannerHardwareLock = new ScannerHardwareLock(90000);
export const scannerPairingManager = new ScannerPairingManager();
