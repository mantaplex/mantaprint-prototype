/**
 * MantaPrint Hub - ScanSnap firmware provisioning (SANE epjitsu backend)
 *
 * Fujitsu ScanSnap S300/S1100/S1300/S1300i and fi-60F/fi-65F have no firmware in
 * flash: SANE's epjitsu backend uploads a vendor ".nal" file on every attach, and
 * when that file is missing attach fails and the scanner never shows up in
 * `scanimage -L` at all. The files are PFU's copyrighted firmware, so they can't be
 * bundled; this module lets an admin hand the hub either the .nal itself or the
 * ScanSnap installer/driver archive it lives in, and installs it where
 * /etc/sane.d/epjitsu.conf already points.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const EPJITSU_CONF = '/etc/sane.d/epjitsu.conf';
export const USB_SYSFS_ROOT = '/sys/bus/usb/devices';

// epjitsu.c load_fw(): skips a 0x100-byte header, then reads exactly 0x10000 bytes of
// firmware. Anything shorter makes attach fail; real files are ~65 KB.
export const NAL_MIN_BYTES = 0x100 + 0x10000;
export const NAL_MAX_BYTES = 1024 * 1024;

const SAFE_NAL_NAME = /^[A-Za-z0-9_.-]+\.nal$/i;
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// Stock epjitsu.conf entries (sane-backends), used when the conf file isn't readable.
const STOCK_DEVICES = [
  ['Fujitsu fi-60F', '60f_0A00.nal', '04c5', '10c7'],
  ['Fujitsu S300', '300_0C00.nal', '04c5', '1156'],
  ['Fujitsu S300M', '300M_0C00.nal', '04c5', '117f'],
  ['Fujitsu fi-65F', '65f_0A01.nal', '04c5', '11bd'],
  ['Fujitsu S1300', '1300_0C26.nal', '04c5', '11ed'],
  ['Fujitsu S1100', '1100_0B00.nal', '04c5', '1200'],
  ['Fujitsu S1300i', '1300i_0D12.nal', '04c5', '128d'],
  ['Fujitsu S1100i', '1100i_0A00.nal', '04c5', '1447']
].map(([model, filename, vid, pid]) => ({
  model,
  filename,
  firmware_path: `/usr/share/sane/epjitsu/${filename}`,
  usb_id: `${vid}:${pid}`
}));

function normHex(value) {
  return String(value || '').trim().toLowerCase().replace(/^0x/, '').padStart(4, '0');
}

// Parse epjitsu.conf into [{model, filename, firmware_path, usb_id}]. A `firmware`
// line applies to every `usb` line after it until the next `firmware` line (the same
// rule the backend uses); the model name comes from the comment right above it.
export function parseEpjitsuConf(text) {
  const devices = [];
  let lastComment = '';
  let firmware = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { lastComment = ''; continue; }
    if (line.startsWith('#')) { lastComment = line.replace(/^#+\s*/, ''); continue; }
    const fw = line.match(/^firmware\s+(\S+)/);
    if (fw) {
      const fwPath = fw[1];
      const filename = path.basename(fwPath);
      firmware = path.isAbsolute(fwPath) && SAFE_NAL_NAME.test(filename)
        ? { firmware_path: fwPath, filename, model: lastComment }
        : null;
      lastComment = '';
      continue;
    }
    const usb = line.match(/^usb\s+(0x[0-9a-f]+|[0-9a-f]{4})\s+(0x[0-9a-f]+|[0-9a-f]{4})\b/i);
    if (usb && firmware) {
      const usbId = `${normHex(usb[1])}:${normHex(usb[2])}`;
      devices.push({
        model: firmware.model || `Fujitsu ${usbId}`,
        filename: firmware.filename,
        firmware_path: firmware.firmware_path,
        usb_id: usbId
      });
    }
    lastComment = '';
  }
  return devices;
}

export function loadEpjitsuDevices(confPath = EPJITSU_CONF) {
  try {
    const devices = parseEpjitsuConf(fs.readFileSync(confPath, 'utf8'));
    if (devices.length) return { devices, conf_found: true };
  } catch {}
  return { devices: STOCK_DEVICES.map((d) => ({ ...d })), conf_found: false };
}

