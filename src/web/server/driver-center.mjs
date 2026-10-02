/**
 * MantaPrint Hub - Driver Center (Admin > Drivers & devices)
 *
 * One place for everything about device support that the hub can't solve by itself:
 *  - the catalog (driver-recipes.json): which families work out of the box, which need a
 *    vendor file the admin has to supply, which have no Linux driver at all;
 *  - "your devices": every printer/scanner the hub sees, with what it still needs;
 *  - lookups ("is model X supported?") answered from the hub's own data: the PPD index
 *    printer_manager.py builds, SANE's USB hwdb, HPLIP's models.dat and the catalog;
 *  - uploads: .nal (ScanSnap firmware), hplip plugin .run, .ppd, HP LaserJet .dl firmware,
 *    vendor .deb packages and installer archives that contain any of those;
 *  - apt: installing packages from a fixed allowlist (needs internet).
 *
 * Installing a .deb runs its maintainer scripts as root: such uploads are staged as
 * "pending" and only installed after the admin confirms with the package details in view.
 * Everything installed is recorded in /etc/mantaprint/drivers.json so it survives OTA updates
 * (which only replace /opt/mantaprint) and can be listed or removed later.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMatchingFiles, getExtractionTools } from './scanner-firmware.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RECIPES_PATH = path.join(__dirname, 'driver-recipes.json');
export const REGISTRY_PATH = '/etc/mantaprint/drivers.json';
export const DRIVER_INDEX_PATH = '/var/cache/cups/mantaprint_drivers.json';
export const SANE_HWDB_PATH = '/usr/lib/udev/hwdb.d/20-sane.hwdb';
export const PPD_DIR = '/usr/share/cups/model/mantaprint-uploads';
export const FOO2ZJS_FW_DIRS = ['/usr/share/foo2zjs/firmware', '/etc/foo2zjs/firmware', '/lib/firmware/hp'];
export const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Packages the admin may install from the Debian repositories (nothing else). */
export const APT_ALLOWLIST = [
  { name: 'hplip', for: 'HP printers and scanners (HPLIP, hp-plugin)' },
  { name: 'libsane-hpaio', for: 'HP scanner backend' },
  { name: 'printer-driver-hpcups', for: 'HP printers (hpcups)' },
  { name: 'printer-driver-postscript-hp', for: 'HP PostScript printers' },
  { name: 'printer-driver-foo2zjs', for: 'HP LaserJet 1018/1020/P1005 and other ZjStream printers' },
  { name: 'printer-driver-brlaser', for: 'Brother laser printers' },
  { name: 'printer-driver-escpr', for: 'Epson inkjets (ESC/P-R)' },
  { name: 'printer-driver-gutenprint', for: 'Many older Epson, Canon and HP models' },
  { name: 'printer-driver-splix', for: 'Samsung and Xerox SPL printers' },
  { name: 'printer-driver-fujixerox', for: 'Fuji Xerox DocuPrint' },
  { name: 'printer-driver-ptouch', for: 'Brother P-touch label printers' },
  { name: 'printer-driver-dymo', for: 'Dymo label printers' },
  { name: 'printer-driver-c2esp', for: 'Kodak ESP inkjets' },
  { name: 'printer-driver-oki', for: 'OKI printers' },
  { name: 'printer-driver-pxljr', for: 'HP Color LaserJet 35xx/36xx' },
  { name: 'printer-driver-sag-gdi', for: 'Samsung GDI printers' },
  { name: 'printer-driver-m2300w', for: 'Minolta magicolor 2300W/2400W' },
  { name: 'printer-driver-min12xxw', for: 'Minolta PagePro 12xxW' },
  { name: 'printer-driver-pnm2ppa', for: 'HP DeskJet 7xx/8xx PPA' },
  { name: 'printer-driver-all', for: 'Every free printer driver Debian ships' },
  { name: 'sane-airscan', for: 'Driverless eSCL / WSD scanners' },
  { name: 'sane-utils', for: 'SANE tools (scanimage)' },
  { name: 'ipp-usb', for: 'Driverless IPP-over-USB printers and scanners' },
  { name: 'cups-filters', for: 'CUPS filter chain' },
  { name: 'nftables', for: 'Firewall used by Lockdown mode (print-only)' },
  { name: 'p7zip-full', for: 'Unpacking vendor installers (.exe/.zip/.7z)' },
  { name: 'cabextract', for: 'Unpacking Windows .cab installers' },
  { name: 'unshield', for: 'Unpacking InstallShield installers' }
];

// ---- small helpers --------------------------------------------------------------------

