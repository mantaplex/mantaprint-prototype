/**
 * MantaPrint Hub - Central Configuration & System Setting Manager
 * Manages /etc/mantaprint/config.json, language, timezone, NTP, manual clock, hostname, and updates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applianceUpdater } from './updater.mjs';
import { INSTALLED_VERSION } from './version.mjs';

const execFileAsync = promisify(execFile);

const PRIMARY_CONFIG_PATH = '/etc/mantaprint/config.json';
const FALLBACK_CONFIG_PATH = path.resolve(process.cwd(), 'config/config.json');

const DEFAULT_CONFIG = {
  version: INSTALLED_VERSION,
  language: 'en', // Default language is English as requested
  hostname: 'mantaprint',
  timezone: 'Asia/Jakarta',
  ntp: {
    enabled: true,
    servers: ['pool.ntp.org', 'time.google.com', 'id.pool.ntp.org']
  },
  admin: {
    username: 'mantaprint',
    password: 'mantapgan'
  },
  updates: {
    current_version: INSTALLED_VERSION,
    channel: 'prototype',
    repo_url: 'https://github.com/mantaplex/mantaprint-prototype',
    last_checked: null,
    update_available: false,
    latest_version: INSTALLED_VERSION,
    changelog: ''
  },
  scanner: {
    portal_enabled: true, // Enables/disables direct Hub WebScan at /scan
    remote_pwa_api_enabled: true // Enables/disables remote PWA API access
  }
};

/**
 * Returns a copy of a hub configuration object safe to send to authenticated
 * clients (admin UI), omitting credentials, tokens, PIN hashes, and secrets.
 */
export function redactConfigForClient(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const {
    admin: _admin,
    lockdown: _lockdown,
    lockdown_override: _lockdownOverride,
    secret: _secret,
    token: _token,
    password: _password,
    ...rest
  } = cfg;
  return structuredClone(rest);
}

class ConfigManager {
  constructor() {
    this.configPath = this.resolveConfigPath();
    this.cachedConfig = this.loadConfig();
  }

