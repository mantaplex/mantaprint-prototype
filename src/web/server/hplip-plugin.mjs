/**
 * MantaPrint Hub - HPLIP proprietary plugin provisioning (Driver Center, phase 1)
 *
 * Many HP multifunction printers (LaserJet Pro MFP M130a among them) print with the free
 * HPLIP packages but only *scan* once HP's proprietary plugin is installed: SANE's hpaio
 * backend attaches to the scanner through binaries that ship in "hplip-<version>-plugin.run",
 * a file HP distributes under its own license. The hub can't bundle or download it, so an
 * admin fetches it on their PC (plugin version = installed HPLIP version) and uploads it
 * here; this module checks it, installs it with hp-plugin, and verifies the result.
 *
 * Which HP devices need the plugin is read from HPLIP's own database
 * (/usr/share/hplip/data/models/models.dat): a "plugin" value > 0, or bit 64 ("scan") in
 * "plugin-reason", means scanning depends on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MODELS_DAT = '/usr/share/hplip/data/models/models.dat';
export const HPLIP_STATE = '/var/lib/hp/hplip.state';
export const PLUGIN_DIRS = ['/usr/share/hplip/scan/plugins', '/usr/share/hplip/prnt/plugins'];
export const PLUGIN_DOWNLOAD_URL = 'https://developers.hp.com/hp-linux-imaging-and-printing/plugins';
export const HP_VENDOR_ID = '03f0';
export const RUN_MAX_BYTES = 64 * 1024 * 1024; // real plugins are ~10 MB
const PLUGIN_REASON_SCAN = 64;
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const RUN_NAME = /^hplip-(\d+\.\d+\.\d+[a-z]?)-plugin\.run$/i;

/** "hplip-3.22.10-plugin.run" -> "3.22.10"; null for anything else. */
export function pluginVersionFromName(fileName) {
  const m = RUN_NAME.exec(String(fileName || '').trim());
  return m ? m[1] : null;
}

/** dpkg's "3.22.10+dfsg0-8.1+deb13u1" -> "3.22.10" (the part the plugin must match). */
export function hplipBaseVersion(dpkgVersion) {
  const m = /(\d+\.\d+\.\d+[a-z]?)/.exec(String(dpkgVersion || ''));
  return m ? m[1] : null;
}