export function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function run(cmd, args, { timeoutMs = 60000, input = null, cwd, env = {}, onLine } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, PATH: TOOL_PATH, LANG: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: e.message });
    }
    const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, timeoutMs);
    const feed = (buf, isErr) => {
      const s = String(buf);
      if (isErr) err += s; else out += s;
      if (out.length > 400000) out = out.slice(-400000);
      if (err.length > 200000) err = err.slice(-200000);
      if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l.trimEnd());
    };
    child.stdout.on('data', (d) => feed(d, false));
    child.stderr.on('data', (d) => feed(d, true));
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: 127, stdout: out, stderr: `${err}${e.message}` }); });
    child.on('close', (code, signal) => { done = true; clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), stdout: out, stderr: err, timedOut: signal === 'SIGKILL' }); });
    if (input !== null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

// ---- catalog --------------------------------------------------------------------------

export function loadRecipes(p = RECIPES_PATH) {
  const data = readJson(p, { version: 0, recipes: [] });
  const recipes = (data.recipes || []).map((r) => ({
    ...r,
    _vendorRe: r.match?.usb_vendor ? new RegExp(`^(${r.match.usb_vendor})$`, 'i') : null,
    _modelRe: r.match?.model ? new RegExp(r.match.model, 'i') : null,
    _products: new Set((r.match?.usb_products || []).map((x) => x.toLowerCase()))
  }));
  return { version: data.version || 0, recipes };
}

/** Recipes matching a device, best first. Score: USB product 3, vendor+model 2, model only 1. */
export function matchRecipes(recipes, { usb_vendor = '', usb_product = '', model = '', vendor = '' } = {}) {
  const text = `${vendor} ${model}`.trim();
  const out = [];
  for (const r of recipes) {
    let score = 0;
    const vendorOk = r._vendorRe ? Boolean(usb_vendor && r._vendorRe.test(usb_vendor)) : true;
    if (usb_vendor && usb_product && r._products.has(usb_product.toLowerCase()) && vendorOk) score = 3;
    else if (r._modelRe && text && r._modelRe.test(text)) score = r._vendorRe ? (vendorOk ? 2 : (usb_vendor ? 0 : 1)) : 1;
    if (score > 0) out.push({ recipe: r, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.recipe);
}

/** Strip the compiled fields before sending a recipe to the browser. */
export function publicRecipe(r) {
  if (!r) return null;
  const { _vendorRe, _modelRe, _products, ...rest } = r;
  return rest;
}

// ---- uploads: what is this file? ------------------------------------------------------

export const UPLOAD_KINDS = ['nal', 'hplip-plugin', 'asc', 'ppd', 'deb', 'dl', 'archive', 'unknown'];

export function classifyUpload(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (/\.nal$/.test(n)) return 'nal';
  if (/^hplip-\d+\.\d+\.\d+[a-z]?-plugin\.run$/.test(n)) return 'hplip-plugin';
  if (/\.run\.asc$/.test(n)) return 'asc';
  if (/\.ppd(\.gz)?$/.test(n)) return 'ppd';
  if (/\.deb$/.test(n)) return 'deb';
  if (/^sihp[a-z0-9]+\.dl$/.test(n)) return 'dl';
  if (/\.(zip|7z|exe|msi|cab|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|rar|dmg|pkg|iso)$/.test(n)) return 'archive';
  return 'unknown';
}

const ARCHIVE_PAYLOAD = /(\.nal|-plugin\.run|\.ppd|\.ppd\.gz|\.deb|\.dl)$/i;

// ---- registry of installed extras -----------------------------------------------------

export function readRegistry(p = REGISTRY_PATH) {
  const d = readJson(p, null);
  return d && Array.isArray(d.items) ? d : { version: 1, items: [] };
}

export function writeRegistry(reg, p = REGISTRY_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, p);
}

export function addRecord(record, p = REGISTRY_PATH) {
  const reg = readRegistry(p);
  reg.items = reg.items.filter((i) => !(i.kind === record.kind && i.name === record.name));
  reg.items.push({ id: crypto.randomBytes(6).toString('hex'), installed_at: new Date().toISOString(), ...record });
  writeRegistry(reg, p);
  return reg.items[reg.items.length - 1];
}

export function removeRecord(id, p = REGISTRY_PATH) {
  const reg = readRegistry(p);
  const item = reg.items.find((i) => i.id === id) || null;
  reg.items = reg.items.filter((i) => i.id !== id);
  writeRegistry(reg, p);
  return item;
}

// ---- lookups ("is this model supported?") --------------------------------------------

export function loadDriverIndex(p = DRIVER_INDEX_PATH) {
  const d = readJson(p, null);
  return d && Array.isArray(d.drivers) ? d.drivers : [];
}

/** 20-sane.hwdb: "# Canon CanoScan LiDE 100" comment lines, then "usb:v04A9p1904*" entries. */
export function parseSaneHwdb(text) {
  const out = [];
  let comment = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('#')) { comment = line.replace(/^#+\s*/, '').trim(); continue; }
    const m = /^usb:v([0-9A-Fa-f]{4})p([0-9A-Fa-f]{4})/.exec(line.trim());
    if (m) { out.push({ usb_id: `${m[1].toLowerCase()}:${m[2].toLowerCase()}`, name: comment }); continue; }
    if (!line.trim()) comment = '';
  }
  return out;
}

export function searchDriverIndex(drivers, query, limit = 10) {
  const qn = normalize(query);
  if (qn.length < 3) return [];
  const hits = [];
  for (const d of drivers) {
    const mm = normalize(d.make_model);
    const mdl = normalize(d.mdl);
    let conf = null;
    const aliasHit = Array.isArray(d.aliases) && d.aliases.some((a) => { const an = normalize(a); return an.length >= 3 && (an === qn || qn.endsWith(an)); });
    if (mm === qn || aliasHit || (mdl.length >= 4 && (mdl === qn || qn.endsWith(mdl)))) conf = 'exact';
    else if ((mdl.length >= 4 && qn.includes(mdl)) || (qn.length >= 5 && mm.includes(qn))) conf = 'fuzzy';
    if (conf) hits.push({ make_model: d.make_model, driver: d.driver, uri: d.uri, confidence: conf, _len: mm.length });
  }
  hits.sort((a, b) => (a.confidence === b.confidence ? a._len - b._len : a.confidence === 'exact' ? -1 : 1));
  return hits.slice(0, limit).map(({ _len, ...h }) => h);
}

export function searchSaneHwdb(entries, query, limit = 6) {
  const qn = normalize(query);
  if (qn.length < 3) return [];
  const idQ = /([0-9a-f]{4}):([0-9a-f]{4})/i.exec(query);
  const out = [];
  for (const e of entries) {
    const n = normalize(e.name);
    if ((idQ && e.usb_id === `${idQ[1]}:${idQ[2]}`.toLowerCase()) || (n && (n.includes(qn) || qn.includes(n) && n.length >= 6))) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Combined answer for a free-text model query. `sources` lets tests inject data; on the hub
 * everything is read from disk.
 */
export function lookupModel(query, sources = {}) {
  const drivers = sources.drivers || loadDriverIndex();
  const hwdb = sources.hwdb || parseSaneHwdb(readText(SANE_HWDB_PATH));
  const recipes = sources.recipes || loadRecipes().recipes;
  const models = sources.models || null; // HPLIP models.dat, parsed (hplip-plugin.mjs)
  const q = String(query || '').trim().slice(0, 120);

  const ppd = searchDriverIndex(drivers, q);
  const sane = searchSaneHwdb(hwdb, q);
  const matched = matchRecipes(recipes, { model: q });
  let hp = null;
  if (models && /(^|\s)hp\b|hewlett|laserjet|deskjet|officejet/i.test(q)) {
    const entry = sources.findModelEntry ? sources.findModelEntry(models, q) : null;
    if (entry) hp = { section: entry.section, plugin: sources.pluginNeed ? sources.pluginNeed(entry) : null };
  }

  let verdict = 'unknown';
  const r0 = matched[0];
  if (r0?.status === 'unsupported') verdict = 'unsupported';
  else if (ppd.some((h) => h.confidence === 'exact') || r0?.status === 'verified' || r0?.print?.how === 'driverless') verdict = 'supported';
  else if (r0?.status === 'needs_file' || hp?.plugin?.needed) verdict = 'needs_file';
  else if (r0?.status === 'available' || ppd.length || sane.length) verdict = 'likely';

  return { query: q, verdict, ppd, sane, hp, recipes: matched.slice(0, 3).map(publicRecipe) };
}

// ---- "your devices" -------------------------------------------------------------------

/**
 * Pure: folds the hub's live views (printers with readiness, scanner status, HP plugin
 * status, ScanSnap firmware status, raw USB devices) into one list with what each device
 * still needs. `installed` is the set of dpkg package names present.
 */
export function deviceNeeds({ printers = [], scanner = null, hp = null, firmware = null, usb = [], recipes = [], installed = new Set() }) {
  const devices = [];
  const seen = new Set();

  const needsForRecipe = (recipe) => {
    const needs = [];
    for (const req of recipe?.requires || []) {
      if (req.kind === 'deb' && req.package && installed.has(req.package.split(/\s*\/\s*/)[0])) continue;
      needs.push({ kind: req.kind, package: req.package || null, download: req.download || null, note: req.note || '' });
    }
    return needs;
  };

  for (const p of printers) {
    const usbId = /usb/i.test(p.device_uri || '') ? (usb.find((u) => p.device_uri.includes(u.serial) && u.serial) || null) : null;
    const rec = matchRecipes(recipes, { usb_vendor: usbId?.idVendor, usb_product: usbId?.idProduct, model: p.model, vendor: p.vendor })[0] || null;
    const needs = [];
    if (p.readiness === 'needs_firmware') needs.push({ kind: 'dl', note: p.readiness_reason });
    if (p.readiness === 'unsupported') needs.push(...(needsForRecipe(rec).length ? needsForRecipe(rec) : [{ kind: 'ppd', note: p.readiness_reason }]));
    if (p.readiness === 'needs_review') needs.push({ kind: 'review', note: p.readiness_detail || p.readiness_reason });
    if (p.readiness === 'ready') for (const n of needsForRecipe(rec)) if (n.kind !== 'deb') needs.push(n);
    if (usbId) seen.add(usbId.dev);
    devices.push({
      type: 'printer', id: `printer:${p.queue_name || p.name}`, name: p.display_name || p.name, model: p.model, vendor: p.vendor,
      queue: p.queue_name || p.name, connected: Boolean(p.connected), usb_id: usbId ? `${usbId.idVendor}:${usbId.idProduct}` : null,
      readiness: p.readiness || null, readiness_reason: p.readiness_reason || '', readiness_detail: p.readiness_detail || '',
      recipe: publicRecipe(rec), needs
    });
  }

  if (scanner?.connected) {
    devices.push({ type: 'scanner', id: `scanner:${scanner.device_id || 'sane'}`, name: scanner.name, model: scanner.model, vendor: scanner.vendor, connected: true, readiness: 'ready', recipe: publicRecipe(matchRecipes(recipes, { model: scanner.model, vendor: scanner.vendor })[0]), needs: [] });
  }
  for (const d of firmware?.needs_firmware || []) {
    devices.push({ type: 'scanner', id: `scanner:${d.usb_id}`, name: d.model, model: d.model, vendor: 'Fujitsu', usb_id: d.usb_id, connected: true, readiness: 'needs_file', recipe: publicRecipe(matchRecipes(recipes, { usb_vendor: d.usb_id.split(':')[0], usb_product: d.usb_id.split(':')[1], model: d.model })[0]), needs: [{ kind: 'nal', filename: d.filename }] });
  }
  for (const d of hp?.needs_plugin || []) {
    devices.push({ type: 'scanner', id: `scanner:${d.usb_id}:${d.serial || ''}`, name: d.model, model: d.model, vendor: 'HP', usb_id: d.usb_id, connected: true, readiness: 'needs_file', recipe: publicRecipe(matchRecipes(recipes, { usb_vendor: '03f0', model: d.model })[0]), needs: [{ kind: 'hplip-plugin', required_file: hp.required_file, download: hp.download_url, hplip_installed: hp.hplip_installed }] });
  }

  // USB printers the kernel sees but no queue represents yet (provisioning pending or failed).
  for (const u of usb) {
    if (seen.has(u.dev)) continue;
    const model = u.prod || `${u.idVendor}:${u.idProduct}`;
    if (devices.some((d) => d.model && normalize(d.model) === normalize(model))) continue;
    const rec = matchRecipes(recipes, { usb_vendor: u.idVendor, usb_product: u.idProduct, model, vendor: u.mfg })[0] || null;
    devices.push({ type: 'usb', id: `usb:${u.dev}`, name: model, model, vendor: u.mfg, usb_id: `${u.idVendor}:${u.idProduct}`, connected: true, readiness: rec?.status === 'unsupported' ? 'unsupported' : null, recipe: publicRecipe(rec), needs: needsForRecipe(rec) });
  }
  return devices;
}

// ---- installers -----------------------------------------------------------------------

export async function hostArchitecture() {
  const r = await run('dpkg', ['--print-architecture'], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : '';
}

export async function installedPackages(names) {
  const set = new Set();
  if (!names.length) return set;
  const r = await run('dpkg-query', ['-W', '-f=${Package}\t${Status}\n', ...names], { timeoutMs: 10000 });
  for (const line of r.stdout.split('\n')) {
    const [pkg, status] = line.split('\t');
    if (pkg && /install ok installed/.test(status || '')) set.add(pkg);
  }
  return set;
}

/** dpkg-deb -f output -> object; also used for the confirmation popup. */
export function parseDebControl(text) {
  const out = {};
  let last = null;
  for (const line of String(text || '').split('\n')) {
    if (/^\s/.test(line) && last) { out[last] += `\n${line.trim()}`; continue; }
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) { last = m[1].toLowerCase(); out[last] = m[2]; }
  }
  return out;
}

export async function inspectDeb(filePath) {
  const r = await run('dpkg-deb', ['-f', filePath, 'Package', 'Version', 'Architecture', 'Maintainer', 'Description', 'Depends', 'Installed-Size', 'Homepage'], { timeoutMs: 30000 });
  if (r.code !== 0) return { ok: false, code: 'not_a_deb', tail: r.stderr.slice(-300) };
  const c = parseDebControl(r.stdout);
  const arch = await hostArchitecture();
  const scripts = await run('dpkg-deb', ['--ctrl-tarfile', filePath], { timeoutMs: 30000 });
  const hasScripts = /(pre|post)(inst|rm)/.test(scripts.stdout);
  return {
    ok: true,
    package: c.package || '', version: c.version || '', architecture: c.architecture || '', maintainer: c.maintainer || '',
    description: (c.description || '').split('\n')[0], depends: c.depends || '', installed_size_kb: Number(c['installed-size'] || 0), homepage: c.homepage || '',
    host_architecture: arch, arch_ok: !c.architecture || c.architecture === 'all' || c.architecture === arch, has_maintainer_scripts: hasScripts
  };
}

export async function installDeb(filePath, { pkgName = '', log = () => {} } = {}) {
  log(`dpkg -i ${path.basename(filePath)}`);
  let r = await run('dpkg', ['-i', filePath], { timeoutMs: 15 * 60 * 1000, onLine: log });
  if (r.code !== 0) {
    log('dpkg reported missing dependencies; trying apt-get -f install (needs internet)');
    r = await run('apt-get', ['-f', 'install', '-y', '--no-install-recommends'], { timeoutMs: 15 * 60 * 1000, onLine: log });
  }
  if (r.code === 0 && pkgName) {
    const q = await run('dpkg-query', ['-W', '-f=${db:Status-Status}', pkgName], { timeoutMs: 5000 });
    if (q.code !== 0 || q.stdout.trim() !== 'installed') {
      log(`Package ${pkgName} is not in installed state after dependency resolution (status: ${q.stdout.trim() || 'removed'})`);
      return { ok: false, code: 'deps_unresolved', exit_code: 1 };
    }
  }
  return { ok: r.code === 0, exit_code: r.code };
}

export async function removeDeb(pkg, { log = () => {} } = {}) {
  if (!/^[a-z0-9][a-z0-9+.-]+$/.test(pkg)) return { ok: false, code: 'bad_name' };
  const r = await run('apt-get', ['remove', '-y', pkg], { timeoutMs: 10 * 60 * 1000, onLine: log });
  return { ok: r.code === 0, exit_code: r.code };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,120}$/;

export async function installPpd(filePath, fileName, { ppdDir = PPD_DIR } = {}) {
  const name = path.basename(fileName).replace(/[^A-Za-z0-9_.+-]/g, '_');
  if (!SAFE_NAME.test(name) || !/\.ppd(\.gz)?$/i.test(name)) return { ok: false, code: 'bad_name' };
  // First line of a PPD (possibly gzipped) is "*PPD-Adobe: "4.3"".
  const head = /\.gz$/i.test(name) ? await run('sh', ['-c', `zcat "$1" | head -c 64`, 'sh', filePath], { timeoutMs: 10000 }) : { code: 0, stdout: readText(filePath).slice(0, 64) };
  if (!/^\*PPD-Adobe/.test(head.stdout || '')) return { ok: false, code: 'not_a_ppd' };
  const test = await run('cupstestppd', ['-r', '-W', 'all', filePath], { timeoutMs: 30000 });
  if (test.code !== 0 && test.code !== 127) return { ok: false, code: 'ppd_invalid', tail: (test.stdout + test.stderr).trim().slice(-600) };
  fs.mkdirSync(ppdDir, { recursive: true, mode: 0o755 });
  const dest = path.join(ppdDir, name);
  fs.copyFileSync(filePath, dest);
  fs.chmodSync(dest, 0o644);
  let nick = '';
  const nm = /\*NickName:\s*"([^"]+)"/.exec(/\.gz$/i.test(name) ? (await run('zcat', [dest], { timeoutMs: 10000 })).stdout : readText(dest));
  if (nm) nick = nm[1];
  return { ok: true, path: dest, name, nickname: nick, validated: test.code === 0 };
}

export async function assignPpdToQueue(queue, ppdPath) {
  if (!/^[A-Za-z0-9_-]+$/.test(queue)) return { ok: false, code: 'bad_queue' };
  const r = await run('lpadmin', ['-p', queue, '-P', ppdPath], { timeoutMs: 30000 });
  return { ok: r.code === 0, tail: (r.stdout + r.stderr).trim().slice(-300) };
}

export function installDl(filePath, fileName, { dirs } = {}) {
  dirs = dirs || [...new Set([hpFirmwareCacheDir(), ...FOO2ZJS_FW_DIRS])];
  const name = path.basename(fileName).toLowerCase();
  if (!/^sihp[a-z0-9]{4,6}\.dl$/.test(name)) return { ok: false, code: 'bad_name' };
  const size = fs.statSync(filePath).size;
  if (size < 50 * 1024 || size > 4 * 1024 * 1024) return { ok: false, code: 'invalid_size' };
  const written = [];
  for (const dir of dirs) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(filePath, path.join(dir, name)); fs.chmodSync(path.join(dir, name), 0o644); written.push(path.join(dir, name)); } catch {}
  }
  return written.length ? { ok: true, name, paths: written } : { ok: false, code: 'write_failed' };
}

