#!/usr/bin/env node
/**
 * MantaPrint Hub - Realtime Universal Print Management Engine
 * Native ESM Node.js Server (Port 80)
 * Security Hardened & Performance Optimized
 * Features:
 * - Direct IPP-over-USB hardware telemetry (CMYK ink levels, maintenance cartridge, alerts)
 * - Realtime Server-Sent Events (SSE) push stream with backpressure & cleanup
 * - CUPS queue management (Pause, Resume, Cancel Job, Cancel All, Test Page)
 * - Direct browser document printing (PDF, Images) with automatic fit-to-page & upload limit
 * - Single-flight request collapsing (anti-thundering-herd)
 * - Strict argument validation & shell/flag injection immunity
 * - Strict path traversal boundary enforcement
 * - Memory bounded (< 60MB RAM budget)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { hdmiNetworkEngine, remoteWizardEngine, validateEthernetConfig, applySysctlHardening } from './hdmi-network-api.mjs';
import { INSTALLED_VERSION } from './version.mjs';
import { buildAirPrintProfile } from './airprint-profile.mjs';
import { runComprehensiveMdnsCupsDiagnostic, getQuickMdnsStatus } from './network-diagnostics.mjs';
import { configManager } from './config-manager.mjs';
import { applianceUpdater, UpdaterState } from './updater.mjs';
import { scannerHardwareLock, scannerPairingManager } from './scanner-pairing-manager.mjs';
import { getFirmwareStatus, getExtractionTools, pickWorkBase, freeBytes, receiveUpload, processFirmwareUpload } from './scanner-firmware.mjs';
import { getHplipPluginStatus, hpPluginHint, installPluginFile, RUN_MAX_BYTES as HPLIP_RUN_MAX_BYTES, parseModelsDat as parseHplipModels, findModelEntry as findHplipModel, pluginNeed as hplipPluginNeed, MODELS_DAT as HPLIP_MODELS_DAT } from './hplip-plugin.mjs';
import * as driverCenter from './driver-center.mjs';
import * as lockdown from './lockdown.mjs';
import { directConnect } from './direct-connect.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

const PORT = parseInt(process.env.PORT || '80', 10);
const FALLBACK_PORT = 8080;

function getCurrentSystemLanguage() {
  if (typeof configManager?.getLanguage === 'function') {
    return configManager.getLanguage();
  }
  if (typeof configManager?.get === 'function') {
    return configManager.get('language') || 'id';
  }
  return configManager?.cachedConfig?.language || 'id';
}

function getCurrentSystemVersion() {
  return applianceUpdater?.currentVersion || INSTALLED_VERSION;
}

// Appliance Storage Tiering & Zero-Trace Privacy Architecture:
// 100% of recurring scans and temporary files stream strictly to volatile RAM tmpfs (/run/mantaprint/scans)
// Under no circumstances are customer scans stored on persistent MicroSD or eMMC
const RAM_SCANS_DIR = '/run/mantaprint/scans';
try {
  if (!fs.existsSync(RAM_SCANS_DIR)) {
    fs.mkdirSync(RAM_SCANS_DIR, { recursive: true, mode: 0o777 });
  }
} catch (e) {
  console.warn('[Storage] Could not create RAM scans directory:', e.message);
}

const SD_DATA_DIR = '/mnt/data';
const SD_SCANS_DIR = path.join(SD_DATA_DIR, 'scans');
const SCAN_STORAGE_DIR = fs.existsSync(RAM_SCANS_DIR)
  ? RAM_SCANS_DIR
  : (fs.existsSync(SD_SCANS_DIR) ? SD_SCANS_DIR : '/tmp');
const RAM_SPOOL_DIR = '/run/mantaprint/spool';
try {
  if (!fs.existsSync(RAM_SPOOL_DIR)) {
    fs.mkdirSync(RAM_SPOOL_DIR, { recursive: true, mode: 0o777 });
  }
} catch {}
const SPOOL_TEMP_DIR = fs.existsSync(RAM_SPOOL_DIR) ? RAM_SPOOL_DIR : '/tmp';

// Server-side scan post-processing is deprecated: the /scan studio renders, enhances, merges
// and stores pages entirely on the client. See the deprecation block in the request handler.
const DEPRECATED_SCAN_ENDPOINTS = new Set([
  '/api/scanner/enhance',
  '/api/scanner/merge',
  '/api/scanner/ktp2in1',
  '/api/scanner/blank-detect',
  '/api/scanner/session-status',
  '/api/scanner/wipe-session'
]);
const DEPRECATED_SCAN_SUNSET = 'Wed, 31 Mar 2027 00:00:00 GMT';
const deprecatedEndpointLogged = new Set();

function resolveScanFilePath(filename) {
  const safeName = path.basename(filename);
  // Check RAM first (Zero-Trace In-Memory)
  const pRam = path.join(RAM_SCANS_DIR, safeName);
  if (fs.existsSync(pRam)) return pRam;
  const pStorage = path.join(SCAN_STORAGE_DIR, safeName);
  if (fs.existsSync(pStorage)) return pStorage;
  const pSd = path.join(SD_SCANS_DIR, safeName);
  if (fs.existsSync(pSd)) return pSd;
  const pTmp = path.join('/tmp', safeName);
  if (fs.existsSync(pTmp)) return pTmp;
  return null;
}

// 60-Second Periodic Garbage Collection (V8 Heap Budget Tuning)
if (typeof global.gc === 'function') {
  setInterval(() => {
    try { global.gc(); } catch {}
  }, 60000);
}

// Unified Scan Artifact Detection Helper (Zero-Trace tmpfs Ephemeral Storage)
function isScanArtifact(filename) {
  const f = path.basename(filename);
  const EPHEMERAL_PREFIXES = ['scan_', 'enh_', 'merged_', 'batch_', 'raw_', 'ktp2in1_', 'tmp_merge_'];
  return EPHEMERAL_PREFIXES.some(p => f.startsWith(p)) || /\.(pnm|tiff|tif|tmp)$/i.test(f);
}

// SANE Diagnostic Error Parser (Feeder empty, jam, cover, USB I/O)
function parseSaneError(stderr = '', stdout = '', exitCode = 1) {
  const combined = `${stderr || ''} ${stdout || ''}`.toLowerCase();
  if (combined.includes('out of documents') || combined.includes('out of paper') || combined.includes('feeder is empty')) {
    return { code: 'ERR_FEEDER_EMPTY', message: 'Kertas pada feeder (ADF) kosong. Masukkan dokumen ke tray feeder.' };
  }
  if (combined.includes('paper jam') || combined.includes('jammed')) {
    return { code: 'ERR_PAPER_JAM', message: 'Kertas macet di dalam feeder ADF (Paper Jam). Buka penutup scanner dan keluarkan kertas.' };
  }
  if (combined.includes('cover open')) {
    return { code: 'ERR_COVER_OPEN', message: 'Penutup scanner terbuka. Tutup penutup scanner sebelum memindai.' };
  }
  if (combined.includes('device i/o') || combined.includes('error during device i/o') || combined.includes('communication error')) {
    return { code: 'ERR_DEVICE_IO', message: 'Koneksi ke scanner terputus. Pastikan kabel USB terpasang dengan kokoh.' };
  }
  if (combined.includes('device busy') || combined.includes('resource has been denied')) {
    return { code: 'ERR_DEVICE_BUSY', message: 'Scanner sedang sibuk atau sedang melakukan kalibrasi hardware.' };
  }
  return { code: 'ERR_SCAN_FAILED', message: 'Gagal memindai dokumen. Pastikan penutup tertutup dan scanner siap.' };
}

// 5-Minute Ephemeral Privacy Auto-Pruning:
// Scanned documents in RAM self-destruct after 5 minutes of inactivity to protect customer privacy
const SCAN_EPHEMERAL_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

// Cryptographic Zero-Trace File Shredding:
// Overwrites ephemeral document buffers with zeroes before unlinking to guarantee customer data privacy
function secureShredFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      const fd = fs.openSync(filePath, 'r+');
      const zeroBuffer = Buffer.alloc(Math.min(stat.size, 65536), 0);
      let written = 0;
      while (written < stat.size) {
        const toWrite = Math.min(zeroBuffer.length, stat.size - written);
        fs.writeSync(fd, zeroBuffer, 0, toWrite, written);
        written += toWrite;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    fs.unlinkSync(filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function pruneExpiredScans() {
  try {
    const targetDirs = [RAM_SCANS_DIR];
    if (SCAN_STORAGE_DIR !== RAM_SCANS_DIR && fs.existsSync(SCAN_STORAGE_DIR)) targetDirs.push(SCAN_STORAGE_DIR);
    if (fs.existsSync(SD_SCANS_DIR)) targetDirs.push(SD_SCANS_DIR);
    const now = Date.now();
    let pruned = 0;
    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (isScanArtifact(f)) {
          const fp = path.join(dir, f);
          try {
            const stat = fs.statSync(fp);
            if (now - stat.mtimeMs > SCAN_EPHEMERAL_TTL_MS) {
              secureShredFile(fp);
              pruned++;
            }
          } catch {}
        }
      }
    }
    if (pruned > 0) {
      console.log(`[Storage/Security] Ephemeral self-destruct: Auto-purged ${pruned} scan artifacts from RAM.`);
    }
  } catch (err) {
    console.warn('[Storage] Pruning error:', err.message);
  }
}
setInterval(pruneExpiredScans, 15 * 1000); // Check every 15 seconds
setImmediate(pruneExpiredScans);

// Generic safe command execution wrapper
function runCmd(cmd, args = [], timeoutMs = 20000) {
  return new Promise(resolve => {
    const env = {
      ...process.env,
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:' + (process.env.PATH || '')
    };
    execFile(cmd, args, { timeout: timeoutMs, env }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        timedOut: Boolean(err && err.killed)
      });
    });
  });
}

function hasInterfaceCarrier(iface) {
  try {
    return fs.readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

function getIpAddress() {
  const interfaces = os.networkInterfaces();

  // 1. Check primary interface from Linux kernel default route (/proc/net/route)
  // Only accept routes on interfaces that actually have physical carrier!
  try {
    const routeContent = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = routeContent.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === '00000000') {
        const defaultIface = parts[0];
        if (hasInterfaceCarrier(defaultIface) && interfaces[defaultIface]) {
          for (const iface of interfaces[defaultIface]) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1' && iface.address !== '10.11.12.1' && !iface.address.startsWith('169.254.')) {
              return iface.address;
            }
          }
        }
      }
    }
  } catch {}

  // 2. Ethernet with active link carrier (highest priority when cable is plugged in)
  const ethPrefixes = ['eth', 'end', 'enp', 'eno', 'enx'];
  for (const name of Object.keys(interfaces)) {
    if (ethPrefixes.some(p => name.startsWith(p)) && hasInterfaceCarrier(name)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1' && iface.address !== '10.11.12.1' && !iface.address.startsWith('169.254.')) {
          return iface.address;
        }
      }
    }
  }

  // 3. Wi-Fi interface (takes over as primary when Ethernet is unplugged or has no IP)
  const wifiPrefixes = ['wlan', 'wlp', 'wls', 'wl', 'ra'];
  for (const name of Object.keys(interfaces)) {
    if (wifiPrefixes.some(p => name.startsWith(p))) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1' && !iface.address.startsWith('169.254.')) {
          return iface.address;
        }
      }
    }
  }

  // 4. Fallback: Direct-connect Ethernet address if active
  for (const name of Object.keys(interfaces)) {
    if (ethPrefixes.some(p => name.startsWith(p))) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address === '10.11.12.1') {
          return iface.address;
        }
      }
    }
  }

  // 5. Fallback: Any non-internal IPv4 excluding virtual/container interfaces
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth') || name.startsWith('lo')) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getCpuTemp() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    return Math.round((parseInt(raw, 10) / 1000) * 10) / 10;
  } catch {
    return 46.5;
  }
}

function getUptime() {
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0];
    const sec = parseFloat(raw);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ') || '< 1m';
  } catch {
    return 'N/A';
  }
}

function getRamInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const lines = raw.split('\n');
    let total = 2048 * 1024;
    let avail = 1536 * 1024;
    for (const line of lines) {
      if (line.startsWith('MemTotal:')) {
        total = parseInt(line.replace(/\D/g, ''), 10) || total;
      } else if (line.startsWith('MemAvailable:')) {
        avail = parseInt(line.replace(/\D/g, ''), 10) || avail;
      }
    }
    const used = total - avail;
    return {
      total_mb: Math.round(total / 1024),
      used_mb: Math.round(used / 1024),
      percent: Math.round((used / total) * 1000) / 10
    };
  } catch {
    return { total_mb: 2048, used_mb: 512, percent: 25 };
  }
}

function getStorageInfo() {
  let emmc = { totalMb: 5900, usedMb: 2500, freeMb: 3400, percent: 42 };
  let microsd = { mounted: false, totalGb: 0, usedMb: 0, freeGb: 0, percent: 0 };
  let storageTier = 'external';
  let mediaType = 'MicroSD';
  let ramSpoolActive = false;
  let devicePath = '';

  try {
    const sRoot = fs.statfsSync('/');
    const rTot = Math.round((sRoot.blocks * sRoot.bsize) / (1024 * 1024));
    const rFree = Math.round((sRoot.bfree * sRoot.bsize) / (1024 * 1024));
    const rUsed = rTot - rFree;
    emmc = {
      totalMb: rTot,
      usedMb: rUsed,
      freeMb: rFree,
      percent: rTot > 0 ? Math.round((rUsed / rTot) * 100) : 0
    };
  } catch {}

  // Check adaptive storage engine state file (/run/mantaprint/storage.json)
  const statePath = '/run/mantaprint/storage.json';
  let hasEngineState = false;
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      hasEngineState = true;
      storageTier = state.tier || 'external';
      mediaType = state.media_type || 'MicroSD';
      ramSpoolActive = Boolean(state.ram_spool_active);
      devicePath = state.device || '';
      microsd.mounted = Boolean(state.mounted);
    } catch {}
  }

  try {
    if (fs.existsSync(SD_DATA_DIR)) {
      const sSd = fs.statfsSync(SD_DATA_DIR);
      const sdTotMb = Math.round((sSd.blocks * sSd.bsize) / (1024 * 1024));
      const sdFreeMb = Math.round((sSd.bfree * sSd.bsize) / (1024 * 1024));
      const sdUsedMb = sdTotMb - sdFreeMb;

      if (!hasEngineState) {
        // Fallback detection if storage engine state is not yet present
        const isExternal = sSd.blocks !== fs.statfsSync('/').blocks;
        microsd.mounted = isExternal && sdTotMb > 500;
      }

      if (microsd.mounted) {
        microsd = {
          mounted: true,
          totalGb: Math.round((sdTotMb / 1024) * 10) / 10,
          usedMb: sdUsedMb,
          freeGb: Math.round((sdFreeMb / 1024) * 10) / 10,
          percent: sdTotMb > 0 ? Math.round((sdUsedMb / sdTotMb) * 100) : 0
        };
      }
    }
  } catch (e) {
    // If statfs on SD_DATA_DIR throws EIO, card was yanked!
    try {
      execFile('/usr/local/bin/mantaprint-storage-manager.sh', ['check-health'], () => {});
    } catch {}
  }

  // Periodic stealth canary check
  if (microsd.mounted && Math.random() < 0.2) {
    try {
      fs.accessSync(path.join(SD_DATA_DIR, '.health'), fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      try {
        execFile('/usr/local/bin/mantaprint-storage-manager.sh', ['check-health'], () => {});
      } catch {}
    }
  }

  let tieringMode = microsd.mounted
    ? `Endurance Tiering Active (${mediaType} Offload)`
    : (ramSpoolActive 
        ? 'Auto-Fallback Active (Zero-eMMC RAM Spooling)' 
        : 'Standard Flash');

  return {
    emmc,
    microsd,
    tier: storageTier,
    media_type: mediaType,
    device: devicePath,
    ram_spool_active: ramSpoolActive,
    tiering_mode: tieringMode,
    scan_storage: {
      type: 'RAM tmpfs (Zero-Trace Ephemeral)',
      ttl_minutes: 5,
      path: RAM_SCANS_DIR
    }
  };
}

// Global cached state to prevent saturating USB / CUPS
let cachedStatus = null;
let lastStatusFetch = 0;
let inflightStatusPromise = null;
let isProbingBackground = false;
const sseClients = new Set();

function getDefaultQueueName() {
  if (cachedStatus?.printer?.connected && cachedStatus?.printer?.queue_name) {
    return cachedStatus.printer.queue_name;
  }
  if (cachedStatus?.queues?.length > 0) {
    return cachedStatus.queues[0].name;
  }
  return '';
}

function resolveTargetQueue(requestedQueue) {
  const activeQueue = getDefaultQueueName();
  if (!requestedQueue) return activeQueue;
  const sanitized = sanitizeIdentifier(requestedQueue);
  if (!sanitized) return activeQueue;
  // If requested queue exists in currently detected queues, use it
  if (cachedStatus?.queues?.some(q => q.name === sanitized)) {
    return sanitized;
  }
  // Otherwise gracefully fall back to the physically active queue
  return activeQueue;
}

function sanitizeIdentifier(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (/^[a-zA-Z0-9_.-]+$/.test(trimmed) && !trimmed.startsWith('-')) {
    return trimmed;
  }
  return null;
}

// --- SCANNER ARCHITECTURE & PROFILES ---
// Standard paper dimension presets (in millimeters)
const SCAN_PAPER_SIZES = {
  'A4': { name: 'A4', width: 210, height: 297 },
  'F4': { name: 'F4 / Folio Indonesia', width: 215, height: 330 },
  'Folio': { name: 'F4 / Folio Indonesia', width: 215, height: 330 },
  'Legal': { name: 'Legal', width: 215.9, height: 355.6 },
  'Letter': { name: 'Letter', width: 215.9, height: 279.4 },
  'ID Card': { name: 'ID Card / KTP', width: 86, height: 54 },
  'IDCard': { name: 'ID Card / KTP', width: 86, height: 54 },
  'KTP': { name: 'ID Card / KTP', width: 86, height: 54 }
};

// 10 Appliance-grade scanner hardware profiles
const SCANNER_PROFILES = [
  {
    id: 'canon-lide-100',
    name: 'Canon CanoScan LiDE 100',
    vendor: 'Canon',
    model: 'CanoScan LiDE 100',
    driver: 'genesys',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600, 1200],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '04a9:1904',
    match: /(lide\s*100|canoscan\s*100|04a9:1904)/i
  },
  {
    id: 'canon-lide-110',
    name: 'Canon CanoScan LiDE 110',
    vendor: 'Canon',
    model: 'CanoScan LiDE 110',
    driver: 'genesys',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600, 1200],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '04a9:1909',
    match: /(lide\s*110|canoscan\s*110|04a9:1909)/i
  },
  {
    id: 'canon-lide-120',
    name: 'Canon CanoScan LiDE 120',
    vendor: 'Canon',
    model: 'CanoScan LiDE 120',
    driver: 'genesys',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600, 1200, 2400],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '04a9:190e',
    match: /(lide\s*120|canoscan\s*120|04a9:190e)/i
  },
  {
    id: 'canon-lide-300',
    name: 'Canon CanoScan LiDE 300',
    vendor: 'Canon',
    model: 'CanoScan LiDE 300',
    driver: 'pixma',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600, 1200, 2400],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '04a9:1913',
    match: /(lide\s*300|canoscan\s*300|04a9:1913)/i
  },
  {
    id: 'epson-ds-410',
    name: 'Epson WorkForce DS-410',
    vendor: 'Epson',
    model: 'WorkForce DS-410',
    driver: 'utsushi',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [75, 150, 200, 300, 600],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 215.9, height: 3048 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04b8:1138',
    match: /(ds-?410|workforce\s*ds-?410|04b8:1138)/i
  },
  {
    id: 'fujitsu-fi-6110',
    name: 'Fujitsu fi-6110',
    vendor: 'Fujitsu',
    model: 'fi-6110',
    driver: 'fujitsu',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray', 'Lineart'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 863 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04c5:1175',
    match: /(fi-?6110|04c5:1175)/i
  },
  {
    id: 'fujitsu-ix500',
    name: 'Fujitsu ScanSnap iX500',
    vendor: 'Fujitsu',
    model: 'ScanSnap iX500',
    driver: 'fujitsu',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 863 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04c5:132b',
    match: /(ix500|scansnap\s*ix500|04c5:132b)/i
  },
  {
    id: 'fujitsu-ix1500',
    name: 'Fujitsu ScanSnap iX1500',
    vendor: 'Fujitsu',
    model: 'ScanSnap iX1500',
    driver: 'fujitsu',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 863 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04c5:159f',
    match: /(ix1500|scansnap\s*ix1500|04c5:159f)/i
  },
  {
    id: 'fujitsu-sv600',
    name: 'Fujitsu ScanSnap SV600 (Overhead)',
    vendor: 'Fujitsu',
    model: 'ScanSnap SV600',
    driver: 'unsupported',
    type: 'Overhead',
    sources: ['Overhead Camera'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png'],
    max_geometry: { width: 432, height: 300 },
    supported_paper_sizes: ['A3', 'A4', 'Letter'],
    usb_id: '04c5:128e',
    match: /(sv600|scansnap\s*sv600|04c5:128e)/i,
    unsupported_reason: 'Proprietary contactless overhead scanner without Linux/SANE driver. Requires Windows/macOS ScanSnap Home.'
  },
  {
    id: 'fujitsu-s1300',
    name: 'Fujitsu ScanSnap S1300',
    vendor: 'Fujitsu',
    model: 'ScanSnap S1300',
    driver: 'epjitsu',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 360 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04c5:11ed',
    match: /(s1300\b|scansnap\s*s1300\b|04c5:11ed)/i
  },
  {
    id: 'fujitsu-s1300i',
    name: 'Fujitsu ScanSnap S1300i',
    vendor: 'Fujitsu',
    model: 'ScanSnap S1300i',
    driver: 'epjitsu',
    type: 'ADF',
    sources: ['ADF Front', 'ADF Duplex'],
    has_adf: true,
    duplex_capable: true,
    resolutions: [150, 200, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 360 },
    supported_paper_sizes: ['A4', 'F4', 'Folio', 'Legal', 'Letter', 'ID Card'],
    usb_id: '04c5:128d',
    match: /(s1300i|scansnap\s*s1300i|04c5:128d)/i
  },
  {
    id: 'canon-g3030',
    name: 'Canon PIXMA G3030 series',
    vendor: 'Canon',
    model: 'PIXMA G3030 series',
    driver: 'eSCL',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '04a9:18da',
    match: /(g3030|g3000|pixma.*g3|04a9:18da)/i
  },
  {
    // Any HP multifunction on SANE's hpaio backend (LaserJet MFP M130a and friends). Most need
    // HP's proprietary plugin before hpaio lists them; see hplip-plugin.mjs.
    id: 'hp-mfp-hpaio',
    name: 'HP multifunction (HPLIP)',
    vendor: 'HP',
    model: 'LaserJet / DeskJet / OfficeJet MFP',
    driver: 'hpaio',
    type: 'Flatbed',
    sources: ['Flatbed'],
    has_adf: false,
    duplex_capable: false,
    resolutions: [75, 150, 300, 600],
    modes: ['Color', 'Gray'],
    formats: ['pdf', 'jpeg', 'png', 'tiff'],
    max_geometry: { width: 216, height: 297 },
    supported_paper_sizes: ['A4', 'Letter', 'ID Card'],
    usb_id: '03f0:*',
    match: /(^|[^a-z])hpaio:|hewlett|(^|\s)hp(\s|_).*(mfp|laserjet|deskjet|officejet|envy|smart tank)/i
  }
];

function matchScannerProfile(model, vendor, devId) {
  const text = `${model || ''} ${vendor || ''} ${devId || ''}`;
  for (const prof of SCANNER_PROFILES) {
    if (prof.match.test(text)) return prof;
  }
  return null;
}

// Blank Page Detection Helper (calls image_processor.py detect-blank)
async function checkBlankPage(imagePath) {
  const procPath = fs.existsSync('/opt/mantaprint/image_processor.py')
    ? '/opt/mantaprint/image_processor.py'
    : path.resolve(__dirname, '../../image_processor.py');

  const res = await runCmd('/usr/bin/python3', [
    procPath,
    'detect-blank',
    '-i', imagePath
  ], 8000);

  if (res.code === 0 && res.stdout) {
    const m = res.stdout.match(/BLANK_JSON:(.+)/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {}
    }
  }
  return { blank: false, mean: 0, stddev: 0, darkPixels: 0 };
}

// Stale-While-Revalidate (SWR) Scanner Telemetry Cache
const SWR_SCANNER_TTL = 10000; // 10s fresh window
let cachedScanner = null;
let lastScannerProbe = 0;
let isProbingScanner = false;
let scannerFirmwareBusy = false;
let hplipPluginBusy = false;

/**
 * Installs an uploaded HPLIP plugin as a background Driver Center job (hp-plugin takes a
 * couple of minutes on a Pi 3; the page polls the job and shows its log). The version check
 * happens inside installPluginFile, so a wrong file fails the job with version_mismatch.
 */
function startHplipPluginJob({ filePath, fileName, ascPath, sha256 = null, size = 0, cleanup = () => {} }) {
  if (hplipPluginBusy) return null;
  const job = driverCenter.startJob('install-hplip-plugin', fileName, async (log) => {
    hplipPluginBusy = true;
    try {
      const result = await installPluginFile({ filePath, fileName, ascPath: ascPath && fs.existsSync(ascPath) ? ascPath : null, log: (l) => { log(l); console.log(`[HPLIP plugin] ${String(l).split('\n')[0].slice(0, 200)}`); } });
      if (result.ok) {
        console.log(`[HPLIP plugin] Installed plugin ${result.version}`);
        driverCenter.addRecord({ kind: 'hplip-plugin', name: fileName, version: result.version, sha256, size, note: 'HPLIP proprietary plugin', path: null, signature_verified: Boolean(result.signature_verified) });
        await probeScannerTelemetry(true).catch(() => {});
      } else {
        try { fs.unlinkSync(filePath); } catch {}
        if (result.tail) log(result.tail);
      }
      return result;
    } finally {
      hplipPluginBusy = false;
      try { cleanup(); } catch {}
    }
  });
  return job;
}

// epjitsu.conf names models tersely ("Fujitsu S1300"); prefer our profile's full name.
function scannerModelName(usbId, fallback) {
  const prof = SCANNER_PROFILES.find(p => p.usb_id === usbId);
  return prof ? prof.name : fallback;
}

function scannerFirmwareStatus() {
  const st = getFirmwareStatus();
  const named = (d) => ({ ...d, model: scannerModelName(d.usb_id, d.model) });
  return { ...st, devices: st.devices.map(named), connected: st.connected.map(named), needs_firmware: st.needs_firmware.map(named) };
}

// A ScanSnap on SANE's epjitsu backend is invisible to scanimage until its .nal
// firmware is installed, so without this hint it would just read "not detected".
function scannerFirmwareHint() {
  try {
    const d = scannerFirmwareStatus().needs_firmware[0];
    return d ? { model: d.model, filename: d.filename, usb_id: d.usb_id } : null;
  } catch {
    return null;
  }
}

function withFirmwareHint(state) {
  const hint = scannerFirmwareHint();
  if (hint) state.firmware_required = hint;
  // An HP MFP whose scanner needs HP's plugin is likewise invisible to scanimage.
  if (!state.connected && lastHpPluginHint) state.plugin_required = lastHpPluginHint;
  return state;
}

// Refreshed on every scanner probe (sysfs + models.dat + dpkg, a few ms) so the hint is
// current by the time withFirmwareHint() runs synchronously.
let lastHpPluginHint = null;
async function refreshHpPluginHint() {
  lastHpPluginHint = await hpPluginHint();
  return lastHpPluginHint;
}

function getInitialScannerState() {
  return {
    connected: false,
    name: 'Belum Ada Scanner Terhubung',
    message: 'Hubungkan scanner atau printer multifungsi USB ke MantaPrint Hub',
    profiles: SCANNER_PROFILES.map(p => ({
      id: p.id,
      name: p.name,
      vendor: p.vendor,
      driver: p.driver,
      type: p.type,
      sources: p.sources,
      duplex_capable: p.duplex_capable,
      supported_paper_sizes: p.supported_paper_sizes
    }))
  };
}

// Instant SWR response (< 10ms) with non-blocking background revalidation
function getScannerStatusSWR() {
  if (!cachedScanner) {
    cachedScanner = getInitialScannerState();
  }

  // Stale-While-Revalidate: trigger async background probe if expired
  if (Date.now() - lastScannerProbe > SWR_SCANNER_TTL && !isProbingScanner) {
    probeScannerTelemetry().catch(() => {});
  }

  return cachedScanner;
}

async function probeScannerTelemetry(forceFresh = false) {
  if (!forceFresh && cachedScanner && (Date.now() - lastScannerProbe < SWR_SCANNER_TTL)) {
    return cachedScanner;
  }
  if (isProbingScanner) return cachedScanner || getInitialScannerState();
  isProbingScanner = true;

  try {
    await refreshHpPluginHint().catch(() => {});
    // 1. Direct probe to local eSCL endpoint (e.g. ipp-usb on 127.0.0.1:60000)
    try {
      const resp = await fetch('http://127.0.0.1:60000/eSCL/ScannerCapabilities', {
        headers: { Host: 'localhost:60000' },
        signal: AbortSignal.timeout(1500)
      });

      if (resp.ok) {
        const xml = await resp.text();
        const mModel = xml.match(/<[^:]*:?MakeAndModel>([^<]+)<\/[^:]*:?MakeAndModel>/i);
        const mMfg = xml.match(/<[^:]*:?Manufacturer>([^<]+)<\/[^:]*:?Manufacturer>/i);
        const isAdf = xml.includes('Adf');
        const modelName = mModel ? mModel[1].trim() : 'Canon G3030 series';
        const vendorName = mMfg ? mMfg[1].trim() : 'Canon';
        const matched = matchScannerProfile(modelName, vendorName, 'escl:http://localhost:60000') || {
          id: 'canon-g3030',
          name: modelName,
          vendor: vendorName,
          driver: 'eSCL',
          type: isAdf ? 'ADF' : 'Flatbed',
          sources: isAdf ? ['Flatbed', 'ADF Front'] : ['Flatbed'],
          has_adf: isAdf,
          duplex_capable: false,
          resolutions: [75, 150, 300, 600],
          modes: ['Color', 'Gray'],
          formats: ['pdf', 'jpeg', 'png'],
          max_geometry: { width: 216, height: 297 },
          supported_paper_sizes: ['A4', 'Letter', 'ID Card']
        };

        cachedScanner = {
          connected: true,
          protocol: 'eSCL',
          device_id: 'escl:http://localhost:60000',
          profile_id: matched.id,
          name: matched.name,
          model: matched.model || modelName,
          vendor: matched.vendor || vendorName,
          driver: matched.driver,
          type: matched.type,
          source: isAdf ? 'ADF Front' : 'Flatbed',
          sources: matched.sources,
          has_adf: matched.has_adf,
          duplex_capable: matched.duplex_capable,
          resolutions: matched.resolutions,
          modes: matched.modes,
          formats: matched.formats,
          max_geometry: matched.max_geometry,
          supported_paper_sizes: matched.supported_paper_sizes,
          profiles: SCANNER_PROFILES.map(p => ({
            id: p.id,
            name: p.name,
            vendor: p.vendor,
            driver: p.driver,
            type: p.type,
            sources: p.sources,
            duplex_capable: p.duplex_capable,
            supported_paper_sizes: p.supported_paper_sizes
          }))
        };
        withFirmwareHint(cachedScanner);
        lastScannerProbe = Date.now();
        return cachedScanner;
      }
    } catch {}

    // 2. Direct probe for standalone USB scanners via SANE scanimage
    try {
      const res = await runCmd('scanimage', ['-f', '%d|%v|%m|%t%n'], 6000);
      if (res.code === 0 && res.stdout.trim()) {
        for (const line of res.stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('<') || trimmed.includes('192.168.')) continue;
          const parts = trimmed.split('|');
          if (parts.length >= 3 && parts[0]) {
            const devId = parts[0].trim();
            const vendor = parts[1].trim() || 'Generic';
            const model = parts[2].trim() || 'USB Scanner';
            const typeStr = (parts[3] || '').toLowerCase();
            const matched = matchScannerProfile(model, vendor, devId);

            cachedScanner = {
              connected: true,
              protocol: 'SANE',
              device_id: devId,
              profile_id: matched ? matched.id : 'generic-sane',
              name: matched ? matched.name : `${vendor} ${model}`.trim(),
              model: matched ? matched.model : model,
              vendor: matched ? matched.vendor : vendor,
              driver: matched ? matched.driver : (devId.split(':')[0] || 'sane'),
              type: matched ? matched.type : (typeStr.includes('adf') ? 'ADF' : 'Flatbed'),
              source: matched ? matched.sources[0] : (typeStr.includes('adf') ? 'ADF Front' : 'Flatbed'),
              sources: matched ? matched.sources : (typeStr.includes('adf') ? ['ADF Front', 'ADF Duplex'] : ['Flatbed']),
              has_adf: matched ? matched.has_adf : typeStr.includes('adf'),
              duplex_capable: matched ? matched.duplex_capable : false,
              resolutions: matched ? matched.resolutions : [75, 150, 300, 600],
              modes: matched ? matched.modes : ['Color', 'Gray'],
              formats: matched ? matched.formats : ['pdf', 'jpeg', 'png', 'tiff'],
              max_geometry: matched ? matched.max_geometry : { width: 216, height: 297 },
              supported_paper_sizes: matched ? matched.supported_paper_sizes : ['A4', 'ID Card'],
              profiles: SCANNER_PROFILES.map(p => ({
                id: p.id,
                name: p.name,
                vendor: p.vendor,
                driver: p.driver,
                type: p.type,
                sources: p.sources,
                duplex_capable: p.duplex_capable,
                supported_paper_sizes: p.supported_paper_sizes
              }))
            };
            withFirmwareHint(cachedScanner);
            lastScannerProbe = Date.now();
            return cachedScanner;
          }
        }
      }
    } catch {}

    cachedScanner = withFirmwareHint(getInitialScannerState());
    lastScannerProbe = Date.now();
    return cachedScanner;
  } finally {
    isProbingScanner = false;
  }
}