// Lower-case "vvvv:pppp" for every USB device the kernel currently sees.
export function getConnectedUsbIds(sysRoot = USB_SYSFS_ROOT) {
  const ids = new Set();
  let entries = [];
  try { entries = fs.readdirSync(sysRoot); } catch { return ids; }
  for (const d of entries) {
    if (d.includes(':')) continue; // interfaces, not devices
    try {
      const vid = fs.readFileSync(path.join(sysRoot, d, 'idVendor'), 'utf8');
      const pid = fs.readFileSync(path.join(sysRoot, d, 'idProduct'), 'utf8');
      ids.add(`${normHex(vid)}:${normHex(pid)}`);
    } catch {}
  }
  return ids;
}

export function validateNal(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { ok: false, code: 'not_found', size: 0 }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', size: 0 };
  if (st.size < NAL_MIN_BYTES || st.size > NAL_MAX_BYTES) return { ok: false, code: 'invalid_size', size: st.size };
  return { ok: true, code: 'ok', size: st.size };
}

function targetPath(device, opts = {}) {
  return opts.firmwareDir ? path.join(opts.firmwareDir, device.filename) : device.firmware_path;
}

export function getFirmwareStatus(opts = {}) {
  const { devices, conf_found } = loadEpjitsuDevices(opts.confPath);
  const connectedIds = opts.connectedIds || getConnectedUsbIds(opts.sysRoot);
  const list = devices.map((d) => {
    const check = validateNal(targetPath(d, opts));
    return {
      model: d.model,
      filename: d.filename,
      usb_id: d.usb_id,
      firmware_path: targetPath(d, opts),
      installed: check.ok,
      size: check.size,
      connected: connectedIds.has(d.usb_id)
    };
  });
  return {
    conf_found,
    devices: list,
    connected: list.filter((d) => d.connected),
    needs_firmware: list.filter((d) => d.connected && !d.installed)
  };
}

// Copy a validated .nal into place atomically (write beside it, then rename).
export function installNal(srcPath, device, opts = {}) {
  const check = validateNal(srcPath);
  if (!check.ok) return { ok: false, code: check.code, filename: device.filename };
  if (!SAFE_NAL_NAME.test(device.filename)) return { ok: false, code: 'unknown_target', filename: device.filename };
  const dest = targetPath(device, opts);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.copyFileSync(srcPath, tmp);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, dest);
  } catch (err) {
    return { ok: false, code: 'write_failed', filename: device.filename, detail: err.code || err.message };
  }
  return { ok: true, code: 'installed', filename: device.filename, model: device.model, size: check.size, path: dest };
}

// ---- Archive extraction ---------------------------------------------------------

function runTool(cmd, args, timeoutMs, maxOutput = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    let child;
    try {
      // stdin closed so an encrypted archive's password prompt fails instead of hanging.
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: `${TOOL_PATH}:${process.env.PATH || ''}` } });
    } catch {
      resolve({ code: 127, stdout: '' });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < maxOutput) stdout += chunk.toString('utf8'); });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code === null ? 124 : code));
  });
}

function whichSync(names) {
  const dirs = `${TOOL_PATH}:${process.env.PATH || ''}`.split(':').filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

export function getExtractionTools() {
  return {
    sevenZip: whichSync(['7z', '7zz', '7za']),
    cabextract: whichSync(['cabextract']),
    unshield: whichSync(['unshield'])
  };
}

// Regular files under root. Symlinks are removed rather than followed so nothing an
// archive creates can point the rest of the pipeline outside the work directory.
function walkFiles(root, maxEntries = 20000) {
  const out = [];
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > maxEntries) return out;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { try { fs.unlinkSync(p); } catch {} continue; }
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try { out.push({ path: p, name: e.name, size: fs.lstatSync(p).size }); } catch {}
    }
  }
  return out;
}