/** Unpack an installer and list the driver-ish files inside (kept on disk for the admin to pick). */
export async function unpackArchive(filePath, workDir, opts = {}) {
  const r = await extractMatchingFiles(filePath, workDir, { ...opts, match: ARCHIVE_PAYLOAD, tools: opts.tools || getExtractionTools() });
  const files = (r.files || []).map((f) => ({ name: f.name, size: f.size, path: f.path, kind: classifyUpload(f.name) })).filter((f) => f.kind !== 'unknown' && f.kind !== 'archive');
  return { code: files.length ? 'ok' : (r.code === 'ok' ? 'no_match' : r.code), files };
}

// ---- apt -------------------------------------------------------------------------------

let lastAptUpdate = 0;

export function isAllowedPackage(name) {
  return APT_ALLOWLIST.some((p) => p.name === name);
}

export async function aptStatus() {
  const installed = await installedPackages(APT_ALLOWLIST.map((p) => p.name));
  return { packages: APT_ALLOWLIST.map((p) => ({ ...p, installed: installed.has(p.name) })), last_update: lastAptUpdate || null };
}

export async function aptInstall(pkg, { log = () => {} } = {}) {
  const pkgs = Array.isArray(pkg) ? pkg : [pkg];
  if (!pkgs.length || !pkgs.every(isAllowedPackage)) return { ok: false, code: 'not_allowed' };
  if (Date.now() - lastAptUpdate > 60 * 60 * 1000) {
    log('apt-get update');
    const u = await run('apt-get', ['update'], { timeoutMs: 5 * 60 * 1000, onLine: log });
    if (u.code !== 0) return { ok: false, code: 'offline', tail: u.stderr.slice(-400) };
    lastAptUpdate = Date.now();
  }
  log(`apt-get install -y --no-install-recommends ${pkgs.join(' ')}`);
  const r = await run('apt-get', ['install', '-y', '--no-install-recommends', ...pkgs], { timeoutMs: 20 * 60 * 1000, onLine: log });
  return { ok: r.code === 0, exit_code: r.code, tail: (r.stdout + r.stderr).trim().slice(-600) };
}