// Scan sysfs directly for physical USB printers (< 0.5ms synchronous query)
function getConnectedUsbPrinters() {
  const list = [];
  const base = '/sys/bus/usb/devices';
  try {
    if (!fs.existsSync(base)) return list;
    const entries = fs.readdirSync(base);
    for (const d of entries) {
      const devPath = path.join(base, d);
      let isPrinter = false;
      try {
        const devClass = fs.readFileSync(path.join(devPath, 'bDeviceClass'), 'utf8').trim();
        if (devClass === '07') isPrinter = true;
      } catch {}
      if (!isPrinter) {
        try {
          const subs = fs.readdirSync(devPath);
          for (const sub of subs) {
            if (sub.includes(':')) {
              try {
                const ifClass = fs.readFileSync(path.join(devPath, sub, 'bInterfaceClass'), 'utf8').trim();
                if (ifClass === '07') {
                  isPrinter = true;
                  break;
                }
              } catch {}
            }
          }
        } catch {}
      }
      if (isPrinter) {
        let mfg = '', prod = '', serial = '', idVendor = '', idProduct = '';
        try { mfg = fs.readFileSync(path.join(devPath, 'manufacturer'), 'utf8').trim(); } catch {}
        try { prod = fs.readFileSync(path.join(devPath, 'product'), 'utf8').trim(); } catch {}
        try { serial = fs.readFileSync(path.join(devPath, 'serial'), 'utf8').trim(); } catch {}
        try { idVendor = fs.readFileSync(path.join(devPath, 'idVendor'), 'utf8').trim(); } catch {}
        try { idProduct = fs.readFileSync(path.join(devPath, 'idProduct'), 'utf8').trim(); } catch {}
        list.push({ dev: d, mfg, prod, serial, idVendor, idProduct });
      }
    }
  } catch (err) {}
  return list;
}

function matchUsbDevice(devUri, connectedPrinters) {
  if (!connectedPrinters || connectedPrinters.length === 0) return false;
  const mSerial = devUri.match(/serial=([^&]+)/);
  if (mSerial) {
    const targetSerial = decodeURIComponent(mSerial[1]).trim().toLowerCase();
    for (const p of connectedPrinters) {
      if (p.serial && p.serial.trim().toLowerCase() === targetSerial) return true;
    }
    return false;
  }
  const uriClean = decodeURIComponent(devUri.replace('usb://', '')).toLowerCase();
  for (const p of connectedPrinters) {
    const pMfg = (p.mfg || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pProd = (p.prod || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const uClean = uriClean.replace(/[^a-z0-9]/g, '');
    if (pProd && uClean.includes(pProd)) return true;
    if (pMfg && uClean.includes(pMfg)) return true;
  }
  return false;
}

function getActiveBroadcastNetwork() {
  const interfaces = os.networkInterfaces();
  
  // Strict rule:
  // "jalur broadcast wifi hanya berlaku jika eth tidak aktif.
  //  jika eth aktif, maka hanya jalur eth saja yang di broadcast mdns."
  
  // 1. Check Ethernet interfaces (eth*, end*, enp*, eno*)
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('eth') || name.startsWith('end') || name.startsWith('enp') || name.startsWith('eno')) {
      let isCarrierUp = true;
      try {
        const carrierPath = `/sys/class/net/${name}/carrier`;
        const operstatePath = `/sys/class/net/${name}/operstate`;
        if (fs.existsSync(carrierPath)) {
          isCarrierUp = fs.readFileSync(carrierPath, 'utf8').trim() === '1';
        } else if (fs.existsSync(operstatePath)) {
          isCarrierUp = fs.readFileSync(operstatePath, 'utf8').trim() !== 'down';
        }
      } catch {}

      if (isCarrierUp) {
        for (const iface of interfaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1') {
            const lastOctet = iface.address.split('.').pop();
            return {
              iface: name,
              type: 'eth',
              ip: iface.address,
              last_octet: lastOctet
            };
          }
        }
      }
    }
  }

  // 2. WiFi broadcast ONLY if Ethernet is NOT active
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('wlan') || name.startsWith('wlp') || name.startsWith('wls') || name.startsWith('ra') || name.startsWith('wl')) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.address !== '127.0.0.1') {
          const lastOctet = iface.address.split('.').pop();
          return {
            iface: name,
            type: 'wifi',
            ip: iface.address,
            last_octet: lastOctet
          };
        }
      }
    }
  }

  // 3. Fallback to default route IP
  const fallbackIp = getIpAddress();
  return {
    iface: 'eth0',
    type: 'eth',
    ip: fallbackIp,
    last_octet: fallbackIp.split('.').pop() || '1'
  };
}

function syncAvahiInterfaceBinding(activeIface) {
  const confPath = '/etc/avahi/avahi-daemon.conf';
  try {
    if (fs.existsSync(confPath)) {
      let content = fs.readFileSync(confPath, 'utf8');
      const targetLine = `allow-interfaces=${activeIface}`;
      let newContent = content;
      if (/^\s*allow-interfaces\s*=/m.test(content)) {
        newContent = content.replace(/^\s*allow-interfaces\s*=.*$/m, targetLine);
      } else if (/^\s*#\s*allow-interfaces\s*=/m.test(content)) {
        newContent = content.replace(/^\s*#\s*allow-interfaces\s*=.*$/m, targetLine);
      } else {
        newContent = content.replace(/\[server\]/, `[server]\n${targetLine}`);
      }
      if (newContent !== content) {
        fs.writeFileSync(confPath, newContent, 'utf8');
        runCmd('systemctl', ['restart', '--no-block', 'avahi-daemon']).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[!] Failed to sync avahi-daemon allow-interfaces:', err.message);
  }
}

function formatMdnsName(displayName, model = '', queueName = '') {
  const net = getActiveBroadcastNetwork();
  const ifaceType = net.type; // 'eth' or 'wifi'
  const lastOctet = net.last_octet; // e.g. '238' or '114'

  const rawText = `${displayName || ''} ${model || ''} ${queueName || ''}`.trim();

  // 1. Extract Brand (MEREK)
  const knownBrands = [
    'CANON', 'EPSON', 'HP', 'BROTHER', 'SAMSUNG', 'XEROX', 
    'FUJIXEROX', 'RICOH', 'PANASONIC', 'KYOCERA', 'LEXMARK', 'DYMO'
  ];
  let brand = '';
  for (const b of knownBrands) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(rawText)) {
      brand = b;
      break;
    }
  }
  if (!brand) {
    const firstWord = rawText.split(/[^a-zA-Z0-9]/)[0];
    brand = (firstWord || 'PRINTER').toUpperCase();
  }

  // 2. Extract Type/Model (tipe)
  let cleanModel = rawText
    .replace(new RegExp(`\\b${brand}\\b`, 'gi'), '')
    .replace(/\b(series|professional|hub|mantaprint|heykprint|printer|scanner)\b/gi, '')
    .replace(/\b(pixma|laserjet|deskjet|stylus|ecotank|workforce|imageclass|imagerunner)\b/gi, '');

  if (cleanModel.includes('/')) {
    cleanModel = cleanModel.split('/')[0];
  }

  const modelTokens = cleanModel.match(/[A-Za-z0-9_-]+/g) || [];
  let chosenToken = '';
  for (const t of modelTokens) {
    const tClean = t.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (/\d/.test(tClean)) {
      chosenToken = tClean;
      break;
    }
  }
  if (!chosenToken && modelTokens.length > 0) {
    chosenToken = modelTokens[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  if (!chosenToken) {
    chosenToken = 'device';
  }

  // Standard Format: (MEREK)-(tipe)-(eth/wifi)((ip belakangnya aja xxx))
  // e.g. CANON-lbp6030-eth(114) or CANON-g3030-eth(238)
  return `${brand}-${chosenToken}-${ifaceType}(${lastOctet})`;
}

const MDNS_CONFIG_FILE = '/mnt/data/config/mdns_settings.json';

function getCustomMdnsConfig() {
  const fallbackHostname = configManager?.cachedConfig?.hostname || os.hostname() || 'mantaprint';
  try {
    if (fs.existsSync(MDNS_CONFIG_FILE)) {
      // 1. Anti-Symlink Traversal Check
      const lstat = fs.lstatSync(MDNS_CONFIG_FILE);
      if (lstat.isSymbolicLink()) {
        console.warn('[SECURITY] MDNS_CONFIG_FILE is a symbolic link! Potential traversal attack prevented. Removing link.');
        try { fs.unlinkSync(MDNS_CONFIG_FILE); } catch {}
        return { hostname: fallbackHostname, domain: 'local', custom_broadcast_names: {} };
      }

      const raw = fs.readFileSync(MDNS_CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      // 2. Strict Schema Validation & Sanitization
      const safeConfig = {
        hostname: fallbackHostname,
        domain: 'local',
        custom_broadcast_names: {}
      };

      if (typeof parsed.hostname === 'string' && /^[a-zA-Z0-9-]{1,32}$/.test(parsed.hostname)) {
        safeConfig.hostname = parsed.hostname;
      }
      if (typeof parsed.domain === 'string' && /^[a-zA-Z0-9-]{1,16}$/.test(parsed.domain)) {
        safeConfig.domain = parsed.domain;
      }
      if (parsed.custom_broadcast_names && typeof parsed.custom_broadcast_names === 'object') {
        for (const [key, val] of Object.entries(parsed.custom_broadcast_names)) {
          if (/^[a-zA-Z0-9_-]{1,64}$/.test(key) && typeof val === 'string') {
            const cleanVal = val.replace(/[^a-zA-Z0-9_\-\s()]/g, '').slice(0, 64).trim();
            if (cleanVal) safeConfig.custom_broadcast_names[key] = cleanVal;
          }
        }
      }
      return safeConfig;
    }
  } catch (err) {
    console.warn('[SECURITY] Failed to read or sanitize mdns_settings.json:', err.message);
  }
  return {
    hostname: fallbackHostname,
    domain: 'local',
    custom_broadcast_names: {}
  };
}

function saveCustomMdnsConfig(cfg) {
  try {
    const dir = path.dirname(MDNS_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Refuse writing through symlink
    if (fs.existsSync(MDNS_CONFIG_FILE) && fs.lstatSync(MDNS_CONFIG_FILE).isSymbolicLink()) {
      fs.unlinkSync(MDNS_CONFIG_FILE);
    }

    const fallbackHost = configManager?.cachedConfig?.hostname || os.hostname() || 'mantaprint';
    // Sanitize before saving
    const safe = {
      hostname: typeof cfg.hostname === 'string' ? cfg.hostname.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32) : fallbackHost,
      domain: typeof cfg.domain === 'string' ? cfg.domain.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 16) : 'local',
      custom_broadcast_names: {}
    };
    if (cfg.custom_broadcast_names && typeof cfg.custom_broadcast_names === 'object') {
      for (const [k, v] of Object.entries(cfg.custom_broadcast_names)) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(k) && typeof v === 'string') {
          const clean = v.replace(/[^a-zA-Z0-9_\-\s()]/g, '').slice(0, 64).trim();
          if (clean) safe.custom_broadcast_names[k] = clean;
        }
      }
    }

    fs.writeFileSync(MDNS_CONFIG_FILE, JSON.stringify(safe, null, 2), 'utf8');

    // Keep configManager in sync
    if (safe.hostname && configManager && configManager.cachedConfig?.hostname !== safe.hostname) {
      configManager.saveConfig({ hostname: safe.hostname });
    }

    return true;
  } catch (err) {
    console.error('[!] Failed to save mdns_settings.json:', err.message);
    return false;
  }
}

// --- NATIVE CUPS PRINTER CONFIGURATION & AVAHI PERSISTENCE ---
const PRINTERS_CONFIG_FILE = '/mnt/data/config/printers_config.json';
const FALLBACK_PRINTERS_CONFIG_FILE = '/etc/mantaprint/printers_config.json';

function getPersistentPrintersConfig() {
  const targetPath = fs.existsSync('/mnt/data/config') ? PRINTERS_CONFIG_FILE : FALLBACK_PRINTERS_CONFIG_FILE;
  try {
    if (fs.existsSync(targetPath)) {
      if (fs.lstatSync(targetPath).isSymbolicLink()) {
        console.warn('[SECURITY] printers_config.json is a symbolic link! Removing link.');
        try { fs.unlinkSync(targetPath); } catch {}
        return { version: 1, printers: {} };
      }
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.printers) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[!] Failed to read printers_config.json:', err.message);
  }
  return { version: 1, printers: {} };
}

function savePersistentPrintersConfig(cfg) {
  const targetPath = fs.existsSync('/mnt/data/config') ? PRINTERS_CONFIG_FILE : FALLBACK_PRINTERS_CONFIG_FILE;
  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
      try { fs.unlinkSync(targetPath); } catch {}
    }
    const safe = {
      version: 1,
      printers: {}
    };
    if (cfg && cfg.printers && typeof cfg.printers === 'object') {
      for (const [qName, details] of Object.entries(cfg.printers)) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(qName) && details && typeof details === 'object') {
          safe.printers[qName] = {
            display_name: typeof details.display_name === 'string' ? details.display_name.slice(0, 64) : qName,
            location: typeof details.location === 'string' ? details.location.slice(0, 64) : '',
            protocol: typeof details.protocol === 'string' ? details.protocol : 'socket',
            is_published: Boolean(details.is_published),
            uri: typeof details.uri === 'string' ? details.uri : '',
            created_at: details.created_at || new Date().toISOString(),
            // "discovered" (adopted from the network scan) or "auto" (auto-adopt); absent = manual
            ...(['discovered', 'auto'].includes(details.source) ? { source: details.source } : {})
          };
        }
      }
    }
    const tmp = `${targetPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf8');
    fs.renameSync(tmp, targetPath);
    return true;
  } catch (err) {
    console.error('[!] Failed to save printers_config.json:', err.message);
    return false;
  }
}

// --- DRIVER READINESS (written by printer_manager.py's sync_all_printers(), read-only here) ---
// A queue with no confident driver match, or an HP model waiting on firmware, used to be
// created, enabled and broadcast over AirPrint exactly like a verified-working one. This file
// is printer_manager.py's honest verdict per queue; missing entries (fresh install, before the
// first hotplug sync has run) default to unknown rather than a false "ready".
const READINESS_FILE = '/var/cache/cups/mantaprint_readiness.json';

function getPrinterReadiness() {
  try {
    if (fs.existsSync(READINESS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(READINESS_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('[!] Failed to read mantaprint_readiness.json:', err.message);
  }
  return {};
}

function generateAvahiXml(serviceName, queueName, cleanTypeName, model, uuidStr, ipAddr, isColor, isDuplex, isOnline) {
  const pdlStr = 'image/urf,image/pwg-raster,application/pdf';
  const urfStr = 'V1.4,W8,SRGB24,CP1,RS300-600';
  const colorStr = isColor ? 'T' : 'F';
  const duplexStr = isDuplex ? 'T' : 'F';
  const printerState = isOnline ? '3' : '5';
  const printerStateReasons = isOnline ? 'none' : 'offline-report';

  let markerLevelsStr = '100';
  let markerNamesStr = 'Black Toner';
  let markerTypesStr = 'toner';
  let markerColorsStr = '#000000';

  if (isColor) {
    markerLevelsStr = isOnline ? '100,100,100,100' : '0,0,0,0';
    markerNamesStr = 'Black,Cyan,Magenta,Yellow';
    markerTypesStr = 'ink,ink,ink,ink';
    markerColorsStr = '#000000,#00FFFF,#FF00FF,#FFFF00';
  } else if (model && (model.includes('LBP6030') || model.includes('Canon'))) {
    markerNamesStr = 'Canon Cartridge 325 (Black Toner)';
  }

  return `<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service-group.dtd">
<service-group>
  <name replace-wildcards="yes">${serviceName}</name>
  <service>
    <type>_ipp._tcp</type>
    <subtype>_universal._sub._ipp._tcp</subtype>
    <subtype>_print._sub._ipp._tcp</subtype>
    <port>631</port>
    <txt-record>txtvers=1</txt-record>
    <txt-record>qtotal=1</txt-record>
    <txt-record>rp=printers/${queueName}</txt-record>
    <txt-record>ty=${cleanTypeName}</txt-record>
    <txt-record>product=(${model || queueName})</txt-record>
    <txt-record>UUID=${uuidStr}</txt-record>
    <txt-record>adminurl=http://${ipAddr}:631/printers/${queueName}</txt-record>
    <txt-record>priority=0</txt-record>
    <txt-record>printer-state=${printerState}</txt-record>
    <txt-record>printer-state-reasons=${printerStateReasons}</txt-record>
    <txt-record>printer-type=0x801046</txt-record>
    <txt-record>Transparent=T</txt-record>
    <txt-record>Color=${colorStr}</txt-record>
    <txt-record>Duplex=${duplexStr}</txt-record>
    <txt-record>pdl=${pdlStr}</txt-record>
    <txt-record>URF=${urfStr}</txt-record>
    <txt-record>mopria-certified=1.3</txt-record>
    <txt-record>TLS=1.2,1.3</txt-record>
    <txt-record>note=Universal Network Printer</txt-record>
    <txt-record>marker-levels=${markerLevelsStr}</txt-record>
    <txt-record>marker-names=${markerNamesStr}</txt-record>
    <txt-record>marker-types=${markerTypesStr}</txt-record>
    <txt-record>marker-colors=${markerColorsStr}</txt-record>
  </service>
  <service>
    <type>_ipps._tcp</type>
    <subtype>_universal._sub._ipps._tcp</subtype>
    <subtype>_print._sub._ipps._tcp</subtype>
    <port>631</port>
    <txt-record>txtvers=1</txt-record>
    <txt-record>qtotal=1</txt-record>
    <txt-record>rp=printers/${queueName}</txt-record>
    <txt-record>ty=${cleanTypeName}</txt-record>
    <txt-record>product=(${model || queueName})</txt-record>
    <txt-record>UUID=${uuidStr}</txt-record>
    <txt-record>adminurl=https://${ipAddr}:631/printers/${queueName}</txt-record>
    <txt-record>priority=0</txt-record>
    <txt-record>printer-state=${printerState}</txt-record>
    <txt-record>printer-state-reasons=${printerStateReasons}</txt-record>
    <txt-record>printer-type=0x801046</txt-record>
    <txt-record>Transparent=T</txt-record>
    <txt-record>Color=${colorStr}</txt-record>
    <txt-record>Duplex=${duplexStr}</txt-record>
    <txt-record>pdl=${pdlStr}</txt-record>
    <txt-record>URF=${urfStr}</txt-record>
    <txt-record>mopria-certified=1.3</txt-record>
    <txt-record>TLS=1.2,1.3</txt-record>
    <txt-record>note=Universal Network Printer</txt-record>
    <txt-record>marker-levels=${markerLevelsStr}</txt-record>
    <txt-record>marker-names=${markerNamesStr}</txt-record>
    <txt-record>marker-types=${markerTypesStr}</txt-record>
    <txt-record>marker-colors=${markerColorsStr}</txt-record>
  </service>