const NESTED_ARCHIVE = /\.(zip|cab|7z|exe|msi|rar|iso|dmg|pkg|xar|tar|gz|tgz|bz2|xz|lzh)$/i;
function isNestedArchive(f) {
  return f.size >= 512 && (NESTED_ARCHIVE.test(f.name) || f.name === 'Payload');
}

// Sum of uncompressed entry sizes from `7z l -slt`, or null if 7z can't read it.
function parseSevenZipListing(stdout) {
  const sep = stdout.indexOf('\n----------');
  if (sep < 0) return null;
  let total = 0;
  for (const m of stdout.slice(sep).matchAll(/^Size = (\d+)$/gm)) total += Number(m[1]);
  return total;
}

async function extractOne(file, dest, tools, run, budget, timeoutMs) {
  const attempts = [];
  if (tools.sevenZip) attempts.push('7z');
  if (tools.cabextract) attempts.push('cabextract');
  if (tools.unshield && /\.cab$/i.test(file)) attempts.push('unshield');
  for (const tool of attempts) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    let res;
    if (tool === '7z') {
      const list = await run(tools.sevenZip, ['l', '-slt', file], Math.min(timeoutMs, 60000));
      const total = list.code === 0 ? parseSevenZipListing(list.stdout) : null;
      if (total === null) continue;
      if (total > budget) return { ok: false, code: 'too_large' };
      res = await run(tools.sevenZip, ['x', '-y', '-bd', `-o${dest}`, file], timeoutMs);
    } else if (tool === 'cabextract') {
      res = await run(tools.cabextract, ['-q', '-d', dest, file], timeoutMs);
    } else {
      res = await run(tools.unshield, ['-d', dest, 'x', file], timeoutMs);
    }
    // 7z exits 1/2 on partial damage but may still have produced the files we want.
    if (res.code !== 124 && walkFiles(dest, 1).length) return { ok: true };
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { ok: false, code: 'extract_failed' };
}

// Look for .nal files inside an archive, descending into nested archives (installer
// .exe -> .msi -> .cab ...) up to a few levels, within a time and size budget.
export async function extractNalFiles(archivePath, workDir, opts = {}) {
  const r = await extractMatchingFiles(archivePath, workDir, { ...opts, match: /\.nal$/i });
  return { code: r.code === 'no_match' ? 'no_nal_found' : r.code, nal: r.files };
}

// Generic form: `match` picks the files to collect (Driver Center uses it for .ppd/.deb/.run/.dl).
export async function extractMatchingFiles(archivePath, workDir, opts = {}) {
  const match = opts.match || /\.nal$/i;
  const tools = opts.tools || getExtractionTools();
  const run = opts.runner || runTool;
  const deadline = Date.now() + (opts.timeoutMs || 180000);
  const maxDepth = opts.maxDepth ?? 3;
  let budget = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
  if (!tools.sevenZip && !tools.cabextract && !tools.unshield) return { code: 'no_tools', files: [] };

  const found = [];
  let queue = [{ file: archivePath, depth: 0 }];
  let n = 0;
  let extractedAny = false;
  let lastError = 'extract_failed';
  while (queue.length && n < 60) {
    const next = [];
    for (const item of queue) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || n >= 60) break;
      const dest = path.join(workDir, `x${n++}`);
      const res = await extractOne(item.file, dest, tools, run, budget, Math.max(5000, remaining));
      if (!res.ok) { lastError = res.code; if (res.code === 'too_large' && item.depth === 0) return { code: 'too_large', files: [] }; continue; }
      extractedAny = true;
      const files = walkFiles(dest);
      budget -= files.reduce((s, f) => s + f.size, 0);
      if (budget < 0) return { code: 'too_large', files: found };
      for (const f of files) if (match.test(f.name)) found.push(f);
      if (item.depth < maxDepth) {
        for (const f of files.filter(isNestedArchive).slice(0, 40)) next.push({ file: f.path, depth: item.depth + 1 });
      }
    }
    // Firmware files sit together; once some turn up there's no need to dig deeper.
    if (found.length || Date.now() >= deadline) break;
    queue = next;
  }
  if (found.length) return { code: 'ok', files: found };
  return { code: extractedAny ? 'no_match' : lastError, files: [] };
}

