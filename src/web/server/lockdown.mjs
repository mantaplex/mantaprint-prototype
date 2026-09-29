/**
 * MantaPrint Hub - Lockdown mode (print-only)
 *
 * For sites where the hub must expose as little as possible: an nftables ruleset that lets
 * clients reach the printer (IPP 631/tcp) and discover it (mDNS 5353/udp) and nothing else.
 * The admin web is reachable only from the admin IPs/CIDRs the operator lists (empty list =
 * from nowhere but the hub's own console); SSH follows the same list only when explicitly
 * enabled; every other inbound port is dropped and, apart from DHCP/DNS/NTP/mDNS, so is
 * outbound traffic - which also blocks updates from GitHub and the MantaPool agent.
 * cups-browsed is disabled for good (CVE-2024-47176 family).
 *
 * The switch lives in the TUI (physical console) and in Admin > Settings. Turning it off needs
 * the lockdown PIN (default 1234, changeable in Settings). State: /etc/mantaprint/lockdown.json;
 * the generated ruleset is written to /etc/mantaprint/lockdown.nft and re-applied at boot by
 * mantaprint-lockdown.service. Scanning, Scan Studio, the homepage and MantaPool do not work
 * while lockdown is on - by design, and every UI says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const CONFIG_PATH = '/etc/mantaprint/lockdown.json';
export const RULESET_PATH = '/etc/mantaprint/lockdown.nft';
export const TABLE = 'mantaprint_lockdown';
export const DEFAULT_PIN = '1234';
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** "192.168.10.0/24" or "10.0.0.5" -> normalized string, or null when invalid. */
export function normalizeCidr(text) {
  const s = String(text || '').trim();
  const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(s);
  if (!m || !IPV4.test(m[1])) return null;
  const prefix = m[2] === undefined ? 32 : Number(m[2]);
  if (prefix < 0 || prefix > 32) return null;
  return prefix === 32 ? m[1] : `${m[1]}/${prefix}`;
}

export function parseAdminIps(list) {
  const items = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  const out = [];
  const bad = [];
  for (const raw of items) {
    if (!String(raw || '').trim()) continue;
    const n = normalizeCidr(raw);
    if (n) { if (!out.includes(n)) out.push(n); } else bad.push(String(raw).trim());
  }
  return { ips: out, bad };
}