// ---- background jobs (one at a time) ---------------------------------------------------

let current = null;

export function getJob() {
  return current ? { ...current, log: current.log.slice(-200) } : null;
}

export function jobBusy() {
  return Boolean(current && current.state === 'running');
}

/** Runs fn(log) in the background; the UI polls getJob(). Rejects with 'busy' if one runs. */
export function startJob(kind, label, fn) {
  if (jobBusy()) return null;
  const job = { id: crypto.randomBytes(4).toString('hex'), kind, label, state: 'running', started_at: new Date().toISOString(), finished_at: null, log: [], result: null };
  current = job;
  const log = (line) => { job.log.push(String(line).slice(0, 500)); if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000); };
  Promise.resolve().then(() => fn(log)).then((result) => {
    job.result = result; job.state = result && result.ok === false ? 'failed' : 'done';
  }).catch((err) => {
    console.error(`[Drivers] job ${kind} (${label}) threw:`, err.stack || err.message);
    job.result = { ok: false, code: 'exception', message: err.message }; job.state = 'failed';
  }).finally(() => { job.finished_at = new Date().toISOString(); });
  return job;
}

// ---- pending items (uploads waiting for a decision) -------------------------------------

const pending = new Map();

export function addPending(item) {
  const id = crypto.randomBytes(5).toString('hex');
  const rec = { id, created_at: new Date().toISOString(), ...item };
  pending.set(id, rec);
  return rec;
}
export function getPending(id) { return pending.get(id) || null; }
export function listPending() { return [...pending.values()].map(({ path: _p, workDir: _w, files, ...rest }) => ({ ...rest, files: files ? files.map(({ path: _fp, ...f }) => f) : undefined })); }
export function dropPending(id) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  try { if (p.workDir) fs.rmSync(p.workDir, { recursive: true, force: true }); } catch {}
  return true;
}