/** HPLIP's section naming: "HP LaserJet MFP M130a" -> "hp_laserjet_mfp_m130a". */
export function modelSectionName(product) {
  return String(product || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Minimal INI reader for models.dat: { section: { key: value } }, keys lower-cased. */
export function parseModelsDat(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      cur = line.slice(1, -1).trim().toLowerCase();
      out[cur] = out[cur] || {};
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[cur][line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Finds a device's entry: exact section first, then the longest section name that is a
 * prefix of the normalized product string (models.dat keys series entries like
 * "hp_laserjet_mfp_m130" for "hp_laserjet_mfp_m130a").
 */
export function findModelEntry(models, product) {
  const name = modelSectionName(product);
  if (!name) return null;
  if (models[name]) return { section: name, ...models[name] };
  let best = null;
  for (const key of Object.keys(models)) {
    if (name.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { section: best, ...models[best] } : null;
}

/** Does scanning on this entry depend on HP's plugin? */
export function pluginNeed(entry) {
  if (!entry) return { needed: null, reason: 'unknown_model' };
  const plugin = Number(entry.plugin || 0);
  const reason = Number(entry['plugin-reason'] || 0);
  const scanType = Number(entry['scan-type'] || 0);
  if (plugin > 0 || (reason & PLUGIN_REASON_SCAN)) {
    return { needed: true, reason: reason & PLUGIN_REASON_SCAN ? 'scan' : plugin === 1 ? 'required' : 'optional', scan_type: scanType };
  }
  return { needed: false, reason: 'not_needed', scan_type: scanType };
}

/** /var/lib/hp/hplip.state -> { installed, eula, version }. */
export function parseHplipState(text) {
  const ini = parseModelsDat(text);
  const p = ini.plugin || {};
  return { installed: p.installed === '1', eula: p.eula === '1', version: p.version || null };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function run(cmd, args, { timeoutMs = 30000, input = null, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, PATH: TOOL_PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (!done) { child.kill('SIGKILL'); } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-200000); });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: 127, stdout: out, stderr: `${err}${e.message}` }); });
    child.on('close', (code, signal) => { done = true; clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), stdout: out, stderr: err }); });
    if (input !== null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

/** Installed HPLIP version (dpkg), or null when the package is missing. */
export async function installedHplipVersion() {
  const r = await run('dpkg-query', ['-W', '-f=${Version}', 'hplip'], { timeoutMs: 5000 });
  return r.code === 0 ? hplipBaseVersion(r.stdout) : null;
}

/** Connected HP USB devices (vendor 03f0) with their models.dat verdict. */
export function connectedHpDevices({ sysRoot = '/sys/bus/usb/devices', modelsPath = MODELS_DAT } = {}) {
  const models = parseModelsDat(readText(modelsPath));
  const haveDb = Object.keys(models).length > 0;
  const list = [];
  let entries = [];
  try { entries = fs.readdirSync(sysRoot); } catch { return list; }
  for (const d of entries) {
    if (d.includes(':')) continue;
    const dev = path.join(sysRoot, d);
    const vid = readText(path.join(dev, 'idVendor')).trim().toLowerCase();
    if (vid !== HP_VENDOR_ID) continue;
    const pid = readText(path.join(dev, 'idProduct')).trim().toLowerCase();
    const product = readText(path.join(dev, 'product')).trim();
    const serial = readText(path.join(dev, 'serial')).trim();
    const entry = haveDb ? findModelEntry(models, product) : null;
    const need = haveDb ? pluginNeed(entry) : { needed: null, reason: 'no_models_dat' };
    list.push({
      usb_id: `${vid}:${pid}`,
      model: product || `HP device ${vid}:${pid}`,
      serial: serial ? serial.slice(0, 40) : '',
      section: entry ? entry.section : null,
      plugin: need
    });
  }
  return list;
}

function pluginFilesPresent() {
  return PLUGIN_DIRS.some((dir) => {
    try { return fs.readdirSync(dir).some((f) => /\.so$/i.test(f)); } catch { return false; }
  });
}

/** Everything the admin page needs to show and decide. */
export async function getHplipPluginStatus(opts = {}) {
  const hplip = await installedHplipVersion();
  const state = parseHplipState(readText(opts.statePath || HPLIP_STATE));
  const devices = connectedHpDevices(opts);
  const installed = Boolean(state.installed && state.version && pluginFilesPresent());
  const needs = devices.filter((d) => d.plugin.needed === true);
  return {
    hplip_installed: Boolean(hplip),
    hplip_version: hplip,
    plugin_installed: installed,
    plugin_version: state.version,
    plugin_matches: installed && hplip ? state.version === hplip : false,
    required_file: hplip ? `hplip-${hplip}-plugin.run` : null,
    download_url: PLUGIN_DOWNLOAD_URL,
    devices,
    needs_plugin: installed ? [] : needs,
    max_upload_bytes: RUN_MAX_BYTES
  };
}

/** The hint the scanner status carries when an HP device is plugged in but SANE can't use it yet. */
export async function hpPluginHint(opts = {}) {
  try {
    const st = await getHplipPluginStatus(opts);
    const d = st.needs_plugin[0];
    if (!d) return null;
    return { model: d.model, usb_id: d.usb_id, hplip_version: st.hplip_version, required_file: st.required_file, hplip_installed: st.hplip_installed };
  } catch {
    return null;
  }
}

/**
 * Installs an uploaded plugin file. Steps:
 *  1. name/version check against the installed HPLIP (hp-plugin refuses mismatches anyway);
 *  2. `hp-plugin -i -p <file>`: verifies HP's signature when the .asc sits next to the file,
 *     otherwise asks whether to continue; both prompts and the license prompt get "y";
 *  3. verify via hplip.state + plugin .so files present.
 * Returns { ok, code, log } where code names the failure for the UI.
 */
export async function installPluginFile({ filePath, fileName, ascPath = null, statePath = HPLIP_STATE, log = () => {} }) {
  const version = pluginVersionFromName(fileName);
  if (!version) return { ok: false, code: 'not_a_plugin' };
  const hplip = await installedHplipVersion();
  if (!hplip) return { ok: false, code: 'hplip_missing' };
  if (version !== hplip) return { ok: false, code: 'version_mismatch', required_version: hplip, required_file: `hplip-${hplip}-plugin.run`, uploaded_version: version };

  // hp-plugin wants the canonical file name, and looks for "<name>.asc" beside it.
  const dir = path.dirname(filePath);
  const canonical = path.join(dir, `hplip-${version}-plugin.run`);
  if (canonical !== filePath) fs.renameSync(filePath, canonical);
  if (ascPath && fs.existsSync(ascPath)) fs.renameSync(ascPath, `${canonical}.asc`);
  fs.chmodSync(canonical, 0o755);

  log(`hp-plugin -i -p ${canonical}`);
  const r = await run('hp-plugin', ['-i', '-p', canonical], { timeoutMs: 10 * 60 * 1000, input: 'y\ny\ny\n', cwd: dir });
  log(r.stdout.slice(-4000));
  if (r.stderr.trim()) log(r.stderr.slice(-2000));

  const state = parseHplipState(readText(statePath));
  const ok = state.installed && state.version === version && pluginFilesPresent();
  if (ok) return { ok: true, version, signature_verified: Boolean(ascPath) };
  return { ok: false, code: r.code === 127 ? 'hp_plugin_missing' : 'install_failed', exit_code: r.code, tail: (r.stdout + '\n' + r.stderr).trim().slice(-1500) };
}