  resolveConfigPath() {
    if (process.env.MANTAPRINT_STATE_DIR) {
      const stateDir = path.resolve(process.env.MANTAPRINT_STATE_DIR);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
      }
      return path.join(stateDir, 'config.json');
    }
    try {
      if (!fs.existsSync('/etc/mantaprint')) {
        fs.mkdirSync('/etc/mantaprint', { recursive: true, mode: 0o755 });
      }
      return PRIMARY_CONFIG_PATH;
    } catch {
      const fallbackDir = path.dirname(FALLBACK_CONFIG_PATH);
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      return FALLBACK_CONFIG_PATH;
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        // The version fields in config.json are informational only: the installed
        // version always comes from version.json so a stale config never reports an old release.
        const updates = { ...DEFAULT_CONFIG.updates, ...(parsed.updates || {}), current_version: INSTALLED_VERSION };
        if (!updates.update_available) updates.latest_version = INSTALLED_VERSION;
        return { ...DEFAULT_CONFIG, ...parsed, version: INSTALLED_VERSION, updates };
      }
    } catch (err) {
      console.warn('[ConfigManager] Error reading config file, using defaults:', err.message);
    }
    this.saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(newConfig) {
    try {
      const merged = { ...this.cachedConfig, ...newConfig, version: INSTALLED_VERSION };
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      const tempPath = path.join(dir, `.config.json.tmp.${Date.now()}`);
      fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), 'utf8');
      fs.renameSync(tempPath, this.configPath);
      this.cachedConfig = merged;
      return true;
    } catch (err) {
      console.error('[ConfigManager] Failed to write config atomically:', err.message);
      return false;
    }
  }

  getConfig() {
    return this.cachedConfig || { ...DEFAULT_CONFIG };
  }

  getRedactedConfig() {
    return redactConfigForClient(this.getConfig());
  }

  get(key, defaultValue = null) {
    if (key === 'language') return this.getLanguage();
    return this.cachedConfig && this.cachedConfig[key] !== undefined ? this.cachedConfig[key] : defaultValue;
  }

  getLanguage() {
    return this.cachedConfig.language || 'en';
  }

  setLanguage(lang) {
    const valid = ['en', 'id'].includes(lang) ? lang : 'en';
    this.saveConfig({ language: valid });
    return valid;
  }

  async getTimezone() {
    try {
      const { stdout } = await execFileAsync('timedatectl', ['show', '--property=Timezone', '--value']);
      const tz = stdout.trim();
      if (tz) {
        if (this.cachedConfig.timezone !== tz) {
          this.saveConfig({ timezone: tz });
        }
        return tz;
      }
    } catch {}
    return this.cachedConfig.timezone || 'Asia/Jakarta';
  }

  async setTimezone(tz) {
    if (!tz || typeof tz !== 'string') throw new Error('Invalid timezone specified');
    const safeTz = tz.trim();
    try {
      await execFileAsync('timedatectl', ['set-timezone', safeTz]);
      this.saveConfig({ timezone: safeTz });
      return { success: true, timezone: safeTz };
    } catch (err) {
      console.error('[ConfigManager] Failed to set timezone via timedatectl:', err.message);
      throw new Error(`Gagal mengubah zona waktu: ${err.message}`);
    }
  }

  async getTimeStatus() {
    try {
      const { stdout } = await execFileAsync('timedatectl', ['status']);
      const localTimeMatch = stdout.match(/Local time:\s*(.*)/);
      const utcTimeMatch = stdout.match(/Universal time:\s*(.*)/);
      const rtcTimeMatch = stdout.match(/RTC time:\s*(.*)/);
      const tzMatch = stdout.match(/Time zone:\s*([^\s]+)/);
      const ntpMatch = stdout.match(/NTP service:\s*([^\s]+)/i) || stdout.match(/Network time on:\s*([^\s]+)/i);

      return {
        local_time: localTimeMatch ? localTimeMatch[1].trim() : new Date().toLocaleString(),
        utc_time: utcTimeMatch ? utcTimeMatch[1].trim() : new Date().toUTCString(),
        rtc_time: rtcTimeMatch ? rtcTimeMatch[1].trim() : null,
        timezone: tzMatch ? tzMatch[1].trim() : (this.cachedConfig.timezone || 'Asia/Jakarta'),
        ntp_active: ntpMatch ? (ntpMatch[1].toLowerCase() === 'active' || ntpMatch[1].toLowerCase() === 'yes') : true,
        iso_now: new Date().toISOString()
      };
    } catch (err) {
      return {
        local_time: new Date().toLocaleString(),
        utc_time: new Date().toUTCString(),
        timezone: this.cachedConfig.timezone || 'Asia/Jakarta',
        ntp_active: true,
        iso_now: new Date().toISOString()
      };
    }
  }

  async setNtp(enabled, servers = null) {
    try {
      const flag = enabled ? 'true' : 'false';
      await execFileAsync('timedatectl', ['set-ntp', flag]);
      
      const ntpUpdate = { enabled: Boolean(enabled) };
      if (Array.isArray(servers) && servers.length > 0) {
        ntpUpdate.servers = servers.map(s => String(s).trim()).filter(Boolean);
      }
      this.saveConfig({ ntp: { ...this.cachedConfig.ntp, ...ntpUpdate } });
      return { success: true, ntp: ntpUpdate };
    } catch (err) {
      throw new Error(`Failed to set NTP state: ${err.message}`);
    }
  }

  async setManualDateTime(dateTimeStr) {
    // Expected format: "YYYY-MM-DD HH:MM:SS"
    if (!dateTimeStr || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateTimeStr.trim())) {
      throw new Error('Format tanggal & waktu harus "YYYY-MM-DD HH:MM:SS" (contoh: 2026-09-20 14:30:00)');
    }
    const safeStr = dateTimeStr.trim();
    try {
      // Must disable NTP before setting manual clock in systemd-timesyncd
      await execFileAsync('timedatectl', ['set-ntp', 'false']).catch(() => {});
      await execFileAsync('timedatectl', ['set-time', safeStr]);
      this.saveConfig({ ntp: { ...this.cachedConfig.ntp, enabled: false } });
      return { success: true, message: `System time set to ${safeStr}` };
    } catch (err) {
      throw new Error(`Failed to set manual time: ${err.message}`);
    }
  }

  async setHostname(newHostname) {
    if (!newHostname || !/^[a-zA-Z0-9][a-zA-Z0-9-_]{1,62}$/.test(newHostname.trim())) {
      throw new Error('Hostname hanya boleh berupa huruf, angka, tanda minus, dan garis bawah (2-63 karakter).');
    }
    const safeHost = newHostname.trim().toLowerCase();
    try {
      await execFileAsync('hostnamectl', ['set-hostname', safeHost]);
      
      // Update /etc/hosts to keep 127.0.1.1 mapped cleanly
      try {
        if (fs.existsSync('/etc/hosts')) {
          let hosts = fs.readFileSync('/etc/hosts', 'utf8');
          if (/127\.0\.1\.1\s+/.test(hosts)) {
            hosts = hosts.replace(/127\.0\.1\.1\s+[^\n]+/, `127.0.1.1\t${safeHost}`);
          } else {
            hosts += `\n127.0.1.1\t${safeHost}\n`;
          }
          fs.writeFileSync('/etc/hosts', hosts, 'utf8');
        }
      } catch {}

      this.saveConfig({ hostname: safeHost });
      return { success: true, hostname: safeHost };
    } catch (err) {
      throw new Error(`Failed to set hostname: ${err.message}`);
    }
  }

  async getCuratedTimezones() {
    // Top curated timezones for quick selection + list from timedatectl
    const curated = [
      { id: 'Asia/Jakarta', label: 'WIB (Waktu Indonesia Barat) - Jakarta (UTC+7)' },
      { id: 'Asia/Makassar', label: 'WITA (Waktu Indonesia Tengah) - Makassar, Bali (UTC+8)' },
      { id: 'Asia/Jayapura', label: 'WIT (Waktu Indonesia Timur) - Jayapura, Papua (UTC+9)' },
      { id: 'Asia/Singapore', label: 'Singapore, Kuala Lumpur (UTC+8)' },
      { id: 'Asia/Bangkok', label: 'Bangkok, Hanoi (UTC+7)' },
      { id: 'Asia/Tokyo', label: 'Tokyo, Seoul (UTC+9)' },
      { id: 'UTC', label: 'Coordinated Universal Time (UTC+0)' },
      { id: 'Europe/London', label: 'London, Dublin (UTC+0/+1)' },
      { id: 'Europe/Paris', label: 'Paris, Berlin, Amsterdam (UTC+1/+2)' },
      { id: 'America/New_York', label: 'New York, Toronto (EST/EDT, UTC-5/-4)' },
      { id: 'America/Chicago', label: 'Chicago, Dallas (CST/CDT, UTC-6/-5)' },
      { id: 'America/Los_Angeles', label: 'Los Angeles, San Francisco (PST/PDT, UTC-8/-7)' },
      { id: 'Australia/Sydney', label: 'Sydney, Melbourne (AEST, UTC+10/+11)' }
    ];

    try {
      const { stdout } = await execFileAsync('timedatectl', ['list-timezones']);
      const all = stdout.trim().split('\n').filter(Boolean);
      return { curated, all };
    } catch {
      return { curated, all: curated.map(c => c.id) };
    }
  }

  async checkForUpdates() {
    try {
      const info = await applianceUpdater.checkForUpdates(true);
      const updatesState = {
        current_version: info.current_version,
        latest_version: info.latest_version,
        update_available: info.update_available,
        last_checked: info.last_checked,
        channel: info.channel || 'prototype',
        git: { commit: info.commit || 'main' },
        changelog: Array.isArray(info.changelog) ? info.changelog.join('\n- ') : info.changelog
      };
      this.saveConfig({ updates: updatesState });
      return updatesState;
    } catch {
      return this.cachedConfig.updates || {
        current_version: applianceUpdater.currentVersion,
        latest_version: applianceUpdater.currentVersion,
        update_available: false,
        last_checked: new Date().toISOString()
      };
    }
  }
}

export const configManager = new ConfigManager();