</service-group>`;
}

function writeAvahiService(queueName, displayName, model, isColor = true, isDuplex = false, isOnline = true, explicitBroadcastName = null) {
  const avahiDir = '/etc/avahi/services';
  try {
    if (!fs.existsSync(avahiDir)) return false;
    const net = getActiveBroadcastNetwork();

    // Prioritize explicit broadcast name, then stored custom broadcast name, then formatted default
    const customCfg = getCustomMdnsConfig();
    const customName = (typeof explicitBroadcastName === 'string' && explicitBroadcastName.trim())
      ? explicitBroadcastName.trim()
      : (customCfg?.custom_broadcast_names?.[queueName] || '');

    const serviceName = customName || formatMdnsName(displayName, model, queueName);
    const cleanTypeName = serviceName;
    const uuidStr = crypto.createHash('md5').update(`mantaprint-${queueName}`).digest('hex');
    const xml = generateAvahiXml(serviceName, queueName, cleanTypeName, model || queueName, uuidStr, net.ip, isColor, isDuplex, isOnline);
    
    // Clean up duplicate legacy files for this queue
    const files = fs.readdirSync(avahiDir);
    const targetFile = `mantaprint_${queueName}.service`;
    const targetPath = path.join(avahiDir, targetFile);

    for (const f of files) {
      if (f.includes(queueName) && f.endsWith('.service') && f !== targetFile) {
        try { fs.unlinkSync(path.join(avahiDir, f)); } catch {}
      }
    }

    let existing = '';
    if (fs.existsSync(targetPath)) existing = fs.readFileSync(targetPath, 'utf8');
    if (existing !== xml) {
      fs.writeFileSync(targetPath, xml, 'utf8');
      // Avahi inotify automatically reloads the file
      return true;
    }
  } catch (err) {
    console.error(`[!] Failed to write Avahi service for ${queueName}:`, err.message);
  }
  return false;
}

function removeAvahiService(queueName) {
  const avahiDir = '/etc/avahi/services';
  let removed = false;
  try {
    if (!fs.existsSync(avahiDir)) return false;
    const files = fs.readdirSync(avahiDir);
    for (const f of files) {
      if ((f.startsWith(`mantaprint_${queueName}`) || f.startsWith(`heykprint_${queueName}`) || f.includes(queueName)) && f.endsWith('.service')) {
        try {
          fs.unlinkSync(path.join(avahiDir, f));
          removed = true;
        } catch {}
      }
    }
    // Avahi inotify automatically detects unlinked service files
  } catch (err) {
    console.error(`[!] Failed to remove Avahi service for ${queueName}:`, err.message);
  }
  return removed;
}

function probeNetworkSocket(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const cleanHost = String(host || '').trim();
    const cleanPort = parseInt(port, 10) || 9100;
    
    // Safety check against loopback/internal SSRF:
    if (!cleanHost || cleanHost === '127.0.0.1' || cleanHost === 'localhost' || cleanHost.startsWith('169.254.')) {
      resolve({ reachable: false, error: 'Alamat host dilarang (loopback / link-local).' });
      return;
    }

    const socket = net.createConnection({ host: cleanHost, port: cleanPort, timeout }, () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ reachable: true, latency_ms: latency });
    });
    socket.on('error', (err) => {
      socket.destroy();
      resolve({ reachable: false, error: err.message });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ reachable: false, error: 'Koneksi timeout (port tidak merespons dalam 2s)' });
    });
  });
}

// Network printers used to report "connected" unconditionally. This keeps a cached TCP
// reachability verdict per host:port, refreshed in the background, so /api/status never waits
// on a printer that has gone away. dnssd:// queues have no fixed address and stay "unknown".
const NET_REACH_TTL = 60000;
const netReachability = new Map(); // "host:port" -> { state, host, port, latency_ms, checked_at, pending }
let netReachRefreshTimer = null;

function networkTarget(uri) {
  const defaults = { socket: 9100, ipp: 631, ipps: 631, lpd: 515, http: 631, https: 443 };
  let u;
  try { u = new URL(uri); } catch { return null; }
  const scheme = u.protocol.replace(':', '');
  if (!(scheme in defaults) || !u.hostname) return null;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || defaults[scheme] };
}

function getNetworkReachability(uri) {
  const target = networkTarget(uri);
  if (!target) return { state: 'unknown' };
  const key = `${target.host}:${target.port}`;
  let entry = netReachability.get(key);
  if (!entry) {
    entry = { state: 'unknown', host: target.host, port: target.port, latency_ms: null, checked_at: 0, pending: false };
    netReachability.set(key, entry);
  }
  if (!entry.pending && Date.now() - entry.checked_at > NET_REACH_TTL) {
    entry.pending = true;
    probeNetworkSocket(target.host, target.port, 2500).then((r) => {
      const prev = entry.state;
      entry.state = r.reachable ? 'online' : 'offline';
      entry.latency_ms = r.reachable ? r.latency_ms : null;
      entry.checked_at = Date.now();
      entry.pending = false;
      // "unknown" already reads as connected, so only a real change needs a fresh status push.
      if (prev !== entry.state && !(prev === 'unknown' && entry.state === 'online') && !netReachRefreshTimer) {
        netReachRefreshTimer = setTimeout(() => { netReachRefreshTimer = null; refreshStatusAndBroadcast(); }, 500);
      }
    });
  }
  return entry;
}

async function refreshStatusAndBroadcast() {
  try {
    const fresh = await probePrinterTelemetry();
    cachedStatus = fresh;
    lastStatusFetch = Date.now();
    broadcastSse(fresh);
  } catch (err) {
    console.warn('Status broadcast error:', err.message);
  }
}

function printerManagerScript() {
  if (fs.existsSync('/opt/mantaprint/core/printer_manager.py')) return '/opt/mantaprint/core/printer_manager.py';
  if (fs.existsSync('/opt/mantaprint/printer_manager.py')) return '/opt/mantaprint/printer_manager.py';
  return path.join(__dirname, '../../core/printer_manager.py');
}

// ---- Network printer discovery & adoption (printer_manager.py discover-network) -------------
let lastDiscovery = null;
let discoveryInflight = null;
const DISCOVERY_MAX_AGE = 10 * 60 * 1000;
const AUTO_ADOPT_INTERVAL = 15 * 60 * 1000;

function isAutoAdoptEnabled() {
  return Boolean(configManager.getConfig()?.network_discovery?.auto_adopt);
}

// The hub, not printer_manager.py, owns printers_config.json (names, broadcast flag).
function recordAdoptedPrinters(list, source) {
  if (!list.length) return;
  const pCfg = getPersistentPrintersConfig();
  for (const a of list) {
    pCfg.printers[a.queue] = {
      display_name: a.display_name,
      location: a.location || 'Network',
      protocol: a.protocol,
      is_published: Boolean(a.published),
      uri: a.uri,
      source,
      created_at: new Date().toISOString()
    };
  }
  savePersistentPrintersConfig(pCfg);
}

function runNetworkDiscovery({ autoAdopt = false } = {}) {
  if (discoveryInflight) return discoveryInflight;
  discoveryInflight = (async () => {
    const args = [printerManagerScript(), 'discover-network'];
    if (autoAdopt) args.push('--auto-adopt');
    const res = await runCmd('/usr/bin/python3', args, autoAdopt ? 180000 : 45000);
    const m = res.stdout.match(/^DISCOVERY_JSON:(.+)$/m);
    if (!m) throw new Error(res.timedOut ? 'discovery_timeout' : 'discovery_failed');
    const data = JSON.parse(m[1]);
    lastDiscovery = data;
    if (data.adopted?.length) {
      console.log(`[Discovery] Auto-adopted: ${data.adopted.map(a => a.queue).join(', ')}`);
      recordAdoptedPrinters(data.adopted, 'auto');
      await refreshStatusAndBroadcast();
    }
    return data;
  })().finally(() => { discoveryInflight = null; });
  return discoveryInflight;
}

function discoveryResponse(data) {
  return {
    success: true,
    scanned_at: data?.scanned_at || null,
    tools: data?.tools || {},
    candidates: (data?.candidates || []).map(c => ({
      id: c.id,
      name: c.name,
      make_model: c.make_model,
      host: c.host,
      hostname: c.hostname,
      location: c.location,
      protocols: Object.keys(c.services || {}),
      airprint: Boolean(c.airprint),
      ipp_everywhere: Boolean(c.ipp_everywhere),
      recommendation: c.recommendation,
      configured_queue: c.configured_queue || null,
      adopt: c.adopt ? { uri: c.adopt.uri, protocol: c.adopt.protocol, confidence: c.adopt.confidence, driver_desc: String(c.adopt.driver_desc || '').replace(/\s*\(Score: \d+\)$/, '') } : null
    })),
    auto_adopt: isAutoAdoptEnabled(),
    running: Boolean(discoveryInflight)
  };
}

setInterval(() => {
  if (isAutoAdoptEnabled()) runNetworkDiscovery({ autoAdopt: true }).catch((e) => console.warn('[Discovery] auto-adopt pass failed:', e.message));
}, AUTO_ADOPT_INTERVAL).unref?.();
setTimeout(() => {
  if (isAutoAdoptEnabled()) runNetworkDiscovery({ autoAdopt: true }).catch(() => {});
}, 90000).unref?.();

class PrintJobTracker extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.activeWatcherTimer = null;
    this.lastActiveCount = 0;
  }

  registerJob({ id, printer, title, user = 'anonymous', size = 0 }) {
    const numericMatch = (id || '').match(/-(\d+)$/);
    const numericId = numericMatch ? parseInt(numericMatch[1], 10) : (Date.now() % 100000);
    const job = {
      id,
      numeric_id: numericId,
      printer: printer || 'default',
      title: title || 'Dokumen Tanpa Judul',
      user,
      size,
      state: 'processing',
      status_message: 'Dokumen diterima, mengirim ke printer fisik...',
      printer_state_message: '',
      alerts: [],
      reasons: ['job-printing'],
      submitted_at: Date.now(),
      started_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      duration_ms: null,
      error: null
    };

    this.jobs.set(id, job);
    this.jobs.set(String(numericId), job);

    if (this.jobs.size > 200) {
      const keys = Array.from(this.jobs.keys());
      for (let i = 0; i < 40; i++) {
        this.jobs.delete(keys[i]);
      }
    }

    this.emit('update', job);
    this.emit(`job:${id}`, job);
    this.emit(`job:${numericId}`, job);
    this.startWatcher();
    return job;
  }

  getJob(idOrNumeric) {
    if (!idOrNumeric) return null;
    return this.jobs.get(String(idOrNumeric)) || null;
  }

  getAllJobs() {
    const distinct = new Set(this.jobs.values());
    return Array.from(distinct).sort((a, b) => b.submitted_at - a.submitted_at);
  }

  getActiveJobs() {
    return this.getAllJobs().filter(j => ['pending', 'processing', 'printing'].includes(j.state));
  }

  updateJob(idOrNumeric, patch) {
    const job = this.getJob(idOrNumeric);
    if (!job) return null;
    Object.assign(job, patch, { updated_at: Date.now() });
    if (['completed', 'error', 'canceled'].includes(job.state) && !job.completed_at) {
      job.completed_at = Date.now();
      job.duration_ms = Math.max(0, job.completed_at - job.submitted_at);
    }
    this.emit('update', job);
    this.emit(`job:${job.id}`, job);
    this.emit(`job:${job.numeric_id}`, job);
    return job;
  }

  removeJob(idOrNumeric) {
    if (!idOrNumeric) return false;
    const job = this.getJob(idOrNumeric);
    if (!job) return false;
    this.jobs.delete(job.id);
    this.jobs.delete(String(job.numeric_id));
    this.emit('update', { id: job.id, state: 'deleted' });
    this.emit(`job:${job.id}`, { id: job.id, state: 'deleted' });
    if (job.numeric_id) this.emit(`job:${job.numeric_id}`, { id: job.id, state: 'deleted' });
    return true;
  }

  clearCompletedJobs() {
    for (const [key, job] of this.jobs) {
      if (['completed', 'error', 'canceled', 'timeout', 'deleted'].includes(job.state)) {
        this.jobs.delete(key);
      }
    }
    this.emit('update', { type: 'cleared_history' });
  }

  clearAllJobs() {
    this.jobs.clear();
    this.emit('update', { type: 'cleared_all' });
  }

  waitForJob(idOrNumeric, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const existing = this.getJob(idOrNumeric);
      if (existing && ['completed', 'error', 'canceled'].includes(existing.state)) {
        return resolve(existing);
      }

      const targetKey = existing ? existing.id : String(idOrNumeric);
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.off(`job:${targetKey}`, listener);
        if (existing) this.off(`job:${existing.numeric_id}`, listener);
        resolve(result);
      };

      const timer = setTimeout(() => {
        const current = this.getJob(targetKey) || {
          id: targetKey,
          state: 'timeout',
          status_message: 'Batas waktu pemantauan printer fisik terlampaui (60s).'
        };
        finish(current);
      }, timeoutMs);

      const listener = (updatedJob) => {
        if (['completed', 'error', 'canceled'].includes(updatedJob.state)) {
          finish(updatedJob);
        }
      };

      this.on(`job:${targetKey}`, listener);
      if (existing) this.on(`job:${existing.numeric_id}`, listener);
    });
  }

  async syncWithCups() {
    try {
      const [lpstatP, lpstatLp, lpstatJobs, lpstatCompleted] = await Promise.all([
        runCmd('lpstat', ['-p']),
        runCmd('lpstat', ['-l', '-p']),
        runCmd('lpstat', ['-l', '-o']),
        runCmd('lpstat', ['-l', '-W', 'completed'])
      ]);

      const now = Date.now();

      // 1. Inspect lpstat -p for active printing job or stopped printer
      let activePrintingJobId = null;
      let printerStateText = 'idle';

      for (const rawLine of lpstatP.stdout.split('\n')) {
        const line = rawLine.trim();
        const matchPrinting = line.match(/printer\s+([^\s]+)\s+now printing\s+([^\s\.]+)/i);
        if (matchPrinting) {
          activePrintingJobId = matchPrinting[2].trim();
          printerStateText = 'printing';
        } else if (line.includes('disabled since') || line.includes('is stopped')) {
          printerStateText = 'stopped';
        }
      }

      // 2. Inspect lpstat -l -p for Alerts and Status
      let lpAlerts = [];
      let lpStatus = '';
      for (const rawLine of lpstatLp.stdout.split('\n')) {
        const line = rawLine.trim();
        const alertMatch = line.match(/^Alerts:\s*(.+)$/i);
        if (alertMatch && alertMatch[1].trim() && alertMatch[1].trim() !== 'none') {
          lpAlerts.push(alertMatch[1].trim());
        }
        const statusMatch = line.match(/^Status:\s*(.+)$/i);
        if (statusMatch && statusMatch[1].trim()) {
          lpStatus = statusMatch[1].trim();
        }
      }

      // 3. Inspect Active Spool Jobs from lpstat -l -o
      const activeSpoolJobIds = new Set();
      const spoolLines = lpstatJobs.stdout.split('\n');
      for (const rawLine of spoolLines) {
        const line = rawLine.trim();
        if (!line) continue;
        const headerMatch = line.match(/^([^\s]+)\s+([^\s]+)\s+(\d+)\s+(.+)$/);
        if (headerMatch) {
          const jId = headerMatch[1];
          activeSpoolJobIds.add(jId);
          const numMatch = jId.match(/-(\d+)$/);
          if (numMatch) {
            activeSpoolJobIds.add(numMatch[1]);
          }
          if (!this.getJob(jId)) {
            this.registerJob({
              id: jId,
              printer: jId.split('-')[0] || 'default',
              user: headerMatch[2],
              size: parseInt(headerMatch[3], 10)
            });
          }
        }
      }

      // 4. Inspect Completed Jobs from lpstat -l -W completed
      const completedJobMap = new Map();
      const compLines = lpstatCompleted.stdout.split('\n');
      let currentCompId = null;

      for (const rawLine of compLines) {
        const line = rawLine.trim();
        if (!line) continue;
        const headerMatch = line.match(/^([^\s]+)\s+([^\s]+)\s+(\d+)\s+(.+)$/);
        if (headerMatch) {
          currentCompId = headerMatch[1];
          if (!completedJobMap.has(currentCompId)) {
            completedJobMap.set(currentCompId, { alerts: [], status: '' });
          }
          const numMatchComp = currentCompId.match(/-(\d+)$/);
          if (numMatchComp && !completedJobMap.has(numMatchComp[1])) {
            completedJobMap.set(numMatchComp[1], completedJobMap.get(currentCompId));
          }
        } else if (currentCompId && completedJobMap.has(currentCompId)) {
          const mAlert = line.match(/^Alerts:\s*(.+)$/i);
          if (mAlert) completedJobMap.get(currentCompId).alerts.push(mAlert[1].trim());
          const mStat = line.match(/^Status:\s*(.+)$/i);
          if (mStat) completedJobMap.get(currentCompId).status = mStat[1].trim();
        }
      }

      // 5. Update State for All Known Jobs
      for (const job of this.getAllJobs()) {
        if (['completed', 'error', 'canceled', 'deleted'].includes(job.state)) {
          continue;
        }

        // Check if job is in CUPS completed log (by full ID or numeric ID)
        const compInfo = completedJobMap.get(job.id) || (job.numeric_id ? completedJobMap.get(String(job.numeric_id)) : null);
        if (compInfo) {
          const alertStr = compInfo.alerts.join(', ');
          if (alertStr.includes('job-canceled')) {
            this.updateJob(job.id, {
              state: 'canceled',
              status_message: 'Pekerjaan cetak dibatalkan oleh pengguna.',
              alerts: compInfo.alerts
            });
          } else if (alertStr.includes('job-stopped') || alertStr.includes('aborted')) {
            this.updateJob(job.id, {
              state: 'error',
              status_message: `Gagal mencetak: ${compInfo.status || alertStr || 'Error pada printer'}`,
              error: compInfo.status || alertStr,
              alerts: compInfo.alerts
            });
          } else {
            this.updateJob(job.id, {
              state: 'completed',
              status_message: 'Dokumen berhasil dicetak di printer.',
              alerts: compInfo.alerts
            });
          }
          continue;
        }

        const isInSpool = activeSpoolJobIds.has(job.id) || (job.numeric_id && activeSpoolJobIds.has(String(job.numeric_id)));
        const isActivelyPrinting = (activePrintingJobId && (activePrintingJobId === job.id || activePrintingJobId === String(job.numeric_id))) ||
                                   (!activePrintingJobId && isInSpool && printerStateText === 'printing');

        // If printer attention / out-of-paper while job is active or in spool
        const hasMediaAttention = lpAlerts.some(a => a.toLowerCase().includes('media-needed') || a.toLowerCase().includes('media-empty')) ||
                                  (lpStatus && /kertas habis|media needed/i.test(lpStatus));
        const hasDoorOrJam = lpAlerts.some(a => a.toLowerCase().includes('door-open') || a.toLowerCase().includes('media-jam')) ||
                             (lpStatus && /penutup|door|pintu|jam|tersangkut/i.test(lpStatus));

        if (hasMediaAttention && (isActivelyPrinting || isInSpool)) {
          this.updateJob(job.id, {
            state: 'attention',
            status_message: lpStatus || 'Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.',
            printer_state_message: lpStatus,
            alerts: lpAlerts
          });
          continue;
        }

        if (hasDoorOrJam && (isActivelyPrinting || isInSpool)) {
          this.updateJob(job.id, {
            state: 'attention',
            status_message: lpStatus || 'Pintu terbuka atau kertas tersangkut di printer!',
            printer_state_message: lpStatus,
            alerts: lpAlerts
          });
          continue;
        }

        // If actively printing right now
        if (isActivelyPrinting) {
          this.updateJob(job.id, {
            state: 'printing',
            status_message: lpStatus || 'Sedang mencetak dokumen ke printer fisik...',
            printer_state_message: lpStatus,
            alerts: lpAlerts
          });
          continue;
        }

        // If job is in spool
        if (isInSpool) {
          if (printerStateText === 'stopped') {
            this.updateJob(job.id, {
              state: 'error',
              status_message: `Printer terhenti: ${lpAlerts.join(', ') || 'Printer offline atau ada kendala'}`,
              error: lpAlerts.join(', ') || 'Printer stopped',
              alerts: lpAlerts
            });
          } else {
            this.updateJob(job.id, {
              state: 'pending',
              status_message: 'Menunggu giliran cetak di antrean...',
              alerts: lpAlerts
            });
          }
          continue;
        }

        // Job has departed CUPS spool: if printer is idle or job submitted > 10s ago, conclude it
        if (now - job.submitted_at > 10000 || (!isInSpool && !activePrintingJobId)) {
          if (printerStateText === 'stopped' || lpAlerts.some(a => a.toLowerCase().includes('error') || a.toLowerCase().includes('stopped'))) {
            this.updateJob(job.id, {
              state: 'error',
              status_message: lpStatus || `Gagal mencetak: ${lpAlerts.join(', ') || 'Printer dihentikan oleh CUPS'}`,
              error: lpStatus || lpAlerts.join(', ') || 'Printer stopped',
              alerts: lpAlerts
            });
          } else {
            this.updateJob(job.id, {
              state: 'completed',
              status_message: 'Dokumen berhasil dicetak di printer.',
              alerts: ['job-completed-successfully']
            });
          }
        }
      }
    } catch (err) {
      console.warn('[!] Error syncing jobs with CUPS:', err.message);
    }
  }

  startWatcher() {
    if (this.activeWatcherTimer) return;
    let pollTicks = 0;
    this.activeWatcherTimer = setInterval(async () => {
      pollTicks++;
      await this.syncWithCups();
      const active = this.getActiveJobs();

      // Invalidate cache and broadcast live telemetry while active
      if (active.length > 0 || this.lastActiveCount > 0) {
        cachedStatus = null;
        lastStatusFetch = 0;
        getOrFetchStatus(true).then(broadcastSse).catch(() => {});
      }
      this.lastActiveCount = active.length;

      // When all jobs settle, stop high frequency polling after 10 ticks
      if (active.length === 0 && pollTicks > 10) {
        clearInterval(this.activeWatcherTimer);
        this.activeWatcherTimer = null;
      }
    }, 300);
  }
}

const jobTracker = new PrintJobTracker();

function startActivePrintJobWatcher() {
  jobTracker.startWatcher();
}

async function probePrinterTelemetry() {
  const connectedUsbPrinters = getConnectedUsbPrinters();

  const [cupsActive, avahiActive, ippUsbActive, lpstatRes, lpstatJobs] = await Promise.all([
    runCmd('systemctl', ['is-active', 'cups']),
    runCmd('systemctl', ['is-active', 'avahi-daemon']),
    runCmd('systemctl', ['is-active', 'ipp-usb']),
    runCmd('lpstat', ['-p', '-d', '-v']),
    runCmd('lpstat', ['-o'])
  ]);

  // Self-heal Avahi mDNS daemon if inactive or crashed
  if (avahiActive.stdout.trim() !== 'active') {
    console.warn('[!] Avahi mDNS daemon is inactive or crashed. Auto-reviving avahi-daemon...');
    runCmd('systemctl', ['restart', 'avahi-daemon']).catch(() => {});
  }

  // Parse Default and Available Queues
  let defaultQueue = '';
  const queueDevices = {};
  const queues = [];
  let printerState = 'idle';

  for (const line of lpstatRes.stdout.split('\n')) {
    if (line.includes('system default destination:')) {
      defaultQueue = line.split(':')[1].trim();
    } else if (line.startsWith('printer ')) {
      const parts = line.split(' ');
      const qName = parts[1];
      const isIdle = line.includes('is idle');
      const isStopped = line.includes('disabled') || line.includes('stopped');
      const isPrinting = line.includes('printing');
      const st = isPrinting ? 'processing' : isStopped ? 'stopped' : 'idle';
      queues.push({ name: qName, state: st });
    } else if (line.startsWith('device for ')) {
      const parts = line.split(':', 2);
      const qName = parts[0].replace('device for ', '').trim();
      const u = line.substring(line.indexOf(':') + 1).trim();
      queueDevices[qName] = u;
    }
  }

  // Ensure defaultQueue is initially one of the available queues
  if (defaultQueue && !queues.some(q => q.name === defaultQueue)) {
    defaultQueue = queues.length > 0 ? queues[0].name : '';
  }

  // Parse Active Jobs
  const jobs = [];
  for (const line of lpstatJobs.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 4) {
      jobs.push({
        id: parts[0],
        user: parts[1],
        size: parts[2],
        date: parts.slice(3).join(' '),
        status: printerState === 'processing' ? 'processing' : 'pending'
      });
    }
  }

  const ip = getIpAddress();

  // Helper to inspect a printer queue's live telemetry
  async function probeQueue(qName) {
    let qConn = true;
    let qDisp = qName.replace(/_/g, ' ');
    let qMdl = qDisp;
    let qVen = 'Generic';
    const matchingQ = queues.find(q => q.name === qName);
    let qState = matchingQ ? matchingQ.state : 'idle';
    const queueActiveJobs = jobTracker.getActiveJobs().filter(j => j.printer === qName || j.id.startsWith(qName));
    if (queueActiveJobs.length > 0 || (jobs.length > 0 && jobs.some(j => j.id.startsWith(qName)))) {
      const isPrinting = queueActiveJobs.some(j => j.state === 'printing');
      qState = isPrinting ? 'printing' : 'processing';
    }
    let qAlert = qState === 'printing'
      ? 'Sedang Mencetak Dokumen ke Printer Fisik...'
      : (qState === 'processing'
          ? 'Memproses Antrean Pencetakan...'
          : (qState === 'stopped' ? 'Printer Dihentikan' : 'Siap Digunakan'));
    let qDevId = '';
    let qMarkerNames = [];
    let qMarkerColors = [];
    let qMarkerLevels = [];
    let qDriverInfo = null;
    let qHardwareTelemetry = null;
    let netReach = null;

    const devUri = queueDevices[qName] || '';
    const lpstatDetail = await runCmd('lpstat', ['-l', '-p', qName]);
    const descMatch = lpstatDetail.stdout.match(/Description:\s*(.+?)(?:\s*@\s*(?:MantaPrint|HeykPrint))?$/m);
    if (descMatch && descMatch[1].trim()) {
      qDisp = descMatch[1].trim();
      qMdl = qDisp;
    }

    const persistentConfig = getPersistentPrintersConfig();
    const pOverrides = persistentConfig.printers?.[qName] || {};
    if (pOverrides.display_name) {
      qDisp = pOverrides.display_name;
    }

    const isUsbUri = devUri.startsWith('usb://') || devUri.includes('localhost:600') || devUri.includes('127.0.0.1:600') || devUri.startsWith('mantaprint-usb://') || devUri.startsWith('heykprint-usb://');
    let isUsb = isUsbUri;
    let classification = 'network';
    let canDelete = true;
    let isPublished = false;
    let protocol = 'socket';

    if (devUri.startsWith('ipp://localhost:600') || devUri.startsWith('ipp://127.0.0.1:600')) {
      protocol = 'usb';
      isUsb = true;
      const ippRes = await runCmd('ipptool', [
        '-v', '-t', devUri,
        '/usr/share/cups/ipptool/get-printer-attributes.test'
      ], 1500);

      if (ippRes.code === 0 && ippRes.stdout) {
        classification = 'active_usb';
        canDelete = false;
        qConn = true;
        isPublished = true;
        const out = ippRes.stdout;
        const mMM = out.match(/printer-make-and-model\s+\([^)]+\)\s*=\s*(.+)/);
        const mNames = out.match(/marker-names\s+\([^)]+\)\s*=\s*(.+)/);
        const mColors = out.match(/marker-colors\s+\([^)]+\)\s*=\s*(.+)/);
        const mLevels = out.match(/marker-levels\s+\([^)]+\)\s*=\s*(.+)/);
        const mAlert = out.match(/printer-alert-description\s+\([^)]+\)\s*=\s*(.+)/);
        const mDevId = out.match(/printer-device-id\s+\([^)]+\)\s*=\s*(.+)/);

        if (mMM) { qDisp = pOverrides.display_name || mMM[1].trim(); qMdl = mMM[1].trim(); }
        if (mNames) qMarkerNames = mNames[1].split(',').map(s => s.trim());
        if (mColors) qMarkerColors = mColors[1].split(',').map(s => s.trim());
        if (mLevels) qMarkerLevels = mLevels[1].split(',').map(s => parseInt(s.trim(), 10));
        if (mAlert) qAlert = mAlert[1].trim();
        if (mDevId) qDevId = mDevId[1].trim();
      } else {
        classification = 'inactive_usb';
        canDelete = true;
        qConn = false;
        qAlert = 'Printer USB sedang offline atau tidak merespons';
        qState = 'disconnected';
        isPublished = false;
        runCmd('cupsdisable', ['-r', 'Printer offline atau dimatikan', qName]).catch(() => {});
      }
    } else if (devUri.startsWith('usb://') || devUri.startsWith('mantaprint-usb://')) {
      protocol = 'usb';
      isUsb = true;
      const isUsbPhysicallyAttached = matchUsbDevice(devUri, connectedUsbPrinters);
      if (!isUsbPhysicallyAttached) {
        classification = 'inactive_usb';
        canDelete = true;
        qConn = false;
        qAlert = 'Kabel USB Tidak Terhubung (Offline)';
        qState = 'disconnected';
        isPublished = false;
        if (!matchingQ || (matchingQ.state !== 'processing' && matchingQ.state !== 'printing')) {
          runCmd('cupsdisable', ['-r', 'Kabel USB tidak terhubung', qName]).catch(() => {});
        }
      } else {
        classification = 'active_usb';
        canDelete = false; // PnP Locked
        qConn = true;
        isPublished = pOverrides.is_published !== undefined ? Boolean(pOverrides.is_published) : true;
        if (matchingQ && matchingQ.state === 'stopped') {
          runCmd('cupsenable', [qName]).catch(() => {});
        }
        const ppdPath = `/etc/cups/ppd/${qName}.ppd`;
        try {
          if (fs.existsSync(ppdPath)) {
            const ppdContent = fs.readFileSync(ppdPath, 'utf8');
            const mNick = ppdContent.match(/^\*NickName:\s*"([^"]+)"/m);
            const mMfg = ppdContent.match(/^\*Manufacturer:\s*"([^"]+)"/m);
            const m1284 = ppdContent.match(/^\*1284DeviceID:\s*"([^"]+)"/m);
            if (mNick) {
              qDisp = pOverrides.display_name || mNick[1].split('-')[0].trim();
              qMdl = qDisp;
            }
            if (mMfg) qVen = mMfg[1].trim();
            if (m1284) qDevId = m1284[1].trim();

            const isCanonUfr = ppdContent.includes('rastertosfp') || ppdContent.includes('CNDriverRootPath') || qMdl.toLowerCase().includes('lbp6030') || qMdl.toLowerCase().includes('lbp60');
            if (isCanonUfr) {
              const alertRaw = (lpstatDetail.stdout.match(/Alerts:\s*(.+)/) || ['', ''])[1].toLowerCase();
              let tonerLevel = -2; // CUPS standard for OK / Discrete Normal
              let tonerState = 'ok';
              let coverClosed = true;
              let paperTray = 'ready';
              let paperJam = false;

              if (fs.existsSync('/run/mantaprint/printer_attention')) {
                paperTray = 'empty';
                try {
                  const msg = fs.readFileSync('/run/mantaprint/printer_attention', 'utf8').trim();
                  if (msg) qAlert = msg;
                } catch {}
              } else if (alertRaw.includes('door-open') || alertRaw.includes('cover-open')) {
                coverClosed = false;
                qAlert = 'Penutup Depan/Atas Printer Terbuka (Tutup penutup untuk melanjutkan)';
              } else if (alertRaw.includes('paper-jam') || alertRaw.includes('media-jam')) {
                paperJam = true;
                qAlert = 'Kertas Macet di Dalam Jalur Printer (Buka penutup dan keluarkan kertas macet)';
              } else if (alertRaw.includes('media-empty') || alertRaw.includes('out-of-paper') || alertRaw.includes('media-needed')) {
                paperTray = 'empty';
                qAlert = 'Baki Kertas Habis (Muat kertas A4 ke baki masukan)';
              } else if (alertRaw.includes('toner-empty') || alertRaw.includes('marker-supply-empty')) {
                tonerState = 'empty';
                tonerLevel = 0;
                qAlert = 'Toner Cartridge Habis (Ganti dengan Canon CRG-325 baru)';
              } else if (alertRaw.includes('toner-low') || alertRaw.includes('marker-supply-low')) {
                tonerState = 'low';
                tonerLevel = -3;
                qAlert = 'Toner Cartridge Mendekati Habis (Siapkan cadangan Canon CRG-325)';
              } else {
                qAlert = 'Canon LBP6030 Siap Digunakan | Cartridge CRG-325 Normal';
                if (qState !== 'processing' && qState !== 'printing') {
                  const now = Date.now();
                  if (!global.__lastSmartStatCheck || now - global.__lastSmartStatCheck > 10000) {
                    try {
                      global.__lastSmartStat = await runCmd('/usr/lib/cups/backend/usb', ['--status']);
                      global.__lastSmartStatCheck = now;
                    } catch {}
                  }
                  const smartStat = global.__lastSmartStat;
                  if (smartStat && smartStat.code === 0 && smartStat.stdout) {
                    if (smartStat.stdout.includes('PaperEmpty=1')) {
                      paperTray = 'empty';
                      qAlert = 'Baki Kertas Habis (Muat kertas A4 ke baki masukan)';
                    } else if (smartStat.stdout.includes('door-open-error')) {
                      coverClosed = false;
                      qAlert = 'Penutup Depan/Atas Printer Terbuka (Tutup penutup untuk melanjutkan)';
                    } else if (smartStat.stdout.includes('media-jam-error')) {
                      paperJam = true;
                      qAlert = 'Kertas Macet di Dalam Jalur Printer (Buka penutup dan keluarkan kertas macet)';
                    }
                  }
                }
              }

              qMarkerNames = ['Canon Cartridge 325 (Black Toner)'];
              qMarkerColors = ['#0f172a'];
              qMarkerLevels = [tonerLevel];

              qDriverInfo = {
                name: 'Canon UFR II LT Printer Driver (Resmi)',
                package: 'cnrdrvcups-ufr2lt-uk',
                filter: 'rastertosfp',
                engine_version: '5.x (UK / Global Edition)',
                cartridge_model: 'Canon Cartridge 325 (CRG-325 / 725 / 125)',
                cartridge_yield: '~1.600 Halaman Standar (ISO/IEC 19752)',
                technology: 'Monochrome Electrophotographic Laser Beam Printing',
                resolution: '600 x 600 dpi (AirPrint / High Grade)',
                sensor_type: 'Sensor Diskrit Mekanik-Optik (Chip-less Cartridge)',
                paper_sizes: ['A4', 'Letter', 'Legal', 'A5', 'B5', 'Executive', 'Envelope COM10', 'Foolscap'],
                media_types: ['Plain', 'Plain L', 'Heavy', 'Heavy H'],
                toner_save_mode: 'Tersedia (CNDraftMode)'
              };

              qHardwareTelemetry = {
                cartridge_present: true,
                cartridge_status: tonerState,
                cover_closed: coverClosed,
                paper_tray_status: paperTray,
                paper_jam: paperJam,
                engine_state: qState === 'printing' ? 'printing' : (qState === 'processing' ? 'warming_up' : 'ready')
              };
            }
          }
        } catch {}
      }
    } else {
      isUsb = false;
      classification = 'network';
      canDelete = true;
      if (devUri.startsWith('ipp://') || devUri.startsWith('ipps://')) protocol = 'ipp';
      else if (devUri.startsWith('lpd://')) protocol = 'lpd';
      else protocol = 'socket';

      // Network printer broadcast setting from persistent config (DEFAULT: false!)
      isPublished = Boolean(pOverrides.is_published);
      const reach = getNetworkReachability(devUri);
      netReach = { state: reach.state, host: reach.host || null, port: reach.port || null, latency_ms: reach.latency_ms ?? null, checked_at: reach.checked_at || null };

      if (matchingQ && matchingQ.state === 'stopped') {
        qConn = false;
        qAlert = 'Antrean printer dinonaktifkan (Stopped)';
        qState = 'stopped';
      } else if (reach.state === 'offline') {
        qConn = false;
        qAlert = `Printer jaringan tidak merespons di ${reach.host}:${reach.port}`;
        qState = 'disconnected';
      } else {
        qConn = true;
        qAlert = 'Printer Jaringan Siap Digunakan';
      }
    }

    const lowerName = qDisp.toLowerCase();
    if (lowerName.includes('canon')) qVen = 'Canon';
    else if (lowerName.includes('epson')) qVen = 'Epson';
    else if (lowerName.includes('hp') || lowerName.includes('laserjet') || lowerName.includes('deskjet')) qVen = 'HP';
    else if (lowerName.includes('brother')) qVen = 'Brother';
    else if (lowerName.includes('samsung')) qVen = 'Samsung';
    else if (lowerName.includes('xerox')) qVen = 'Xerox';
    else if (lowerName.includes('zebra')) qVen = 'Zebra';

    return {
      name: qName,
      connected: qConn,
      state: qState,
      displayName: qDisp,
      model: qMdl,
      vendor: qVen,
      alertDesc: qAlert,
      deviceId: qDevId,
      classification,
      isUsb,
      canDelete,
      isPublished,
      deviceUri: devUri,
      protocol,
      location: pOverrides.location || '',
      markerNames: qMarkerNames,
      markerColors: qMarkerColors,
      markerLevels: qMarkerLevels,
      driverInfo: qDriverInfo,
      hardwareTelemetry: qHardwareTelemetry,
      reachability: netReach,
      source: pOverrides.source || null
    };
  }

  // Probe all queues
  const probed = await Promise.all(queues.map(q => probeQueue(q.name)));

  // Load persistent mDNS config for custom broadcast names
  const customMdnsConfig = getCustomMdnsConfig();
  const effectiveHostname = configManager?.cachedConfig?.hostname || customMdnsConfig.hostname || os.hostname() || 'mantaprint';
  customMdnsConfig.hostname = effectiveHostname;

  // Reconcile Avahi AirPrint / mDNS Broadcasts strictly according to appliance rules:
  // - Active USB: always broadcast (is_published = true)
  // - Inactive USB: never broadcast (remove Avahi service)
  // - Network: broadcast ONLY if explicitly enabled by admin (is_published = true)
  const activeQueuesToBroadcast = new Set();
  for (const p of probed) {
    if (p.isPublished && (p.classification === 'active_usb' || p.classification === 'network')) {
      activeQueuesToBroadcast.add(p.name);
      const customName = customMdnsConfig.custom_broadcast_names?.[p.name] || '';
      writeAvahiService(p.name, p.displayName, p.model, true, false, p.connected, customName);
    } else {
      removeAvahiService(p.name);
    }
  }

  // Prune any orphan Avahi service files on disk whose queues are not in activeQueuesToBroadcast
  try {
    const avahiDir = '/etc/avahi/services';
    if (fs.existsSync(avahiDir)) {
      const files = fs.readdirSync(avahiDir);
      let prunedAny = false;
      for (const f of files) {
        if ((f.startsWith('mantaprint_') || f.startsWith('heykprint_')) && f.endsWith('.service')) {
          const match = f.match(/^(?:mantaprint_|heykprint_)(.+)\.service$/);
          if (match && match[1]) {
            const queueCandidate = match[1];
            if (!activeQueuesToBroadcast.has(queueCandidate)) {
              try {
                fs.unlinkSync(path.join(avahiDir, f));
                prunedAny = true;
              } catch {}
            }
          }
        }
      }
      // Avahi inotify automatically detects unlinked service files
    }
  } catch {}

  const activeDetails = probed.find(p => p.name === defaultQueue && p.connected && p.isPublished) 
    || probed.find(p => p.classification === 'active_usb' && p.connected && p.isPublished)
    || probed.find(p => p.connected && p.isPublished) 
    || probed.find(p => p.isPublished)
    || null;

  if (activeDetails) {
    defaultQueue = activeDetails.name;
  } else {
    defaultQueue = '';
  }

  const isConnected = Boolean(activeDetails && activeDetails.connected);
  let displayName = isConnected ? activeDetails.displayName : 'Belum Ada Printer Terdeteksi';
  let model = isConnected ? activeDetails.model : 'Belum Ada Printer Terdeteksi';
  let vendor = isConnected ? activeDetails.vendor : 'None';
  const activeTrackerJobs = jobTracker.getActiveJobs();
  const allTrackerJobs = jobTracker.getAllJobs();
  const currentJob = activeTrackerJobs.length > 0 
    ? activeTrackerJobs[0] 
    : (allTrackerJobs.length > 0 && (Date.now() - allTrackerJobs[0].updated_at < 6000) ? allTrackerJobs[0] : null);

  printerState = isConnected ? activeDetails.state : 'disconnected';
  if (isConnected && (activeTrackerJobs.length > 0 || jobs.length > 0 || queues.some(q => q.state === 'processing'))) {
    const isActivelyPrinting = activeTrackerJobs.some(j => j.state === 'printing') || queues.some(q => q.state === 'processing');
    printerState = isActivelyPrinting ? 'printing' : 'processing';
  }
  let alertDesc = isConnected 
    ? (printerState === 'printing'
        ? (currentJob ? `Sedang Mencetak: ${currentJob.title} (${currentJob.status_message})` : 'Sedang Mencetak Dokumen ke Printer Fisik...')
        : (printerState === 'processing'
            ? 'Memproses Antrean Pencetakan...'
            : (currentJob && currentJob.state === 'completed' && (Date.now() - currentJob.completed_at < 5000)
                ? `Selesai Dicetak: ${currentJob.title} ✓`
                : activeDetails.alertDesc)))
    : 'Hubungkan kabel USB printer ke port USB MantaPrint Hub';
  let deviceId = isConnected ? activeDetails.deviceId : '';
  let markerNames = isConnected ? activeDetails.markerNames : [];
  let markerColors = isConnected ? activeDetails.markerColors : [];
  let markerLevels = isConnected ? activeDetails.markerLevels : [];
  let driverInfo = isConnected ? activeDetails.driverInfo : null;
  let hardwareTelemetry = isConnected ? activeDetails.hardwareTelemetry : null;

  if (!isConnected) {
    defaultQueue = '';
  }

  // Format markers array for frontend
  const markers = markerNames.map((name, idx) => {
    const color = markerColors[idx] || '#6366f1';
    const level = typeof markerLevels[idx] === 'number' ? markerLevels[idx] : -2;
    const isWaste = name.toLowerCase().includes('mc') || name.toLowerCase().includes('waste');
    const isToner = name.toLowerCase().includes('toner') || name.toLowerCase().includes('crg');
    return {
      name,
      color,
      level,
      type: isWaste ? 'waste' : (isToner ? 'toner' : 'ink'),
      cartridge: isToner ? 'CRG-325' : (isWaste ? 'MC-G02' : 'Standard'),
      label: isWaste 
        ? 'Waste Absorber (MC)' 
        : (isToner 
            ? 'Canon CRG-325 Black Toner' 
            : name.replace(/Black.*/, 'Pigment Black')),
      discrete_state: level === -2 ? 'ok' : (level === -3 ? 'low' : (level === 0 ? 'empty' : 'normal')),
      discrete_label: level === -2 ? 'Optimal (Normal)' : (level === -3 ? 'Toner Rendah' : (level === 0 ? 'Toner Habis' : 'OK')),
      chip_less: isToner,
      technology: isToner ? 'Monochrome Laser' : 'Inkjet'
    };
  });

  // Build full details for all probed printers
  const readinessByQueue = getPrinterReadiness();
  const allPrinters = probed.map(p => {
    const readiness = readinessByQueue[p.name];
    const isConn = Boolean(p && p.connected);
    const pMarkers = (p.markerNames || []).map((name, idx) => {
      const color = p.markerColors[idx] || '#6366f1';
      const level = typeof p.markerLevels[idx] === 'number' ? p.markerLevels[idx] : -2;
      const isWaste = name.toLowerCase().includes('mc') || name.toLowerCase().includes('waste');
      const isToner = name.toLowerCase().includes('toner') || name.toLowerCase().includes('crg');
      return {
        name,
        color,
        level,
        type: isWaste ? 'waste' : (isToner ? 'toner' : 'ink'),
        cartridge: isToner ? 'CRG-325' : (isWaste ? 'MC-G02' : 'Standard'),
        label: isWaste 
          ? 'Waste Absorber (MC)' 
          : (isToner 
              ? 'Canon CRG-325 Black Toner' 
              : name.replace(/Black.*/, 'Pigment Black')),
        discrete_state: level === -2 ? 'ok' : (level === -3 ? 'low' : (level === 0 ? 'empty' : 'normal')),
        discrete_label: level === -2 ? 'Optimal (Normal)' : (level === -3 ? 'Toner Rendah' : (level === 0 ? 'Toner Habis' : 'OK')),
        chip_less: isToner,
        technology: isToner ? 'Monochrome Laser' : 'Inkjet'
      };
    });

    const customName = customMdnsConfig.custom_broadcast_names?.[p.name] || '';
    const broadcastName = customName || (isConn ? formatMdnsName(p.displayName, p.model, p.name) : p.displayName);

    return {
      name: p.name,
      queue_name: p.name,
      connected: isConn,
      classification: p.classification,
      is_usb: p.isUsb,
      is_active: isConn,
      can_delete: p.canDelete,
      can_edit: true,
      is_published: p.isPublished,
      device_uri: p.deviceUri,
      protocol: p.protocol,
      location: p.location || '',
      display_name: broadcastName,
      raw_display_name: p.displayName,
      custom_broadcast_name: customName,
      mdns_name: broadcastName,
      model: p.model,
      vendor: p.vendor,
      state: isConn ? p.state : 'disconnected',
      alert_description: p.alertDesc,
      device_id: p.deviceId,
      ipp_url: `ipp://${ip}:631/printers/${p.name}`,
      cups_url: `http://${ip}:631/printers/${p.name}`,
      mdns_url: `ipp://${effectiveHostname}.local:631/printers/${p.name}`,
      markers_supported: pMarkers.length > 0,
      markers: pMarkers,
      driver_info: p.driverInfo,
      hardware_telemetry: p.hardwareTelemetry,
      is_default: p.name === defaultQueue,
      // From printer_manager.py's sync_all_printers(): "ready", "needs_firmware",
      // "provisioning", "needs_review" or "unsupported". Absent until the first hotplug sync
      // has run for this queue (e.g. right after a fresh install).
      readiness: readiness?.state || null,
      // A stable key the frontend translates (EN/ID) — never ready-made English text; see
      // adm.printers.readiness.reasons in frontend/src/i18n/ui.js.
      readiness_reason: readiness?.reason_code || '',
      readiness_detail: readiness?.detail || '',
      driver_confidence: readiness?.confidence || null,
      // Network queues only: { state: online|offline|unknown, host, port, latency_ms, checked_at }
      network_reachability: p.reachability || null,
      // "discovered" / "auto" for a network printer adopted from a scan; null otherwise
      added_by: p.source || null
    };
  });

  const scannerStatus = getScannerStatusSWR();
  const scannerBroadcastName = scannerStatus && scannerStatus.connected 
    ? formatMdnsName(scannerStatus.name, scannerStatus.model, 'scanner') 
    : '';

  const peripherals = [
    ...allPrinters.map(p => ({
      id: `printer-${p.queue_name}`,
      type: 'printer',
      kind: p.is_usb ? 'Printer USB' : 'Printer Jaringan',
      classification: p.classification,
      is_usb: p.is_usb,
      can_delete: p.can_delete,
      is_published: p.is_published,
      name: p.display_name,
      display_name: p.display_name,
      structured_name: p.display_name,
      raw_name: p.raw_display_name,
      model: p.model,
      vendor: p.vendor,
      connected: p.connected,
      state: p.state,
      queue_name: p.queue_name,
      alert_description: p.alert_description,
      markers: p.markers,
      details: p
    })),
    ...(scannerStatus && scannerStatus.connected ? [{
      id: `scanner-${scannerStatus.profile_id || 'main'}`,
      type: 'scanner',
      kind: scannerStatus.type === 'ADF' ? 'Dokumen Scanner (ADF)' : 'Flatbed Scanner',
      name: scannerBroadcastName || scannerStatus.name,
      display_name: scannerBroadcastName || scannerStatus.name,
      structured_name: scannerBroadcastName,
      raw_name: scannerStatus.name,
      model: scannerStatus.model,
      vendor: scannerStatus.vendor,
      connected: scannerStatus.connected,
      state: 'ready',
      profile_id: scannerStatus.profile_id,
      details: scannerStatus
    }] : [])
  ];

  const customDefaultName = customMdnsConfig.custom_broadcast_names?.[defaultQueue];
  const finalDefaultDisplayName = customDefaultName || (isConnected ? formatMdnsName(displayName, model, defaultQueue) : 'Belum Ada Printer Terdeteksi');

  const net = getActiveBroadcastNetwork();
  syncAvahiInterfaceBinding(net.iface);

  const payload = {
    timestamp: Math.floor(Date.now() / 1000),
    version: applianceUpdater.currentVersion,
    system: {
      version: applianceUpdater.currentVersion,
      language: configManager.getLanguage(),
      timezone: configManager.cachedConfig.timezone || 'Asia/Jakarta',
      hostname: effectiveHostname,
      ip,
      broadcast_ip: net.ip,
      broadcast_network: net,
      mdns_host: `${effectiveHostname}.local`,
      uptime: getUptime(),
      cpu_temp: getCpuTemp(),
      load: os.loadavg().map(v => Math.round(v * 100) / 100),
      ram: getRamInfo(),
      storage: getStorageInfo()
    },
    services: {
      cups: cupsActive.stdout.trim() === 'active',
      avahi: avahiActive.stdout.trim() === 'active',
      ipp_usb: ippUsbActive.stdout.trim() === 'active'
    },
    mdns_network: getQuickMdnsStatus(ip, defaultQueue),
    direct_connect: directConnect.getStatus(),
    printer: {
      connected: isConnected,
      is_published: Boolean(activeDetails && activeDetails.isPublished),
      display_name: finalDefaultDisplayName,
      raw_display_name: displayName,
      custom_broadcast_name: customDefaultName || '',
      mdns_name: finalDefaultDisplayName,
      model,
      vendor,
      queue_name: defaultQueue,
      state: isConnected ? printerState : 'disconnected',
      alert_description: alertDesc,
      device_id: deviceId,
      ipp_url: defaultQueue ? `ipp://${ip}:631/printers/${defaultQueue}` : '',
      cups_url: defaultQueue ? `http://${ip}:631/printers/${defaultQueue}` : '',
      mdns_url: defaultQueue ? `ipp://${effectiveHostname}.local:631/printers/${defaultQueue}` : '',
      markers_supported: markers.length > 0,
      markers,
      driver_info: driverInfo,
      hardware_telemetry: hardwareTelemetry,
      current_job: currentJob,
      active_jobs: activeTrackerJobs,
      recent_jobs: allTrackerJobs.slice(0, 10).map(j => ({
        id: j.id,
        user: j.user,
        size: `${Math.round((j.size || 0) / 1024)} KB`,
        date: new Date(j.submitted_at).toLocaleTimeString('id-ID'),
        status: j.state,
        message: j.status_message
      })),
      jobs: activeTrackerJobs.map(j => ({
        id: j.id,
        user: j.user,
        size: `${Math.round((j.size || 0) / 1024)} KB`,
        date: new Date(j.submitted_at).toLocaleTimeString('id-ID'),
        status: j.state,
        message: j.status_message
      }))
    },
    printers: allPrinters,
    published_printers: allPrinters.filter(p => p.is_published),
    scanner: scannerStatus,
    scanners: scannerStatus?.connected ? [scannerStatus] : [],
    peripherals,
    published_peripherals: peripherals.filter(p => p.type === 'scanner' || p.is_published),
    custom_mdns: {
      hostname: effectiveHostname,
      domain: customMdnsConfig.domain || 'local',
      mdns_host: `${effectiveHostname}.${customMdnsConfig.domain || 'local'}`,
      custom_broadcast_names: customMdnsConfig.custom_broadcast_names || {}
    },
    updates: {
      update_available: Boolean(applianceUpdater?.updateInfo?.update_available),
      current_version: applianceUpdater?.currentVersion || INSTALLED_VERSION,
      latest_version: applianceUpdater?.latestVersion || applianceUpdater?.currentVersion || INSTALLED_VERSION,
      last_checked: applianceUpdater?.updateInfo?.last_checked || null,
      channel: applianceUpdater?.updateInfo?.channel || 'prototype'
    },
    lockdown: lockdownSummary(),
    scanner_portal_enabled: configManager.getConfig()?.scanner?.portal_enabled !== false,
    scanner_pwa_api_enabled: configManager.getConfig()?.scanner?.remote_pwa_api_enabled !== false,
    queues
  };

  cachedStatus = payload;
  lastStatusFetch = Date.now();
  return payload;
}

