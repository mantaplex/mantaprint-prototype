/**
 * MantaPrint Hub — Direct-Connect Mode
 *
 * When the Ethernet cable is plugged in but no usable IPv4 address arrives
 * (laptop plugged straight into the hub, or a network without DHCP) for
 * COUNTDOWN_SECS, the hub takes 10.11.12.1/24 and serves DHCP
 * (10.11.12.10–10.11.12.20, gateway 10.11.12.1) so the laptop can open
 * http://10.11.12.1/ and configure the real network settings.
 *
 * States: off → waiting (countdown) → active → off
 * Leaves `active` when a real address appears (DHCP/static took over), the cable
 * is unplugged, or an admin stops it. A manual stop holds until the cable is
 * re-plugged or a real address appears, so the countdown doesn't just restart.
 *
 * DHCP engine: dnsmasq (DHCP only, DNS disabled) when installed; otherwise
 * systemd-networkd's built-in DHCP server when networkd owns the port;
 * otherwise address only (clients must pick a 10.11.12.x address by hand).
 */

import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { detectPhysicalInterfaces, getNetworkBackend } from './hdmi-network-api.mjs';

export const COUNTDOWN_SECS = 60;
export const DC_LOCAL_IP = '10.11.12.1';
export const DC_RANGE_START = '10.11.12.10';
export const DC_RANGE_END = '10.11.12.20';
export const DC_SUBNET = '255.255.255.0';
export const DC_PREFIX = 24;

const POLL_MS = 5000;
const RUN_DIR = '/run/mantaprint';
const LEASE_FILE = `${RUN_DIR}/dc-leases.txt`;
const PID_FILE = `${RUN_DIR}/dc-dnsmasq.pid`;
const CONF_FILE = `${RUN_DIR}/dc-dnsmasq.conf`;
// Sorts ahead of both our persistent 05-mantaprint-*.network and netplan's 10-netplan-*.
const NETWORKD_DC_FILE = '/run/systemd/network/04-mantaprint-direct.network';

function runCmd(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function ipv4Addresses(iface) {
  try {
    return (os.networkInterfaces()[iface] || []).filter((a) => a.family === 'IPv4' || a.family === 4).map((a) => a.address);
  } catch {
    return [];
  }
}

function hasCarrier(iface) {
  try {
    return fs.readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

function isRealAddress(ip) {
  return ip !== DC_LOCAL_IP && !ip.startsWith('169.254.');
}

function readDnsmasqLeases() {
  try {
    return fs.readFileSync(LEASE_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      const [expiry, mac, ip, hostname] = l.split(/\s+/);
      return { expiry, mac, ip, hostname: hostname && hostname !== '*' ? hostname : '' };
    });
  } catch {
    return [];
  }
}

function killPidFile() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid > 1) process.kill(pid, 'SIGTERM');
  } catch {}
}

class DirectConnectDaemon {
  constructor() {
    this._state = 'off';
    this._countdown = 0;
    this._iface = null;
    this._engine = null; // 'dnsmasq' | 'networkd' | 'none'
    this._suppressed = false;
    this._timer = null;
    this._pollInterval = null;
    this._busy = false;
    this._dnsmasqProc = null;
    this._networkdClients = [];
    this._lastError = '';
  }

  getStatus() {
    return {
      state: this._state,
      countdown: this._countdown,
      countdown_total: COUNTDOWN_SECS,
      suppressed: this._suppressed,
      local_ip: DC_LOCAL_IP,
      prefix: DC_PREFIX,
      range_start: DC_RANGE_START,
      range_end: DC_RANGE_END,
      iface: this._iface,
      dhcp_engine: this._engine,
      clients: this._state !== 'active' ? [] : (this._engine === 'dnsmasq' ? readDnsmasqLeases() : this._networkdClients),
      error: this._lastError || null,
    };
  }