// ---- Matching found files to scanners ----------------------------------------------

function nalStem(name) {
  return String(name).toLowerCase().replace(/\.nal$/, '').split('_')[0];
}

// Decide which found .nal goes to which configured scanner: an exact filename match
// first, then the same model stem with a different firmware revision (newest wins),
// and finally - for a single unrecognised file - the one scanner the admin (or the
// hub, when exactly one connected scanner is waiting) named as the target.
export function planInstall(nalFiles, devices, { target } = {}) {
  const plan = [];
  const used = new Set();
  for (const d of devices) {
    if (plan.some((p) => p.device.filename === d.filename)) continue;
    const exact = nalFiles.find((f) => f.name.toLowerCase() === d.filename.toLowerCase());
    const sameStem = nalFiles
      .filter((f) => nalStem(f.name) === nalStem(d.filename))
      .sort((a, b) => b.name.localeCompare(a.name));
    const pick = exact || sameStem[0];
    if (pick) { plan.push({ device: d, source: pick }); used.add(pick.path); }
  }
  if (target) {
    const device = devices.find((d) => d.filename.toLowerCase() === String(target).toLowerCase());
    const leftovers = nalFiles.filter((f) => !used.has(f.path));
    if (device && !plan.some((p) => p.device.filename === device.filename) && leftovers.length === 1) {
      plan.push({ device, source: leftovers[0] });
    }
  }
  return plan;
}

// Full pipeline for one uploaded file: a .nal goes straight to matching, anything
// else is treated as an archive to search.
export async function processFirmwareUpload({ filePath, fileName, workDir, target, ...opts }) {
  const { devices } = loadEpjitsuDevices(opts.confPath);
  let candidates;
  let extractCode = 'ok';
  if (/\.nal$/i.test(fileName || '')) {
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}
    candidates = [{ path: filePath, name: path.basename(fileName), size }];
  } else {
    const res = await extractNalFiles(filePath, workDir, opts);
    candidates = res.nal;
    extractCode = res.code;
  }
  const valid = candidates.filter((f) => f.size >= NAL_MIN_BYTES && f.size <= NAL_MAX_BYTES);
  const found = candidates.slice(0, 20).map((f) => ({ name: f.name, size: f.size }));
  if (!candidates.length) return { ok: false, code: extractCode === 'ok' ? 'no_nal_found' : extractCode, installed: [], found };
  if (!valid.length) return { ok: false, code: 'invalid_size', installed: [], found };

  const plan = planInstall(valid, devices, { target });
  if (!plan.length) return { ok: false, code: 'unknown_target', installed: [], found };
  const installed = [];
  const failed = [];
  for (const { device, source } of plan) {
    const r = installNal(source.path, device, opts);
    (r.ok ? installed : failed).push(r);
  }
  if (!installed.length) return { ok: false, code: failed[0]?.code || 'write_failed', installed, failed, found };
  return { ok: true, code: 'installed', installed, failed, found };
}

// ---- Upload plumbing ---------------------------------------------------------------

function isMountPoint(dir) {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n').some((l) => l.split(' ')[1] === dir);
  } catch {
    return false;
  }
}

// Where an uploaded installer is unpacked. Prefer the MicroSD high-churn tier; without
// it fall back to /var/tmp with a much smaller cap (one-off write to eMMC, never the
// RAM-backed /tmp on a 1 GB box). Free space is checked by the caller.
export function pickWorkBase() {
  if (isMountPoint('/mnt/data')) return { dir: '/mnt/data/tmp', maxUploadBytes: 800 * 1024 * 1024 };
  return { dir: '/var/tmp', maxUploadBytes: 256 * 1024 * 1024 };
}

export function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

// Stream a request body to disk, aborting past maxBytes (never buffered in the 64 MB heap).
export async function receiveUpload(req, destPath, maxBytes) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'too_large' }));
      else cb(null, chunk);
    }
  });
  await pipeline(req, limiter, fs.createWriteStream(destPath, { mode: 0o600 }));
  return size;
}