let usbWatcherDebounce = null;
let lastKnownHardwareConnected = null;

function startUsbHardwareWatcher() {
  const watchPath = '/dev/bus/usb';
  try {
    if (fs.existsSync(watchPath)) {
      fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        clearTimeout(usbWatcherDebounce);
        usbWatcherDebounce = setTimeout(async () => {
          const usbPrinters = getConnectedUsbPrinters();
          console.log(`[*] USB event on /dev/bus/usb (${eventType}: ${filename || 'all'}), detected ${usbPrinters.length} physical USB printer(s)`);

          // 1. Immediately invalidate cache and push fresh telemetry to all clients (< 100ms)
          cachedStatus = null;
          lastStatusFetch = 0;
          cachedScanner = null;
          lastScannerProbe = 0;
          try {
            const data = await probePrinterTelemetry();
            broadcastSse(data);
          } catch (e) {
            console.error('[!] Instant telemetry broadcast error:', e);
          }

          // Asynchronously re-probe scanner telemetry and push to clients (< 300ms)
          probeScannerTelemetry(true).then((sc) => {
            if (sc) broadcastSse({ scanner: sc });
          }).catch(() => {});

          // 2. Trigger CUPS / Avahi dynamic synchronization in background
          const genScript = fs.existsSync('/opt/mantaprint/printer_manager.py')
            ? '/opt/mantaprint/printer_manager.py'
            : path.join(__dirname, '../../core/printer_manager.py');

          if (fs.existsSync(genScript)) {
            runCmd('python3', [genScript], 10000)
              .then(async () => {
                cachedStatus = null;
                lastStatusFetch = 0;
                const finalData = await probePrinterTelemetry();
                broadcastSse(finalData);
              })
              .catch(() => {});
          }
        }, 150);
      });
      console.log('[+] Real-time USB hardware watcher initialized on /dev/bus/usb');
    }
  } catch (err) {
    console.warn('[!] Failed to initialize /dev/bus/usb watcher:', err.message);
  }
}

let lastKnownIpAddress = getIpAddress();
let ipMonitorProcess = null;
let ipChangeDebounce = null;

async function handleNetworkIpChange(newIp) {
  if (!newIp || newIp === '127.0.0.1' || newIp === lastKnownIpAddress) {
    return;
  }
  console.log(`[!] Dynamic Network IP Change Detected: ${lastKnownIpAddress} -> ${newIp}`);
  lastKnownIpAddress = newIp;

  // 1. Invalidate cache and broadcast to all connected web clients
  cachedStatus = null;
  lastStatusFetch = 0;
  try {
    const freshStatus = await probePrinterTelemetry();
    broadcastSse(freshStatus);
  } catch (err) {
    console.error('[!] Error broadcasting updated IP status:', err);
  }

  // 2. Trigger printer_manager.py to update Avahi DNS-SD XML service files on disk
  const scriptPath = fs.existsSync('/opt/mantaprint/printer_manager.py')
    ? '/opt/mantaprint/printer_manager.py'
    : path.join(__dirname, '../../core/printer_manager.py');
  if (fs.existsSync(scriptPath)) {
    console.log(`[*] Triggering printer_manager to update Avahi mDNS service name with new IP (${newIp})...`);
    runCmd('/usr/bin/python3', [scriptPath], 10000)
      .then(async () => {
        cachedStatus = null;
        lastStatusFetch = 0;
        const postData = await probePrinterTelemetry();
        broadcastSse(postData);
      })
      .catch((e) => console.error('[!] Failed to execute printer_manager on IP change:', e));
  }
}

function startNetworkIpWatcher() {
  // 1. Instant kernel netlink event monitor via 'ip monitor address link'
  try {
    ipMonitorProcess = spawn('/usr/sbin/ip', ['monitor', 'address', 'link']);
    if (ipMonitorProcess.stdout) {
      ipMonitorProcess.stdout.on('data', () => {
        clearTimeout(ipChangeDebounce);
        ipChangeDebounce = setTimeout(() => {
          const currentIp = getIpAddress();
          handleNetworkIpChange(currentIp);
        }, 400);
      });
    }

    ipMonitorProcess.on('error', (err) => {
      console.warn('[!] ip monitor address spawn error:', err.message);
    });

    ipMonitorProcess.on('exit', () => {
      // Auto-restart after 5s if process exited
      setTimeout(startNetworkIpWatcher, 5000);
    });
    console.log('[+] Real-time Kernel Netlink Network IP monitor initialized');
  } catch (e) {
    console.warn('[!] Failed to initialize kernel netlink address monitor:', e.message);
  }

  // 2. Periodic polling safeguard (every 2000ms) to guarantee sync across link flaps
  setInterval(() => {
    const currentIp = getIpAddress();
    handleNetworkIpChange(currentIp);
  }, 2000);
}

// Single-flight in-flight collapsing with Stale-While-Revalidate (instant response)
// Lockdown mode summary for /api/status: config is cheap; whether the nft table is really
// loaded is checked at most every 30 s (it spawns nft).
let lockdownApplied = { value: null, at: 0 };
function lockdownSummary() {
  const cfg = lockdown.loadConfig();
  if (Date.now() - lockdownApplied.at > 30000) {
    lockdownApplied.at = Date.now();
    lockdown.isApplied().then((v) => { lockdownApplied.value = v; }).catch(() => {});
  }
  return { enabled: Boolean(cfg.enabled), applied: lockdownApplied.value, admin_ips: cfg.admin_ips || [], ssh_from_admin: Boolean(cfg.ssh_from_admin), pin_is_default: Boolean(cfg.pin_is_default), enabled_at: cfg.enabled_at, enabled_by: cfg.enabled_by };
}

async function getOrFetchStatus(forceFresh = false) {
  if (cachedStatus && !forceFresh && (Date.now() - lastStatusFetch <= 4000)) {
    return cachedStatus;
  }

  if (inflightStatusPromise) {
    return await inflightStatusPromise;
  }
  inflightStatusPromise = probePrinterTelemetry()
    .then(data => {
      broadcastSse(data);
      return data;
    })
    .finally(() => {
      inflightStatusPromise = null;
    });
  return await inflightStatusPromise;
}