  startMonitor() {
    if (this._pollInterval) return;
    this._pollInterval = setInterval(() => this._poll(), POLL_MS);
    this._poll();
  }

  stopMonitor() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    this._clearCountdown();
  }

  // Admin "stop": tear down and hold off until the cable is re-plugged or a real address appears.
  async stop() {
    this._suppressed = true;
    await this._shutdown();
  }

  // Admin "activate now": skip the countdown. Refused when the port already has a real address.
  async activateNow() {
    const { ethIface } = detectPhysicalInterfaces();
    const real = ipv4Addresses(ethIface).filter(isRealAddress);
    if (real.length) throw new Error(`Ethernet already has ${real[0]}; direct-connect is not needed.`);
    if (!hasCarrier(ethIface)) throw new Error('Ethernet cable is not connected.');
    this._suppressed = false;
    this._clearCountdown();
    if (this._state !== 'active') await this._activate(ethIface);
  }

  // Called before a new Ethernet config is applied; the monitor re-evaluates afterwards.
  async deactivate() {
    await this._shutdown();
  }

  async _shutdown() {
    this._clearCountdown();
    if (this._state === 'active') await this._deactivate();
    this._state = 'off';
    this._countdown = 0;
  }

  async _poll() {
    if (this._busy) return;
    this._busy = true;
    try {
      const { ethIface } = detectPhysicalInterfaces();
      this._iface = ethIface;
      const carrier = hasCarrier(ethIface);
      const addrs = ipv4Addresses(ethIface);
      const hasReal = addrs.some(isRealAddress);

      if (!carrier || hasReal) {
        this._suppressed = false;
        if (this._state !== 'off') await this._shutdown();
        return;
      }
      if (this._suppressed) return;

      if (this._state === 'active') {
        await this._heal(ethIface, addrs);
      } else if (this._state === 'off') {
        // Our address still present means the web service restarted mid-session: resume without a countdown.
        if (addrs.includes(DC_LOCAL_IP)) await this._activate(ethIface);
        else this._startCountdown();
      }
    } catch (err) {
      console.error('[direct-connect] poll error:', err.message);
    } finally {
      this._busy = false;
    }
  }

  _startCountdown() {
    this._state = 'waiting';
    this._countdown = COUNTDOWN_SECS;
    this._clearCountdown();
    this._timer = setInterval(() => {
      this._countdown = Math.max(0, this._countdown - 1);
      if (this._countdown === 0) {
        this._clearCountdown();
        this._activate(this._iface).catch((err) => console.error('[direct-connect] activate failed:', err.message));
      }
    }, 1000);
  }

  _clearCountdown() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _activate(iface) {
    this._lastError = '';
    fs.mkdirSync(RUN_DIR, { recursive: true });
    await runCmd('ip', ['link', 'set', 'dev', iface, 'up']);

    const backend = await getNetworkBackend(iface, { fresh: true }).catch(() => 'iproute2');
    const hasDnsmasq = (await runCmd('sh', ['-c', 'command -v dnsmasq'], 2000)).ok;

    if (!hasDnsmasq && backend === 'networkd') {
      this._engine = 'networkd';
      this._writeNetworkdConf(iface);
      await this._networkdReload(iface);
    } else {
      this._engine = hasDnsmasq ? 'dnsmasq' : 'none';
      await runCmd('ip', ['addr', 'replace', `${DC_LOCAL_IP}/${DC_PREFIX}`, 'dev', iface]);
      if (hasDnsmasq) this._startDnsmasq(iface);
      else this._lastError = 'No DHCP server available (install dnsmasq). Set the laptop to 10.11.12.10/24 manually.';
    }

    this._state = 'active';
    this._countdown = 0;
    console.log(`[direct-connect] active on ${iface}: ${DC_LOCAL_IP}/${DC_PREFIX}, DHCP engine=${this._engine}`);
  }

  // NetworkManager/networkd may flush foreign addresses or dnsmasq may die; put them back.
  async _heal(iface, addrs) {
    if (this._engine === 'networkd') {
      if (!fs.existsSync(NETWORKD_DC_FILE)) { this._writeNetworkdConf(iface); await this._networkdReload(iface); }
      const st = await runCmd('networkctl', ['status', iface, '--no-pager'], 4000);
      this._networkdClients = [...st.stdout.matchAll(/(10\.11\.12\.\d+)\s*\(to\s*([0-9a-f:]+)\)/gi)].map((m) => ({ ip: m[1], mac: m[2], hostname: '' }));
      return;
    }
    if (!addrs.includes(DC_LOCAL_IP)) await runCmd('ip', ['addr', 'replace', `${DC_LOCAL_IP}/${DC_PREFIX}`, 'dev', iface]);
    if (this._engine === 'dnsmasq' && !this._dnsmasqProc) this._startDnsmasq(iface);
  }

  _startDnsmasq(iface) {
    killPidFile();
    fs.writeFileSync(CONF_FILE, [
      `interface=${iface}`,
      'bind-interfaces',
      'port=0',
      'no-resolv',
      'no-hosts',
      'dhcp-authoritative',
      `dhcp-range=${DC_RANGE_START},${DC_RANGE_END},${DC_SUBNET},1h`,
      `dhcp-option=option:router,${DC_LOCAL_IP}`,
      `dhcp-leasefile=${LEASE_FILE}`,
      `pid-file=${PID_FILE}`,
    ].join('\n') + '\n', 'utf8');
    const proc = spawn('dnsmasq', ['--keep-in-foreground', `--conf-file=${CONF_FILE}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    proc.on('error', (err) => { this._lastError = `dnsmasq: ${err.message}`; });
    proc.on('exit', (code) => {
      if (this._dnsmasqProc === proc) this._dnsmasqProc = null;
      if (code) this._lastError = `dnsmasq exited (${code}): ${stderr.trim()}`;
    });
    this._dnsmasqProc = proc;
  }

  _writeNetworkdConf(iface) {
    fs.mkdirSync('/run/systemd/network', { recursive: true });
    fs.writeFileSync(NETWORKD_DC_FILE, [
      '[Match]', `Name=${iface}`, '',
      '[Network]', `Address=${DC_LOCAL_IP}/${DC_PREFIX}`, 'DHCPServer=yes', 'ConfigureWithoutCarrier=yes', '',
      '[DHCPServer]', 'PoolOffset=10', 'PoolSize=11', 'EmitRouter=yes', 'EmitDNS=no', 'DefaultLeaseTimeSec=3600',
    ].join('\n') + '\n', 'utf8');
  }

  async _networkdReload(iface) {
    const r = await runCmd('networkctl', ['reload'], 10000);
    if (r.ok) await runCmd('networkctl', ['reconfigure', iface], 10000);
    else await runCmd('systemctl', ['restart', 'systemd-networkd'], 15000);
  }

  async _deactivate() {
    const iface = this._iface || detectPhysicalInterfaces().ethIface;
    try {
      if (this._dnsmasqProc) {
        const proc = this._dnsmasqProc;
        this._dnsmasqProc = null;
        try { proc.kill('SIGTERM'); } catch {}
      }
      killPidFile();
      if (fs.existsSync(NETWORKD_DC_FILE)) {
        fs.rmSync(NETWORKD_DC_FILE, { force: true });
        await this._networkdReload(iface);
      }
      await runCmd('ip', ['addr', 'del', `${DC_LOCAL_IP}/${DC_PREFIX}`, 'dev', iface]);
      for (const f of [LEASE_FILE, PID_FILE, CONF_FILE]) fs.rmSync(f, { force: true });
    } catch (err) {
      console.error('[direct-connect] deactivate error:', err.message);
    }
    this._engine = null;
    this._networkdClients = [];
    console.log(`[direct-connect] stopped on ${iface}`);
  }
}

export const directConnect = new DirectConnectDaemon();