// ---- setup checklists (what the Drivers & devices page executes) ----------------------
//
// A family (catalog entry) or a connected device gets an ordered list of steps, each with a
// status and the action that completes it. Pure functions: the route gathers the facts
// (installed packages, HP plugin state, ScanSnap firmware, HP firmware files, connected
// devices) and the browser only renders and triggers actions.

/** getweb model key -> firmware file (mirrors HP_FIRMWARE_MODELS in printer_manager.py). */
export const HP_FIRMWARE = {
  '1000': 'sihp1000.dl', '1005': 'sihp1005.dl', '1018': 'sihp1018.dl', '1020': 'sihp1020.dl',
  P1005: 'sihpP1005.dl', P1007: 'sihpP1005.dl', P1006: 'sihpP1006.dl', P1008: 'sihpP1006.dl', P1505: 'sihpP1505.dl'
};
export const HP_FIRMWARE_DIRS = ['/mnt/data/firmware/hp', '/var/cache/mantaprint/firmware/hp', '/usr/share/foo2zjs/firmware', '/etc/foo2zjs/firmware', '/lib/firmware/hp'];

/** Lower-cased names of firmware files present (non-empty) in any of the known directories. */
export function presentHpFirmware(dirs = HP_FIRMWARE_DIRS) {
  const out = new Set();
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      try { if (/\.dl$/i.test(f) && fs.statSync(path.join(dir, f)).size > 0) out.add(f.toLowerCase()); } catch {}
    }
  }
  return out;
}