export function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}$${h}`;
}

export function verifyPin(pin, stored) {
  const [salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const cand = crypto.scryptSync(String(pin), salt, 32);
  const want = Buffer.from(h, 'hex');
  return cand.length === want.length && crypto.timingSafeEqual(cand, want);
}

export function validPin(pin) {
  return /^\d{4,8}$/.test(String(pin || ''));
}

export function defaultConfig() {
  return { version: 1, enabled: false, admin_ips: [], ssh_from_admin: false, pin_hash: hashPin(DEFAULT_PIN), pin_is_default: true, enabled_at: null, enabled_by: null };
}

export function loadConfig(p = CONFIG_PATH) {
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...defaultConfig(), ...c, admin_ips: Array.isArray(c.admin_ips) ? c.admin_ips : [] };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg, p = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * The nftables ruleset. Pure: same config in, same text out (tests pin it down).
 * Inbound: loopback, established, ICMP/ICMPv6 (no echo replies are needed for printing, but
 * path MTU and neighbour discovery are), DHCP replies, mDNS, IPP 631/tcp, and 80/tcp (+22/tcp
 * when enabled) from the admin list only. Outbound: loopback, established, ICMP, DHCP, DNS,
 * NTP, mDNS. Everything else is dropped; drops are counted so the admin can see them.
 */
export function buildRuleset(cfg) {
  const adminIps = (cfg.admin_ips || []).map(normalizeCidr).filter(Boolean);
  const adminSet = adminIps.length ? `{ ${adminIps.join(', ')} }` : null;
  const lines = [
    `#!/usr/sbin/nft -f`,
    `# MantaPrint lockdown mode (print-only). Generated; do not edit. See docs/14-lockdown-mode.md.`,
    `table inet ${TABLE}`,
    `delete table inet ${TABLE}`,
    `table inet ${TABLE} {`,
    `  counter dropped_in { }`,
    `  counter dropped_out { }`,
    `  chain input {`,
    `    type filter hook input priority 0; policy drop;`,
    `    iif "lo" accept`,
    `    ct state established,related accept`,
    `    ct state invalid drop`,
    `    ip protocol icmp accept`,
    `    ip6 nexthdr icmpv6 accept`,
    `    udp sport 67 udp dport 68 accept comment "DHCP"`,
    `    udp dport 5353 accept comment "mDNS (AirPrint/Mopria discovery)"`,
    `    tcp dport 631 accept comment "IPP printing"`
  ];
  if (adminSet) {
    lines.push(`    ip saddr ${adminSet} tcp dport 80 accept comment "admin web from admin IPs"`);
    if (cfg.ssh_from_admin) lines.push(`    ip saddr ${adminSet} tcp dport 22 accept comment "SSH from admin IPs"`);
  }
  lines.push(
    `    counter name "dropped_in" drop`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority 0; policy drop;`,
    `  }`,
    `  chain output {`,
    `    type filter hook output priority 0; policy drop;`,
    `    oif "lo" accept`,
    `    ct state established,related accept`,
    `    ip protocol icmp accept`,
    `    ip6 nexthdr icmpv6 accept`,
    `    udp sport 68 udp dport 67 accept comment "DHCP"`,
    `    udp dport 53 accept comment "DNS"`,
    `    tcp dport 53 accept comment "DNS"`,
    `    udp dport 123 accept comment "NTP"`,
    `    udp dport 5353 accept comment "mDNS"`,
    `    counter name "dropped_out" drop`,
    `  }`,
    `}`,
    ``
  );
  return lines.join('\n');
}

function run(cmd, args, { timeoutMs = 20000, input = null } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, PATH: TOOL_PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: 127, stdout: '', stderr: e.message }); }
    const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: 127, stdout: out, stderr: `${err}${e.message}` }); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout: out, stderr: err }); });
    if (input !== null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

export async function nftAvailable() {
  const r = await run('nft', ['--version'], { timeoutMs: 5000 });
  return r.code === 0;
}

/** Is the lockdown table live in the kernel right now? */
export async function isApplied() {
  const r = await run('nft', ['list', 'table', 'inet', TABLE], { timeoutMs: 5000 });
  return r.code === 0;
}

export async function dropCounters() {
  const r = await run('nft', ['-j', 'list', 'counters', 'table', 'inet', TABLE], { timeoutMs: 5000 });
  const out = { dropped_in: 0, dropped_out: 0 };
  if (r.code !== 0) return out;
  try {
    for (const item of JSON.parse(r.stdout).nftables || []) {
      const c = item.counter;
      if (c && c.name in out) out[c.name] = Number(c.packets || 0);
    }
  } catch {}
  return out;
}

/** Writes the ruleset and loads it; disables cups-browsed. */
export async function applyLockdown(cfg, { rulesetPath = RULESET_PATH } = {}) {
  if (!(await nftAvailable())) return { ok: false, code: 'nft_missing' };
  const text = buildRuleset(cfg);
  fs.mkdirSync(path.dirname(rulesetPath), { recursive: true });
  fs.writeFileSync(rulesetPath, text, { mode: 0o600 });
  // The "delete table" line only works when the table exists, hence the leading declaration;
  // nft still refuses if the kernel lacks nf_tables - report that as-is.
  const r = await run('nft', ['-f', rulesetPath], { timeoutMs: 20000 });
  if (r.code !== 0) return { ok: false, code: 'nft_failed', tail: (r.stderr || r.stdout).trim().slice(-500) };
  await run('systemctl', ['disable', '--now', 'cups-browsed.service'], { timeoutMs: 20000 });
  return { ok: true };
}

export async function clearLockdown() {
  if (!(await isApplied())) return { ok: true, was_applied: false };
  const r = await run('nft', ['delete', 'table', 'inet', TABLE], { timeoutMs: 10000 });
  return r.code === 0 ? { ok: true, was_applied: true } : { ok: false, code: 'nft_failed', tail: (r.stderr || r.stdout).trim().slice(-500) };
}

export async function getStatus(cfg = loadConfig()) {
  const [applied, nft] = await Promise.all([isApplied(), nftAvailable()]);
  const counters = applied ? await dropCounters() : { dropped_in: 0, dropped_out: 0 };
  return {
    enabled: Boolean(cfg.enabled),
    applied,
    nft_available: nft,
    admin_ips: cfg.admin_ips || [],
    ssh_from_admin: Boolean(cfg.ssh_from_admin),
    pin_is_default: Boolean(cfg.pin_is_default),
    enabled_at: cfg.enabled_at,
    enabled_by: cfg.enabled_by,
    counters,
    // The console can always turn lockdown off; the web can only from an admin IP.
    blocks: ['scan_studio', 'homepage', 'admin_web_except_admin_ips', 'ssh', 'updates', 'mantapool_agent', 'ipp_usb_escl']
  };
}

export async function enable({ by = 'admin', admin_ips, ssh_from_admin } = {}) {
  const cfg = loadConfig();
  if (admin_ips !== undefined) {
    const parsed = parseAdminIps(admin_ips);
    if (parsed.bad.length) return { ok: false, code: 'bad_admin_ip', bad: parsed.bad };
    cfg.admin_ips = parsed.ips;
  }
  if (ssh_from_admin !== undefined) cfg.ssh_from_admin = Boolean(ssh_from_admin);
  const r = await applyLockdown(cfg);
  if (!r.ok) return r;
  cfg.enabled = true;
  cfg.enabled_at = new Date().toISOString();
  cfg.enabled_by = by;
  saveConfig(cfg);
  return { ok: true, status: await getStatus(cfg) };
}

export async function disable({ pin } = {}) {
  const cfg = loadConfig();
  if (!verifyPin(pin, cfg.pin_hash)) return { ok: false, code: 'bad_pin' };
  const r = await clearLockdown();
  if (!r.ok) return r;
  cfg.enabled = false;
  cfg.enabled_at = null;
  cfg.enabled_by = null;
  saveConfig(cfg);
  return { ok: true, status: await getStatus(cfg) };
}

/** Admin IPs / SSH flag (re-applied live when lockdown is on) and PIN change. */
export async function updateConfig({ admin_ips, ssh_from_admin, pin_current, pin_new } = {}) {
  const cfg = loadConfig();
  if (pin_new !== undefined) {
    if (!verifyPin(pin_current, cfg.pin_hash)) return { ok: false, code: 'bad_pin' };
    if (!validPin(pin_new)) return { ok: false, code: 'weak_pin' };
    cfg.pin_hash = hashPin(pin_new);
    cfg.pin_is_default = String(pin_new) === DEFAULT_PIN;
  }
  if (admin_ips !== undefined) {
    const parsed = parseAdminIps(admin_ips);
    if (parsed.bad.length) return { ok: false, code: 'bad_admin_ip', bad: parsed.bad };
    cfg.admin_ips = parsed.ips;
  }
  if (ssh_from_admin !== undefined) cfg.ssh_from_admin = Boolean(ssh_from_admin);
  if (cfg.enabled) {
    const r = await applyLockdown(cfg);
    if (!r.ok) return r;
  }
  saveConfig(cfg);
  return { ok: true, status: await getStatus(cfg) };
}
