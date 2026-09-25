import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MantaStore {
  constructor(dbPath) {
    this.dbPath = dbPath || process.env.MANTAMAN_DB_PATH || path.resolve(__dirname, '../../data/mantaman.sqlite');
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o750 });
    }

    this.db = new DatabaseSync(this.dbPath);
    this._initPragmas();
    this._initSchema();

    // Telemetry Coalescing Buffer (500ms debouncing)
    this.telemetryQueue = new Map();
    this.telemetryFlushTimer = null;
  }

  _initPragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  _initSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
    try {
      this.db.exec("ALTER TABLE hubs ADD COLUMN peripherals_json TEXT DEFAULT '{}'");
    } catch {}
    try {
      this.db.exec("ALTER TABLE hubs ADD COLUMN admin_password TEXT DEFAULT ''");
    } catch {}
    this._seedDefaultAdmin();
  }

  _seedDefaultAdmin() {
    const row = this.db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!row) {
      // Default: admin / mantaprint2026! (SHA-256 for basic bootstrap or overridden)
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(salt + 'mantaprint2026!').digest('hex');
      const fullHash = `sha256:${salt}:${hash}`;
      this.db.prepare(`
        INSERT INTO users (id, username, password_hash, role, display_name, created_at)
        VALUES (?, ?, ?, 'SuperAdmin', 'System Administrator', ?)
      `).run('usr_admin_default', 'admin', fullHash, Date.now());
    }
  }

  // --- SITES ---
  listSites() {
    return this.db.prepare('SELECT * FROM sites ORDER BY name ASC').all();
  }

  getSite(id) {
    return this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  }

  createSite({ name, slug, address = '', subnet_cidr = '', contact_email = '' }) {
    const id = 'site_' + crypto.randomBytes(4).toString('hex');
    this.db.prepare(`
      INSERT INTO sites (id, name, slug, address, subnet_cidr, contact_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, address, subnet_cidr, contact_email, Date.now());
    return this.getSite(id);
  }

  updateSite(id, { name, slug, address, subnet_cidr, contact_email }) {
    this.db.prepare(`
      UPDATE sites
      SET name = COALESCE(?, name),
          slug = COALESCE(?, slug),
          address = COALESCE(?, address),
          subnet_cidr = COALESCE(?, subnet_cidr),
          contact_email = COALESCE(?, contact_email)
      WHERE id = ?
    `).run(name ?? null, slug ?? null, address ?? null, subnet_cidr ?? null, contact_email ?? null, id);
    return this.getSite(id);
  }

  deleteSite(id) {
    if (id === 'site_default') {
      throw new Error('Default site cannot be deleted.');
    }
    // Reassign hubs on this site to site_default
    this.db.prepare('UPDATE hubs SET site_id = ? WHERE site_id = ?').run('site_default', id);
    this.db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    return { success: true };
  }

  // --- HUBS ---
  listHubs(filter = {}) {
    let sql = 'SELECT * FROM hubs';
    const params = [];
    const conditions = [];

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.site_id) {
      conditions.push('site_id = ?');
      params.push(filter.site_id);
    }
    if (filter.is_online !== undefined) {
      conditions.push('is_online = ?');
      params.push(filter.is_online ? 1 : 0);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY is_online DESC, name ASC';

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => {
      const hub = {
        ...r,
        is_online: Boolean(r.is_online),
        toner_cmyk: JSON.parse(r.toner_cmyk || '{}'),
        peripherals: JSON.parse(r.peripherals_json || '{}')
      };
      delete hub.auth_token_hash;
      return hub;
    });
  }

  getHub(id) {
    const row = this.db.prepare('SELECT * FROM hubs WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      is_online: Boolean(row.is_online),
      toner_cmyk: JSON.parse(row.toner_cmyk || '{}'),
      peripherals: JSON.parse(row.peripherals_json || '{}')
    };
  }

  upsertDiscoveredHub({ id, name, ip_address, mac_address = '', arch = 'arm64', model = 'MantaPrint Hub', version = 'v0.2.1', peripherals = null }) {
    let existing = this.getHub(id);
    if (!existing && mac_address) {
      const row = this.db.prepare('SELECT * FROM hubs WHERE mac_address = ? AND mac_address != ""').get(mac_address);
      if (row) existing = this.getHub(row.id);
    }
    const now = Date.now();
    const periphStr = peripherals ? JSON.stringify(peripherals) : (existing?.peripherals_json || '{}');
    if (!existing) {
      this.db.prepare(`
        INSERT INTO hubs (id, name, ip_address, mac_address, arch, model, version, status, is_online, peripherals_json, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'unadopted', 1, ?, ?, ?, ?)
      `).run(id, name || id, ip_address, mac_address, arch, model, version, periphStr, now, now, now);
      return this.getHub(id);
    } else {
      this.db.prepare(`
        UPDATE hubs
        SET name = COALESCE(?, name),
            ip_address = ?,
            mac_address = COALESCE(NULLIF(?, ''), mac_address),
            arch = ?,
            model = ?,
            version = ?,
            peripherals_json = ?,
            is_online = 1,
            last_seen_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(name || null, ip_address, mac_address, arch, model, version, periphStr, now, now, existing.id);
      return this.getHub(existing.id);
    }
  }

  deleteHub(id) {
    this.db.prepare('DELETE FROM hubs WHERE id = ?').run(id);
    return { success: true };
  }

  purgeStaleUnadopted(olderThanMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    const info = this.db.prepare("DELETE FROM hubs WHERE status = 'unadopted' AND last_seen_at < ?").run(cutoff);
    return { success: true, deleted: info.changes };
  }

  updateHubPeripherals(id, peripherals) {
    const now = Date.now();
    const periphStr = JSON.stringify(peripherals || {});
    const primaryPrinter = (peripherals?.printers || [])[0];
    const printerName = primaryPrinter?.display_name || primaryPrinter?.name || null;
    const cupsState = primaryPrinter?.state || null;
    this.db.prepare(`
      UPDATE hubs
      SET peripherals_json = ?,
          printer_name = COALESCE(?, printer_name),
          cups_state = COALESCE(?, cups_state),
          updated_at = ?
      WHERE id = ?
    `).run(periphStr, printerName, cupsState, now, id);
    return this.getHub(id);
  }

  setHubOnline(id, isOnline) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE hubs
      SET is_online = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(isOnline ? 1 : 0, now, now, id);
  }

  queueTelemetryUpdate(id, telemetry) {
    this.telemetryQueue.set(id, {
      ...telemetry,
      timestamp: Date.now()
    });

    if (!this.telemetryFlushTimer) {
      this.telemetryFlushTimer = setTimeout(() => this._flushTelemetryQueue(), 500);
    }
  }

  _flushTelemetryQueue() {
    this.telemetryFlushTimer = null;
    if (this.telemetryQueue.size === 0) return;

    const entries = Array.from(this.telemetryQueue.entries());
    this.telemetryQueue.clear();

    const stmt = this.db.prepare(`
      UPDATE hubs
      SET cpu_temp = COALESCE(?, cpu_temp),
          ram_used_mb = COALESCE(?, ram_used_mb),
          ram_total_mb = COALESCE(?, ram_total_mb),
          uptime = COALESCE(?, uptime),
          cups_state = COALESCE(?, cups_state),
          printer_name = COALESCE(?, printer_name),
          toner_cmyk = COALESCE(?, toner_cmyk),
          is_online = 1,
          last_seen_at = ?,
          updated_at = ?
      WHERE id = ?
    `);

    // Execute in transaction
    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      for (const [id, t] of entries) {
        const tonerStr = t.toner ? JSON.stringify(t.toner) : null;
        stmt.run(
          t.system?.cpu_temp ?? null,
          t.system?.ram_used_mb ?? null,
          t.system?.ram_total_mb ?? null,
          t.system?.uptime ?? null,
          t.printer?.state ?? null,
          t.printer?.name ?? null,
          tonerStr,
          t.timestamp,
          t.timestamp,
          id
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (inTransaction) {
        try { this.db.exec('ROLLBACK'); } catch {}
      }
      console.error('[MantaStore] Failed flushing telemetry batch:', err.message);
    }
  }

  adoptHub(id, { site_id, name, token_hash }) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE hubs
      SET status = 'managed',
          site_id = COALESCE(?, site_id),
          name = COALESCE(?, name),
          auth_token_hash = ?,
          pairing_pin = NULL,
          pairing_pin_exp = 0,
          updated_at = ?
      WHERE id = ?
    `).run(site_id || null, name || null, token_hash, now, id);
    return this.getHub(id);
  }

  updateHub(id, { name, site_id }) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE hubs
      SET name = COALESCE(?, name),
          site_id = COALESCE(?, site_id),
          updated_at = ?
      WHERE id = ?
    `).run(name ?? null, site_id ?? null, now, id);
    return this.getHub(id);
  }

  unadoptHub(id) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE hubs
      SET status = 'unadopted',
          auth_token_hash = NULL,
          pairing_pin = NULL,
          pairing_pin_exp = 0,
          is_online = 0,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
    return this.getHub(id);
  }

  setPairingChallenge(id, pin, ttlMs = 300000) {
    const exp = Date.now() + ttlMs;
    this.db.prepare(`
      UPDATE hubs
      SET pairing_pin = ?, pairing_pin_exp = ?, updated_at = ?
      WHERE id = ?
    `).run(pin, exp, Date.now(), id);
  }

  // --- BATCH TASKS ---
  createBatchTask({ title, task_type, target_site_id = null, payload = {}, total_nodes = 0 }) {
    const id = 'task_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const taskTitle = title || `${task_type} operation`;
    this.db.prepare(`
      INSERT INTO batch_tasks (id, title, task_type, target_site_id, payload_json, status, total_nodes, successful_nodes, failed_nodes, logs_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, '[]', ?)
    `).run(id, taskTitle, task_type, target_site_id || null, JSON.stringify(payload || {}), total_nodes || 0, Date.now());
    return this.getBatchTask(id);
  }

  getBatchTask(id) {
    const row = this.db.prepare('SELECT * FROM batch_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      payload_json: JSON.parse(row.payload_json || '{}'),
      logs_json: JSON.parse(row.logs_json || '[]')
    };
  }

  listBatchTasks(limit = 20) {
    const rows = this.db.prepare('SELECT * FROM batch_tasks ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(r => ({
      ...r,
      payload_json: JSON.parse(r.payload_json || '{}'),
      logs_json: JSON.parse(r.logs_json || '[]')
    }));
  }

  updateBatchTaskProgress(id, { status, total_nodes, successful_nodes, failed_nodes, log_entry }) {
    const task = this.getBatchTask(id);
    if (!task) return null;

    const logs = task.logs_json;
    if (log_entry) {
      logs.push({ timestamp: Date.now(), ...log_entry });
    }

    const completedAt = (status === 'completed' || status === 'failed' || status === 'cancelled') 
      ? Date.now() 
      : (task.completed_at ?? null);

    this.db.prepare(`
      UPDATE batch_tasks
      SET status = COALESCE(?, status),
          total_nodes = COALESCE(?, total_nodes),
          successful_nodes = COALESCE(?, successful_nodes),
          failed_nodes = COALESCE(?, failed_nodes),
          logs_json = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      status ?? null, 
      total_nodes ?? null, 
      successful_nodes ?? null, 
      failed_nodes ?? null, 
      JSON.stringify(logs), 
      completedAt ?? null, 
      id
    );

    return this.getBatchTask(id);
  }

  // --- CRYPTOGRAPHIC AUDIT LOG (SHA-256 Chained) ---
  recordAuditLog({ actor, action, target_type, target_id, details = {} }) {
    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;

      const lastRow = this.db.prepare('SELECT record_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get();
      const prevHash = lastRow?.record_hash || '0000000000000000000000000000000000000000000000000000000000000000';

      const timestamp = Date.now();
      const detailsJson = JSON.stringify(details);
      const payloadToHash = `${prevHash}|${timestamp}|${actor}|${action}|${target_type}|${target_id}|${detailsJson}`;
      const recordHash = crypto.createHash('sha256').update(payloadToHash).digest('hex');

      this.db.prepare(`
        INSERT INTO audit_logs (timestamp, actor, action, target_type, target_id, details_json, prev_hash, record_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(timestamp, actor, action, target_type, target_id, detailsJson, prevHash, recordHash);

      this.db.exec('COMMIT');
      return { timestamp, actor, action, target_id, recordHash };
    } catch (err) {
      if (inTransaction) {
        try { this.db.exec('ROLLBACK'); } catch {}
      }
      console.error('[MantaStore] Failed to record audit log:', err.message);
      throw err;
    }
  }

  listAuditLogs(limit = 100) {
    const rows = this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({
      ...r,
      details: JSON.parse(r.details_json || '{}')
    }));
  }

  // --- AUTHENTICATION ---
  verifyUser(username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return null;

    const parts = row.password_hash.split(':');
    if (parts[0] === 'sha256' && parts.length === 3) {
      const salt = parts[1];
      const expected = parts[2];
      const actual = crypto.createHash('sha256').update(salt + password).digest('hex');
      if (crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
        return { id: row.id, username: row.username, role: row.role, display_name: row.display_name };
      }
    }
    return null;
  }
}