/** HP firmware cache dir printer_manager.py reads from (MicroSD first). */
export function hpFirmwareCacheDir() {
  return fs.existsSync('/mnt/data') ? '/mnt/data/firmware/hp' : '/var/cache/mantaprint/firmware/hp';
}

/** "brscan4 / <model>lpr" -> "brscan4"; null when the requirement names no package. */
export function requiredPackageName(req) {
  const first = String(req?.package || '').split(/\s*\/\s*/)[0].trim();
  return /^[a-z0-9][a-z0-9+.-]*$/.test(first) ? first : null;
}

/** Every dpkg package name the checklists need to know the state of. */
export function allPackageNames(recipes) {
  const names = new Set(APT_ALLOWLIST.map((p) => p.name));
  for (const r of recipes) {
    for (const p of r.apt || []) names.add(p);
    for (const req of r.requires || []) { const n = requiredPackageName(req); if (n) names.add(n); }
  }
  return [...names];
}

const SETUP_KINDS = new Set(['packages', 'deb', 'plugin', 'nal', 'dl', 'ppd']);

function summarize(recipeStatus, steps) {
  if (recipeStatus === 'unsupported') return { state: 'unsupported', todo: 0 };
  const todo = steps.filter((s) => SETUP_KINDS.has(s.kind) && (s.status === 'todo' || s.status === 'blocked')).length;
  return { state: todo ? 'setup' : 'ready', todo };
}

/** Per-file rows for a step that needs several files, each with its own upload button in the UI. */
export function nalFiles(targets) {
  return (targets || []).map((x) => ({ id: x.filename, name: x.filename, note: x.model, done: Boolean(x.installed), connected: Boolean(x.connected), accept: '.nal,.zip,.exe,.cab,.msi,.7z,.dmg,.pkg', expect: 'nal', endpoint: '/api/scanner/firmware', target: x.filename }));
}
export function dlFiles(models) {
  return (models || []).map((m) => ({ id: m.key, name: m.filename, note: m.models.join(', '), done: Boolean(m.present), accept: '.dl', expect: 'dl', endpoint: '/api/drivers/upload' }));
}
export function pluginFiles(hplip, done) {
  const run = hplip.required_file || 'hplip-<version>-plugin.run';
  return [
    { id: 'asc', name: `${run}.asc`, optional: true, done: Boolean(hplip.asc_pending || (done && hplip.signature_verified)), accept: '.asc', expect: 'hplip-plugin', endpoint: '/api/drivers/upload' },
    { id: 'run', name: run, done, accept: '.run', expect: 'hplip-plugin', endpoint: '/api/drivers/upload' }
  ];
}

function hpFirmwareModels(recipe, hpfw) {
  const out = [];
  for (const m of recipe.models || []) {
    const key = Object.keys(HP_FIRMWARE).find((k) => new RegExp(`(^|\\s)${k}$`, 'i').test(m));
    if (!key) continue;
    const file = HP_FIRMWARE[key];
    if (out.some((x) => x.filename === file)) { out.find((x) => x.filename === file).models.push(m); continue; }
    out.push({ key, filename: file, models: [m], present: hpfw.has(file.toLowerCase()) });
  }
  return out;
}