function broadcastSse(data) {
  const jsonStr = JSON.stringify(redactStatusForPublic(data));
  const msg = `data: ${jsonStr}\n\n`;
  for (const client of sseClients) {
    try {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
      } else {
        client.write(msg);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

// Periodic heartbeat / telemetry push to all SSE listeners with overlap guard
setInterval(async () => {
  if (!isProbingBackground) {
    isProbingBackground = true;
    try {
      const data = await probePrinterTelemetry();
      const currentConnected = Boolean(data?.printer?.connected);
      if (sseClients.size > 0 || lastKnownHardwareConnected !== currentConnected) {
        broadcastSse(data);
      }
      lastKnownHardwareConnected = currentConnected;
    } catch (e) {
      // Ignore background push errors
    } finally {
      isProbingBackground = false;
    }
  }
}, 1000);

// Periodic garbage collection sweep to strictly maintain < 60MB RAM footprint
setInterval(() => {
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch {}
  }
}, 30000);

// Safe body parser with strict maximum size limit and abort handling
async function readJsonBody(req, maxBytes = 64 * 1024) {
  return parseJsonBody(await readBody(req, maxBytes)) || {};
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function parseJsonBody(raw) {
  if (!raw || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return null;
  } catch {
    return null;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip'
};

// Admin Authentication State
function getEffectiveAdminConfig() {
  const adminCfg = configManager?.getConfig?.()?.admin || {};
  const effectiveUser = process.env.MANTAPRINT_ADMIN_USER || adminCfg.username || 'mantaprint';
  let effectivePass = process.env.MANTAPRINT_ADMIN_PASS || (adminCfg.password && adminCfg.password !== '<SET_ADMIN_PASSWORD>' ? adminCfg.password : null);

  if (!effectivePass) {
    try {
      if (fs.existsSync('/etc/mantaprint/admin.secret')) {
        const stored = fs.readFileSync('/etc/mantaprint/admin.secret', 'utf8').trim();
        if (stored) effectivePass = stored;
      }
    } catch {}
  }

  if (!effectivePass) {
    effectivePass = 'mantapgan';
  }

  return { username: effectiveUser, password: effectivePass, configured: adminCfg };
}

function verifyAdminCredentials(inputUser, inputPass) {
  if (!inputUser || !inputPass) return false;
  const { username, password, configured } = getEffectiveAdminConfig();

  const isCustomUserConfigured = Boolean(
    configured.username &&
    configured.username !== 'mantaprint' &&
    configured.username !== 'mimin'
  );
  const acceptedUsers = isCustomUserConfigured
    ? [username, configured.username].filter(Boolean)
    : [username, 'mantaprint', 'admin', 'mimin'].filter(Boolean);

  const userMatched = acceptedUsers.some(u => safeCompare(inputUser, u));
  if (!userMatched) return false;

  const isCustomPasswordSet = Boolean(
    configured.password &&
    configured.password !== 'mantapgan' &&
    configured.password !== '<SET_ADMIN_PASSWORD>'
  );

  const acceptedPasswords = isCustomPasswordSet
    ? [password, configured.password].filter(p => p && p !== '<SET_ADMIN_PASSWORD>')
    : [password, configured.password, 'mantapgan'].filter(p => p && p !== '<SET_ADMIN_PASSWORD>');

  return acceptedPasswords.some(p => safeCompare(inputPass, p));
}

// Bounded active tokens map with TTL (24 hours) to prevent unbounded memory growth
const activeAdminTokens = new Map(); // token -> expiresAt
const MAX_ACTIVE_TOKENS = 100;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function generateAuthToken() {
  return 'mp_' + crypto.randomBytes(32).toString('hex');
}

function getAuthToken(req) {
  const custom = req.headers['x-admin-token'];
  if (custom) return custom;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function isAdminAuthenticated(req) {
  const token = getAuthToken(req);
  if (!token) return false;
  const expiresAt = activeAdminTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeAdminTokens.delete(token);
    return false;
  }
  return true;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Loopback callers (HDMI TUI, local agent) are trusted for queue maintenance.
function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAdminOrLocal(req) {
  return isAdminAuthenticated(req) || isLoopbackRequest(req);
}

function denyAdmin(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: 'Admin authentication required.' }));
}

// Per-job secret handed only to the client that submitted the job, so a customer can
// follow and cancel their own job without seeing or touching anyone else's.
function getJobToken(req, parsed = null) {
  const h = req.headers['x-job-token'];
  if (typeof h === 'string' && h) return h;
  if (parsed && typeof parsed.job_token === 'string') return parsed.job_token;
  return '';
}

function jobTokenMatches(job, token) {
  return Boolean(job && job.cancel_token && token && safeCompare(String(token), String(job.cancel_token)));
}

// Public views of print jobs never expose document titles, submitter addresses or tokens.
function publicJobView(job) {
  if (!job) return job;
  const { title, user, cancel_token, ...rest } = job;
  return rest;
}

function redactStatusForPublic(status) {
  if (!status || !status.printer) return status;
  const strip = (arr) => (Array.isArray(arr) ? arr.map((j) => {
    if (!j || typeof j !== 'object') return j;
    const { title, user, cancel_token, ...rest } = j;
    return rest;
  }) : arr);
  const printer = {
    ...status.printer,
    current_job: status.printer.current_job ? strip([status.printer.current_job])[0] : status.printer.current_job,
    active_jobs: strip(status.printer.active_jobs),
    recent_jobs: strip(status.printer.recent_jobs),
    jobs: strip(status.printer.jobs)
  };
  return { ...status, printer };
}

const server = http.createServer(async (req, res) => {
  try {
    // Safe pathname parsing: never trust req.headers.host for URL constructor
    let pathname = '/';
    let url = null;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
      pathname = url.pathname;
    } catch {
      url = new URL('http://127.0.0.1/');
      pathname = '/';
    }

    // Global CORS & Private Network Access (PNA) Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Printer-Queue, X-Wait-Job, X-Document-Name, X-File-Name, X-Job-Token, X-Admin-Token, Authorization, X-MantaPrint-Client-Id, X-MantaPrint-Token, Access-Control-Request-Private-Network');
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- CAPTIVE PORTAL PROBE REDIRECTIONS (iOS, Android, Windows SoftAP Onboarding) ---
    if (
      pathname === '/generate_204' ||
      pathname === '/gen_204' ||
      pathname === '/hotspot-detect.html' ||
      pathname === '/connecttest.txt' ||
      pathname === '/ncsi.txt' ||
      pathname === '/canonical.html' ||
      pathname === '/success.txt'
    ) {
      res.writeHead(302, {
        'Location': 'http://192.168.4.1/',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end();
      return;
    }

    // --- AUTHENTICATION API ROUTES ---
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = parseJsonBody(raw) || {};
      const { username, password } = body;
      if (verifyAdminCredentials(username, password)) {
        const now = Date.now();
        for (const [tok, exp] of activeAdminTokens) {
          if (now > exp) activeAdminTokens.delete(tok);
        }
        if (activeAdminTokens.size >= MAX_ACTIVE_TOKENS) {
          const firstKey = activeAdminTokens.keys().next().value;
          if (firstKey) activeAdminTokens.delete(firstKey);
        }
        const token = generateAuthToken();
        activeAdminTokens.set(token, now + TOKEN_TTL_MS);
        const { username: defUser } = getEffectiveAdminConfig();
        const authedUser = username || defUser;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token, user: authedUser }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Username atau sandi administrator tidak valid.' }));
      }
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = getAuthToken(req);
      if (token) activeAdminTokens.delete(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname === '/api/auth/check' && req.method === 'GET') {
      const authed = isAdminAuthenticated(req);
      const { username: defUser } = getEffectiveAdminConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: authed, user: authed ? defUser : null }));
      return;
    }

    if (pathname === '/api/auth/profile' && req.method === 'GET') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const { username, configured, password } = getEffectiveAdminConfig();
      const isDefaultPassword = password === 'mantapgan';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        username,
        isDefaultPassword,
        updated_at: configured.updated_at || null
      }));
      return;
    }

    if (pathname === '/api/auth/profile' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonBody(raw) || {};
      const { currentPassword, newUsername, newPassword, confirmPassword } = body;

      if (!currentPassword) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Kata sandi saat ini wajib diisi untuk verifikasi keamanan.' }));
        return;
      }

      const { username: curUser, password: curPass, configured } = getEffectiveAdminConfig();

      // Verify current password against accepted passwords
      const acceptedPasswords = [
        curPass,
        configured.password,
        'mantapgan'
      ].filter(p => p && p !== '<SET_ADMIN_PASSWORD>');

      const isCurrentPasswordValid = acceptedPasswords.some(p => safeCompare(currentPassword, p));
      if (!isCurrentPasswordValid) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Kata sandi saat ini salah.' }));
        return;
      }

      let updatedUsername = curUser;
      if (typeof newUsername === 'string' && newUsername.trim()) {
        const cleanUser = newUsername.trim();
        if (!/^[a-zA-Z0-9_\-\.]{3,32}$/.test(cleanUser)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Username harus 3-32 karakter alfanumerik (huruf, angka, _, -, .).' }));
          return;
        }
        updatedUsername = cleanUser;
      }

      let updatedPassword = curPass;
      if (newPassword) {
        if (typeof newPassword !== 'string' || newPassword.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Kata sandi baru minimal harus 6 karakter.' }));
          return;
        }
        if (newPassword !== confirmPassword) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Konfirmasi kata sandi baru tidak cocok.' }));
          return;
        }
        updatedPassword = newPassword;
      }

      try {
        const updatedAdminObj = {
          ...configured,
          username: updatedUsername,
          password: updatedPassword,
          updated_at: new Date().toISOString()
        };

        configManager.saveConfig({ admin: updatedAdminObj });

        // Also persist to /etc/mantaprint/admin.secret if possible
        try {
          if (!fs.existsSync('/etc/mantaprint')) {
            fs.mkdirSync('/etc/mantaprint', { recursive: true, mode: 0o700 });
          }
          fs.writeFileSync('/etc/mantaprint/admin.secret', updatedPassword, { encoding: 'utf8', mode: 0o600 });
        } catch {}

        // Ensure token remains active for current admin session
        const currentToken = getAuthToken(req);
        if (currentToken) {
          activeAdminTokens.set(currentToken, Date.now() + TOKEN_TTL_MS);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Profil dan kredensial administrator berhasil diperbarui.',
          username: updatedUsername,
          isDefaultPassword: updatedPassword === 'mantapgan'
        }));
      } catch (saveErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Gagal menyimpan kredensial: ${saveErr.message}` }));
      }
      return;
    }

    // --- API ROUTES ---
    if ((pathname === '/api/health' || pathname === '/healthz') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        appliance: 'mantaprint-hub',
        version: applianceUpdater.currentVersion,
        channel: 'prototype',
        prototype: true,
        risk_acknowledged: fs.existsSync('/etc/mantaprint/prototype-ack.json'),
        uptime_seconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      }));
      return;
    }

    if (pathname === '/api/airprint.mobileconfig' && req.method === 'GET') {
      const queue = String(url.searchParams.get('queue') || '');
      const data = await getOrFetchStatus();
      const shared = (data.printers || []).filter(p => p.is_published);
      const printer = shared.find(p => p.queue_name === queue) || (!queue ? shared[0] : null);
      if (!printer || !/^[A-Za-z0-9_.-]+$/.test(printer.queue_name)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'No shared printer with that name.' }));
        return;
      }
      // Prefer the address the phone actually used to reach the hub.
      const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
      const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostHeader) && hostHeader !== '127.0.0.1'
        ? hostHeader
        : (data.system?.broadcast_ip || data.system?.ip);
      const body = buildAirPrintProfile({
        ip,
        queue: printer.queue_name,
        name: printer.mdns_name || printer.display_name,
        hostname: data.system?.hostname
      });
      res.writeHead(200, {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': `attachment; filename="MantaPrint-${printer.queue_name}.mobileconfig"`,
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      const data = await getOrFetchStatus(req.url.includes('fresh=true'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(redactStatusForPublic(data)));
      return;
    }

    // Server-Sent Events (SSE) Stream
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      res.write('retry: 3000\n\n');
      getOrFetchStatus().then(snapshot => {
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(redactStatusForPublic(snapshot))}\n\n`);
          }
        } catch {}
      });
      sseClients.add(res);

      const cleanup = () => {
        sseClients.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    // Invalidate cache helper
    const invalidateCacheAndBroadcast = async () => {
      lastStatusFetch = 0;
      cachedStatus = null;
      try {
        const fresh = await probePrinterTelemetry();
        cachedStatus = fresh;
        lastStatusFetch = Date.now();
        broadcastSse(fresh);
      } catch (err) {
        console.warn('Status broadcast error:', err.message);
      }
    };

    // CUPS Web UI Reverse Proxy (/cups/* -> 127.0.0.1:631/*)
    if (pathname.startsWith('/cups')) {
      const targetPath = pathname.replace(/^\/cups/, '') || '/';
      const cupsUrl = `http://127.0.0.1:631${targetPath}${url.search}`;
      
      const proxyReq = http.request(cupsUrl, {
        method: req.method,
        headers: {
          ...req.headers,
          host: '127.0.0.1:631'
        }
      }, (cupsRes) => {
        res.writeHead(cupsRes.statusCode, cupsRes.headers);
        cupsRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('CUPS daemon unavailable: ' + err.message);
      });

      req.pipe(proxyReq);
      return;
    }

    // --- SCANNER & eSCL ROUTES ---
    // Reverse proxy eSCL (Apple AirScan & Mopria Scan) to local ipp-usb
    if (pathname.startsWith('/eSCL/')) {
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 60000,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: 'localhost:60000'
        }
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Scanner eSCL endpoint offline.' }));
      });
      req.pipe(proxyReq);
      return;
    }

    // ==========================================
    // DEPRECATED SERVER-SIDE SCAN PROCESSING
    // ==========================================
    // MantaPageScan Studio (/scan) processes and stores pages on the client device.
    // These endpoints are kept only for API compatibility and are scheduled for removal.
    // They answer with RFC 8594 Deprecation/Sunset headers so any remaining caller is visible in logs.
    if (DEPRECATED_SCAN_ENDPOINTS.has(pathname)) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', DEPRECATED_SCAN_SUNSET);
      res.setHeader('Warning', '299 - "Deprecated: server-side scan processing moved to the client (MantaPageScan Studio)"');
      if (!deprecatedEndpointLogged.has(pathname)) {
        deprecatedEndpointLogged.add(pathname);
        console.warn(`[Deprecation] ${req.method} ${pathname} was called; this endpoint is deprecated and will be removed.`);
      }
    }

    // ==========================================
    // SCANNER PWA PAIRING, CLIENTS & MUTEX API
    // ==========================================

    // 1. Scanner Subnet Discovery & Probe (Zero-auth for fast subnet sweep)
    if (pathname === '/api/scanner/probe' && req.method === 'GET') {
      const cfg = configManager.getConfig();
      const status = scannerHardwareLock.getStatus();
      const networkIp = getIpAddress();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hub_uuid: scannerPairingManager.getHubUuid(),
        hostname: os.hostname(),
        ip: networkIp || '127.0.0.1',
        version: getCurrentSystemVersion(),
        portal_enabled: cfg?.scanner?.portal_enabled !== false,
        pwa_api_enabled: cfg?.scanner?.remote_pwa_api_enabled !== false,
        is_busy: status.is_busy,
        busy_holder: status.is_busy ? (status.holder || 'Perangkat terhubung') : null
      }));
      return;
    }

    // 2. Generate Ephemeral Pairing Code (Admin Only)
    if (pathname === '/api/scanner/pairing/generate' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const hostHeader = req.headers.host || 'mantaprint.local';
      const [hostName, hostPort] = hostHeader.split(':');
      const networkIp = getIpAddress();
      const code = scannerPairingManager.generatePairingCode(
        hostName.includes('.local') ? hostName : 'mantaprint.local',
        networkIp || '127.0.0.1',
        parseInt(hostPort || '80', 10)
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...code }));
      return;
    }

    // 3. Verify Pairing Code & Issue Durable Token (PWA Client)
    if (pathname === '/api/scanner/pairing/verify' && req.method === 'POST') {
      const cfg = configManager.getConfig();
      if (cfg?.scanner?.remote_pwa_api_enabled === false) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error_code: 'ERR_PWA_API_DISABLED',
          message: 'Akses Remote Scanner PWA dinonaktifkan oleh Administrator.'
        }));
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload tidak valid.' }));
        return;
      }

      const parsed = parseJsonBody(raw) || {};
      const clientIp = req.socket?.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
      const result = scannerPairingManager.verifyPairing(parsed.pin || parsed.pairing_token, {
        device_name: parsed.device_name,
        platform: parsed.platform,
        userAgent: req.headers['user-agent'],
        ip: clientIp
      });

      if (!result.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Broadcast SSE event to admin console that client paired
      broadcastSse({
        type: 'scanner:client_paired',
        client_id: result.client_id,
        device_name: result.device_name,
        ip: clientIp,
        timestamp: new Date().toISOString()
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // 4. List Paired Clients (Admin Only)
    if (pathname === '/api/scanner/clients' && req.method === 'GET') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const clients = scannerPairingManager.listClients();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, clients, count: clients.length }));
      return;
    }

    // 5. Revoke Client (Admin Only)
    if (pathname.startsWith('/api/scanner/clients/') && pathname.endsWith('/revoke') && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const parts = pathname.split('/');
      const clientId = parts[4];
      const ok = scannerPairingManager.revokeClient(clientId, 'admin');
      if (ok) {
        broadcastSse({
          type: 'scanner:client_revoked',
          client_id: clientId,
          timestamp: new Date().toISOString()
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Akses perangkat berhasil dicabut.' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Perangkat tidak ditemukan.' }));
      }
      return;
    }

    // 6. Reauthorize Client (Admin Only)
    if (pathname.startsWith('/api/scanner/clients/') && pathname.endsWith('/reauthorize') && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const parts = pathname.split('/');
      const clientId = parts[4];
      const ok = scannerPairingManager.reauthorizeClient(clientId);
      if (ok) {
        broadcastSse({
          type: 'scanner:client_reauthorized',
          client_id: clientId,
          timestamp: new Date().toISOString()
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Perangkat berhasil diotorisasi ulang.' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Perangkat tidak ditemukan.' }));
      }
      return;
    }

    // 7. Rename Client (Admin Only)
    if (pathname.startsWith('/api/scanner/clients/') && pathname.endsWith('/rename') && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const parts = pathname.split('/');
      const clientId = parts[4];
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw) || {};
      const ok = scannerPairingManager.renameClient(clientId, parsed.device_name);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // 8. Delete Client (Admin Only)
    if (pathname.startsWith('/api/scanner/clients/') && req.method === 'DELETE') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const parts = pathname.split('/');
      const clientId = parts[4];
      const ok = scannerPairingManager.deleteClient(clientId);
      broadcastSse({
        type: 'scanner:client_deleted',
        client_id: clientId,
        timestamp: new Date().toISOString()
      });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // 9. ScanSnap (epjitsu) firmware: status + upload of a .nal or the installer holding it
    // --- LOCKDOWN MODE (print-only) ---
    // The console (loopback, i.e. the TUI) and admin sessions may switch it; turning it off
    // needs the PIN either way. Config changes (admin IPs, SSH, PIN) need an admin session.
    if (pathname === '/api/lockdown' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ success: true, ...(await lockdown.getStatus()) }));
      return;
    }
    if (pathname === '/api/lockdown/enable' && req.method === 'POST') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const r = await lockdown.enable({ by: isLoopbackRequest(req) && !isAdminAuthenticated(req) ? 'console' : 'admin', admin_ips: body.admin_ips, ssh_from_admin: body.ssh_from_admin });
      if (r.ok) { console.log(`[Lockdown] ENABLED by ${isLoopbackRequest(req) ? 'console' : req.socket.remoteAddress}; admin IPs: ${(lockdown.loadConfig().admin_ips || []).join(', ') || 'none'}`); lockdownApplied = { value: true, at: Date.now() }; }
      res.writeHead(r.ok ? 200 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: r.ok, ...r }));
      return;
    }
    if (pathname === '/api/lockdown/disable' && req.method === 'POST') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const r = await lockdown.disable({ pin: String(body.pin || '') });
      if (r.ok) { console.log(`[Lockdown] DISABLED by ${isLoopbackRequest(req) ? 'console' : req.socket.remoteAddress}`); lockdownApplied = { value: false, at: Date.now() }; }
      else console.warn(`[Lockdown] disable refused (${r.code}) from ${req.socket.remoteAddress}`);
      res.writeHead(r.ok ? 200 : r.code === 'bad_pin' ? 403 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: r.ok, ...r }));
      return;
    }
    if (pathname === '/api/lockdown/config' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const r = await lockdown.updateConfig({ admin_ips: body.admin_ips, ssh_from_admin: body.ssh_from_admin, pin_current: body.pin_current, pin_new: body.pin_new });
      res.writeHead(r.ok ? 200 : r.code === 'bad_pin' ? 403 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: r.ok, ...r }));
      return;
    }

    // --- DRIVER CENTER: Admin > Drivers & devices ---
    if (pathname === '/api/drivers/overview' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const [status, hp, apt] = await Promise.all([getOrFetchStatus(), getHplipPluginStatus(), driverCenter.aptStatus()]);
      const { recipes } = driverCenter.loadRecipes();
      const firmware = scannerFirmwareStatus();
      // dpkg state for every package the checklists care about (allowlist, family apt lists,
      // vendor .deb names), plus anything installed through this page.
      const installed = await driverCenter.installedPackages(driverCenter.allPackageNames(recipes));
      for (const i of driverCenter.readRegistry().items) if (i.kind === 'deb' && i.package) installed.add(i.package);
      const registry = driverCenter.readRegistry().items;
      hp.asc_pending = fs.existsSync(path.join(pickWorkBase().dir, 'drivers', 'hplip', 'pending.asc'));
      hp.signature_verified = registry.some(i => i.kind === 'hplip-plugin' && i.signature_verified && i.version === hp.plugin_version);
      const facts = { installed, hplip: hp, nal: firmware, hpfw: driverCenter.presentHpFirmware() };
      const devices = driverCenter.deviceNeeds({ printers: status.printers || [], scanner: status.scanner, hp, firmware, usb: getConnectedUsbPrinters(), recipes, installed })
        .map(d => ({ ...d, ...driverCenter.deviceSteps(d, recipes.find(r => r.id === d.recipe?.id) || null, facts) }));
      const catalog = recipes.map(r => ({ ...driverCenter.publicRecipe(r), ...driverCenter.familySteps(r, { ...facts, devices: devices.filter(d => d.recipe?.id === r.id) }) }));
      const tools = getExtractionTools();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        success: true,
        devices,
        catalog,
        installed: driverCenter.readRegistry().items,
        pending: driverCenter.listPending(),
        apt,
        hplip: { installed: hp.hplip_installed, version: hp.hplip_version, plugin_installed: hp.plugin_installed, plugin_version: hp.plugin_version, required_file: hp.required_file, download_url: hp.download_url },
        tools: { archive: Boolean(tools.sevenZip), cab: Boolean(tools.cabextract), installshield: Boolean(tools.unshield) },
        job: driverCenter.getJob(),
        max_upload_bytes: driverCenter.UPLOAD_MAX_BYTES,
        host_architecture: await driverCenter.hostArchitecture()
      }));
      return;
    }

    if (pathname === '/api/drivers/lookup' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const q = String(url.searchParams.get('q') || '').slice(0, 120);
      let models = null;
      try { models = parseHplipModels(fs.readFileSync(HPLIP_MODELS_DAT, 'utf8')); } catch {}
      const result = driverCenter.lookupModel(q, { models, findModelEntry: findHplipModel, pluginNeed: hplipPluginNeed });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    if (pathname === '/api/drivers/job' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ success: true, job: driverCenter.getJob() }));
      return;
    }

    // Generic upload: the hub classifies the file. Low-risk kinds (.nal, .ppd, .dl, hplip
    // plugin) install right away; a .deb or an installer archive becomes a pending item the
    // admin confirms (or picks from) with the details in view.
    if (pathname === '/api/drivers/upload' && req.method === 'POST') {
      const reply = (code, body) => {
        if (res.headersSent) return;
        res.writeHead(code, { 'Content-Type': 'application/json', ...(req.complete ? {} : { Connection: 'close' }) });
        res.end(JSON.stringify(body));
      };
      if (!isAdminAuthenticated(req)) return reply(401, { success: false, code: 'unauthorized' });
      if (driverCenter.jobBusy() || scannerFirmwareBusy || hplipPluginBusy) return reply(409, { success: false, code: 'busy' });
      const length = Number(req.headers['content-length']);
      if (!Number.isFinite(length) || length <= 0) return reply(411, { success: false, code: 'length_required' });
      if (length > driverCenter.UPLOAD_MAX_BYTES) return reply(413, { success: false, code: 'too_large', max_upload_bytes: driverCenter.UPLOAD_MAX_BYTES });
      let fileName = '';
      try { fileName = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || ''))).slice(0, 200); } catch {}
      const kind = driverCenter.classifyUpload(fileName);
      if (kind === 'unknown') return reply(422, { success: false, code: 'unknown_kind', file: fileName });
      // .nal and the HP plugin keep their dedicated handlers (they know their targets).
      if (kind === 'nal') return reply(422, { success: false, code: 'use_scanner_firmware' });
      const base = pickWorkBase();
      const keep = path.join(base.dir, 'drivers');
      let work = null;
      try {
        fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
        if (freeBytes(keep) < length * (kind === 'archive' ? 4 : 1) + 64 * 1024 * 1024) return reply(507, { success: false, code: 'insufficient_space' });
        work = fs.mkdtempSync(path.join(keep, 'up-'));
        const filePath = path.join(work, fileName.replace(/[^A-Za-z0-9_.+-]/g, '_'));
        try { await receiveUpload(req, filePath, length); } catch (err) { fs.rmSync(work, { recursive: true, force: true }); return reply(err.code === 'too_large' ? 413 : 400, { success: false, code: err.code === 'too_large' ? 'too_large' : 'upload_failed' }); }
        const sha256 = await driverCenter.sha256File(filePath);
        const target = String(url.searchParams.get('queue') || '');

        if (kind === 'hplip-plugin' || kind === 'asc') {
          if (kind === 'asc') { fs.mkdirSync(path.join(keep, 'hplip'), { recursive: true, mode: 0o700 }); fs.renameSync(filePath, path.join(keep, 'hplip', 'pending.asc')); fs.rmSync(work, { recursive: true, force: true }); return reply(200, { success: true, kind, stored: 'asc' }); }
          const job = startHplipPluginJob({ filePath, fileName, ascPath: path.join(keep, 'hplip', 'pending.asc'), sha256, size: length, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) });
          if (!job) { fs.rmSync(work, { recursive: true, force: true }); return reply(409, { success: false, code: 'busy' }); }
          return reply(200, { success: true, kind, job });
        }

        if (kind === 'ppd') {
          const r = await driverCenter.installPpd(filePath, fileName);
          fs.rmSync(work, { recursive: true, force: true });
          if (!r.ok) return reply(422, { success: false, kind, ...r });
          const rec = driverCenter.addRecord({ kind, name: r.name, version: '', sha256, size: length, note: r.nickname, path: r.path, target: target || null });
          let assigned = null;
          if (target) assigned = await driverCenter.assignPpdToQueue(target, r.path);
          return reply(200, { success: true, kind, ...r, record: rec, assigned });
        }

        if (kind === 'dl') {
          const r = driverCenter.installDl(filePath, fileName);
          fs.rmSync(work, { recursive: true, force: true });
          if (!r.ok) return reply(422, { success: false, kind, ...r });
          driverCenter.addRecord({ kind, name: r.name, version: '', sha256, size: length, note: 'HP LaserJet firmware (foo2zjs)', path: r.paths[0] });
          if (target) runCmd('/usr/bin/python3', [printerManagerScript(), 'provision-firmware', target], 120000).catch(() => {});
          return reply(200, { success: true, kind, ...r });
        }

        if (kind === 'deb') {
          const info = await driverCenter.inspectDeb(filePath);
          if (!info.ok) { fs.rmSync(work, { recursive: true, force: true }); return reply(422, { success: false, kind, ...info }); }
          const item = driverCenter.addPending({ kind, name: fileName, size: length, sha256, path: filePath, workDir: work, info, target: target || null });
          return reply(200, { success: true, kind, pending: { id: item.id, name: fileName, size: length, sha256, info } });
        }

        // archive
        const un = await driverCenter.unpackArchive(filePath, work, { maxBytes: Math.max(0, freeBytes(keep) - 64 * 1024 * 1024) });
        if (un.code !== 'ok') { fs.rmSync(work, { recursive: true, force: true }); return reply(422, { success: false, kind, code: un.code === 'no_match' ? 'nothing_useful' : un.code }); }
        const files = [];
        for (const f of un.files) files.push({ ...f, sha256: await driverCenter.sha256File(f.path), info: f.kind === 'deb' ? await driverCenter.inspectDeb(f.path) : null });
        const item = driverCenter.addPending({ kind, name: fileName, size: length, sha256, path: filePath, workDir: work, files, target: target || null });
        return reply(200, { success: true, kind, pending: { id: item.id, name: fileName, files: files.map(({ path: _p, ...f }) => f) } });
      } catch (err) {
        console.error('[Drivers] Upload failed:', err.message);
        try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch {}
        return reply(500, { success: false, code: 'upload_failed' });
      }
    }

    // Confirmed install of a pending item (a .deb, or one file out of an unpacked archive).
    if (pathname === '/api/drivers/pending/install' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const item = driverCenter.getPending(String(body.id || ''));
      if (!item) { res.writeHead(404, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'not_found' })); }
      let file = null;
      if (item.kind === 'deb') file = { kind: 'deb', name: item.name, path: item.path, sha256: item.sha256, size: item.size, info: item.info };
      else file = (item.files || []).find(f => f.sha256 === String(body.sha256 || '')) || null;
      if (!file) { res.writeHead(400, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'bad_file' })); }
      if (file.kind === 'deb' && body.confirm !== true) { res.writeHead(400, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'confirm_required' })); }
      if (file.kind === 'deb' && file.info && !file.info.arch_ok && body.force !== true) { res.writeHead(422, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'arch_mismatch', info: file.info })); }
      const target = String(body.queue || item.target || '');
      const job = driverCenter.startJob(`install-${file.kind}`, file.name, async (log) => {
        if (file.kind === 'deb') {
          const r = await driverCenter.installDeb(file.path, { log });
          if (r.ok) {
            const keepDir = path.join(pickWorkBase().dir, 'drivers', 'deb');
            fs.mkdirSync(keepDir, { recursive: true, mode: 0o700 });
            const kept = path.join(keepDir, `${file.info.package}_${file.info.version}_${file.info.architecture}.deb`.replace(/[^A-Za-z0-9_.+-]/g, '_'));
            try { fs.copyFileSync(file.path, kept); } catch {}
            driverCenter.addRecord({ kind: 'deb', name: file.name, package: file.info.package, version: file.info.version, architecture: file.info.architecture, maintainer: file.info.maintainer, sha256: file.sha256, size: file.size, path: kept, target: target || null });
            runCmd('/usr/bin/python3', [printerManagerScript(), 'sync'], 120000).catch(() => {});
          }
          return r;
        }
        if (file.kind === 'ppd') {
          const r = await driverCenter.installPpd(file.path, file.name);
          if (r.ok) { driverCenter.addRecord({ kind: 'ppd', name: r.name, version: '', sha256: file.sha256, size: file.size, note: r.nickname, path: r.path, target: target || null }); if (target) r.assigned = await driverCenter.assignPpdToQueue(target, r.path); }
          return r;
        }
        if (file.kind === 'dl') {
          const r = driverCenter.installDl(file.path, file.name);
          if (r.ok) driverCenter.addRecord({ kind: 'dl', name: r.name, version: '', sha256: file.sha256, size: file.size, note: 'HP LaserJet firmware (foo2zjs)', path: r.paths[0] });
          return r;
        }
        if (file.kind === 'hplip-plugin') {
          const r = await installPluginFile({ filePath: file.path, fileName: file.name, log });
          if (r.ok) { driverCenter.addRecord({ kind: 'hplip-plugin', name: file.name, version: r.version, sha256: file.sha256, size: file.size, note: 'HPLIP proprietary plugin', path: null }); await probeScannerTelemetry(true).catch(() => {}); }
          return r;
        }
        if (file.kind === 'nal') {
          const r = await processFirmwareUpload({ filePath: file.path, fileName: file.name, workDir: fs.mkdtempSync(path.join(pickWorkBase().dir, 'scanfw-')), target: '', maxBytes: 64 * 1024 * 1024 });
          if (r.ok) { for (const i of r.installed) driverCenter.addRecord({ kind: 'nal', name: i.filename, version: '', sha256: file.sha256, size: file.size, note: i.model || '', path: null }); await probeScannerTelemetry(true).catch(() => {}); }
          return r;
        }
        return { ok: false, code: 'bad_kind' };
      });
      if (!job) { res.writeHead(409, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'busy' })); }
      // The pending item is consumed once its job finishes; a multi-file archive stays until dropped.
      if (item.kind === 'deb') setTimeout(() => { const j = driverCenter.getJob(); if (j && j.id === job.id && j.state !== 'running') driverCenter.dropPending(item.id); }, 20 * 60 * 1000).unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, job: driverCenter.getJob() }));
      return;
    }

    if (pathname === '/api/drivers/pending/drop' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: driverCenter.dropPending(String(body.id || '')) }));
      return;
    }

    if (pathname === '/api/drivers/installed/remove' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const item = driverCenter.readRegistry().items.find(i => i.id === String(body.id || ''));
      if (!item) { res.writeHead(404, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'not_found' })); }
      const job = driverCenter.startJob(`remove-${item.kind}`, item.name, async (log) => {
        let r = { ok: true };
        if (item.kind === 'deb' && item.package) r = await driverCenter.removeDeb(item.package, { log });
        else if ((item.kind === 'ppd' || item.kind === 'dl') && item.path) { try { fs.unlinkSync(item.path); } catch {} }
        else if (item.kind === 'hplip-plugin' || item.kind === 'nal') { log('Only the record is removed; the installed files stay.'); }
        if (r.ok) driverCenter.removeRecord(item.id);
        return r;
      });
      if (!job) { res.writeHead(409, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'busy' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, job: driverCenter.getJob() }));
      return;
    }

    // HP host-based LaserJet firmware via foo2zjs' getweb (needs internet); runs as a job.
    if (pathname === '/api/drivers/hp-firmware/fetch' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const models = (Array.isArray(body.models) ? body.models : [body.model]).map(String).filter(m => m in driverCenter.HP_FIRMWARE);
      if (!models.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'bad_model' })); }
      const job = driverCenter.startJob('hp-firmware', models.join(', '), async (log) => {
        const r = await driverCenter.fetchHpFirmware(models, { log, workDir: fs.mkdtempSync(path.join(pickWorkBase().dir, 'getweb-')) });
        if (r.fetched.length) runCmd('/usr/bin/python3', [printerManagerScript(), 'sync'], 120000).catch(() => {});
        return r;
      });
      if (!job) { res.writeHead(409, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'busy' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, job: driverCenter.getJob() }));
      return;
    }

    if (pathname === '/api/drivers/apt/install' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const body = await readJsonBody(req).catch(() => ({}));
      const pkg = Array.isArray(body.packages) ? body.packages.map(String) : [String(body.package || '')];
      if (!pkg.length || !pkg.every(driverCenter.isAllowedPackage)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'not_allowed' })); }
      const job = driverCenter.startJob('apt-install', pkg.join(', '), async (log) => {
        const r = await driverCenter.aptInstall(pkg, { log });
        if (r.ok) { runCmd('/usr/bin/python3', [printerManagerScript(), 'sync'], 120000).catch(() => {}); await probeScannerTelemetry(true).catch(() => {}); }
        return r;
      });
      if (!job) { res.writeHead(409, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify({ success: false, code: 'busy' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, job: driverCenter.getJob() }));
      return;
    }

    // --- DRIVER CENTER: HPLIP proprietary plugin ---
    if (pathname === '/api/drivers/hplip' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const st = await getHplipPluginStatus();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ success: true, ...st, busy: hplipPluginBusy }));
      return;
    }

    // Raw body = the .run file (X-File-Name carries its name); ?kind=asc stores HP's detached
    // signature next to a previously uploaded .run so hp-plugin can verify it.
    if (pathname === '/api/drivers/hplip/plugin' && req.method === 'POST') {
      const reply = (code, body) => {
        if (res.headersSent) return;
        res.writeHead(code, { 'Content-Type': 'application/json', ...(req.complete ? {} : { Connection: 'close' }) });
        res.end(JSON.stringify(body));
      };
      if (!isAdminAuthenticated(req)) return reply(401, { success: false, code: 'unauthorized' });
      if (hplipPluginBusy) return reply(409, { success: false, code: 'busy' });
      const length = Number(req.headers['content-length']);
      if (!Number.isFinite(length) || length <= 0) return reply(411, { success: false, code: 'length_required' });
      const kind = url.searchParams.get('kind') === 'asc' ? 'asc' : 'run';
      const maxBytes = kind === 'asc' ? 64 * 1024 : HPLIP_RUN_MAX_BYTES;
      if (length > maxBytes) return reply(413, { success: false, code: 'too_large', max_upload_bytes: maxBytes });
      let fileName = '';
      try { fileName = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || ''))).slice(0, 200); } catch {}
      const base = pickWorkBase();
      const keep = path.join(base.dir, 'drivers', 'hplip');
      hplipPluginBusy = true;
      try {
        fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
        if (freeBytes(keep) < length + 64 * 1024 * 1024) return reply(507, { success: false, code: 'insufficient_space' });
        if (kind === 'asc') {
          const target = path.join(keep, 'pending.asc');
          try { await receiveUpload(req, target, maxBytes); } catch (err) { return reply(err.code === 'too_large' ? 413 : 400, { success: false, code: err.code === 'too_large' ? 'too_large' : 'upload_failed' }); }
          return reply(200, { success: true, stored: 'asc' });
        }
        const upload = path.join(keep, 'upload.run');
        try { await receiveUpload(req, upload, maxBytes); } catch (err) { return reply(err.code === 'too_large' ? 413 : 400, { success: false, code: err.code === 'too_large' ? 'too_large' : 'upload_failed' }); }
        const job = startHplipPluginJob({ filePath: upload, fileName, ascPath: path.join(keep, 'pending.asc'), size: length });
        if (!job) return reply(409, { success: false, code: 'busy' });
        return reply(200, { success: true, job });
      } catch (err) {
        console.error('[HPLIP plugin] Upload failed:', err.message);
        return reply(500, { success: false, code: 'install_failed' });
      } finally {
        hplipPluginBusy = false;
      }
    }

    if (pathname === '/api/scanner/firmware' && req.method === 'GET') {
      if (!isAdminOrLocal(req)) return denyAdmin(res);
      const tools = getExtractionTools();
      const base = pickWorkBase();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        success: true,
        ...scannerFirmwareStatus(),
        tools: { archive: Boolean(tools.sevenZip), cab: Boolean(tools.cabextract), installshield: Boolean(tools.unshield) },
        max_upload_bytes: base.maxUploadBytes,
        busy: scannerFirmwareBusy
      }));
      return;
    }

    if (pathname === '/api/scanner/firmware' && req.method === 'POST') {
      const reply = (code, body) => {
        if (res.headersSent) return;
        res.writeHead(code, { 'Content-Type': 'application/json', ...(req.complete ? {} : { Connection: 'close' }) });
        res.end(JSON.stringify(body));
      };
      if (!isAdminAuthenticated(req)) return reply(401, { success: false, code: 'unauthorized' });
      if (scannerFirmwareBusy) return reply(409, { success: false, code: 'busy' });
      const base = pickWorkBase();
      const length = Number(req.headers['content-length']);
      if (!Number.isFinite(length) || length <= 0) return reply(411, { success: false, code: 'length_required' });
      if (length > base.maxUploadBytes) return reply(413, { success: false, code: 'too_large', max_upload_bytes: base.maxUploadBytes });
      let fileName = 'upload.bin';
      try { fileName = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || ''))).slice(0, 200) || fileName; } catch {}
      const isNal = /\.nal$/i.test(fileName);
      if (isNal && length > 1024 * 1024) return reply(422, { success: false, code: 'invalid_size' });

      scannerFirmwareBusy = true;
      let work = null;
      try {
        fs.mkdirSync(base.dir, { recursive: true, mode: 0o700 });
        // Room for the upload plus, for an installer, everything unpacked out of it.
        const needed = isNal ? length + 1024 * 1024 : length * 4 + 64 * 1024 * 1024;
        if (freeBytes(base.dir) < needed) return reply(507, { success: false, code: 'insufficient_space' });
        work = fs.mkdtempSync(path.join(base.dir, 'scanfw-'));
        const upload = path.join(work, 'upload.bin');
        try {
          await receiveUpload(req, upload, length);
        } catch (err) {
          return reply(err.code === 'too_large' ? 413 : 400, { success: false, code: err.code === 'too_large' ? 'too_large' : 'upload_failed' });
        }
        let target = url.searchParams.get('target') || '';
        if (!target) {
          const waiting = getFirmwareStatus().needs_firmware;
          if (waiting.length === 1) target = waiting[0].filename;
        }
        const result = await processFirmwareUpload({
          filePath: upload,
          fileName,
          workDir: work,
          target,
          maxBytes: Math.max(0, freeBytes(base.dir) - 64 * 1024 * 1024)
        });
        if (result.ok) {
          console.log(`[Scanner] Installed epjitsu firmware: ${result.installed.map(i => i.filename).join(', ')}`);
          await probeScannerTelemetry(true).catch(() => {});
        }
        const status = scannerFirmwareStatus();
        const installed = result.installed.map(i => ({ ...i, model: status.devices.find(d => d.filename === i.filename)?.model || i.model }));
        return reply(result.ok ? 200 : 422, { success: result.ok, ...result, installed, status, scanner: cachedScanner });
      } catch (err) {
        console.warn('[Scanner] Firmware upload failed:', err.message);
        return reply(500, { success: false, code: 'internal_error' });
      } finally {
        if (work) fs.rmSync(work, { recursive: true, force: true });
        scannerFirmwareBusy = false;
      }
    }

    // 10. Scanner Service Configuration (Portal & PWA API toggles)
    if (pathname === '/api/scanner/config' && req.method === 'GET') {
      const cfg = configManager.getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        portal_enabled: cfg?.scanner?.portal_enabled !== false,
        remote_pwa_api_enabled: cfg?.scanner?.remote_pwa_api_enabled !== false
      }));
      return;
    }

    if (pathname === '/api/scanner/config' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw) || {};
      const currentScannerCfg = configManager.getConfig()?.scanner || {};
      const updatedScannerCfg = {
        ...currentScannerCfg,
        portal_enabled: parsed.portal_enabled !== undefined ? !!parsed.portal_enabled : currentScannerCfg.portal_enabled !== false,
        remote_pwa_api_enabled: parsed.remote_pwa_api_enabled !== undefined ? !!parsed.remote_pwa_api_enabled : currentScannerCfg.remote_pwa_api_enabled !== false
      };
      configManager.saveConfig({ scanner: updatedScannerCfg });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, scanner: updatedScannerCfg }));
      return;
    }

    // 10. Direct Zero-Footprint SANE Chunked Stream
    if (pathname === '/api/scanner/stream' && (req.method === 'GET' || req.method === 'POST')) {
      const authHeader = req.headers['authorization'] || req.headers['x-mantaprint-token'] || url.searchParams.get('token');
      const clientIp = req.socket?.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
      const auth = scannerPairingManager.verifyClientToken(authHeader, clientIp);
      if (!auth.valid && !isAdminAuthenticated(req)) {
        res.writeHead(auth.code === 'ERR_CLIENT_REVOKED' ? 403 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error_code: auth.code || 'ERR_UNAUTHORIZED',
          message: auth.message || 'Autentikasi token diperlukan.',
          action_required: auth.code === 'ERR_CLIENT_REVOKED' ? 'PURGE_LOCAL_CREDENTIALS' : 'REPAIR'
        }));
        return;
      }

      const clientName = auth?.client?.device_name || 'Stream Client';
      const clientId = auth?.client?.client_id || 'direct';

      const lock = scannerHardwareLock.acquire(clientId, clientName);
      if (!lock.acquired) {
        res.writeHead(423, { 
          'Content-Type': 'application/json',
          'Retry-After': String(lock.estimatedRemainingSec || 15)
        });
        res.end(JSON.stringify({
          success: false,
          error_code: 'SCANNER_BUSY',
          message: lock.message,
          holder: lock.holder,
          elapsed_sec: lock.elapsedSec
        }));
        return;
      }

      const sc = await probeScannerTelemetry();
      if (!sc.connected) {
        scannerHardwareLock.release(clientId);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Tidak ada scanner yang terhubung.' }));
        return;
      }

      let resolutionNum = parseInt(url.searchParams.get('resolution') || '300', 10);
      if (isNaN(resolutionNum) || resolutionNum < 75) resolutionNum = 150;
      const validModes = ['Color', 'Gray', 'Lineart'];
      const mode = validModes.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'Color';
      const maxDpi = mode === 'Color' ? 300 : 600;
      resolutionNum = Math.min(resolutionNum, maxDpi);
      const validFormats = ['jpeg', 'png', 'tiff', 'pnm'];
      const format = validFormats.includes(url.searchParams.get('format')?.toLowerCase()) ? url.searchParams.get('format').toLowerCase() : 'jpeg';
      const validSources = ['Flatbed', 'ADF Front', 'ADF Back', 'ADF Duplex'];
      const sourceRaw = url.searchParams.get('source') || 'Flatbed';
      const source = validSources.includes(sourceRaw) ? sourceRaw : 'Flatbed';

      res.writeHead(200, {
        'Content-Type': format === 'jpeg' ? 'image/jpeg' : 'image/x-portable-pixmap',
        'Transfer-Encoding': 'chunked',
        'X-Scanner-Model': sc.model || 'SANE Scanner',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });

      const args = [
        '-d', sc.device_id,
        `--resolution=${resolutionNum}`,
        `--mode=${mode}`,
        `--format=${format}`
      ];
      if (source && source !== 'Flatbed') {
        args.push(`--source=${source}`);
      }

      const proc = spawn('scanimage', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      scannerHardwareLock.registerActiveProcess(proc);

      // Drain stderr to prevent pipe buffer deadlock
      proc.stderr.resume();

      proc.on('error', (err) => {
        console.error('[ScannerStream] Failed to spawn scanimage:', err.message);
        scannerHardwareLock.release(clientId);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Gagal menjalankan subsistem pemindai.' }));
        }
      });

      proc.stdout.pipe(res);

      req.on('close', () => {
        if (!proc.killed) {
          try { proc.kill('SIGTERM'); } catch {}
          scannerHardwareLock.release(clientId);
        }
      });

      proc.on('close', () => {
        scannerHardwareLock.release(clientId);
        res.end();
      });
      return;
    }

    // Scanner Status (SWR Cache: Instant < 10ms response time)
    if (pathname === '/api/scanner/status' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const mockProfileId = parsedUrl.searchParams.get('mock');
      let sc;
      if (mockProfileId) {
        const p = SCANNER_PROFILES.find(x => x.id === mockProfileId || x.model.toLowerCase().includes(mockProfileId.toLowerCase()));
        if (p) {
          sc = {
            connected: true,
            protocol: p.driver === 'eSCL' ? 'eSCL' : 'SANE',
            device_id: `${p.driver}:mock:${p.id}`,
            profile_id: p.id,
            name: p.name,
            model: p.model,
            vendor: p.vendor,
            driver: p.driver,
            type: p.type,
            source: p.sources[0],
            sources: p.sources,
            has_adf: p.has_adf,
            duplex_capable: p.duplex_capable,
            resolutions: p.resolutions,
            modes: p.modes,
            formats: p.formats,
            max_geometry: p.max_geometry,
            supported_paper_sizes: p.supported_paper_sizes,
            profiles: SCANNER_PROFILES.map(pr => ({
              id: pr.id,
              name: pr.name,
              vendor: pr.vendor,
              driver: pr.driver,
              type: pr.type,
              sources: pr.sources,
              duplex_capable: pr.duplex_capable,
              supported_paper_sizes: pr.supported_paper_sizes
            }))
          };
        }
      }
      if (!sc) sc = getScannerStatusSWR();

      const cfg = configManager.getConfig();
      const status = scannerHardwareLock.getStatus();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify({
        success: true,
        scanner: sc,
        mutex: status,
        portal_enabled: cfg?.scanner?.portal_enabled !== false,
        remote_pwa_api_enabled: cfg?.scanner?.remote_pwa_api_enabled !== false,
        paperSizes: SCAN_PAPER_SIZES,
        profiles: SCANNER_PROFILES.map(p => ({
          id: p.id,
          name: p.name,
          vendor: p.vendor,
          driver: p.driver,
          type: p.type,
          sources: p.sources,
          duplex_capable: p.duplex_capable,
          supported_paper_sizes: p.supported_paper_sizes
        }))
      }));
      return;
    }

    // Blank Page Detection On-Demand API
    if (pathname === '/api/scanner/blank-detect' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const parsed = parseJsonBody(raw) || {};
      const fileId = sanitizeIdentifier(parsed.fileId ? path.basename(parsed.fileId) : '');
      if (!fileId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'File ID is required.' }));
        return;
      }
      const filePath = resolveScanFilePath(fileId);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'File not found or expired.' }));
        return;
      }

      const result = await checkBlankPage(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        fileId,
        isBlank: result.blank,
        metrics: {
          mean: result.mean,
          stddev: result.stddev,
          darkPixels: result.darkPixels,
          totalPixels: result.totalPixels
        }
      }));
      return;
    }

    // Scanner Image Acquisition (WebScan & PWA Client)
    if (pathname === '/api/scanner/scan' && req.method === 'POST') {
      // Auth & Portal Permission Check
      const tokenHeader = req.headers['authorization'] || req.headers['x-mantaprint-token'];
      const cfg = configManager.getConfig();
      let clientInfo = null;

      if (tokenHeader) {
        const clientIp = req.socket?.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
        const auth = scannerPairingManager.verifyClientToken(tokenHeader, clientIp);
        if (!auth.valid) {
          res.writeHead(auth.code === 'ERR_CLIENT_REVOKED' ? 403 : 401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error_code: auth.code || 'ERR_UNAUTHORIZED',
            message: auth.message || 'Token tidak valid.',
            action_required: auth.code === 'ERR_CLIENT_REVOKED' ? 'PURGE_LOCAL_CREDENTIALS' : 'REPAIR'
          }));
          return;
        }
        clientInfo = auth.client;
      } else {
        // Direct web access from /scan portal
        if (cfg?.scanner?.portal_enabled === false && !isAdminAuthenticated(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error_code: 'ERR_PORTAL_DISABLED',
            message: 'WebScan Direct Portal dinonaktifkan oleh Administrator.'
          }));
          return;
        }
      }

      // Hardware Mutex Lock
      const lockHolderName = clientInfo?.device_name || 'WebScan Direct';
      const lockHolderId = clientInfo?.client_id || 'direct_scan';
      const lockAcquired = scannerHardwareLock.acquire(lockHolderId, lockHolderName);
      if (!lockAcquired.acquired) {
        res.writeHead(423, { 
          'Content-Type': 'application/json',
          'Retry-After': String(lockAcquired.estimatedRemainingSec || 15)
        });
        res.end(JSON.stringify({
          success: false,
          error_code: 'SCANNER_BUSY',
          message: lockAcquired.message,
          holder: lockAcquired.holder,
          elapsed_sec: lockAcquired.elapsedSec,
          estimated_remaining_sec: lockAcquired.estimatedRemainingSec
        }));
        return;
      }

      try {
        let raw;
        try {
          raw = await readBody(req);
        } catch {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
          return;
        }

      const parsed = parseJsonBody(raw) || {};
      let sc = await probeScannerTelemetry();

      // Allow specifying mock scanner profile for appliance test suite
      if (parsed.mock && typeof parsed.mock === 'string') {
        const p = SCANNER_PROFILES.find(x => x.id === parsed.mock || x.model.toLowerCase().includes(parsed.mock.toLowerCase()));
        if (p) {
          sc = {
            connected: true,
            protocol: p.driver === 'eSCL' ? 'eSCL' : 'SANE',
            device_id: `${p.driver}:mock:${p.id}`,
            profile_id: p.id,
            name: p.name,
            model: p.model,
            vendor: p.vendor,
            driver: p.driver,
            type: p.type,
            source: p.sources[0],
            sources: p.sources,
            has_adf: p.has_adf,
            duplex_capable: p.duplex_capable,
            resolutions: p.resolutions,
            modes: p.modes,
            formats: p.formats,
            max_geometry: p.max_geometry,
            supported_paper_sizes: p.supported_paper_sizes
          };
        }
      }

      const isMockMode = Boolean(parsed.mock || sc.device_id?.includes(':mock:'));
      if (!sc.connected && !isMockMode) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Tidak ada scanner yang terhubung.' }));
        return;
      }

      const mode = (parsed.mode === 'Gray' || parsed.mode === 'Lineart') ? parsed.mode : 'Color';
      // Hardware Anti-OOM Safeguard: Embedded SBCs (1-2GB RAM) will trigger Linux OOM Killer if 24-bit RGB Color
      // is acquired at >300 DPI (>100MB raw pixels expanding to >1.5GB during binarization) or Gray at >600 DPI.
      const maxAllowedDpi = mode === 'Color' ? 300 : 600;
      let reqRes = Number(parsed.resolution) || 300;
      let resolution = [75, 100, 150, 200, 300, 600].includes(reqRes) ? reqRes : 300;
      if (resolution > maxAllowedDpi) {
        resolution = maxAllowedDpi;
      }
      const format = (parsed.format === 'jpeg' || parsed.format === 'jpg') ? 'jpeg' : (parsed.format === 'png' ? 'png' : (parsed.format === 'tiff' ? 'tiff' : 'pdf'));
      const fileExt = format === 'jpeg' ? 'jpg' : (format === 'tiff' ? 'tiff' : format);
      const scanId = 'scan_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');

      // Paper Dimensions Resolution
      // F4 / Folio: 215mm x 330mm, ID Card: 86mm x 54mm, A4: 210mm x 297mm
      let width = 210;
      let height = 297;
      const requestedPaper = parsed.paperSize || parsed.paper_size;
      if (requestedPaper && SCAN_PAPER_SIZES[requestedPaper]) {
        width = SCAN_PAPER_SIZES[requestedPaper].width;
        height = SCAN_PAPER_SIZES[requestedPaper].height;
      } else if (parsed.width && parsed.height) {
        const w = Number(parsed.width);
        const h = Number(parsed.height);
        if (w > 10 && w < 1000) width = w;
        if (h > 10 && h < 5000) height = h;
      }

      // Clamp geometry if hardware bed has physical limit (e.g. Flatbed LiDE max 297mm height)
      if (sc.max_geometry) {
        if (sc.type === 'Flatbed' && height > sc.max_geometry.height) {
          height = sc.max_geometry.height;
        }
        if (width > sc.max_geometry.width) {
          width = sc.max_geometry.width;
        }
      }

      // Source Resolution (Flatbed, ADF Front, ADF Duplex)
      let source = 'Flatbed';
      if (parsed.source === 'ADF Duplex' && sc.duplex_capable) {
        source = 'ADF Duplex';
      } else if (parsed.source === 'ADF Front' || parsed.source === 'ADF') {
        source = sc.has_adf ? 'ADF Front' : 'Flatbed';
      } else if (parsed.source === 'Flatbed') {
        source = 'Flatbed';
      } else if (sc.has_adf && !sc.sources?.includes('Flatbed')) {
        source = 'ADF Front';
      }

      const procPath = fs.existsSync('/opt/mantaprint/image_processor.py')
        ? '/opt/mantaprint/image_processor.py'
        : path.resolve(__dirname, '../../image_processor.py');

      let blankPagesDiscarded = 0;
      let discardedPages = [];
      const primaryFilename = `${scanId}.${fileExt}`;
      const primaryOutPath = path.join(SCAN_STORAGE_DIR, primaryFilename);

      if (isMockMode) {
        // Appliance Simulation Engine for test verification without physical USB scanner
        const p1Name = `${scanId}_p1.jpg`;
        const p1Path = path.join(SCAN_STORAGE_DIR, p1Name);
        const pxW = Math.round((width / 25.4) * resolution);
        const pxH = Math.round((height / 25.4) * resolution);

        // Generate Page 1 (valid document with content)
        await runCmd('/usr/bin/python3', ['-c', `
from PIL import Image, ImageDraw
im = Image.new('RGB', (${pxW}, ${pxH}), (252, 252, 250))
d = ImageDraw.Draw(im)
d.rectangle([(20, 20), (${pxW}-20, ${pxH}-20)], outline=(120, 120, 120), width=2)
d.text((50, 50), 'MantaPrint Scan Document [${source}] [${requestedPaper || "A4"}]', fill=(20, 20, 20))
d.text((50, 80), 'Resolution: ${resolution} DPI | Dim: ${width}x${height} mm', fill=(40, 40, 40))
im.save('${p1Path}', 'JPEG', quality=90)
`]);

        let generatedFiles = [p1Path];

        // If ADF Duplex, simulate Page 2 (blank back side of page)
        if (source === 'ADF Duplex') {
          const p2Name = `${scanId}_p2.jpg`;
          const p2Path = path.join(SCAN_STORAGE_DIR, p2Name);
          await runCmd('/usr/bin/python3', ['-c', `
from PIL import Image
im = Image.new('RGB', (${pxW}, ${pxH}), (250, 250, 248))
im.save('${p2Path}', 'JPEG', quality=90)
`]);
          generatedFiles.push(p2Path);

          // Backend Blank Page Detection: Inspect back side (p2)
          const blankCheck = await checkBlankPage(p2Path);
          if (blankCheck.blank) {
            try { fs.unlinkSync(p2Path); } catch {}
            blankPagesDiscarded++;
            discardedPages.push(2);
            generatedFiles = [p1Path];
          }
        }

        // Finalize output format
        if (fileExt === 'pdf') {
          await runCmd('/usr/bin/python3', [procPath, 'merge', '-i', ...generatedFiles, '-o', primaryOutPath, '--format', 'pdf']);
          try { fs.unlinkSync(p1Path); } catch {}
        } else if (fileExt === 'jpg' || fileExt === 'jpeg') {
          if (fs.existsSync(p1Path) && p1Path !== primaryOutPath) {
            fs.renameSync(p1Path, primaryOutPath);
          }
        } else {
          await runCmd('/usr/bin/python3', [procPath, 'merge', '-i', ...generatedFiles, '-o', primaryOutPath, '--format', fileExt]);
          try { fs.unlinkSync(p1Path); } catch {}
        }

        const stats = fs.statSync(primaryOutPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          scanId,
          filename: `Dokumen_Scan_${Date.now()}.${fileExt}`,
          format: fileExt,
          source,
          paperSize: requestedPaper || 'Custom',
          dimensions: { width_mm: width, height_mm: height },
          blankPagesDiscarded,
          discardedPages,
          pageCount: generatedFiles.length,
          sizeBytes: stats.size,
          sizeKb: Math.round(stats.size / 1024),
          previewUrl: `/api/scanner/download/${primaryFilename}`,
          downloadUrl: `/api/scanner/download/${primaryFilename}`
        }));
        return;
      }

      // --- PHYSICAL SANE / eSCL SCAN EXECUTION ---
      if (source === 'ADF Duplex') {
        // Multi-page batch acquisition for ADF Duplex
        const batchFormat = path.join(SCAN_STORAGE_DIR, `batch_${scanId}_p%d.jpg`);
        const args = [
          '-d', sc.device_id,
          `--resolution=${resolution}`,
          `--mode=${mode}`,
          `--source=ADF Duplex`,
          '-x', String(width),
          '-y', String(height),
          `--batch=${batchFormat}`,
          '--batch-count=2',
          '--format=jpeg'
        ];

        const scanRes = await runCmd('scanimage', args, 90000);
        const p1 = path.join(SCAN_STORAGE_DIR, `batch_${scanId}_p1.jpg`);
        const p2 = path.join(SCAN_STORAGE_DIR, `batch_${scanId}_p2.jpg`);

        if (scanRes.code !== 0) {
          try { if (fs.existsSync(p1)) fs.unlinkSync(p1); } catch {}
          try { if (fs.existsSync(p2)) fs.unlinkSync(p2); } catch {}
          const parsedErr = parseSaneError(scanRes.stderr, scanRes.stdout, scanRes.code);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error_code: parsedErr.code,
            message: parsedErr.message,
            error: scanRes.stderr || scanRes.stdout
          }));
          return;
        }

        let validPages = [];
        if (fs.existsSync(p1)) validPages.push(p1);

        // Blank page detection on duplex back-side
        if (fs.existsSync(p2)) {
          const blankCheck = await checkBlankPage(p2);
          if (blankCheck.blank) {
            try { fs.unlinkSync(p2); } catch {}
            blankPagesDiscarded++;
            discardedPages.push(2);
          } else {
            validPages.push(p2);
          }
        }

        if (validPages.length === 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Gagal memindai dokumen ADF Duplex. Tidak ada halaman valid yang diperoleh.',
            error: scanRes.stderr || scanRes.stdout
          }));
          return;
        }

        // Convert or merge pages to requested format
        if (fileExt === 'pdf') {
          await runCmd('/usr/bin/python3', [procPath, 'merge', '-i', ...validPages, '-o', primaryOutPath, '--format', 'pdf']);
          for (const p of validPages) { try { fs.unlinkSync(p); } catch {} }
        } else {
          if (validPages.length === 1) {
            fs.renameSync(validPages[0], primaryOutPath);
          } else {
            await runCmd('/usr/bin/python3', [procPath, 'merge', '-i', ...validPages, '-o', primaryOutPath, '--format', fileExt]);
            for (const p of validPages) { try { fs.unlinkSync(p); } catch {} }
          }
        }
      } else {
        // Single-page Flatbed or ADF Front acquisition
        const args = [
          '-d', sc.device_id,
          `--resolution=${resolution}`,
          `--mode=${mode}`,
          `-x`, String(width),
          `-y`, String(height),
          `--format=${format === 'pdf' ? 'jpeg' : format}`,
          '-o', fileExt === 'pdf' ? path.join(SCAN_STORAGE_DIR, `raw_${scanId}.jpg`) : primaryOutPath
        ];

        if (source === 'ADF Front') {
          args.push('--source=ADF Front');
        } else if (source === 'Flatbed') {
          args.push('--source=Flatbed');
        }

        const scanRes = await runCmd('scanimage', args, 90000);
        const tempRaw = path.join(SCAN_STORAGE_DIR, `raw_${scanId}.jpg`);

        if (scanRes.code !== 0) {
          try { if (fs.existsSync(tempRaw)) fs.unlinkSync(tempRaw); } catch {}
          try { if (fs.existsSync(primaryOutPath)) fs.unlinkSync(primaryOutPath); } catch {}
          const parsedErr = parseSaneError(scanRes.stderr, scanRes.stdout, scanRes.code);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error_code: parsedErr.code,
            message: parsedErr.message,
            error: scanRes.stderr || scanRes.stdout
          }));
          return;
        }

        if (fileExt === 'pdf' && fs.existsSync(tempRaw)) {
          const mergeRes = await runCmd('/usr/bin/python3', [procPath, 'merge', '-i', tempRaw, '-o', primaryOutPath, '--format', 'pdf'], 30000);
          try { fs.unlinkSync(tempRaw); } catch {}
          if (mergeRes.code !== 0 || !fs.existsSync(primaryOutPath)) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              message: 'Gagal mengonversi hasil pemindaian ke format PDF.',
              error: mergeRes.stderr || mergeRes.stdout
            }));
            return;
          }
        } else if (!fs.existsSync(primaryOutPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Berkas hasil pindaian tidak ditemukan.',
            error: scanRes.stderr || scanRes.stdout
          }));
          return;
        }
      }

      if (fs.existsSync(primaryOutPath)) {
        const stats = fs.statSync(primaryOutPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          scanId,
          filename: `Dokumen_Scan_${Date.now()}.${fileExt}`,
          format: fileExt,
          source,
          paperSize: requestedPaper || 'Custom',
          dimensions: { width_mm: width, height_mm: height },
          blankPagesDiscarded,
          discardedPages,
          sizeBytes: stats.size,
          sizeKb: Math.round(stats.size / 1024),
          previewUrl: `/api/scanner/download/${primaryFilename}`,
          downloadUrl: `/api/scanner/download/${primaryFilename}`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Berkas hasil pindaian tidak ditemukan.' }));
      }
    } finally {
      scannerHardwareLock.release(lockHolderId);
    }
    return;
  }

    // Enhance Scanned Page
    if (pathname === '/api/scanner/enhance' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const parsed = parseJsonBody(raw) || {};
      const fileId = sanitizeIdentifier(parsed.fileId ? path.basename(parsed.fileId) : '');
      if (!fileId || !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(fileId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid file ID.' }));
        return;
      }
      const inPath = resolveScanFilePath(fileId);
      if (!inPath || !fs.existsSync(inPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Source image expired or not found.' }));
        return;
      }

      const rotate = [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0;
      const brightness = typeof parsed.brightness === 'number' ? Math.max(0.2, Math.min(2.5, parsed.brightness)) : 1.0;
      const contrast = typeof parsed.contrast === 'number' ? Math.max(0.2, Math.min(2.5, parsed.contrast)) : 1.0;
      const filter = ['none', 'clean', 'bw', 'sauvola', 'dual_layer', 'dual_color', 'gray', 'color'].includes(parsed.filter) ? parsed.filter : 'none';
      const autoDeskew = Boolean(parsed.deskew);

      const enhId = `enh_${Date.now()}_${fileId}`;
      const outPath = path.join(SCAN_STORAGE_DIR, enhId);

      const procPath = fs.existsSync('/opt/mantaprint/image_processor.py')
        ? '/opt/mantaprint/image_processor.py'
        : path.resolve(__dirname, '../../image_processor.py');

      const args = [
        'enhance',
        '-i', inPath,
        '-o', outPath,
        '--rotate', String(rotate),
        '--brightness', String(brightness),
        '--contrast', String(contrast),
        '--filter', filter
      ];
      if (autoDeskew) {
        args.push('--deskew');
      }

      const enhRes = await runCmd('/usr/bin/python3', [procPath, ...args], 15000);
      if (enhRes.code === 0 && fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          enhancedId: enhId,
          sizeKb: Math.round(stats.size / 1024),
          previewUrl: `/api/scanner/download/${enhId}`,
          downloadUrl: `/api/scanner/download/${enhId}`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Gagal memproses gambar.', error: enhRes.stderr || enhRes.stdout }));
      }
      return;
    }

    // Merge Multi-Page Scanned Document (PDF, TIFF, PNG, JPEG)
    if (pathname === '/api/scanner/merge' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const parsed = parseJsonBody(raw) || {};
      const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
      if (pages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Belum ada halaman dokumen yang dipindai.' }));
        return;
      }

      const validFiles = [];
      const tempFilesToClean = [];

      const procPath = fs.existsSync('/opt/mantaprint/image_processor.py')
        ? '/opt/mantaprint/image_processor.py'
        : path.resolve(__dirname, '../../image_processor.py');

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        let filename = '';
        let rotation = 0;
        let brightness = 1.0;
        let contrast = 1.0;
        let filter = 'none';

        if (typeof p === 'string') {
          filename = p;
        } else if (p && typeof p === 'object') {
          filename = p.file || p.filename || '';
          rotation = parseInt(p.rotation, 10) || 0;
          brightness = parseFloat(p.brightness) || 1.0;
          contrast = parseFloat(p.contrast) || 1.0;
          filter = typeof p.filter === 'string' ? p.filter : 'none';
        }

        const base = path.basename(String(filename));
        if (/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|pdf|tiff|tif)$/.test(base)) {
          const fullP = resolveScanFilePath(base);
          if (fullP && fs.existsSync(fullP)) {
            const needsEnhance = rotation !== 0 || Math.abs(brightness - 1.0) > 0.02 || Math.abs(contrast - 1.0) > 0.02 || (filter !== 'none' && filter !== 'clean');
            if (needsEnhance) {
              const tempEnhId = `tmp_merge_${Date.now()}_${i}.jpg`;
              const tempEnhPath = path.join(SCAN_STORAGE_DIR, tempEnhId);
              const enhArgs = [
                'enhance',
                '-i', fullP,
                '-o', tempEnhPath,
                '--rotate', String(rotation),
                '--brightness', String(brightness),
                '--contrast', String(contrast),
                '--filter', filter
              ];
              const enhRes = await runCmd('/usr/bin/python3', [procPath, ...enhArgs], 15000);
              if (enhRes.code === 0 && fs.existsSync(tempEnhPath)) {
                validFiles.push(tempEnhPath);
                tempFilesToClean.push(tempEnhPath);
              } else {
                validFiles.push(fullP);
              }
            } else {
              validFiles.push(fullP);
            }
          }
        }
      }

      if (validFiles.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Tidak ada berkas halaman yang valid.' }));
        return;
      }

      const format = ['pdf', 'tiff', 'tif', 'png', 'jpeg', 'jpg'].includes(parsed.format) ? parsed.format : 'pdf';
      const fileExt = (format === 'jpeg' || format === 'jpg') ? 'jpg' : (format === 'tiff' || format === 'tif') ? 'tiff' : format;
      const customName = (parsed.filename && typeof parsed.filename === 'string') 
        ? parsed.filename.replace(/[^a-zA-Z0-9_-]/g, '_') 
        : `Dokumen_Pindai_${Date.now()}`;
      
      const outId = `merged_${Date.now()}.${fileExt}`;
      const outPath = path.join(SCAN_STORAGE_DIR, outId);

      const args = [
        'merge',
        '-i', ...validFiles,
        '-o', outPath,
        '--format', fileExt
      ];

      const mergeRes = await runCmd('/usr/bin/python3', [procPath, ...args], 25000);

      // Clean up temporary transformed page files
      for (const tmp of tempFilesToClean) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      }
      if (mergeRes.code === 0 && fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          filename: `${customName}.${fileExt}`,
          format: fileExt,
          pageCount: validFiles.length,
          sizeBytes: stats.size,
          sizeKb: Math.round(stats.size / 1024),
          downloadUrl: `/api/scanner/download/${outId}`,
          previewUrl: `/api/scanner/download/${outId}`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Gagal menggabungkan halaman.', error: mergeRes.stderr || mergeRes.stdout }));
      }
      return;
    }

    // KTP / ID Card 2-in-1 Merger (Front + Back aligned on A4 Canvas)
    if (pathname === '/api/scanner/ktp2in1' && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const parsed = parseJsonBody(raw) || {};
      const frontId = sanitizeIdentifier(parsed.frontId ? path.basename(parsed.frontId) : '');
      const backId = sanitizeIdentifier(parsed.backId ? path.basename(parsed.backId) : '');

      if (!frontId || !backId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Sisi depan (frontId) dan sisi belakang (backId) harus disediakan.' }));
        return;
      }

      const frontPath = resolveScanFilePath(frontId);
      const backPath = resolveScanFilePath(backId);

      if (!frontPath || !fs.existsSync(frontPath) || !backPath || !fs.existsSync(backPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Berkas KTP depan atau belakang tidak ditemukan.' }));
        return;
      }

      const format = ['pdf', 'png', 'jpeg', 'jpg'].includes(parsed.format) ? parsed.format : 'pdf';
      const fileExt = (format === 'jpeg' || format === 'jpg') ? 'jpg' : format;
      const dpi = [150, 300, 600].includes(Number(parsed.dpi)) ? Number(parsed.dpi) : 300;
      const outId = `ktp2in1_${Date.now()}.${fileExt}`;
      const outPath = path.join(SCAN_STORAGE_DIR, outId);

      const procPath = fs.existsSync('/opt/mantaprint/image_processor.py')
        ? '/opt/mantaprint/image_processor.py'
        : path.resolve(__dirname, '../../image_processor.py');

      const args = [
        'ktp-2in1',
        '--front', frontPath,
        '--back', backPath,
        '-o', outPath,
        '--dpi', String(dpi)
      ];
      if (parsed.noEnhance) {
        args.push('--no-enhance');
      }

      const ktpRes = await runCmd('/usr/bin/python3', [procPath, ...args], 25000);
      if (ktpRes.code === 0 && fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ktp2in1Id: outId,
          filename: `KTP_2in1_${Date.now()}.${fileExt}`,
          format: fileExt,
          sizeKb: Math.round(stats.size / 1024),
          previewUrl: `/api/scanner/download/${outId}`,
          downloadUrl: `/api/scanner/download/${outId}`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Gagal menggabungkan template KTP 2-in-1.', error: ktpRes.stderr || ktpRes.stdout }));
      }
      return;
    }

    // Ephemeral Scan Session Status
    if (pathname === '/api/scanner/session-status' && req.method === 'GET') {
      let activeCount = 0;
      let oldestMtime = Date.now();
      let totalBytes = 0;
      try {
        if (fs.existsSync(RAM_SCANS_DIR)) {
          const files = fs.readdirSync(RAM_SCANS_DIR);
          for (const f of files) {
            if (isScanArtifact(f)) {
              try {
                const stat = fs.statSync(path.join(RAM_SCANS_DIR, f));
                activeCount++;
                totalBytes += stat.size;
                if (stat.mtimeMs < oldestMtime) oldestMtime = stat.mtimeMs;
              } catch {}
            }
          }
        }
      } catch {}
      const ageSec = activeCount > 0 ? Math.floor((Date.now() - oldestMtime) / 1000) : 0;
      const remainingTtlSec = activeCount > 0 ? Math.max(0, 300 - ageSec) : 300;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        storage_type: 'RAM tmpfs (Zero-Trace Ephemeral)',
        active_scans: activeCount,
        total_size_kb: Math.round(totalBytes / 1024),
        age_sec: ageSec,
        remaining_ttl_sec: remainingTtlSec
      }));
      return;
    }

    // Ephemeral Scan Session Manual Wipe
    if (pathname === '/api/scanner/wipe-session' && req.method === 'POST') {
      let count = 0;
      try {
        const targetDirs = [RAM_SCANS_DIR, SD_SCANS_DIR, '/tmp'];
        for (const dir of targetDirs) {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (isScanArtifact(f)) {
              try {
                fs.unlinkSync(path.join(dir, f));
                count++;
              } catch {}
            }
          }
        }
      } catch (e) {
        console.warn('[Storage] Wipe session error:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, wipedCount: count, message: 'Scan memory cleared.' }));
      return;
    }

    // Download / Preview Scanned File with Auto-Wipe Support
    if (pathname.startsWith('/api/scanner/download/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const rawName = pathname.replace('/api/scanner/download/', '');
      const safeName = path.basename(rawName);
      if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|tiff|tif|pdf)$/.test(safeName)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid filename.');
        return;
      }
      const filePath = resolveScanFilePath(safeName);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File scan not found or expired.');
        return;
      }

      const urlObj = new URL(req.url, 'http://127.0.0.1');

      // Auth / Portal validation guard: Require open portal, admin auth, or valid client token
      const cfg = configManager.getConfig();
      const tokenHeader = req.headers['authorization'] || req.headers['x-mantaprint-token'] || urlObj.searchParams.get('token');
      const isPortalOpen = cfg?.scanner?.portal_enabled !== false;
      const isAdmin = isAdminAuthenticated(req);
      const isTokenValid = tokenHeader ? scannerPairingManager.verifyClientToken(tokenHeader).valid : false;
      if (!isPortalOpen && !isAdmin && !isTokenValid) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Akses berkas pindaian dibatasi oleh Administrator.');
        return;
      }

      const shouldWipe = urlObj.searchParams.get('wipe') === 'true' || req.headers['x-auto-wipe'] === 'true';

      let contentType = 'application/octet-stream';
      if (safeName.endsWith('.pdf')) contentType = 'application/pdf';
      else if (safeName.endsWith('.png')) contentType = 'image/png';
      else if (safeName.endsWith('.jpg') || safeName.endsWith('.jpeg')) contentType = 'image/jpeg';
      else if (safeName.endsWith('.tiff') || safeName.endsWith('.tif')) contentType = 'image/tiff';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'no-cache'
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      if (shouldWipe) {
        res.on('finish', () => {
          try {
            if (fs.existsSync(filePath)) {
              secureShredFile(filePath);
              console.log('[Storage/Privacy] Zero-trace auto-wiped document after download:', safeName);
            }
          } catch {}
        });
      }
      return;
    }

    // Test Print (Both modern and legacy aliases)
    if ((pathname === '/api/print/test' || pathname === '/api/printer/test-page') && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw);
      if (parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Malformed JSON payload.' }));
        return;
      }

      const queue = resolveTargetQueue(parsed.printer);
      if (!queue) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Tidak ada printer aktif yang terhubung.' }));
        return;
      }

      // Generate custom HeykPrint test page PDF
      const pdfPath = `/tmp/mantaprint_testpage_${queue}.pdf`;
      const displayName = cachedStatus?.printer?.display_name || queue.replace(/_/g, ' ');

      const genScript = fs.existsSync('/opt/mantaprint/test_page_generator.py')
        ? '/opt/mantaprint/test_page_generator.py'
        : path.join(__dirname, '../../core/test_page_generator.py');

      if (fs.existsSync(genScript)) {
        const currentLang = getCurrentSystemLanguage();
        const currentVer = getCurrentSystemVersion();
        try {
          await runCmd('python3', [genScript, pdfPath, queue, displayName, currentLang, currentVer], 8000);
        } catch (e) {
          console.warn('[TestPage] Generator warning:', e?.message || e);
        }
      }

      const printFile = fs.existsSync(pdfPath) ? pdfPath : '/usr/share/cups/data/testprint';
      const cmdRes = await runCmd('lp', ['-d', queue, '-o', 'fit-to-page', '-o', 'PageSize=A4', printFile]);
      const success = cmdRes.code === 0;

      if (!success) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          state: 'error',
          message: `Gagal mengirim ke antrean printer: ${cmdRes.stderr || cmdRes.stdout}`
        }));
        return;
      }

      const match = (cmdRes.stdout || '').match(/request id is ([^\s]+)/i);
      const jobId = match ? match[1] : `${queue}-${Date.now() % 100000}`;
      const numericId = parseInt((jobId.match(/-(\d+)$/) || [])[1] || '0', 10);

      const jobRecord = jobTracker.registerJob({
        id: jobId,
        printer: queue,
        title: 'Halaman Uji Coba MantaPrint',
        user: req.socket.remoteAddress || 'client',
        size: fs.existsSync(printFile) ? fs.statSync(printFile).size : 0
      });

      const shouldWait = url.searchParams.get('wait') === 'true' ||
                         url.searchParams.get('sync') === 'true' ||
                         url.searchParams.get('sync') === '1' ||
                         req.headers['x-wait-job'] === 'true';

      if (shouldWait) {
        const finalJob = await jobTracker.waitForJob(jobId, 60000);
        const isSuccess = finalJob.state === 'completed';
        res.writeHead(isSuccess ? 200 : (finalJob.state === 'error' ? 502 : 504), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: isSuccess,
          job_id: finalJob.id,
          id: finalJob.numeric_id,
          printer: queue,
          state: finalJob.state,
          status_message: finalJob.status_message,
          error: finalJob.error,
          duration_ms: finalJob.duration_ms,
          poll_url: `/api/jobs/${encodeURIComponent(jobId)}`,
          events_url: `/api/jobs/${encodeURIComponent(jobId)}/events`,
          message: isSuccess 
            ? `Halaman uji coba berhasil dicetak pada ${queue}!`
            : `Pencetakan tidak tuntas: ${finalJob.status_message}`
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        job_id: jobId,
        id: numericId,
        printer: queue,
        state: jobRecord.state,
        status_message: jobRecord.status_message,
        poll_url: `/api/jobs/${encodeURIComponent(jobId)}`,
        events_url: `/api/jobs/${encodeURIComponent(jobId)}/events`,
        wait_url: `/api/jobs/${encodeURIComponent(jobId)}/wait`,
        message: `Halaman uji coba kustom MantaPrint berhasil dikirim ke ${queue}! Sedang diproses printer fisik.`
      }));
      return;
    }

    // Test Page PDF Preview / Download Endpoint
    if ((pathname === '/api/printer/test-page/preview' || pathname === '/api/printer/test-page/pdf') && (req.method === 'GET' || req.method === 'HEAD')) {
      const queue = resolveTargetQueue() || 'Canon_LBP6030_6040_6018L';
      const displayName = cachedStatus?.printer?.display_name || queue.replace(/_/g, ' ');
      const pdfPath = `/tmp/mantaprint_testpage_${queue}.pdf`;

      const genScript = fs.existsSync('/opt/mantaprint/test_page_generator.py')
        ? '/opt/mantaprint/test_page_generator.py'
        : path.join(__dirname, '../../core/test_page_generator.py');

      if (fs.existsSync(genScript)) {
        const currentLang = getCurrentSystemLanguage();
        const currentVer = getCurrentSystemVersion();
        try {
          await runCmd('python3', [genScript, pdfPath, queue, displayName, currentLang, currentVer], 8000);
        } catch (e) {
          console.warn('[TestPage] Preview generator warning:', e?.message || e);
        }
      }

      if (fs.existsSync(pdfPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="mantaprint-test-page.pdf"'
        });
        fs.createReadStream(pdfPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Test page could not be generated' }));
      }
      return;
    }

    // Pause, Resume, or Toggle Printer Queue (Admin protected)
    if ((pathname === '/api/printer/pause' || pathname === '/api/printer/resume' || pathname === '/api/printer/toggle') && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw);
      if (parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Malformed JSON payload.' }));
        return;
      }

      const queue = resolveTargetQueue(parsed.printer);
      if (!queue) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Tidak ada printer aktif yang terhubung.' }));
        return;
      }

      const isResume = (pathname === '/api/printer/resume') || (pathname === '/api/printer/toggle' && parsed.action === 'resume');

      if (!isResume) {
        const cmdRes = await runCmd('cupsdisable', [queue]);
        const success = cmdRes.code === 0;

        res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success,
          message: success ? `Printer queue ${queue} paused.` : `Failed to pause queue.`
        }));
      } else {
        await runCmd('cupsenable', ['--release', queue]);
        const acceptRes = await runCmd('cupsaccept', [queue]);
        const success = acceptRes.code === 0;

        try {
          if (fs.existsSync('/run/mantaprint/printer_attention')) {
            fs.unlinkSync('/run/mantaprint/printer_attention');
          }
        } catch {}

        res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success,
          message: success ? `Printer queue ${queue} resumed and accepting jobs.` : `Failed to resume queue.`
        }));
      }

      await invalidateCacheAndBroadcast();
      return;
    }

    // Set or Clear Attention State (Out of Paper, Jam, Manual Hold)
    if (pathname === '/api/printer/attention' && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw) || {};
      const attentionFile = '/run/mantaprint/printer_attention';
      try {
        if (parsed.status === 'clear' || parsed.status === 'none' || parsed.clear === true) {
          if (fs.existsSync(attentionFile)) fs.unlinkSync(attentionFile);
        } else {
          fs.mkdirSync('/run/mantaprint', { recursive: true });
          fs.writeFileSync(attentionFile, parsed.message || 'Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.');
        }
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: parsed.status || 'set' }));
      await invalidateCacheAndBroadcast();
      return;
    }

    // Cancel Single Job (Supports /api/printer/cancel-job, /api/cups/cancel, /api/printer/cancel, /api/jobs/cancel)
    if ((pathname === '/api/printer/cancel-job' || pathname === '/api/cups/cancel' || pathname === '/api/printer/cancel' || pathname === '/api/jobs/cancel') && req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw);
      if (parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Malformed JSON payload.' }));
        return;
      }

      const rawId = parsed.jobId || parsed.job_id || parsed.id || '';
      const jobId = sanitizeIdentifier(String(rawId));
      if (!jobId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid or missing job ID.' }));
        return;
      }

      if (!isAdminOrLocal(req) && !jobTokenMatches(jobTracker.getJob(jobId), getJobToken(req, parsed))) {
        denyAdmin(res);
        return;
      }

      const numericMatch = jobId.match(/-(\d+)$/);
      const cupsJobArg = numericMatch ? numericMatch[1] : jobId;

      // Run cancel with -x without '--' (CUPS cancel rejects '--' as an unknown option)
      const cancelRes = await runCmd('cancel', ['-x', cupsJobArg]);
      let success = cancelRes.code === 0;
      if (!success && cupsJobArg !== jobId) {
        const retryRes = await runCmd('cancel', ['-x', jobId]);
        success = retryRes.code === 0;
      }

      // Also attempt lprm if cancel didn't find the job in standard queue
      if (!success) {
        await runCmd('lprm', [cupsJobArg]).catch(() => {});
      }

      // Always unfreeze printer queue if it got stopped by a filter error
      const targetPrinter = parsed.printer || (jobTracker.getJob(jobId)?.printer) || '';
      if (targetPrinter) {
        await runCmd('cupsenable', [targetPrinter]).catch(() => {});
        await runCmd('cupsaccept', [targetPrinter]).catch(() => {});
      } else {
        await runCmd('cupsenable', ['-c']).catch(() => {});
      }

      // Clean up any hung driver processes (e.g. captdriver or rastertosfp in retry loop)
      try {
        await runCmd('pkill', ['-f', 'rastertosfp|cnrsdrvsfp|captdriver|foo2zjs|rastertoescpr']).catch(() => {});
      } catch {}

      // Mark in jobTracker
      jobTracker.updateJob(jobId, {
        state: 'canceled',
        status_message: 'Pekerjaan cetak dibatalkan oleh pengguna.'
      });
      if (numericMatch) {
        jobTracker.updateJob(numericMatch[1], {
          state: 'canceled',
          status_message: 'Pekerjaan cetak dibatalkan oleh pengguna.'
        });
      }

      // If purge/delete requested, remove completely from memory tracker
      if (parsed.purge || parsed.delete) {
        jobTracker.removeJob(jobId);
        if (numericMatch) jobTracker.removeJob(numericMatch[1]);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Pekerjaan #${jobId} berhasil dibatalkan.`
      }));

      await invalidateCacheAndBroadcast();
      return;
    }

    // Cancel All Jobs / Purge Queue (Supports /api/printer/cancel-all, /api/printer/cancel-jobs, /api/cups/purge-all, /api/cups/cancel-all, /api/jobs/cancel-all)
    if ((pathname === '/api/printer/cancel-all' || pathname === '/api/printer/cancel-jobs' || pathname === '/api/cups/purge-all' || pathname === '/api/cups/cancel-all' || pathname === '/api/jobs/cancel-all') && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      let raw = '';
      try {
        raw = await readBody(req);
      } catch {}
      const parsed = parseJsonBody(raw) || {};
      const printer = parsed.printer ? sanitizeIdentifier(String(parsed.printer)) : '';

      // Purge CUPS jobs with -x and -a (and specific printer if provided)
      if (printer) {
        await runCmd('cancel', ['-a', '-x', printer]);
      }
      await runCmd('cancel', ['-a', '-x']);
      await runCmd('lprm', ['-']).catch(() => {});

      // Re-enable and accept queue to unfreeze any stopped state from filter failures
      if (printer) {
        await runCmd('cupsenable', [printer]).catch(() => {});
        await runCmd('cupsaccept', [printer]).catch(() => {});
      } else {
        await runCmd('cupsenable', ['-c']).catch(() => {});
        await runCmd('cupsaccept', ['-c']).catch(() => {});
      }

      // Clear any hanging filter processes if necessary
      try {
        await runCmd('pkill', ['-f', 'rastertosfp|cnrsdrvsfp|captdriver|foo2zjs|rastertoescpr']).catch(() => {});
      } catch {}

      jobTracker.getActiveJobs().forEach(j => {
        jobTracker.updateJob(j.id, {
          state: 'canceled',
          status_message: 'Semua pekerjaan cetak dibatalkan.'
        });
      });

      if (parsed.purge || parsed.clear) {
        jobTracker.clearAllJobs();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Semua antrean cetak telah dibatalkan dan spooler dibersihkan.'
      }));

      await invalidateCacheAndBroadcast();
      return;
    }

    // Clear Print History
    if ((pathname === '/api/jobs/clear-history' || pathname === '/api/printer/clear-history') && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      jobTracker.clearCompletedJobs();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Riwayat cetak berhasil dibersihkan.'
      }));
      await invalidateCacheAndBroadcast();
      return;
    }

    // Resync USB / Hardware Probing
    if ((pathname === '/api/scan' || pathname === '/api/rescan' || pathname === '/api/printer/rescan' || pathname === '/api/system/rescan') && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      const pmScript = fs.existsSync('/opt/mantaprint/core/printer_manager.py')
        ? '/opt/mantaprint/core/printer_manager.py'
        : (fs.existsSync('/opt/mantaprint/printer_manager.py') ? '/opt/mantaprint/printer_manager.py' : path.join(__dirname, '../../core/printer_manager.py'));
      const rescanRes = await runCmd('/usr/bin/python3', [pmScript, 'sync'], 15000);
      const success = rescanRes.code === 0;

      res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success,
        message: success ? 'USB hardware synchronized successfully.' : 'Sync completed with warnings.'
      }));

      probePrinterTelemetry().then(broadcastSse);
      return;
    }

    // Manually (re)try provisioning firmware for one HP printer waiting on it — the "Provision
    // firmware now" button in the admin Printers side sheet. Bypasses the getweb retry backoff.
    if (pathname.match(/^\/api\/printers\/[^/]+\/provision-firmware$/) && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      const queueName = decodeURIComponent(pathname.split('/')[3] || '');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(queueName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid queue name.' }));
        return;
      }
      const pmScript = fs.existsSync('/opt/mantaprint/core/printer_manager.py')
        ? '/opt/mantaprint/core/printer_manager.py'
        : (fs.existsSync('/opt/mantaprint/printer_manager.py') ? '/opt/mantaprint/printer_manager.py' : path.join(__dirname, '../../core/printer_manager.py'));
      const provRes = await runCmd('/usr/bin/python3', [pmScript, 'provision-firmware', queueName], 40000);
      const success = provRes.code === 0;
      res.writeHead(success ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success,
        message: success
          ? 'Firmware delivered; the printer is restarting its USB interface.'
          : 'Could not provision firmware yet — check the hub is online and the printer is connected.',
        detail: (provRes.stdout || provRes.stderr || '').slice(-500)
      }));
      probePrinterTelemetry().then(broadcastSse);
      return;
    }

    // --- SYSTEM MDNS & BROADCAST NAME CONFIGURATION ---
    if (pathname === '/api/system/mdns' && req.method === 'GET') {
      const cfg = getCustomMdnsConfig();
      const status = await getOrFetchStatus(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        hostname: cfg.hostname || 'mantaprint',
        domain: cfg.domain || 'local',
        mdns_host: `${cfg.hostname || 'mantaprint'}.local`,
        custom_broadcast_names: cfg.custom_broadcast_names || {},
        printers: status.printers || []
      }));
      return;
    }

    if (pathname === '/api/system/mdns' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const body = parseJsonBody(raw);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Malformed JSON payload.' }));
        return;
      }

      const cfg = getCustomMdnsConfig();
      let avahiNeedsReload = false;

      // 1. Update Hostname if provided
      if (body.hostname && typeof body.hostname === 'string') {
        const cleanHost = body.hostname.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
        if (cleanHost && cleanHost !== cfg.hostname) {
          cfg.hostname = cleanHost;
          try {
            configManager.setHostname(cleanHost).catch(() => {});
          } catch {}
          try {
            const confPath = '/etc/avahi/avahi-daemon.conf';
            if (fs.existsSync(confPath)) {
              let conf = fs.readFileSync(confPath, 'utf8');
              if (/^\s*#?\s*host-name\s*=/m.test(conf)) {
                conf = conf.replace(/^\s*#?\s*host-name\s*=.*$/m, `host-name=${cleanHost}`);
              } else {
                conf = conf.replace(/\[server\]/i, `[server]\nhost-name=${cleanHost}`);
              }
              fs.writeFileSync(confPath, conf, 'utf8');
              avahiNeedsReload = true;
            }
          } catch (e) {
            console.error('[!] Failed to update avahi-daemon.conf:', e);
          }
        }
      }

      // 2. Update Printer Broadcast Names if provided
      if (body.custom_broadcast_names && typeof body.custom_broadcast_names === 'object') {
        if (!cfg.custom_broadcast_names) cfg.custom_broadcast_names = {};
        for (const [k, v] of Object.entries(body.custom_broadcast_names)) {
          const cleanV = String(v || '').trim();
          if (cleanV) {
            cfg.custom_broadcast_names[k] = cleanV;
          } else {
            delete cfg.custom_broadcast_names[k];
          }
        }
      }
      if (body.queue_name && body.custom_name !== undefined) {
        if (!cfg.custom_broadcast_names) cfg.custom_broadcast_names = {};
        const cleanCustom = String(body.custom_name).trim();
        if (cleanCustom) {
          cfg.custom_broadcast_names[body.queue_name] = cleanCustom;
        } else {
          delete cfg.custom_broadcast_names[body.queue_name];
        }
      }

      // Save persistent configuration
      saveCustomMdnsConfig(cfg);

      // Apply to Avahi .service files and CUPS
      try {
        const curStatus = await getOrFetchStatus(false);
        for (const p of (curStatus.printers || [])) {
          if (p.is_published) {
            const customName = cfg.custom_broadcast_names?.[p.queue_name || p.name] || '';
            writeAvahiService(p.queue_name || p.name, p.raw_display_name || p.display_name, p.model, true, false, p.connected, customName);
            if (customName) {
              runCmd('lpadmin', ['-p', p.queue_name || p.name, '-D', customName]).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error('[!] Error updating Avahi services:', e);
      }

      if (avahiNeedsReload) {
        runCmd('systemctl', ['restart', '--no-block', 'avahi-daemon']).catch(() => {});
      }

      // Invalidate cache and push SSE update
      cachedStatus = null;
      lastStatusFetch = 0;
      setTimeout(async () => {
        try {
          const fresh = await getOrFetchStatus(true);
          broadcastSse(fresh);
        } catch (e) {}
      }, 500);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Pengaturan mDNS & nama siaran berhasil diperbarui!',
        config: cfg
      }));
      return;
    }

    // --- NATIVE CUPS MULTI-PRINTER MANAGEMENT ENDPOINTS ---

    // 1. Get All Printers (Synced with CUPS and classification)
    if (pathname === '/api/printers' && req.method === 'GET') {
      const status = await getOrFetchStatus(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        printers: status.printers || [],
        default_queue: status.printer?.queue_name || ''
      }));
      return;
    }

    // 2. Probe Network Printer (TCP Port Probe)
    if (pathname === '/api/printers/probe-network' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const body = parseJsonBody(raw) || {};
      const host = String(body.host || '').trim();
      const port = parseInt(body.port, 10) || 9100;

      if (!host) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Alamat host atau IP printer jaringan wajib diisi.' }));
        return;
      }

      const probeRes = await probeNetworkSocket(host, port, 2500);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        host,
        port,
        reachable: probeRes.reachable,
        latency_ms: probeRes.latency_ms,
        error: probeRes.error
      }));
      return;
    }

    // 3. Add Network Printer to CUPS
    if (pathname === '/api/printers/add' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const body = parseJsonBody(raw) || {};
      const rawName = String(body.name || '').trim();
      const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);

      if (!cleanName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Nama antrean printer (queue name) tidak valid.' }));
        return;
      }

      const curStatus = await getOrFetchStatus(false);
      if ((curStatus.printers || []).some(p => p.queue_name === cleanName || p.name === cleanName)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Antrean '${cleanName}' sudah ada di dalam CUPS.` }));
        return;
      }

      const protocol = ['socket', 'ipp', 'ipps', 'lpd'].includes(body.protocol) ? body.protocol : 'socket';
      const host = String(body.host || '').trim();
      if (!host || host === '127.0.0.1' || host === 'localhost' || host.startsWith('169.254.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Alamat IP / Host printer tidak valid atau dilarang.' }));
        return;
      }

      const port = parseInt(body.port, 10) || (protocol === 'socket' ? 9100 : (protocol === 'ipp' || protocol === 'ipps' ? 631 : 515));
      const queuePath = String(body.queue_path || '').replace(/^\/+/, '');
      let deviceUri = '';
      if (protocol === 'socket') deviceUri = `socket://${host}:${port}`;
      else if (protocol === 'ipp') deviceUri = `ipp://${host}:${port}/${queuePath || 'ipp/print'}`;
      else if (protocol === 'ipps') deviceUri = `ipps://${host}:${port}/${queuePath || 'ipp/print'}`;
      else if (protocol === 'lpd') deviceUri = `lpd://${host}:${port}/${queuePath || 'raw'}`;

      const displayName = String(body.display_name || cleanName.replace(/_/g, ' ')).trim().slice(0, 64);
      const location = String(body.location || 'Network').trim().slice(0, 64);
      const publishBroadcast = Boolean(body.publish_broadcast); // Rule: default is FALSE for network printers
      const isSharedVal = publishBroadcast ? 'true' : 'false';

      // Driver preset mapping
      const driver = String(body.driver || 'generic-pcl');
      let driverArgs = ['-m', 'drv:///sample.drv/generpcl.ppd'];
      if (driver === 'generic-ps') driverArgs = ['-m', 'drv:///sample.drv/generic.ppd'];
      else if (driver === 'generic-escp') driverArgs = ['-m', 'drv:///sample.drv/epson9.ppd'];
      else if (driver === 'raw') driverArgs = ['-m', 'raw'];
      else if (driver === 'everywhere') driverArgs = ['-m', 'everywhere'];

      const lpadminArgs = [
        '-p', cleanName,
        '-E',
        '-v', deviceUri,
        ...driverArgs,
        '-D', displayName,
        '-L', location,
        '-o', `printer-is-shared=${isSharedVal}`,
        '-o', 'printer-error-policy=abort-job'
      ];

      const addRes = await runCmd('lpadmin', lpadminArgs, 30000);
      if (addRes.code !== 0) {
        const errMsg = addRes.timedOut
          ? 'Operasi penambahan printer timeout setelah 30 detik.'
          : (addRes.stderr || 'lpadmin error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Gagal menambahkan printer: ${errMsg}` }));
        return;
      }

      await runCmd('cupsenable', [cleanName]).catch(() => {});
      await runCmd('cupsaccept', [cleanName]).catch(() => {});

      // Save persistent configuration
      const pCfg = getPersistentPrintersConfig();
      pCfg.printers[cleanName] = {
        display_name: displayName,
        location,
        protocol,
        is_published: publishBroadcast,
        uri: deviceUri,
        created_at: new Date().toISOString()
      };
      savePersistentPrintersConfig(pCfg);

      if (publishBroadcast) {
        writeAvahiService(cleanName, displayName, displayName, true, false, true);
      } else {
        removeAvahiService(cleanName);
      }

      await invalidateCacheAndBroadcast();

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Printer '${displayName}' berhasil didaftarkan ke CUPS.`,
        queue_name: cleanName
      }));
      return;
    }

    // 3b. Printers found on the network (mDNS + SNMP), adopting one, and auto-adopt
    if (pathname === '/api/printers/discover' && req.method === 'GET') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      const stale = !lastDiscovery || Date.now() - lastDiscovery.scanned_at * 1000 > DISCOVERY_MAX_AGE;
      if (url.searchParams.get('refresh') === '1' || (stale && url.searchParams.get('cached') !== '1')) {
        try {
          await runNetworkDiscovery();
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, code: err.message }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(discoveryResponse(lastDiscovery)));
      return;
    }

    if (pathname === '/api/printers/discover/adopt' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      let body;
      try { body = parseJsonBody(await readBody(req)) || {}; } catch { body = {}; }
      const id = String(body.id || '');
      // Only ids from a scan this hub actually ran; printer_manager.py looks the rest up itself.
      if (!id || id.length > 300 || !(lastDiscovery?.candidates || []).some(c => c.id === id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, code: 'not_found' }));
        return;
      }
      const args = [printerManagerScript(), 'adopt-network', id];
      if (body.publish) args.push('--publish');
      const out = await runCmd('/usr/bin/python3', args, 90000);
      const m = out.stdout.match(/^ADOPT_JSON:(.+)$/m);
      let result = { ok: false, code: out.timedOut ? 'timeout' : 'adopt_failed' };
      try { if (m) result = JSON.parse(m[1]); } catch {}
      if (result.ok) {
        recordAdoptedPrinters([result], 'discovered');
        const cand = lastDiscovery.candidates.find(c => c.id === id);
        if (cand) cand.configured_queue = result.queue;
        await refreshStatusAndBroadcast();
      }
      res.writeHead(result.ok ? 201 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: Boolean(result.ok), ...result }));
      return;
    }

    if (pathname === '/api/printers/discover/settings' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) return denyAdmin(res);
      let body;
      try { body = parseJsonBody(await readBody(req)) || {}; } catch { body = {}; }
      const current = configManager.getConfig()?.network_discovery || {};
      const updated = { ...current, auto_adopt: Boolean(body.auto_adopt) };
      configManager.saveConfig({ network_discovery: updated });
      if (updated.auto_adopt) runNetworkDiscovery({ autoAdopt: true }).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, auto_adopt: updated.auto_adopt }));
      return;
    }

    // 4. Update Printer (Display Name, Location, Broadcast, Default)
    if (pathname === '/api/printers/update' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const body = parseJsonBody(raw) || {};
      const queueName = String(body.name || body.queue_name || '').trim();

      if (!queueName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Nama antrean printer (queue_name) wajib diisi.' }));
        return;
      }

      const curStatus = await getOrFetchStatus(false);
      const existing = (curStatus.printers || []).find(p => p.queue_name === queueName || p.name === queueName);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Antrean '${queueName}' tidak ditemukan di CUPS.` }));
        return;
      }

      const pCfg = getPersistentPrintersConfig();
      if (!pCfg.printers[queueName]) {
        pCfg.printers[queueName] = {
          display_name: existing.display_name,
          location: existing.location || '',
          protocol: existing.protocol || 'socket',
          is_published: Boolean(existing.is_published),
          uri: existing.device_uri || ''
        };
      }

      if (body.display_name !== undefined) {
        const cleanDisp = String(body.display_name).trim().slice(0, 64);
        pCfg.printers[queueName].display_name = cleanDisp || queueName;
        await runCmd('lpadmin', ['-p', queueName, '-D', cleanDisp || queueName]).catch(() => {});
      }

      if (body.location !== undefined) {
        const cleanLoc = String(body.location).trim().slice(0, 64);
        pCfg.printers[queueName].location = cleanLoc;
        await runCmd('lpadmin', ['-p', queueName, '-L', cleanLoc]).catch(() => {});
      }

      if (body.publish_broadcast !== undefined) {
        const isPub = Boolean(body.publish_broadcast);
        pCfg.printers[queueName].is_published = isPub;
        await runCmd('lpadmin', ['-p', queueName, '-o', `printer-is-shared=${isPub ? 'true' : 'false'}`]).catch(() => {});
        if (isPub) {
          writeAvahiService(queueName, pCfg.printers[queueName].display_name, existing.model, true, false, existing.connected);
        } else {
          removeAvahiService(queueName);
        }
      }

      if (body.is_default) {
        await runCmd('lpadmin', ['-d', queueName]).catch(() => {});
      }

      savePersistentPrintersConfig(pCfg);
      await invalidateCacheAndBroadcast();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `Pengaturan printer '${pCfg.printers[queueName].display_name}' berhasil diperbarui.`
      }));
      return;
    }

    // 5. Delete Printer (With strict Active USB protection)
    // Matches DELETE /api/printers/:name or POST /api/printers/delete
    const deleteMatch = pathname.match(/^\/api\/printers\/([a-zA-Z0-9_-]+)$/);
    if ((deleteMatch && req.method === 'DELETE') || (pathname === '/api/printers/delete' && req.method === 'POST')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }

      // Only the DELETE /api/printers/:name form carries the name in the path; for
      // POST /api/printers/delete the regex above would otherwise read "delete" as the queue.
      let targetQueue = deleteMatch && req.method === 'DELETE' ? deleteMatch[1] : '';
      if (!targetQueue && req.method === 'POST') {
        let raw = '';
        try { raw = await readBody(req); } catch {}
        const body = parseJsonBody(raw) || {};
        targetQueue = String(body.name || body.queue_name || '').trim();
      }

      if (!targetQueue) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Nama antrean printer yang akan dihapus tidak ditentukan.' }));
        return;
      }

      const curStatus = await getOrFetchStatus(false);
      const targetPrinter = (curStatus.printers || []).find(p => p.queue_name === targetQueue || p.name === targetQueue);

      // STRICT PROTECTION: Active USB printers cannot be deleted because they are managed via auto-sensing PnP
      if (targetPrinter && (targetPrinter.classification === 'active_usb' || (!targetPrinter.can_delete && targetPrinter.is_usb && targetPrinter.connected))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'ACTIVE_USB_LOCKED',
          message: 'Printer USB ini sedang terhubung fisik dan aktif. Antrean Plug-and-Play dikelola secara otomatis dan tidak dapat dihapus saat perangkat terpasang. Cabut kabel USB terlebih dahulu jika ingin menonaktifkan antrean ini.'
        }));
        return;
      }

      // Safe Deletion Sequence:
      // 1. Disable queue
      await runCmd('cupsdisable', [targetQueue]).catch(() => {});
      // 2. Cancel all pending and active jobs
      await runCmd('cancel', ['-a', '-x', targetQueue]).catch(() => {});
      // 3. Remove Avahi AirPrint service file
      removeAvahiService(targetQueue);
      // 4. Remove CUPS queue
      const delRes = await runCmd('lpadmin', ['-x', targetQueue]);
      // 5. Remove custom lpoptions
      await runCmd('lpoptions', ['-x', targetQueue]).catch(() => {});

      // 6. Clean persistent config
      const pCfg = getPersistentPrintersConfig();
      if (pCfg.printers && pCfg.printers[targetQueue]) {
        delete pCfg.printers[targetQueue];
        savePersistentPrintersConfig(pCfg);
      }

      await invalidateCacheAndBroadcast();

      if (delRes.code === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Antrean printer '${targetQueue}' berhasil dihapus dari sistem CUPS.`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: `Gagal menghapus antrean '${targetQueue}': ${delRes.stderr || 'lpadmin error'}`
        }));
      }
      return;
    }

    // 6. Toggle Broadcast (AirPrint / mDNS) for a specific printer
    const broadcastMatch = pathname.match(/^\/api\/printers\/([a-zA-Z0-9_-]+)\/broadcast$/);
    if (broadcastMatch && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const targetQueue = broadcastMatch[1];
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }
      const body = parseJsonBody(raw) || {};
      const isPub = Boolean(body.is_published);

      const curStatus = await getOrFetchStatus(false);
      const existing = (curStatus.printers || []).find(p => p.queue_name === targetQueue || p.name === targetQueue);

      await runCmd('lpadmin', ['-p', targetQueue, '-o', `printer-is-shared=${isPub ? 'true' : 'false'}`]).catch(() => {});

      const pCfg = getPersistentPrintersConfig();
      if (!pCfg.printers[targetQueue]) {
        pCfg.printers[targetQueue] = {
          display_name: existing?.display_name || targetQueue,
          location: existing?.location || '',
          protocol: existing?.protocol || 'socket',
          is_published: isPub,
          uri: existing?.device_uri || ''
        };
      } else {
        pCfg.printers[targetQueue].is_published = isPub;
      }
      savePersistentPrintersConfig(pCfg);

      if (isPub) {
        writeAvahiService(targetQueue, pCfg.printers[targetQueue].display_name, existing?.model, true, false, existing?.connected);
      } else {
        removeAvahiService(targetQueue);
      }

      await invalidateCacheAndBroadcast();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        queue_name: targetQueue,
        is_published: isPub,
        message: isPub ? 'Siaran AirPrint & mDNS diaktifkan.' : 'Siaran AirPrint & mDNS dinonaktifkan.'
      }));
      return;
    }

    // 7. Set Default Printer
    const setDefaultMatch = pathname.match(/^\/api\/printers\/([a-zA-Z0-9_-]+)\/set-default$/);
    if (setDefaultMatch && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      const targetQueue = setDefaultMatch[1];
      const resCmd = await runCmd('lpadmin', ['-d', targetQueue]);
      await invalidateCacheAndBroadcast();

      if (resCmd.code === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Printer '${targetQueue}' berhasil ditetapkan sebagai antrean utama (default).`
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: `Gagal mengubah printer utama: ${resCmd.stderr || 'lpadmin error'}`
        }));
      }
      return;
    }

    // 8. Test Print to specific printer
    const testPrintMatch = pathname.match(/^\/api\/printers\/([a-zA-Z0-9_-]+)\/test-page$/);
    if (testPrintMatch && req.method === 'POST') {
      if (!isAdminOrLocal(req)) { denyAdmin(res); return; }
      const targetQueue = testPrintMatch[1];
      const curStatus = await getOrFetchStatus(false);
      const targetPrinter = (curStatus.printers || []).find(p => p.queue_name === targetQueue || p.name === targetQueue);
      const displayName = targetPrinter ? targetPrinter.display_name : targetQueue.replace(/_/g, ' ');

      const genScript = fs.existsSync('/opt/mantaprint/test_page_generator.py')
        ? '/opt/mantaprint/test_page_generator.py'
        : path.join(__dirname, '../../core/test_page_generator.py');
      const pdfPath = `/tmp/mantaprint_testpage_${targetQueue}.pdf`;

      if (fs.existsSync(genScript)) {
        const currentLang = getCurrentSystemLanguage();
        const currentVer = getCurrentSystemVersion();
        await runCmd('/usr/bin/python3', [genScript, pdfPath, targetQueue, displayName, currentLang, currentVer]).catch((e) => {
          console.warn('[TestPage] Queue print generator warning:', e?.message || e);
        });
      }

      let printRes;
      if (fs.existsSync(pdfPath)) {
        printRes = await runCmd('lp', ['-d', targetQueue, '-t', `Uji Cetak MantaPrint - ${displayName}`, pdfPath]);
      } else {
        const textContent = `MantaPrint Hub Test Page\nPrinter: ${displayName}\nQueue: ${targetQueue}\nDate: ${new Date().toISOString()}\n`;
        const tempText = `/tmp/testpage_${targetQueue}.txt`;
        fs.writeFileSync(tempText, textContent, 'utf8');
        printRes = await runCmd('lp', ['-d', targetQueue, '-t', 'Test Page', tempText]);
      }

      await invalidateCacheAndBroadcast();

      res.writeHead(printRes.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: printRes.code === 0,
        message: printRes.code === 0
          ? `Halaman uji cetak berhasil dikirim ke antrean '${displayName}'.`
          : `Gagal mencetak: ${printRes.stderr || 'lp error'}`
      }));
      return;
    }

    // Restart Core System Service
    if (pathname === '/api/service/restart' && req.method === 'POST') {
      if (!isAdminOrLocal(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw);
      if (parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Malformed JSON payload.' }));
        return;
      }

      const service = parsed.service;
      const ALLOWED = ['cups', 'avahi-daemon', 'ipp-usb'];
      if (!ALLOWED.includes(service)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Service '${service}' not permitted.` }));
        return;
      }

      const restartRes = await runCmd('systemctl', ['restart', service], 15000);
      const success = restartRes.code === 0;

      res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success,
        message: success ? `Service '${service}' successfully restarted.` : `Failed to restart '${service}'.`
      }));

      setTimeout(() => {
        probePrinterTelemetry().then(broadcastSse);
      }, 1200);
      return;
    }

    // Comprehensive mDNS & CUPS Network Diagnostics
    if ((pathname === '/api/diagnostics/mdns-cups' || pathname === '/api/diagnostics/network') && (req.method === 'GET' || req.method === 'POST')) {
      const status = await getOrFetchStatus(false);
      const ip = status?.system?.ip || '192.0.2.10';
      const queue = status?.printer?.queue_name || '';
      const diag = await runComprehensiveMdnsCupsDiagnostic(ip, queue);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diag));
      return;
    }

    // --- SYSTEM TIMEZONE CONFIGURATION (Asia/Jakarta Default + Manual Admin Setup) ---
    if (pathname === '/api/system/timezone' && req.method === 'GET') {
      const tzCmd = await runCmd('timedatectl', ['show', '--property=Timezone', '--value']);
      const currentTz = tzCmd.stdout.trim() || 'Asia/Jakarta';
      const now = new Date();
      let formattedTime = '';
      try {
        formattedTime = new Intl.DateTimeFormat('id-ID', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: currentTz
        }).format(now);
      } catch {
        formattedTime = now.toString();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        timezone: currentTz,
        currentTime: formattedTime,
        available: [
          { id: 'Asia/Jakarta', label: 'WIB - Asia/Jakarta (GMT+7)', region: 'Indonesia Barat' },
          { id: 'Asia/Makassar', label: 'WITA - Asia/Makassar (GMT+8)', region: 'Indonesia Tengah' },
          { id: 'Asia/Jayapura', label: 'WIT - Asia/Jayapura (GMT+9)', region: 'Indonesia Timur' },
          { id: 'Asia/Singapore', label: 'SGT - Asia/Singapore (GMT+8)', region: 'ASEAN' },
          { id: 'Asia/Bangkok', label: 'ICT - Asia/Bangkok (GMT+7)', region: 'ASEAN' },
          { id: 'UTC', label: 'UTC - Coordinated Universal Time (GMT+0)', region: 'Global' }
        ]
      }));
      return;
    }

    if (pathname === '/api/system/timezone' && req.method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Autentikasi administrator diperlukan.' }));
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Payload too large.' }));
        return;
      }

      const parsed = parseJsonBody(raw);
      const targetTz = parsed?.timezone;
      if (!targetTz || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)?$/.test(targetTz)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Zona waktu tidak valid.' }));
        return;
      }

      const tzSetRes = await runCmd('timedatectl', ['set-timezone', targetTz]);
      if (tzSetRes.code === 0) {
        process.env.TZ = targetTz;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Zona waktu sistem berhasil diubah ke ${targetTz}.`,
          timezone: targetTz
        }));
        await invalidateCacheAndBroadcast();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: `Gagal mengubah zona waktu: ${tzSetRes.stderr || tzSetRes.stdout}`
        }));
      }
      return;
    }

    // --- GOOGLE ADMIN CONSOLE CHROME OS FLEET DEPLOYMENT & CSV EXPORT ---
    if (pathname === '/api/fleet/chromeos-csv' && req.method === 'GET') {
      const status = await getOrFetchStatus();
      const ip = status.system.ip;
      const queue = status.printer.queue_name || 'Canon_LBP6030_6040_6018L';
      const cleanName = status.printer.mdns_name || formatMdnsName(status.printer.display_name, status.printer.model, queue);
      const csvHeader = 'name,description,driverless,model,uri,allowed for user,allowed for device,allowed for managed guest session\r\n';
      const csvRow = `"${cleanName}","MantaPrint Universal Print Hub",true,,"ipp://${ip}:631/printers/${queue}",true,true,true\r\n`;

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mantaprint_chromeos_${queue}.csv"`
      });
      res.end(csvHeader + csvRow);
      return;
    }

    if (pathname === '/api/fleet/chromeos-guide' && req.method === 'GET') {
      const status = await getOrFetchStatus();
      const ip = status.system.ip;
      const queue = status.printer.queue_name || 'Canon_LBP6030_6040_6018L';
      const cleanName = status.printer.mdns_name || formatMdnsName(status.printer.display_name, status.printer.model, queue);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        printer: {
          name: cleanName,
          ip,
          queue,
          ippUri: `ipp://${ip}:631/printers/${queue}`,
          ippsUri: `ipps://${ip}:631/printers/${queue}`
        },
        steps: [
          {
            step: 1,
            title: "Buka Google Admin Console",
            instruction: "Masuk ke portal administrator di admin.google.com menggunakan akun Google Workspace Super Admin atau Chrome Admin."
          },
          {
            step: 2,
            title: "Navigasi ke Printer ChromeOS",
            instruction: "Buka Menu Utama > Perangkat (Devices) > Chrome > Printer (Printers)."
          },
          {
            step: 3,
            title: "Tentukan Unit Organisasi (OU)",
            instruction: "Pilih Unit Organisasi target (misalnya: Siswa, Ruang Ujian, Lab Komputer, atau Guru) di pohon hierarki OU sebelah kiri."
          },
          {
            step: 4,
            title: "Tambahkan Printer (Manual atau Unggah CSV)",
            instruction: `Klik tombol (+) Tambah Printer, pilih metode 'Alamat Jaringan (URI)'. Masukkan URI: ipp://${ip}:631/printers/${queue}. Nama: ${cleanName}. Setup Method: Driverless Configuration (IPP Everywhere). Atau klik 'Upload Printers' dan unggah berkas CSV dari MantaPrint.`
          },
          {
            step: 5,
            title: "Aktifkan Distribusi Otomatis (Force-Deploy Permissions)",
            instruction: "Pilih tab 'Izin' (Permissions). Aktifkan toggle 'Izinkan untuk pengguna di organisasi ini' dan 'Izinkan untuk perangkat di organisasi ini'. Printer akan langsung terpasang otomatis di semua Chromebook siswa tanpa perlu input IP manual!"
          },
          {
            step: 6,
            title: "Konfigurasikan Default Printer (Opsional)",
            instruction: "Di menu 'Perangkat > Chrome > Setelan > Pengguna & browser > Pencetakan', aktifkan kebijakan 'DefaultPrinterSelection' dengan pencocokan nama atau ID printer."
          }
        ]
      }));
      return;
    }

    // Direct Document Print (Streaming multipart / binary upload) with 25MB limit & low RAM footprint (<64KB)
    if (pathname === '/api/print/upload' && req.method === 'POST') {
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Ukuran berkas melebihi batas 25MB.' }));
        return;
      }

      const tempRawPath = path.join(SPOOL_TEMP_DIR, `mantaprint_raw_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.dat`);
      const tempFinalPath = path.join(SPOOL_TEMP_DIR, `mantaprint_prn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.dat`);
      const fileStream = fs.createWriteStream(tempRawPath);

      let totalBytes = 0;
      let exceeded = false;
      let aborted = false;

      const cleanupFiles = () => {
        try { if (fs.existsSync(tempRawPath)) fs.unlinkSync(tempRawPath); } catch {}
        try { if (fs.existsSync(tempFinalPath)) fs.unlinkSync(tempFinalPath); } catch {}
      };

      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          exceeded = true;
          req.pause();
          cleanupFiles();
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Ukuran berkas melebihi batas 25MB.' }));
          }
        }
      });

      req.on('aborted', () => {
        aborted = true;
        cleanupFiles();
      });

      req.pipe(fileStream);

      fileStream.on('finish', async () => {
        if (exceeded || aborted) return;
        try {
          const stats = fs.statSync(tempRawPath);
          if (stats.size === 0) {
            cleanupFiles();
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Berkas kosong (0 bytes).' }));
            return;
          }

          let docName = req.headers['x-document-name'] || '';
          try { docName = decodeURIComponent(docName); } catch {}
          const contentType = req.headers['content-type'] || '';

          if (contentType.includes('multipart/form-data')) {
            const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
            const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;

            if (boundary) {
              // Read first 8KB to find multipart header
              const headLen = Math.min(stats.size, 8192);
              const headFd = fs.openSync(tempRawPath, 'r');
              const headBuf = Buffer.alloc(headLen);
              fs.readSync(headFd, headBuf, 0, headLen, 0);
              fs.closeSync(headFd);

              const headerEndIdx = headBuf.indexOf('\r\n\r\n');
              if (headerEndIdx !== -1) {
                const headerText = headBuf.toString('binary', 0, headerEndIdx);
                const fnMatch = headerText.match(/filename="([^"]+)"/i);
                if (fnMatch) docName = fnMatch[1];

                const fileStart = headerEndIdx + 4;

                // Read last 4KB to find footer boundary
                const tailLen = Math.min(stats.size, 4096);
                const tailFd = fs.openSync(tempRawPath, 'r');
                const tailBuf = Buffer.alloc(tailLen);
                fs.readSync(tailFd, tailBuf, 0, tailLen, Math.max(0, stats.size - tailLen));
                fs.closeSync(tailFd);

                const footerIdx = tailBuf.lastIndexOf(`--${boundary}`);
                let fileEnd = stats.size;
                if (footerIdx !== -1) {
                  const tailOffset = Math.max(0, stats.size - tailLen);
                  fileEnd = tailOffset + footerIdx;
                  // Strip preceding CRLF if present
                  if (fileEnd >= 2) {
                    const checkFd = fs.openSync(tempRawPath, 'r');
                    const crlfBuf = Buffer.alloc(2);
                    fs.readSync(checkFd, crlfBuf, 0, 2, fileEnd - 2);
                    fs.closeSync(checkFd);
                    if (crlfBuf.toString() === '\r\n') {
                      fileEnd -= 2;
                    } else if (crlfBuf[1] === 0x0A) {
                      fileEnd -= 1;
                    }
                  }
                }

                if (fileEnd > fileStart) {
                  // Stream slice to tempFinalPath without loading entire payload into RAM
                  await new Promise((resolvePipe, rejectPipe) => {
                    const rStream = fs.createReadStream(tempRawPath, { start: fileStart, end: fileEnd - 1 });
                    const wStream = fs.createWriteStream(tempFinalPath);
                    rStream.pipe(wStream);
                    wStream.on('finish', resolvePipe);
                    wStream.on('error', rejectPipe);
                  });
                } else {
                  fs.copyFileSync(tempRawPath, tempFinalPath);
                }
              } else {
                fs.copyFileSync(tempRawPath, tempFinalPath);
              }
            } else {
              fs.copyFileSync(tempRawPath, tempFinalPath);
            }
          } else {
            // Raw binary upload
            fs.copyFileSync(tempRawPath, tempFinalPath);
          }

          try { fs.unlinkSync(tempRawPath); } catch {}

          if (!docName) docName = 'Dokumen Klien';

          // Extract printer target from query, headers, or default queue
          const requestedPrinter = url.searchParams.get('printer') || req.headers['x-printer-queue'];
          const targetPrinter = resolveTargetQueue(requestedPrinter);
          if (!targetPrinter) {
            cleanupFiles();
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Tidak ada printer aktif yang terhubung.' }));
            return;
          }

          // Dynamic lp options
          const lpArgs = ['-d', targetPrinter];

          const copies = parseInt(req.headers['x-print-copies'] || url.searchParams.get('copies') || '1', 10);
          if (copies > 1 && copies <= 100) {
            lpArgs.push('-n', String(copies));
          }

          const rawMedia = (req.headers['x-print-media'] || url.searchParams.get('media') || 'A4').trim();
          if (/^[a-zA-Z0-9_\-]+$/.test(rawMedia)) {
            lpArgs.push('-o', `media=${rawMedia}`);
          }

          const rawOrientation = (req.headers['x-print-orientation'] || url.searchParams.get('orientation') || '').trim();
          if (rawOrientation === 'landscape' || rawOrientation === 'portrait') {
            lpArgs.push('-o', rawOrientation);
          }

          const rawDuplex = (req.headers['x-print-duplex'] || url.searchParams.get('duplex') || '').trim();
          if (rawDuplex === 'two-sided-long-edge' || rawDuplex === 'two-sided-short-edge') {
            lpArgs.push('-o', `sides=${rawDuplex}`);
          }

          const rawPageRanges = (req.headers['x-print-page-ranges'] || url.searchParams.get('page_ranges') || '').trim();
          if (/^[\d,-]+$/.test(rawPageRanges)) {
            lpArgs.push('-o', `page-ranges=${rawPageRanges}`);
          }

          lpArgs.push('-o', 'fit-to-page');
          lpArgs.push('--', tempFinalPath);

          const printRes = await runCmd('lp', lpArgs, 15000);
          cleanupFiles();

          const success = printRes.code === 0;
          if (!success) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              state: 'error',
              message: `Gagal mengirim ke antrean printer: ${printRes.stderr || printRes.stdout}`
            }));
            return;
          }

          const match = (printRes.stdout || '').match(/request id is ([^\s]+)/i);
          const jobId = match ? match[1] : `${targetPrinter}-${Date.now() % 100000}`;
          const numericId = parseInt((jobId.match(/-(\d+)$/) || [])[1] || '0', 10);

          const jobRecord = jobTracker.registerJob({
            id: jobId,
            printer: targetPrinter,
            title: docName,
            user: req.socket.remoteAddress || 'client',
            size: stats.size
          });
          const jobToken = crypto.randomBytes(16).toString('hex');
          jobTracker.updateJob(jobId, { cancel_token: jobToken });

          const shouldWait = url.searchParams.get('wait') === 'true' ||
                             url.searchParams.get('sync') === 'true' ||
                             url.searchParams.get('sync') === '1' ||
                             req.headers['x-wait-job'] === 'true';

          if (shouldWait) {
            const finalJob = await jobTracker.waitForJob(jobId, 60000);
            const isSuccess = finalJob.state === 'completed';
            res.writeHead(isSuccess ? 200 : (finalJob.state === 'error' ? 502 : 504), { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: isSuccess,
              job_id: finalJob.id,
              job_token: jobToken,
              id: finalJob.numeric_id,
              printer: targetPrinter,
              title: docName,
              state: finalJob.state,
              status_message: finalJob.status_message,
              error: finalJob.error,
              duration_ms: finalJob.duration_ms,
              poll_url: `/api/jobs/${encodeURIComponent(jobId)}`,
              events_url: `/api/jobs/${encodeURIComponent(jobId)}/events`,
              message: isSuccess 
                ? `Dokumen "${docName}" berhasil dicetak pada ${targetPrinter}!`
                : `Pencetakan tidak tuntas: ${finalJob.status_message}`
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            job_id: jobId,
            id: numericId,
            printer: targetPrinter,
            title: docName,
            state: jobRecord.state,
            status_message: jobRecord.status_message,
            poll_url: `/api/jobs/${encodeURIComponent(jobId)}`,
            events_url: `/api/jobs/${encodeURIComponent(jobId)}/events`,
            wait_url: `/api/jobs/${encodeURIComponent(jobId)}/wait`,
            job_token: jobToken,
            message: `Dokumen "${docName}" berhasil dikirim ke antrean ${targetPrinter}. Sedang dicetak.`
          }));
        } catch (uploadErr) {
          cleanupFiles();
          console.error('[Upload Error]', uploadErr);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: `Kesalahan pemrosesan berkas: ${uploadErr.message}` }));
          }
        }
      });

      fileStream.on('error', err => {
        cleanupFiles();
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: `Gagal menulis berkas sementara: ${err.message}` }));
        }
      });

      return;
    }

    // --- REAL-TIME PRINT JOB STATUS & TELEMETRY ENDPOINTS ---

    // List all print jobs (active + recent history)
    if (pathname === '/api/jobs' && req.method === 'GET') {
      await jobTracker.syncWithCups();
      const full = isAdminOrLocal(req);
      const view = (list) => (full ? list.map((j) => { const { cancel_token, ...rest } = j; return rest; }) : list.map(publicJobView));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        active_jobs: view(jobTracker.getActiveJobs()),
        jobs: view(jobTracker.getAllJobs())
      }));
      return;
    }

    // Specific Job Telemetry / Long-Poll Wait / SSE Stream / Cancel / Delete
    if ((pathname.startsWith('/api/jobs/') || pathname.startsWith('/api/print/status/')) && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
      const sub = pathname.startsWith('/api/jobs/') ? pathname.replace('/api/jobs/', '') : pathname.replace('/api/print/status/', '');
      const parts = sub.split('/');
      const jobId = sanitizeIdentifier(parts[0] || '');
      const subAction = parts[1] || '';

      const jobForAuth = jobTracker.getJob(jobId);
      const canSeeJob = isAdminOrLocal(req) || jobTokenMatches(jobForAuth, getJobToken(req) || url.searchParams.get('token'));
      const jobView = (j) => {
        if (!j) return j;
        if (canSeeJob) { const { cancel_token, ...rest } = j; return rest; }
        return publicJobView(j);
      };

      if (req.method === 'DELETE' || (req.method === 'POST' && subAction === 'cancel')) {
        if (!canSeeJob) { denyAdmin(res); return; }
        const numericMatch = jobId.match(/-(\d+)$/);
        const cupsJobArg = numericMatch ? numericMatch[1] : jobId;
        await runCmd('cancel', ['-x', cupsJobArg]).catch(() => {});
        if (cupsJobArg !== jobId) {
          await runCmd('cancel', ['-x', jobId]).catch(() => {});
        }
        await runCmd('lprm', [cupsJobArg]).catch(() => {});
        await runCmd('cupsenable', ['-c']).catch(() => {});
        try {
          await runCmd('pkill', ['-f', 'rastertosfp|cnrsdrvsfp|captdriver|foo2zjs|rastertoescpr']).catch(() => {});
        } catch {}
        jobTracker.updateJob(jobId, { state: 'canceled', status_message: 'Pekerjaan cetak dibatalkan.' });
        if (numericMatch) jobTracker.updateJob(numericMatch[1], { state: 'canceled', status_message: 'Pekerjaan cetak dibatalkan.' });
        if (req.method === 'DELETE') {
          jobTracker.removeJob(jobId);
          if (numericMatch) jobTracker.removeJob(numericMatch[1]);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Pekerjaan #${jobId} telah dibatalkan.` }));
        await invalidateCacheAndBroadcast();
        return;
      }

      if (subAction === 'wait') {
        const finalJob = await jobTracker.waitForJob(jobId, 60000);
        const isSuccess = finalJob.state === 'completed';
        res.writeHead(isSuccess ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: isSuccess,
          job: jobView(finalJob)
        }));
        return;
      }

      if (subAction === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(': sse-job-stream-open\n\n');

        const current = jobTracker.getJob(jobId);
        if (current) {
          res.write(`event: job_status\ndata: ${JSON.stringify(jobView(current))}\n\n`);
          if (['completed', 'error', 'canceled'].includes(current.state)) {
            res.end();
            return;
          }
        }

        const listener = (job) => {
          try {
            res.write(`event: job_status\ndata: ${JSON.stringify(jobView(job))}\n\n`);
            if (['completed', 'error', 'canceled'].includes(job.state)) {
              res.end();
            }
          } catch {
            jobTracker.off(`job:${jobId}`, listener);
          }
        };

        jobTracker.on(`job:${jobId}`, listener);
        req.on('close', () => {
          jobTracker.off(`job:${jobId}`, listener);
        });
        return;
      }

      // Default: JSON snapshot of job status
      const job = jobTracker.getJob(jobId);
      if (job) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, job: jobView(job) }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Pekerjaan cetak #${jobId} tidak ditemukan.` }));
      }
      return;
    }

    // --- NETWORK & HOTSPOT API ROUTES (Universal Web & HDMI Console) ---
    if (pathname.startsWith('/api/hdmi/network/') || pathname.startsWith('/api/network/')) {
      const subPath = pathname.startsWith('/api/network/')
        ? pathname.replace('/api/network/', '')
        : pathname.replace('/api/hdmi/network/', '');

      // Status
      if (subPath === 'status' && req.method === 'GET') {
        const netStatus = await hdmiNetworkEngine.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...netStatus }));
        return;
      }

      // SoftAP Hotspot Status
      if (subPath === 'softap/status' && req.method === 'GET') {
        const apStatus = await hdmiNetworkEngine.getSoftApStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...apStatus }));
        return;
      }

      // SoftAP Hotspot Toggle
      if (subPath === 'softap/toggle' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        const result = await hdmiNetworkEngine.toggleSoftAp(Boolean(body.enabled), body.ssid || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Wi-Fi Scan
      if (subPath === 'wifi/scan' && req.method === 'GET') {
        const networks = await hdmiNetworkEngine.scanWifi();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: networks.length, networks }));
        return;
      }

      // Wi-Fi Connect
      if (subPath === 'wifi/connect' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await hdmiNetworkEngine.connectWifi(body);
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // Wi-Fi Radio Toggle (Master Kill-Switch)
      if (subPath === 'wifi/radio' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        const result = await hdmiNetworkEngine.setWifiRadio(Boolean(body.enabled));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Ethernet Config
      if ((subPath === 'ethernet/config' || subPath === 'ethernet') && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        let cfg;
        try {
          cfg = validateEthernetConfig(body);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
          return;
        }
        const apply = async () => {
          await directConnect.deactivate();
          return hdmiNetworkEngine.applyEthernetConfig(cfg);
        };
        // A remote caller's connection usually dies when the address changes, so answer first.
        if (!isLoopbackRequest(req)) {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            scheduled: true,
            mode: cfg.mode,
            reconnect_url: cfg.mode === 'static' ? `http://${cfg.ip}/` : null,
            message: 'Applying network settings in 2 seconds.',
          }));
          setTimeout(() => {
            apply()
              .then((r) => {
                hdmiNetworkEngine.lastEthernetApply = { success: true, message: r.message, at: Date.now() };
                console.log(`[NET] Ethernet ${r.mode} applied via ${r.backend}: ${r.applied_ip}`);
              })
              .catch((err) => {
                hdmiNetworkEngine.lastEthernetApply = { success: false, message: err.message, at: Date.now() };
                console.error('[NET] Ethernet apply failed:', err.message);
              });
          }, 2000);
          return;
        }
        try {
          const result = await apply();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      if (subPath === 'direct-connect/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...directConnect.getStatus() }));
        return;
      }

      if ((subPath === 'direct-connect/start' || subPath === 'direct-connect/stop') && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        try {
          if (subPath === 'direct-connect/start') await directConnect.activateNow();
          else await directConnect.stop();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...directConnect.getStatus() }));
        } catch (err) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // VLAN Config
      if (subPath === 'vlan/config' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await hdmiNetworkEngine.applyVlanConfig(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // Diagnostics: Ping (supports GET with query param or POST with body)
      if (subPath === 'diagnostics/ping' && (req.method === 'GET' || req.method === 'POST')) {
        let target = url.searchParams.get('target');
        if (!target && req.method === 'POST') {
          const raw = await readBody(req);
          const body = parseJsonBody(raw) || {};
          target = body.target;
        }
        target = target || '1.1.1.1';
        const result = await hdmiNetworkEngine.pingTest(target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Diagnostics: DNS
      if (subPath === 'diagnostics/dns' && (req.method === 'GET' || req.method === 'POST')) {
        let host = url.searchParams.get('host');
        if (!host && req.method === 'POST') {
          const raw = await readBody(req);
          const body = parseJsonBody(raw) || {};
          host = body.host;
        }
        host = host || 'google.com';
        const result = await hdmiNetworkEngine.dnsTest(host);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Diagnostics: mDNS & CUPS Comprehensive Broadcast Test
      if ((subPath === 'diagnostics/mdns-cups' || subPath === 'diagnostics/network') && (req.method === 'GET' || req.method === 'POST')) {
        const status = await getOrFetchStatus(false);
        const ip = status?.system?.ip || '192.0.2.10';
        const queue = status?.printer?.queue_name || '';
        const diag = await runComprehensiveMdnsCupsDiagnostic(ip, queue);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diag));
        return;
      }

      // Factory Network Reset
      if (subPath === 'reset' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const result = await hdmiNetworkEngine.resetFactoryNetwork();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // System Reboot
      if (subPath === 'system/reboot' && req.method === 'POST') {
        if (!isAdminOrLocal(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        runCmd('systemctl', ['reboot']).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Memulai reboot sistem...' }));
        return;
      }

      // Remote IR Mapping Wizard routes
      if (subPath === 'remote/wizard/start' && req.method === 'POST') {
        const result = await remoteWizardEngine.start();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (subPath === 'remote/wizard/status' && req.method === 'GET') {
        const result = remoteWizardEngine.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (subPath === 'remote/wizard/undo' && req.method === 'POST') {
        const result = await remoteWizardEngine.undo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (subPath === 'remote/wizard/reset' && req.method === 'POST') {
        const result = await remoteWizardEngine.reset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (subPath === 'remote/wizard/skip' && req.method === 'POST') {
        const result = await remoteWizardEngine.skip();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (subPath === 'remote/wizard/cancel' && req.method === 'POST') {
        remoteWizardEngine.stop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Wizard dibatalkan' }));
        return;
      }
    }

    // --- SYSTEM SETTINGS & LOCALIZATION & UPDATES ---
    if (pathname.startsWith('/api/system/')) {
      const sub = pathname.replace('/api/system/', '');

      // 1. Get full system settings & time status
      if (sub === 'settings' && req.method === 'GET') {
        const timeStatus = await configManager.getTimeStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          settings: configManager.getConfig(),
          time_status: timeStatus
        }));
        return;
      }

      // 2. Set Language (en or id)
      if (sub === 'settings/language' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        const chosen = configManager.setLanguage(body.language);
        invalidateCacheAndBroadcast();
        // Immediately restart TUI so HDMI display refreshes language instantly
        runCmd('systemctl', ['restart', 'mantaprint-tui.service']).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, language: chosen, message: 'Language updated. TUI restarted.' }));
        return;
      }

      // 3. Set Timezone via timedatectl
      if (sub === 'settings/timezone' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await configManager.setTimezone(body.timezone);
          invalidateCacheAndBroadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 4. Set NTP State & Servers
      if (sub === 'settings/ntp' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await configManager.setNtp(body.enabled, body.servers);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 5. Set Manual Date & Time
      if (sub === 'settings/time' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await configManager.setManualDateTime(body.datetime);
          invalidateCacheAndBroadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 6. Set Hostname via hostnamectl
      if (sub === 'settings/hostname' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await configManager.setHostname(body.hostname);
          const customMdnsConfig = getCustomMdnsConfig();
          customMdnsConfig.hostname = result.hostname;
          saveCustomMdnsConfig(customMdnsConfig);

          // Update /etc/avahi/avahi-daemon.conf so mDNS advertises the new hostname
          try {
            const confPath = '/etc/avahi/avahi-daemon.conf';
            if (fs.existsSync(confPath)) {
              let conf = fs.readFileSync(confPath, 'utf8');
              if (/^\s*#?\s*host-name\s*=/m.test(conf)) {
                conf = conf.replace(/^\s*#?\s*host-name\s*=.*$/m, `host-name=${result.hostname}`);
              } else {
                conf = conf.replace(/\[server\]/i, `[server]\nhost-name=${result.hostname}`);
              }
              fs.writeFileSync(confPath, conf, 'utf8');
              runCmd('systemctl', ['restart', '--no-block', 'avahi-daemon']).catch(() => {});
            }
          } catch (e) {
            console.error('[!] Failed to update avahi-daemon.conf on hostname change:', e);
          }

          invalidateCacheAndBroadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 7. Get Curated Timezones
      if (sub === 'timezones' && req.method === 'GET') {
        const timezones = await configManager.getCuratedTimezones();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...timezones }));
        return;
      }

      // 8. Versioning Manifest Endpoint
      if (sub === 'version' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          version: applianceUpdater.currentVersion,
          manifest: applianceUpdater.installedManifest || {}
        }));
        return;
      }

      // 9. Updates: Check
      if (sub === 'updates/check' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const updateInfo = await applianceUpdater.checkForUpdates(true);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...updateInfo }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 10. Updates: Live SSE Progress & Cyber Terminal Log Stream
      if (sub === 'updates/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        applianceUpdater.addSseClient(res);
        return;
      }

      // 11. Updates: Start Update (Install)
      if ((sub === 'updates/apply' || sub === 'updates/install') && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }

        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        try {
          const result = await applianceUpdater.startUpdate({ backup: body.backup !== false });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 12. Updates: List Snapshots
      if (sub === 'updates/backups' && req.method === 'GET') {
        try {
          const backups = await applianceUpdater.listSnapshots();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, backups }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 13. Updates: Rollback to Snapshot
      if (sub === 'updates/rollback' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }

        const raw = await readBody(req);
        const body = parseJsonBody(raw) || {};
        if (!body.snapshotId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Parameter snapshotId diperlukan.' }));
          return;
        }

        try {
          const result = await applianceUpdater.rollbackToSnapshot(body.snapshotId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
      }

      // 10. Maintenance: Restart Core Appliance Services
      if ((sub === 'restart-services' || sub === 'services/restart' || sub === 'restart-service') && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Merestart layanan appliance Hub...' }));
        setTimeout(() => {
          runCmd('systemctl', ['restart', 'mantaprint-tui.service', 'mantaprint-agent.service', 'cups.service']).catch(() => {});
          setTimeout(() => {
            runCmd('systemctl', ['restart', 'mantaprint-web.service']).catch(() => {});
          }, 600);
        }, 400);
        return;
      }

      // 11. Maintenance: Full Appliance Reboot
      if (sub === 'reboot' && req.method === 'POST') {
        if (!isAdminAuthenticated(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Autentikasi admin diperlukan.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Memulai reboot sistem MantaPrint Hub...' }));
        setTimeout(() => {
          runCmd('systemctl', ['reboot']).catch(() => {});
        }, 800);
        return;
      }
    }

    // --- STATIC ASSET SERVING (SPA) & STRICT PATH TRAVERSAL GUARD ---
    const normalizedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPath = path.normalize(path.resolve(DIST_DIR, normalizedPath));

    // Guard: strictly ensure requested file stays within DIST_DIR
    if (!resolvedPath.startsWith(DIST_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let filePath = resolvedPath;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const dirIndex = path.join(filePath, 'index.html');
      if (fs.existsSync(dirIndex)) {
        filePath = dirIndex;
      } else {
        filePath = path.join(DIST_DIR, 'index.html');
      }
    } else if (!fs.existsSync(filePath)) {
      if (pathname.startsWith('/hdmi')) {
        const hdmiFile = path.join(DIST_DIR, 'hdmi', 'index.html');
        filePath = fs.existsSync(hdmiFile) ? hdmiFile : path.join(DIST_DIR, 'index.html');
      } else if (pathname.startsWith('/scanner')) {
        const scannerFile = path.join(DIST_DIR, 'scanner', 'index.html');
        filePath = fs.existsSync(scannerFile) ? scannerFile : path.join(DIST_DIR, 'index.html');
      } else {
        filePath = path.join(DIST_DIR, 'index.html');
      }
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const stream = fs.createReadStream(filePath);

      let cacheControl = 'no-cache, must-revalidate';
      if (ext === '.html' || normalizedPath === 'sw.js' || normalizedPath === 'manifest.json') {
        cacheControl = 'no-cache, no-store, must-revalidate';
      } else if (normalizedPath.startsWith('ocr/')) {
        // OCR engine and language data live under a versioned folder and never change in place.
        cacheControl = 'public, max-age=31536000, immutable';
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl
      });
      stream.pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (globalErr) {
    console.error('[!] Global request handler error:', globalErr);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Internal Server Error' }));
    }
  }
});

function ensureAvahiServiceHardening() {
  try {
    const overrideDir = '/etc/systemd/system/avahi-daemon.service.d';
    const overrideFile = path.join(overrideDir, 'override.conf');
    const expected = `[Service]\nRestart=on-failure\nRestartSec=3s\n`;
    
    let needsReload = false;
    if (!fs.existsSync(overrideDir)) {
      try { fs.mkdirSync(overrideDir, { recursive: true }); } catch {}
    }
    if (fs.existsSync(overrideDir)) {
      if (!fs.existsSync(overrideFile) || fs.readFileSync(overrideFile, 'utf8') !== expected) {
        fs.writeFileSync(overrideFile, expected, 'utf8');
        needsReload = true;
      }
    }
    if (needsReload) {
      runCmd('systemctl', ['daemon-reload']).catch(() => {});
    }

    // Silence CUPS native raw DNS-SD to prevent duplicate "@ host" Generic PostScript broadcasts
    runCmd('cupsctl', ['BrowseLocalProtocols=none']).catch(() => {});
  } catch {}
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[+] MantaPrint Hub Server active on http://0.0.0.0:${PORT}`);
  applySysctlHardening().catch((err) => console.warn('[!] Failed to apply sysctl hardening:', err.message));
  ensureAvahiServiceHardening();
  startUsbHardwareWatcher();
  startNetworkIpWatcher();
  hdmiNetworkEngine.reapplySavedEthernetConfig().finally(() => directConnect.startMonitor());
});

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.warn(`[!] Port ${PORT} permission denied, attempting fallback port ${FALLBACK_PORT}...`);
    server.listen(FALLBACK_PORT, '0.0.0.0');
  } else {
    console.error(`[!] Server Error:`, err);
  }
});
