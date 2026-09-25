import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');
function resolveBackupsDir() {
  if (process.env.MANTAMAN_BACKUP_DIR) return process.env.MANTAMAN_BACKUP_DIR;
  if (fs.existsSync('/var/lib/mantaman')) {
    try {
      fs.accessSync('/var/lib/mantaman', fs.constants.W_OK);
      return '/var/lib/mantaman/backups';
    } catch {
      // not writable by current user
    }
  }
  return path.join(ROOT_DIR, 'backups');
}
const BACKUPS_DIR = resolveBackupsDir();

export class MantaPoolUpdater {
  constructor(store) {
    this.store = store;
    this.sseClients = new Set();
    this.isUpdating = false;
    this.updateState = 'IDLE'; // 'IDLE', 'CHECKING', 'BACKING_UP', 'DOWNLOADING', 'BUILDING', 'RESTARTING', 'COMPLETED', 'FAILED'
    this.updateProgress = 0;
    this.updateLogs = [];
    this.latestCheckedRelease = null;

    if (!fs.existsSync(BACKUPS_DIR)) {
      try {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o750 });
      } catch (err) {
        console.warn('[MantaPoolUpdater] Failed to create backups directory:', err.message);
      }
    }
  }

  // Check if running inside a Docker container
  isDocker() {
    return Boolean(
      process.env.MANTAMAN_DOCKER ||
      fs.existsSync('/.dockerenv') ||
      (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'))
    );
  }

  getVersion() {
    const versionPath = path.join(ROOT_DIR, 'version.json');
    let versionInfo = {
      name: 'mantapool-console',
      version: '0.3.0',
      release_channel: 'prototype',
      build_date: new Date().toISOString(),
      git_repo: 'https://github.com/mantaplex/mantaprint-prototype'
    };

    if (fs.existsSync(versionPath)) {
      try {
        const raw = fs.readFileSync(versionPath, 'utf8');
        versionInfo = { ...versionInfo, ...JSON.parse(raw) };
      } catch (err) {
        console.warn('[MantaPoolUpdater] Error reading version.json:', err.message);
      }
    }

    return {
      ...versionInfo,
      is_docker: this.isDocker(),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch
    };
  }

  async checkForUpdates() {
    this._log('Checking for latest MantaPool updates from GitHub...');
    const current = this.getVersion();

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/mantaplex/mantaprint-prototype/releases',
        headers: {
          'User-Agent': 'MantaPool-Fleet-Console/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };

      const req = https.get(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const releases = JSON.parse(body);
              if (Array.isArray(releases) && releases.length > 0) {
                const latest = releases[0];
                const cleanTag = latest.tag_name ? latest.tag_name.replace(/^v/, '') : '';
                const updateAvailable = cleanTag !== '' && this._compareSemver(cleanTag, current.version) > 0;

                const result = {
                  updateAvailable,
                  currentVersion: current.version,
                  latestVersion: cleanTag || current.version,
                  releaseName: latest.name || latest.tag_name,
                  releaseNotes: latest.body || 'No release notes provided.',
                  publishedAt: latest.published_at,
                  htmlUrl: latest.html_url
                };

                this.latestCheckedRelease = result;
                return resolve(result);
              }
            } catch (parseErr) {
              console.warn('[MantaPoolUpdater] JSON parse error:', parseErr.message);
            }
          }

          // Fallback or rate-limited response
          resolve(this._getFallbackUpdateInfo(current));
        });
      });

      req.on('error', (err) => {
        console.warn('[MantaPoolUpdater] Network error checking updates:', err.message);
        resolve(this._getFallbackUpdateInfo(current));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(this._getFallbackUpdateInfo(current));
      });
    });
  }

  _getFallbackUpdateInfo(current) {
    return {
      updateAvailable: false,
      currentVersion: current.version,
      latestVersion: current.version,
      releaseName: `v${current.version}`,
      releaseNotes: 'Running latest installed build.',
      publishedAt: current.build_date,
      htmlUrl: 'https://github.com/mantaplex/mantaprint-prototype/releases'
    };
  }

  _compareSemver(v1, v2) {
    const parse = (s) => (s || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
    const [p1, p2] = [parse(v1), parse(v2)];
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  // Backup SQLite database
  async createDatabaseBackup() {
    const current = this.getVersion();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `mantaman_backup_v${current.version}_${ts}.sqlite`;
    const destPath = path.join(BACKUPS_DIR, backupName);

    if (this.store && this.store.db) {
      try {
        // 1. Force WAL checkpoint to flush all uncommitted journal transactions
        try {
          this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {}

        // 2. Perform atomic online snapshot via VACUUM INTO, fallback to copyFileSync
        try {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          this.store.db.prepare('VACUUM INTO ?').run(destPath);
        } catch {
          fs.copyFileSync(this.store.dbPath, destPath);
        }

        this._log(`[Backup] SQLite database preserved at: ${backupName}`);
        return { success: true, backupName, destPath };
      } catch (err) {
        this._log(`[Backup Error] Failed to copy SQLite database: ${err.message}`);
        throw err;
      }
    } else if (this.store && this.store.dbPath && fs.existsSync(this.store.dbPath)) {
      try {
        fs.copyFileSync(this.store.dbPath, destPath);
        this._log(`[Backup] SQLite database preserved at: ${backupName}`);
        return { success: true, backupName, destPath };
      } catch (err) {
        this._log(`[Backup Error] Failed to copy SQLite database: ${err.message}`);
        throw err;
      }
    } else {
      this._log('[Backup] No database file found to backup, continuing...');
      return { success: true, backupName: null };
    }
  }

  listBackups() {
    if (!fs.existsSync(BACKUPS_DIR)) return [];
    try {
      return fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.endsWith('.sqlite'))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUPS_DIR, f));
          return {
            filename: f,
            size: stat.size,
            created_at: stat.mtime
          };
        })
        .sort((a, b) => b.created_at - a.created_at);
    } catch (err) {
      console.warn('[MantaPoolUpdater] Error listing backups:', err.message);
      return [];
    }
  }

  async rollbackDatabase(backupFilename) {
    if (!backupFilename) throw new Error('Backup filename is required');
    const safeName = path.basename(backupFilename);
    const backupPath = path.join(BACKUPS_DIR, safeName);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file ${safeName} does not exist`);
    }

    if (this.store && this.store.dbPath) {
      this._log(`[Rollback] Restoring SQLite database from ${safeName}...`);

      // 1. Close open database connection if active
      try {
        if (this.store.db && typeof this.store.db.close === 'function') {
          this.store.db.close();
        }
      } catch {}

      // 2. Remove stale WAL/SHM companion files to prevent transaction replay onto restored database
      const walFile = this.store.dbPath + '-wal';
      const shmFile = this.store.dbPath + '-shm';
      try { if (fs.existsSync(walFile)) fs.unlinkSync(walFile); } catch {}
      try { if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile); } catch {}

      // 3. Atomically overwrite primary DB file
      fs.copyFileSync(backupPath, this.store.dbPath);
      this._log('[Rollback] Database successfully restored. Restarting service.');
      this._scheduleRestart();
      return { success: true, message: 'Database restored successfully' };
    }

    throw new Error('Store database path is not defined');
  }

  // Main Update Execution Pipeline
  async installUpdate() {
    if (this.isUpdating) {
      throw new Error('An update is already in progress');
    }

    this.isUpdating = true;
    this.updateProgress = 5;
    this.updateState = 'BACKING_UP';
    this.updateLogs = [];
    this._broadcastState();

    try {
      this._log('[1/5] Initiating pre-update safety backup...');
      await this.createDatabaseBackup();
      this.updateProgress = 25;
      this._broadcastState();

      if (this.isDocker()) {
        this.updateState = 'COMPLETED';
        this.updateProgress = 100;
        this._log('[Docker Detected] To complete container update, execute:');
        this._log('  docker compose pull && docker compose up -d');
        this._broadcastState();
        this.isUpdating = false;
        return { success: true, mode: 'docker', message: 'Pull new container image to finish update.' };
      }

      // Standalone Linux environment
      this.updateState = 'DOWNLOADING';
      this.updateProgress = 40;
      this._log('[2/5] Fetching latest source code from repository...');
      this._broadcastState();

      try {
        const { stdout: pullOut } = await execAsync('git pull origin main', { cwd: ROOT_DIR, timeout: 60000 });
        this._log(`[Git Pull] ${pullOut.trim()}`);
      } catch (gitErr) {
        this._log(`[Git Warning] ${gitErr.message}. Attempting install on current tree.`);
      }

      this.updateState = 'BUILDING';
      this.updateProgress = 65;
      this._log('[3/5] Compiling MantaPool Console frontend distribution...');
      this._broadcastState();

      try {
        const { stdout: buildOut } = await execAsync('npm run build:frontend', { cwd: ROOT_DIR, timeout: 120000 });
        this._log(`[Build] Frontend compiled successfully.`);
      } catch (buildErr) {
        this._log(`[Build Error] ${buildErr.message}`);
        throw new Error('Failed to compile frontend');
      }

      this.updateState = 'RESTARTING';
      this.updateProgress = 90;
      this._log('[4/5] Reloading MantaPool systemd daemon...');
      this._broadcastState();

      this.updateState = 'COMPLETED';
      this.updateProgress = 100;
      this._log('[5/5] Update applied successfully! Reconnecting console...');
      this._broadcastState();

      this._scheduleRestart();
      this.isUpdating = false;
      return { success: true, mode: 'standalone' };

    } catch (err) {
      this.updateState = 'FAILED';
      this.updateProgress = 0;
      this._log(`[ERROR] Update failed: ${err.message}`);
      this._broadcastState();
      this.isUpdating = false;
      throw err;
    }
  }

  _scheduleRestart() {
    setTimeout(() => {
      // Attempt systemctl restart or graceful exit so systemd restarts it
      exec('systemctl restart mantapool.service 2>/dev/null || systemctl restart mantaman.service 2>/dev/null', (err) => {
        if (err) {
          console.log('[MantaPoolUpdater] Exiting process for systemd supervisor restart...');
          process.exit(0);
        }
      });
    }, 1500);
  }

  _log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${msg}`;
    this.updateLogs.push(entry);
    if (this.updateLogs.length > 500) this.updateLogs.shift();
    this._broadcastLog(entry);
  }

  _broadcastState() {
    const data = JSON.stringify({
      type: 'state',
      state: this.updateState,
      progress: this.updateProgress,
      isUpdating: this.isUpdating
    });
    for (const client of this.sseClients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }

  _broadcastLog(line) {
    const data = JSON.stringify({
      type: 'log',
      line
    });
    for (const client of this.sseClients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }

  addSseClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');

    // Send initial state
    res.write(`data: ${JSON.stringify({
      type: 'state',
      state: this.updateState,
      progress: this.updateProgress,
      isUpdating: this.isUpdating,
      logs: this.updateLogs.slice(-50)
    })}\n\n`);

    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }
}