/**
 * Steps for a catalog family. facts: { installed:Set, hplip, nal:{devices:[]}, hpfw:Set,
 * devices:[connected devices matched to this family] }.
 */
export function familySteps(recipe, facts = {}) {
  const installed = facts.installed || new Set();
  const hplip = facts.hplip || {};
  const nalDevices = facts.nal?.devices || [];
  const hpfw = facts.hpfw || new Set();
  const devices = facts.devices || [];
  const steps = [];

  if (recipe.status === 'unsupported') {
    steps.push({ id: 'unsupported', kind: 'unsupported', status: 'info', note: recipe.note || '', actions: [] });
    return { steps, summary: summarize(recipe.status, steps) };
  }

  const pkgs = recipe.apt || [];
  if (pkgs.length) {
    const missing = pkgs.filter((p) => !installed.has(p));
    steps.push({ id: 'packages', kind: 'packages', status: missing.length ? 'todo' : 'done', packages: pkgs, missing, actions: missing.length ? [{ type: 'apt', packages: missing }] : [] });
  }

  for (const req of recipe.requires || []) {
    if (req.kind === 'deb') {
      const pkg = requiredPackageName(req);
      const done = Boolean(pkg && installed.has(pkg));
      steps.push({ id: `deb:${pkg || 'vendor'}`, kind: 'deb', status: done ? 'done' : 'todo', package: req.package || '', arch: req.arch || [], download: req.download || null, note: req.note || '', actions: done ? [] : [{ type: 'upload', accept: '.deb', endpoint: '/api/drivers/upload', expect: 'deb' }, ...(req.download ? [{ type: 'link', href: req.download }] : [])] });
    } else if (req.kind === 'hplip-plugin') {
      const done = Boolean(hplip.plugin_installed && hplip.plugin_matches !== false);
      const blocked = !hplip.hplip_installed;
      steps.push({ id: 'plugin', kind: 'plugin', status: done ? 'done' : blocked ? 'blocked' : 'todo', blocked_by: blocked ? 'packages' : null, required_file: hplip.required_file || 'hplip-<version>-plugin.run', hplip_version: hplip.hplip_version || null, plugin_version: hplip.plugin_version || null, download: req.download || hplip.download_url || null, files: pluginFiles(hplip, done), actions: done || blocked ? [] : [{ type: 'upload', accept: '.run,.asc', endpoint: '/api/drivers/upload', expect: 'hplip-plugin' }, ...(req.download ? [{ type: 'link', href: req.download }] : [])] });
    } else if (req.kind === 'nal') {
      const targets = nalDevices.map((d) => ({ model: d.model, filename: d.filename, usb_id: d.usb_id, installed: Boolean(d.installed), connected: Boolean(d.connected) }));
      const connectedMissing = targets.filter((x) => x.connected && !x.installed);
      const installedCount = targets.filter((x) => x.installed).length;
      const status = connectedMissing.length ? 'todo' : installedCount ? 'done' : 'todo';
      steps.push({ id: 'nal', kind: 'nal', status, targets, files: nalFiles(targets), actions: status === 'done' ? [] : [{ type: 'upload', accept: '.nal,.zip,.exe,.cab,.msi,.7z,.dmg,.pkg', endpoint: '/api/scanner/firmware', expect: 'nal', target: connectedMissing[0]?.filename || null }] });
    } else if (req.kind === 'dl') {
      const models = hpFirmwareModels(recipe, hpfw);
      const missing = models.filter((m) => !m.present);
      steps.push({ id: 'dl', kind: 'dl', status: missing.length ? 'todo' : 'done', models, files: dlFiles(models), actions: missing.length ? [{ type: 'getweb', models: missing.map((m) => m.key) }, { type: 'upload', accept: '.dl', endpoint: '/api/drivers/upload', expect: 'dl' }] : [] });
    }
  }

  steps.push({ id: 'connect', kind: 'connect', status: devices.length ? 'done' : 'todo', connected: devices.map((d) => d.name || d.model), actions: [] });

  const setupDone = steps.every((s) => !SETUP_KINDS.has(s.kind) || s.status === 'done');
  const printers = devices.filter((d) => d.type === 'printer' && d.queue);
  const scanners = devices.filter((d) => d.type === 'scanner' && d.readiness === 'ready');
  const verifyActions = [...printers.map((d) => ({ type: 'test-print', queue: d.queue, name: d.name })), ...(scanners.length || recipe.kind === 'scanner' || recipe.kind === 'mfp' ? [{ type: 'open-scan' }] : [])];
  steps.push({ id: 'verify', kind: 'verify', status: devices.length && setupDone ? 'todo' : 'blocked', actions: devices.length && setupDone ? verifyActions : [] });

  return { steps, summary: summarize(recipe.status, steps) };
}

/** Steps for one connected device (the family's steps, targeted, plus queue-specific ones). */
export function deviceSteps(device, recipe, facts = {}) {
  let steps = [];
  if (recipe) {
    steps = familySteps(recipe, { ...facts, devices: [device] }).steps.filter((s) => s.kind !== 'connect');
    // ScanSnap firmware: only this device's file.
    const nal = steps.find((s) => s.kind === 'nal');
    if (nal && device.usb_id) {
      nal.targets = nal.targets.filter((x) => x.usb_id === device.usb_id);
      nal.files = nalFiles(nal.targets);
      const mine = nal.targets[0];
      if (mine) { nal.status = mine.installed ? 'done' : 'todo'; nal.actions = mine.installed ? [] : [{ type: 'upload', accept: '.nal,.zip,.exe,.cab,.msi,.7z,.dmg,.pkg', endpoint: '/api/scanner/firmware', expect: 'nal', target: mine.filename }]; }
    }
  }
  const verify = steps.find((s) => s.kind === 'verify');
  if (verify) steps = steps.filter((s) => s.kind !== 'verify');

  if (device.type === 'printer' && device.queue) {
    const q = device.queue;
    // HP host-based firmware: talk about this printer's own file, not the whole family's.
    const dl = steps.find((s) => s.kind === 'dl');
    if (dl && dl.models?.length) {
      const hay = `${device.name || ''} ${device.model || ''}`;
      const mine = dl.models.filter((m) => m.models.some((name) => new RegExp(`(^|[^0-9a-z])${name.replace(/^laserjet\s+/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9a-z]|$)`, 'i').test(hay)));
      if (mine.length) {
        dl.models = mine;
        dl.files = dlFiles(mine);
        dl.status = mine.every((m) => m.present) ? 'done' : 'todo';
        dl.actions = dl.status === 'done' ? [] : [{ type: 'getweb', models: mine.filter((m) => !m.present).map((m) => m.key) }, { type: 'upload', accept: '.dl', endpoint: '/api/drivers/upload', expect: 'dl' }];
      }
    }
    if (device.readiness === 'needs_firmware') {
      const provision = { type: 'provision', queue: q };
      if (dl) { dl.status = 'todo'; dl.actions = [provision, ...dl.actions.filter((a) => a.type !== 'provision')]; }
      else steps.push({ id: 'dl', kind: 'dl', status: 'todo', models: [], files: [], actions: [provision, { type: 'upload', accept: '.dl', endpoint: '/api/drivers/upload', expect: 'dl', queue: q }] });
    } else if (device.readiness === 'provisioning') {
      steps.push({ id: 'provisioning', kind: 'provisioning', status: 'info', actions: [] });
    }
    if (device.readiness === 'unsupported' || device.readiness === 'needs_review' || (!recipe && device.readiness == null)) {
      const optional = device.readiness === 'needs_review' || steps.some((s) => s.kind === 'deb' && s.status !== 'done');
      steps.push({ id: 'ppd', kind: 'ppd', status: optional ? 'optional' : 'todo', queue: q, reason: device.readiness_reason || '', actions: [{ type: 'upload', accept: '.ppd,.ppd.gz,.gz', endpoint: '/api/drivers/upload', expect: 'ppd', queue: q }] });
    }
    const setupDone = steps.every((s) => !SETUP_KINDS.has(s.kind) || s.status === 'done' || s.status === 'optional');
    steps.push({ id: 'verify', kind: 'verify', status: device.readiness === 'ready' || (setupDone && device.connected) ? 'todo' : 'blocked', actions: device.connected ? [{ type: 'test-print', queue: q, name: device.name }] : [] });
  } else if (device.type === 'scanner') {
    const setupDone = steps.every((s) => !SETUP_KINDS.has(s.kind) || s.status === 'done');
    steps.push({ id: 'verify', kind: 'verify', status: device.readiness === 'ready' && setupDone ? 'todo' : 'blocked', actions: device.readiness === 'ready' ? [{ type: 'open-scan' }] : [] });
  } else if (device.type === 'usb' && !recipe) {
    steps.push({ id: 'ppd', kind: 'ppd', status: 'todo', queue: null, reason: 'unknown_device', actions: [{ type: 'upload', accept: '.ppd,.ppd.gz,.gz', endpoint: '/api/drivers/upload', expect: 'ppd' }] });
  }
  const summary = summarize(recipe?.status === 'unsupported' ? 'unsupported' : 'x', steps);
  if (device.readiness === 'ready' && summary.state === 'setup') summary.state = 'ready';
  return { steps, summary };
}

/** Fetch HP host-based LaserJet firmware with foo2zjs' getweb (needs internet). */
export async function fetchHpFirmware(models, { log = () => {}, workDir } = {}) {
  const keys = [...new Set((Array.isArray(models) ? models : [models]).map(String))].filter((k) => k in HP_FIRMWARE);
  if (!keys.length) return { ok: false, code: 'bad_model' };
  const cwd = workDir || fs.mkdtempSync(path.join('/tmp', 'getweb-'));
  const dirs = [...new Set([hpFirmwareCacheDir(), ...FOO2ZJS_FW_DIRS])];
  const fetched = [], failed = [];
  for (const key of keys) {
    const file = HP_FIRMWARE[key];
    log(`getweb ${key}`);
    const r = await run('getweb', [key], { timeoutMs: 90000, cwd, onLine: log });
    const found = [cwd, '/usr/share/foo2zjs/firmware', '/etc/foo2zjs/firmware'].map((d) => path.join(d, file)).find((p) => { try { return fs.statSync(p).size > 50 * 1024; } catch { return false; } });
    if (r.code === 0 && found) {
      const res = installDl(found, file, { dirs });
      if (res.ok) { fetched.push(file); continue; }
    }
    failed.push(key);
    log(`  ${key}: ${r.code === 127 ? 'getweb is not installed (package printer-driver-foo2zjs)' : 'download failed (no internet, or the mirror is down)'}`);
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  return { ok: failed.length === 0, code: failed.length ? 'fetch_failed' : undefined, fetched, failed };
}
