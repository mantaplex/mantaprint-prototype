// MantaPrint Enterprise Hub - HDMI Network Management API Engine
// Interacts directly with Linux networkctl, netplan, wpa_cli, rfkill, and ethtool.

import { exec, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';

export function runCmdFile(file, args = [], timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, code: error.code || 1, stdout: stdout || '', stderr: stderr || error.message });
      } else {
        resolve({ success: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

function runCmd(cmd, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, code: error.code || 1, stdout: stdout || '', stderr: stderr || error.message });
      } else {
        resolve({ success: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

// Multi-Interface dual-homing and linkdown route isolation hardening
export async function applySysctlHardening() {
  const settings = [
    'net.ipv4.conf.all.ignore_routes_with_linkdown=1',
    'net.ipv4.conf.default.ignore_routes_with_linkdown=1',
    'net.ipv4.conf.all.rp_filter=2',
    'net.ipv4.conf.default.rp_filter=2',
    'net.ipv4.conf.all.arp_ignore=1',
    'net.ipv4.conf.default.arp_ignore=1',
    'net.ipv4.conf.all.arp_announce=2',
    'net.ipv4.conf.default.arp_announce=2',
  ];
  for (const s of settings) {
    try {
      await runCmdFile('sysctl', ['-w', s], 2000);
    } catch {}
  }
  try {
    const sysctlConf = '/etc/sysctl.d/99-mantaprint-network.conf';
    if (!fs.existsSync(sysctlConf)) {
      fs.writeFileSync(sysctlConf, settings.map(s => s.replace('=', ' = ')).join('\n') + '\n', 'utf8');
    }
  } catch {}
}

export function detectPhysicalInterfaces() {
  let ifaces = [];
  try {
    ifaces = fs.readdirSync('/sys/class/net').filter(n => n !== 'lo');
  } catch {
    ifaces = ['eth0', 'wlan0'];
  }
  const ethIface = ifaces.find(n => 
    n.startsWith('eth') || n.startsWith('enp') || n.startsWith('eno') || n.startsWith('end') || n.startsWith('enx')
  ) || 'eth0';
  const wifiIface = ifaces.find(n => 
    n.startsWith('wlan') || n.startsWith('wlp') || n.startsWith('wls') || n.startsWith('wl') || n.startsWith('ra')
  ) || 'wlan0';
  return { ethIface, wifiIface, all: ifaces };
}

const IPV4_RE = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.){3}(25[0-5]|(2[0-4]|1\d|[1-9]|)\d)$/;
const IFACE_RE = /^[a-zA-Z0-9._-]{1,15}$/;
const ETH_STATE_FILE = '/etc/mantaprint/network-eth.json';
// Sorts ahead of netplan's generated /run/systemd/network/10-netplan-*.network, so ours wins.
const networkdEthFile = (iface) => `/etc/systemd/network/05-mantaprint-${iface}.network`;
export const RESERVED_DIRECT_CONNECT_IP = '10.11.12.1';

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);
}

function sameSubnet(a, b, prefix) {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return ((ipToInt(a) & mask) >>> 0) === ((ipToInt(b) & mask) >>> 0);
}

// Throws a user-facing error for bad input; returns a normalized config otherwise.
export function validateEthernetConfig({ mode = 'dhcp', ip = '', prefix = 24, gateway = '', dns1 = '', dns = '', dns2 = '', mtu = 1500 } = {}) {
  if (mode !== 'dhcp' && mode !== 'static') throw new Error('Mode must be "dhcp" or "static".');
  const cleanMtu = parseInt(mtu, 10) || 1500;
  if (cleanMtu < 576 || cleanMtu > 9000) throw new Error('MTU must be between 576 and 9000.');
  if (mode === 'dhcp') return { mode, mtu: cleanMtu };

  let cleanIp = String(ip || '').trim();
  let cleanPrefix = parseInt(prefix, 10);
  if (cleanIp.includes('/')) {
    const [addr, p] = cleanIp.split('/');
    cleanIp = addr.trim();
    cleanPrefix = parseInt(p, 10);
  }
  if (!IPV4_RE.test(cleanIp)) throw new Error('Invalid IP address.');
  if (!Number.isInteger(cleanPrefix) || cleanPrefix < 8 || cleanPrefix > 30) throw new Error('Subnet prefix must be between 8 and 30 (e.g. 24 = 255.255.255.0).');
  if (cleanIp === RESERVED_DIRECT_CONNECT_IP) throw new Error(`${RESERVED_DIRECT_CONNECT_IP} is reserved for direct-connect mode.`);
  const hostBits = ipToInt(cleanIp) & ((1 << (32 - cleanPrefix)) - 1);
  if (hostBits === 0 || hostBits === (1 << (32 - cleanPrefix)) - 1) throw new Error('IP address cannot be the network or broadcast address of its subnet.');

  // Gateway is optional: isolated networks may have none.
  const cleanGw = String(gateway || '').trim();
  if (cleanGw) {
    if (!IPV4_RE.test(cleanGw)) throw new Error('Invalid default gateway.');
    if (cleanGw === cleanIp) throw new Error('Gateway cannot be the same as the hub IP address.');
    if (!sameSubnet(cleanIp, cleanGw, cleanPrefix)) throw new Error(`Gateway ${cleanGw} is outside ${cleanIp}/${cleanPrefix}.`);
  }

  const cleanDns1 = String(dns1 || dns || cleanGw || '1.1.1.1').trim();
  if (!IPV4_RE.test(cleanDns1)) throw new Error('Invalid primary DNS.');
  const cleanDns2 = String(dns2 || '').trim();
  if (cleanDns2 && !IPV4_RE.test(cleanDns2)) throw new Error('Invalid secondary DNS.');

  return { mode, ip: cleanIp, prefix: cleanPrefix, gateway: cleanGw, dns1: cleanDns1, dns2: cleanDns2, mtu: cleanMtu };
}

export function readSavedEthernetConfig() {
  try {
    return JSON.parse(fs.readFileSync(ETH_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveEthernetConfig(cfg, backend) {
  try {
    fs.mkdirSync(path.dirname(ETH_STATE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ETH_STATE_FILE, JSON.stringify({ ...cfg, backend, applied_at: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.warn('[HDMI-NET] Could not persist Ethernet config:', err.message);
  }
}

function hasEthCarrier(iface) {
  try {
    return fs.readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

// Only writes when resolv.conf is a plain file; a symlink means resolved/resolvconf owns it.
function writeStaticResolvConf(servers) {
  try {
    if (fs.lstatSync('/etc/resolv.conf').isSymbolicLink()) return;
    fs.writeFileSync('/etc/resolv.conf', `# Generated by MantaPrint (static Ethernet)\n${servers.map((s) => `nameserver ${s}`).join('\n')}\n`);
  } catch {}
}

async function isServiceActive(name) {
  return (await runCmdFile('systemctl', ['is-active', '--quiet', name], 3000)).success;
}

async function hasBinary(name) {
  return (await runCmdFile('sh', ['-c', `command -v ${name}`], 2000)).success;
}

// nmcli -t / -g escape ':' and '\' inside values.
function splitNmcliLine(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (line[i] === ':') { out.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  out.push(cur);
  return out;
}

let backendCache = { iface: null, value: null, at: 0 };

/**
 * Which stack actually owns the Ethernet interface:
 * 'nmcli' (NetworkManager manages it) | 'networkd' | 'iproute2' (runtime only, re-applied at boot).
 */
export async function getNetworkBackend(iface, { fresh = false } = {}) {
  if (!fresh && backendCache.iface === iface && Date.now() - backendCache.at < 30000) return backendCache.value;
  let value = 'iproute2';
  if (await isServiceActive('NetworkManager') && await hasBinary('nmcli')) {
    const r = await runCmdFile('nmcli', ['-t', '-f', 'DEVICE,STATE', 'device'], 4000);
    const row = r.stdout.split('\n').map(splitNmcliLine).find((cols) => cols[0] === iface);
    if (row && !String(row[1] || '').startsWith('unmanaged')) value = 'nmcli';
  }
  if (value === 'iproute2' && await isServiceActive('systemd-networkd')) value = 'networkd';
  backendCache = { iface, value, at: Date.now() };
  return value;
}

export class HdmiNetworkEngine {
  constructor() {
    this.rollbackTimer = null;
    this.previousNetplan = null;
    this.isApplying = false;
    this.lastEthernetApply = null;
  }

  // 1. Get Live Status of all network adapters
  async getStatus() {
    const { ethIface, wifiIface } = detectPhysicalInterfaces();
    const [ipRes, ethLinkRes, wifiStatusRes, rfkillRes, resolvRes, softapRes] = await Promise.all([
      runCmd('ip -j addr show'),
      runCmd(`ethtool ${ethIface} 2>/dev/null || ip link show ${ethIface}`),
      runCmd(`wpa_cli -i ${wifiIface} status 2>/dev/null || wpa_cli status 2>/dev/null`),
      runCmd('rfkill list wifi 2>/dev/null'),
      runCmd('resolvectl status 2>/dev/null || cat /etc/resolv.conf'),
      this.getSoftApStatus()
    ]);

    let ipData = [];
    try {
      ipData = JSON.parse(ipRes.stdout);
    } catch {
      ipData = [];
    }

    // Parse dynamic Ethernet interface
    const ethObj = ipData.find(iface => iface.ifname === ethIface) || {};
    const ethIpv4 = (ethObj.addr_info || []).find(a => a.family === 'inet') || {};
    const ethCarrier = (ethLinkRes.stdout.includes('Link detected: yes') || (ethObj.operstate === 'UP'));
    const speedMatch = ethLinkRes.stdout.match(/Speed:\s*([^\s]+)/i);
    const duplexMatch = ethLinkRes.stdout.match(/Duplex:\s*([^\s]+)/i);

    // Parse dynamic Wi-Fi interface
    const wlanObj = ipData.find(iface => iface.ifname === wifiIface) || {};
    const wlanIpv4 = (wlanObj.addr_info || []).find(a => a.family === 'inet') || {};
    
    // Parse wpa_cli status output
    const wifiProps = {};
    for (const line of (wifiStatusRes.stdout || '').split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim();
        wifiProps[k] = v;
      }
    }

    // Fallback: If wpa_cli didn't report SSID, check nmcli for active Wi-Fi connection
    if (!wifiProps.ssid) {
      try {
        const nmCheck = await runCmd('nmcli -t -f active,ssid,bssid dev wifi 2>/dev/null');
        if (nmCheck.success && nmCheck.stdout) {
          for (const nl of nmCheck.stdout.split('\n')) {
            const parts = nl.replace(/\\:/g, '%%COLON%%').split(':');
            if (parts[0] === 'yes' && parts[1]) {
              wifiProps.ssid = parts[1].replace(/%%COLON%%/g, ':').trim();
              wifiProps.bssid = (parts[2] || '').replace(/%%COLON%%/g, ':').trim();
              wifiProps.wpa_state = 'COMPLETED';
              break;
            }
          }
        }
      } catch {}
    }

    // Check rfkill
    const isRadioBlocked = rfkillRes.stdout.includes('Soft blocked: yes') || rfkillRes.stdout.includes('Hard blocked: yes');

    // Dynamic Primary Interface & Failover Resolution
    const ethHasCarrier = Boolean(ethCarrier);
    const ethHasIp = Boolean(ethIpv4.local && ethIpv4.local !== RESERVED_DIRECT_CONNECT_IP && !ethIpv4.local.startsWith('169.254.'));
    const wifiConnected = (wifiProps.wpa_state === 'COMPLETED') || Boolean(wlanIpv4.local);
    const wifiHasIp = Boolean(wlanIpv4.local && !wlanIpv4.local.startsWith('169.254.'));

    let primaryIface = 'none';
    let primaryIp = null;
    let primaryMode = 'offline';
    let networkStatusText = 'Offline';

    if (ethHasCarrier && ethHasIp) {
      primaryIface = ethIface;
      primaryIp = ethIpv4.local;
      primaryMode = 'ethernet';
      networkStatusText = wifiHasIp
        ? `Ethernet Aktif (Utama) • Wi-Fi Cadangan (${wifiProps.ssid || 'Terhubung'})`
        : 'Ethernet Aktif (Utama)';
    } else if (wifiConnected && wifiHasIp) {
      primaryIface = wifiIface;
      primaryIp = wlanIpv4.local;
      primaryMode = 'wifi';
      networkStatusText = ethHasCarrier
        ? `Wi-Fi Aktif (Utama: ${wifiProps.ssid || 'Terhubung'}) • Menunggu IP LAN`
        : `Wi-Fi Aktif (Utama: ${wifiProps.ssid || 'Terhubung'}) • Kabel LAN Tidak Terhubung`;
    } else if (ethHasCarrier && ethIpv4.local === RESERVED_DIRECT_CONNECT_IP) {
      primaryIface = ethIface;
      primaryIp = ethIpv4.local;
      primaryMode = 'direct-connect';
      networkStatusText = 'Mode Direct-Connect (10.11.12.1)';
    } else if (ethHasCarrier) {
      primaryIface = ethIface;
      primaryIp = ethIpv4.local || null;
      primaryMode = 'ethernet-link-only';
      networkStatusText = 'Kabel LAN Terhubung (Menunggu DHCP/IP)';
    } else {
      primaryIface = 'none';
      primaryIp = null;
      primaryMode = 'offline';
      networkStatusText = 'Terputus (Kabel LAN dicabut & Wi-Fi tidak terhubung)';
    }

    // Default Gateway respecting active primary interface
    const routeRes = await runCmd('ip -j route show default');
    let defaultGateway = null;
    let defaultDev = primaryIface !== 'none' ? primaryIface : (ethHasCarrier ? ethIface : wifiIface);
    try {
      const routes = JSON.parse(routeRes.stdout);
      if (Array.isArray(routes) && routes.length > 0) {
        const matchingRoute = routes.find(r => r.dev === primaryIface) || routes[0];
        if (matchingRoute) {
          defaultGateway = matchingRoute.gateway || defaultGateway;
          defaultDev = matchingRoute.dev || defaultDev;
        }
      }
    } catch {}

    // DNS IPs
    const dnsIps = [];
    const dnsMatches = resolvRes.stdout.matchAll(/DNS Servers?:\s*([0-9.]+)/gi);
    for (const m of dnsMatches) {
      if (m[1] && !dnsIps.includes(m[1])) dnsIps.push(m[1]);
    }
    if (dnsIps.length === 0) {
      const nsMatches = resolvRes.stdout.matchAll(/nameserver\s+([0-9.]+)/gi);
      for (const m of nsMatches) {
        if (m[1] && !dnsIps.includes(m[1])) dnsIps.push(m[1]);
      }
    }
    if (dnsIps.length === 0) dnsIps.push('1.1.1.1', '8.8.8.8');

    return {
      ethernet: {
        interface: ethIface,
        carrier: ethCarrier,
        operstate: ethObj.operstate || 'DOWN',
        mac: ethObj.address || '0E:73:1E:5D:0F:C8',
        ip: ethIpv4.local || null,
        prefix: ethIpv4.prefixlen || null,
        broadcast: ethIpv4.broadcast || null,
        speed: speedMatch ? speedMatch[1] : (ethCarrier ? '100Mb/s' : 'Disconnected'),
        duplex: duplexMatch ? duplexMatch[1] : 'Full',
        mtu: ethObj.mtu || 1500,
        addresses: (ethObj.addr_info || []).filter(a => a.family === 'inet').map(a => `${a.local}/${a.prefixlen}`),
        config: readSavedEthernetConfig(),
        backend: await getNetworkBackend(ethIface).catch(() => null),
        last_apply: this.lastEthernetApply || null
      },
      wifi: {
        interface: wifiIface,
        radio_enabled: !isRadioBlocked,
        state: wifiProps.wpa_state || (wlanIpv4.local ? 'COMPLETED' : (isRadioBlocked ? 'BLOCKED' : 'DISCONNECTED')),
        ssid: wifiProps.ssid || (wlanIpv4.local ? 'Connected' : null),
        bssid: wifiProps.bssid || null,
        ip: wlanIpv4.local || wifiProps.ip_address || null,
        prefix: wlanIpv4.prefixlen || null,
        mac: wlanObj.address || wifiProps.address || 'd4:58:00:28:19:f9',
        freq: parseInt(wifiProps.freq || '0', 10),
        band: (parseInt(wifiProps.freq || '0', 10) > 4000) ? '5 GHz' : '2.4 GHz',
        key_mgmt: wifiProps.key_mgmt || 'WPA2-PSK',
        pairwise_cipher: wifiProps.pairwise_cipher || 'CCMP'
      },
      softap: softapRes,
      system: {
        default_gateway: defaultGateway,
        primary_interface: defaultDev,
        primary_ip: primaryIp,
        primary_mode: primaryMode,
        status_text: networkStatusText,
        failover: {
          active_primary: primaryMode,
          ethernet_carrier: ethHasCarrier,
          ethernet_ip: ethIpv4.local || null,
          wifi_connected: wifiConnected,
          wifi_ssid: wifiProps.ssid || null,
          wifi_ip: wlanIpv4.local || null,
        },
        dns_servers: dnsIps,
        hostname: 'mantaprint',
        timestamp: new Date().toISOString()
      }
    };
  }

  // 2. Scan Wi-Fi SSIDs with adaptive encryption detection (nmcli + wpa_cli fallback)
  async scanWifi() {
    const networks = [];

    // 1. Try NetworkManager (nmcli) first if available
    try {
      const nmRes = await runCmd('nmcli -t -f active,ssid,bssid,signal,security,freq dev wifi 2>/dev/null');
      if (nmRes.success && nmRes.stdout && nmRes.stdout.trim().length > 0) {
        const lines = nmRes.stdout.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          const safeLine = line.replace(/\\:/g, '%%COLON%%');
          const parts = safeLine.split(':');
          if (parts.length >= 6) {
            const rawSsid = parts[1].replace(/%%COLON%%/g, ':').trim();
            const bssid = parts[2].replace(/%%COLON%%/g, ':').trim();
            const signalLevel = parseInt(parts[3].trim(), 10) || 50;
            const sec = parts[4].replace(/%%COLON%%/g, ':').trim();
            const freqStr = parts[5].replace(/%%COLON%%/g, ':').trim();
            const freq = parseInt(freqStr.replace(/[^0-9]/g, ''), 10) || 2412;

            const isHidden = !rawSsid || rawSsid.length === 0;
            const displayName = isHidden ? '<SSID Tersembunyi>' : rawSsid;

            let securityType = 'WPA2-PSK';
            let badge = 'WPA2';
            let requiresPassword = true;

            const secUpper = sec.toUpperCase();
            if (secUpper.includes('WPA3') || secUpper.includes('SAE')) {
              securityType = 'WPA3-SAE';
              badge = 'WPA3';
            } else if (secUpper.includes('802.1X') || secUpper.includes('EAP')) {
              securityType = 'WPA2-ENTERPRISE';
              badge = '802.1X ENT';
            } else if (secUpper.includes('OWE')) {
              securityType = 'OWE';
              badge = 'ENCRYPTED OPEN';
              requiresPassword = false;
            } else if (!secUpper || secUpper === '--' || secUpper === 'NONE' || secUpper === 'OPEN') {
              securityType = 'OPEN';
              badge = 'OPEN';
              requiresPassword = false;
            } else if (secUpper.includes('WEP')) {
              securityType = 'WEP';
              badge = 'WEP';
            }

            networks.push({
              bssid,
              ssid: displayName,
              raw_ssid: rawSsid,
              is_hidden: isHidden,
              freq,
              band: freq > 4000 ? '5G' : '2.4G',
              signal_dbm: Math.round((signalLevel / 2) - 100),
              signal_percent: Math.min(100, Math.max(0, signalLevel)),
              flags: sec,
              security_type: securityType,
              badge,
              requires_password: requiresPassword
            });
          }
        }
      }
    } catch {}

    // 2. If nmcli produced no networks, fallback to wpa_cli
    if (networks.length === 0) {
      // Trigger scan
      await runCmd('wpa_cli scan 2>/dev/null');
      // Allow radio 1.2s to collect probe responses
      await new Promise(r => setTimeout(r, 1200));

      const scanRes = await runCmd('wpa_cli scan_results 2>/dev/null');
      const lines = (scanRes.stdout || '').split('\n').filter(l => l.trim().length > 0);
      
      // Header format: bssid / frequency / signal level / flags / ssid
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length >= 4) {
          const bssid = parts[0].trim();
          const freq = parseInt(parts[1].trim(), 10) || 2412;
          const signalLevel = parseInt(parts[2].trim(), 10) || -70;
          const flags = parts[3].trim();
          const rawSsid = parts.slice(4).join('\t').trim();

          const isHidden = !rawSsid || rawSsid.length === 0;
          const displayName = isHidden ? '<SSID Tersembunyi>' : rawSsid;

          // Security Classification
          let securityType = 'WPA2-PSK';
          let badge = 'WPA2';
          let requiresPassword = true;

          if (flags.includes('SAE') || flags.includes('WPA3')) {
            securityType = 'WPA3-SAE';
            badge = 'WPA3';
          } else if (flags.includes('EAP') || flags.includes('802.1X') || flags.includes('WPA-EAP')) {
            securityType = 'WPA2-ENTERPRISE';
            badge = '802.1X ENT';
          } else if (flags.includes('OWE')) {
            securityType = 'OWE';
            badge = 'ENCRYPTED OPEN';
            requiresPassword = false;
          } else if (!flags.includes('WPA') && !flags.includes('WEP')) {
            securityType = 'OPEN';
            badge = 'OPEN';
            requiresPassword = false;
          } else if (flags.includes('WEP')) {
            securityType = 'WEP';
            badge = 'WEP';
          }

          // Calculate 0-100% signal quality
          let percent = 0;
          if (signalLevel >= -50) percent = 100;
          else if (signalLevel <= -100) percent = 0;
          else percent = Math.round(2 * (signalLevel + 100));

          networks.push({
            bssid,
            ssid: displayName,
            raw_ssid: rawSsid,
            is_hidden: isHidden,
            freq,
            band: freq > 4000 ? '5G' : '2.4G',
            signal_dbm: signalLevel,
            signal_percent: percent,
            flags,
            security_type: securityType,
            badge,
            requires_password: requiresPassword
          });
        }
      }
    }

    // Deduplicate by SSID, keep highest signal
    const map = new Map();
    for (const net of networks) {
      const key = net.is_hidden ? `hidden_${net.bssid}` : net.ssid;
      if (!map.has(key) || map.get(key).signal_percent < net.signal_percent) {
        map.set(key, net);
      }
    }

    const sorted = Array.from(map.values()).sort((a, b) => b.signal_percent - a.signal_percent);
    return sorted;
  }

  // 3. Connect to Wi-Fi (Adaptive: Open, WPA2/WPA3, Enterprise 802.1X, Hidden SSID)
  async connectWifi({ ssid, hidden = false, auth_method = 'wpa2', password = '', identity = '', eap_method = 'PEAP', band = 'auto' }) {
    if (!ssid || ssid.trim().length === 0) {
      throw new Error('Nama SSID tidak boleh kosong.');
    }

    const cleanSsid = ssid.trim();
    console.log(`[HDMI-NET] Connecting to Wi-Fi: "${cleanSsid}" (Auth: ${auth_method}, Hidden: ${hidden})`);

    // Ensure Wi-Fi radio is unblocked
    const { wifiIface } = detectPhysicalInterfaces();
    await runCmd('rfkill unblock wifi 2>/dev/null');
    await runCmd(`ip link set ${wifiIface} up 2>/dev/null`);

    // Try NetworkManager (nmcli) first if available
    const checkNm = await runCmd('which nmcli 2>/dev/null');
    if (checkNm.success && checkNm.stdout.trim()) {
      let nmCmd;
      const safeSsid = cleanSsid.replace(/"/g, '\\"');
      const safePass = (password || '').replace(/"/g, '\\"');
      if (auth_method === 'open' || !password) {
        nmCmd = `nmcli dev wifi connect "${safeSsid}" ${hidden ? 'hidden yes' : ''}`;
      } else {
        nmCmd = `nmcli dev wifi connect "${safeSsid}" password "${safePass}" ${hidden ? 'hidden yes' : ''}`;
      }
      const nmRes = await runCmd(nmCmd, 25000);
      if (nmRes.success) {
        this.persistWifiToNetplan(cleanSsid, password, hidden, wifiIface);
        return {
          success: true,
          ssid: cleanSsid,
          message: `Berhasil terhubung ke jaringan Wi-Fi "${cleanSsid}"!`
        };
      }
      // If nmcli failed and wpa_cli does not exist on the system, return nmcli's error
      const hasWpa = await runCmd('which wpa_cli 2>/dev/null');
      if (!hasWpa.success || !hasWpa.stdout.trim()) {
        const errOut = (nmRes.stderr || nmRes.stdout || '').trim();
        return {
          success: false,
          state: 'FAILED',
          message: errOut || `Gagal menyambung ke "${cleanSsid}". Periksa sandi Wi-Fi.`
        };
      }
    }

    // Add network to wpa_supplicant
    const addRes = await runCmdFile('wpa_cli', ['-i', wifiIface, 'add_network']);
    const netId = parseInt((addRes.stdout || '').trim(), 10);
    if (isNaN(netId)) {
      throw new Error(`Gagal membuat ID jaringan wpa_supplicant: ${addRes.stderr || addRes.stdout}`);
    }

    const wpaExec = (args) => runCmdFile('wpa_cli', ['-i', wifiIface, ...args]);

    await wpaExec(['set_network', String(netId), 'ssid', `"${cleanSsid}"`]);

    if (hidden) {
      await wpaExec(['set_network', String(netId), 'scan_ssid', '1']);
    }

    if (auth_method === 'open') {
      await wpaExec(['set_network', String(netId), 'key_mgmt', 'NONE']);
    } else if (auth_method === 'wpa3') {
      await wpaExec(['set_network', String(netId), 'key_mgmt', 'SAE']);
      await wpaExec(['set_network', String(netId), 'psk', `"${password}"`]);
      await wpaExec(['set_network', String(netId), 'ieee80211w', '2']);
    } else if (auth_method === 'enterprise' || auth_method === '802.1x') {
      await wpaExec(['set_network', String(netId), 'key_mgmt', 'WPA-EAP']);
      await wpaExec(['set_network', String(netId), 'eap', String(eap_method)]);
      await wpaExec(['set_network', String(netId), 'identity', `"${identity}"`]);
      await wpaExec(['set_network', String(netId), 'password', `"${password}"`]);
      await wpaExec(['set_network', String(netId), 'phase2', '"auth=MSCHAPV2"']);
    } else {
      // Default: WPA / WPA2 Personal (PSK)
      await wpaExec(['set_network', String(netId), 'key_mgmt', 'WPA-PSK']);
      await wpaExec(['set_network', String(netId), 'psk', `"${password}"`]);
    }

    await wpaExec(['enable_network', String(netId)]);
    await wpaExec(['select_network', String(netId)]);
    await wpaExec(['save_config']);

    // Persist to Netplan for reboot survivability
    this.persistWifiToNetplan(cleanSsid, password, hidden, wifiIface);

    // Wait up to 12s for COMPLETED state
    let connected = false;
    let lastState = 'DISCONNECTED';
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const checkRes = await runCmdFile('wpa_cli', ['-i', wifiIface, 'status']);
      const stdout = checkRes.stdout || '';
      if (stdout.includes('wpa_state=COMPLETED')) {
        connected = true;
        break;
      }
      const match = stdout.match(/wpa_state=([^\s]+)/);
      if (match) lastState = match[1];
    }

    if (!connected) {
      return {
        success: false,
        state: lastState,
        message: `Koneksi nirkabel belum tuntas (Status: ${lastState}). Pastikan sandi benar dan sinyal terjangkau.`
      };
    }

    // Trigger DHCP request
    await runCmd('systemctl restart systemd-networkd.service 2>/dev/null || true');

    return {
      success: true,
      ssid: cleanSsid,
      message: `Berhasil terhubung ke jaringan Wi-Fi "${cleanSsid}"!`
    };
  }

  persistWifiToNetplan(ssid, password, hidden, wifiIface = 'wlan0') {
    try {
      const safeSsid = String(ssid || '').replace(/["\\]/g, '\\$&');
      const safePassword = String(password || '').replace(/["\\]/g, '\\$&');
      const netplanYaml = `network:
  version: 2
  renderer: networkd
  wifis:
    ${wifiIface}:
      dhcp4: true
      dhcp4-overrides:
        route-metric: 600
      dhcp6: true
      access-points:
        "${safeSsid}":
          password: "${safePassword}"
          ${hidden ? 'hidden: true' : ''}
`;
      fs.writeFileSync('/etc/netplan/90-mantaprint-wifi.yaml', netplanYaml, { mode: 0o600, encoding: 'utf8' });
    } catch (err) {
      console.warn('[HDMI-NET] Could not persist Wi-Fi to netplan:', err.message);
    }
  }

  // 4. Toggle Wi-Fi Radio (Master Kill-Switch)
  async setWifiRadio(enabled) {
    const { wifiIface } = detectPhysicalInterfaces();
    if (enabled) {
      await runCmd('rfkill unblock wifi');
      await runCmd(`ip link set ${wifiIface} up`);
      await runCmd(`wpa_cli -i ${wifiIface} reassociate 2>/dev/null || true`);
      return { success: true, radio_enabled: true, message: 'Radio Wi-Fi diaktifkan.' };
    } else {
      await runCmd(`wpa_cli -i ${wifiIface} disconnect 2>/dev/null || true`);
      await runCmd(`ip link set ${wifiIface} down 2>/dev/null || true`);
      await runCmd('rfkill block wifi 2>/dev/null || true');
      return { success: true, radio_enabled: false, message: 'Radio Wi-Fi dimatikan total (Hemat daya & bebas interferensi).' };
    }
  }

  // 5. Apply Ethernet configuration on whichever stack owns the interface.
  async applyEthernetConfig(input) {
    const cfg = validateEthernetConfig(input);
    const { ethIface } = detectPhysicalInterfaces();
    if (!IFACE_RE.test(ethIface)) throw new Error(`Unexpected Ethernet interface name: ${ethIface}`);
    const backend = await getNetworkBackend(ethIface, { fresh: true });
    const carrier = hasEthCarrier(ethIface);

    let note;
    if (backend === 'nmcli') note = await this._applyEthernetNmcli(ethIface, cfg, carrier);
    else if (backend === 'networkd') note = await this._applyEthernetNetworkd(ethIface, cfg);
    else note = await this._applyEthernetIproute2(ethIface, cfg);

    saveEthernetConfig(cfg, backend);

    const target = cfg.mode === 'static' ? `${cfg.ip}/${cfg.prefix}` : 'DHCP';
    let message = cfg.mode === 'static'
      ? `Static IP ${target} applied.`
      : 'DHCP enabled. If no DHCP server answers within 60 s the hub switches to direct-connect (10.11.12.1).';
    if (!carrier) message += ' Ethernet cable is unplugged; the settings take effect when it is connected.';
    if (note) message += ` ${note}`;
    return { success: true, mode: cfg.mode, backend, carrier, applied_ip: target, config: cfg, message };
  }

  async _applyEthernetNmcli(iface, cfg, carrier) {
    const nm = (args, timeout = 10000) => runCmdFile('nmcli', args, timeout);

    // Edit the profile NetworkManager already uses for this port rather than adding a competing one.
    let con = splitNmcliLine((await nm(['-g', 'GENERAL.CONNECTION', 'device', 'show', iface])).stdout.trim())[0];
    if (con === '--') con = '';
    if (!con) {
      const list = await nm(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
      for (const line of list.stdout.split('\n').filter(Boolean)) {
        const [name, type] = splitNmcliLine(line);
        if (type !== '802-3-ethernet') continue;
        const bound = (await nm(['-g', 'connection.interface-name', 'connection', 'show', name])).stdout.trim();
        if (!bound || bound === iface) { con = name; break; }
      }
    }
    if (!con) {
      con = `mantaprint-${iface}`;
      const add = await nm(['connection', 'add', 'type', 'ethernet', 'ifname', iface, 'con-name', con]);
      if (!add.success) throw new Error(`NetworkManager could not create a profile: ${add.stderr.trim()}`);
    }

    const common = ['connection.autoconnect', 'yes', 'connection.autoconnect-priority', '50', '802-3-ethernet.mtu', cfg.mtu === 1500 ? '0' : String(cfg.mtu), 'ipv4.route-metric', '100'];
    const args = cfg.mode === 'static'
      ? ['ipv4.addresses', `${cfg.ip}/${cfg.prefix}`, 'ipv4.method', 'manual', 'ipv4.gateway', cfg.gateway,
         'ipv4.dns', [cfg.dns1, cfg.dns2].filter(Boolean).join(','), 'ipv4.ignore-auto-dns', 'yes']
      : ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '', 'ipv4.ignore-auto-dns', 'no'];
    const mod = await nm(['connection', 'modify', con, ...args, ...common]);
    if (!mod.success) throw new Error(`NetworkManager rejected the settings: ${mod.stderr.trim()}`);

    if (!carrier) return '';
    // DHCP activation blocks until a lease or a ~45 s timeout; don't hold the request for it.
    const up = await nm(['connection', 'up', con, 'ifname', iface], cfg.mode === 'static' ? 20000 : 8000);
    if (!up.success && cfg.mode === 'static') throw new Error(`Saved, but NetworkManager could not activate it: ${up.stderr.trim()}`);
    return '';
  }

  async _applyEthernetNetworkd(iface, cfg) {
    const file = networkdEthFile(iface);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const lines = ['[Match]', `Name=${iface}`, '', '[Link]', `MTUBytes=${cfg.mtu}`, '', '[Network]'];
    if (cfg.mode === 'static') {
      lines.push(`Address=${cfg.ip}/${cfg.prefix}`);
      if (cfg.gateway) {
        lines.push(`Gateway=${cfg.gateway}`);
        lines.push('', '[Route]', `Gateway=${cfg.gateway}`, 'Metric=100');
      }
      lines.push(`DNS=${cfg.dns1}`);
      if (cfg.dns2) lines.push(`DNS=${cfg.dns2}`);
    } else {
      lines.push('DHCP=ipv4', '', '[DHCPv4]', 'RouteMetric=100');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const reload = async () => {
      const r = await runCmdFile('networkctl', ['reload'], 10000);
      const rc = r.success ? await runCmdFile('networkctl', ['reconfigure', iface], 10000) : r;
      return rc.success ? rc : runCmdFile('systemctl', ['restart', 'systemd-networkd'], 15000);
    };
    const res = await reload();
    if (!res.success) {
      if (previous !== null) fs.writeFileSync(file, previous, 'utf8');
      else fs.rmSync(file, { force: true });
      await reload();
      throw new Error(`systemd-networkd rejected the settings: ${res.stderr.trim()}`);
    }
    if (cfg.mode === 'static' && !(await isServiceActive('systemd-resolved'))) {
      writeStaticResolvConf([cfg.dns1, cfg.dns2].filter(Boolean));
    }
    return '';
  }

  async _applyEthernetIproute2(iface, cfg) {
    await runCmdFile('ip', ['-4', 'addr', 'flush', 'dev', iface, 'scope', 'global']);
    await runCmdFile('ip', ['link', 'set', 'dev', iface, 'mtu', String(cfg.mtu)]);
    await runCmdFile('ip', ['link', 'set', 'dev', iface, 'up']);
    if (cfg.mode === 'static') {
      const add = await runCmdFile('ip', ['addr', 'add', `${cfg.ip}/${cfg.prefix}`, 'dev', iface]);
      if (!add.success) throw new Error(`Could not assign ${cfg.ip}/${cfg.prefix}: ${add.stderr.trim()}`);
      if (cfg.gateway) {
        const rt = await runCmdFile('ip', ['route', 'replace', 'default', 'via', cfg.gateway, 'dev', iface, 'metric', '100']);
        if (!rt.success) throw new Error(`Could not set gateway ${cfg.gateway}: ${rt.stderr.trim()}`);
      }
      writeStaticResolvConf([cfg.dns1, cfg.dns2].filter(Boolean));
      return '';
    }
    const dh = await runCmdFile('sh', ['-c', `command -v dhclient >/dev/null && { dhclient -r ${iface}; dhclient -nw ${iface}; } || udhcpc -b -i ${iface}`], 10000);
    return dh.success ? '' : 'No DHCP client (dhclient/udhcpc) found on this system.';
  }

  // The iproute2 fallback has no persistent store of its own, so replay the saved config at boot.
  async reapplySavedEthernetConfig() {
    const saved = readSavedEthernetConfig();
    if (!saved || saved.mode !== 'static') return;
    const { ethIface } = detectPhysicalInterfaces();
    if (await getNetworkBackend(ethIface, { fresh: true }) !== 'iproute2') return;
    try {
      await this._applyEthernetIproute2(ethIface, validateEthernetConfig(saved));
      console.log(`[HDMI-NET] Re-applied saved static IP ${saved.ip}/${saved.prefix} on ${ethIface}.`);
    } catch (err) {
      console.warn('[HDMI-NET] Could not re-apply saved Ethernet config:', err.message);
    }
  }

  // 6. Apply VLAN 802.1Q Configuration
  async applyVlanConfig({ enabled = true, vlan_id = 20, parent = 'eth0', mode = 'dhcp', ip = '', prefix = 24 }) {
    const filePath = '/etc/netplan/20-mantaprint-vlan.yaml';

    if (!enabled) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await runCmd('netplan apply');
      return { success: true, message: 'VLAN dinonaktifkan.' };
    }

    const vlanIdNum = parseInt(vlan_id, 10);
    if (isNaN(vlanIdNum) || vlanIdNum < 1 || vlanIdNum > 4094) {
      throw new Error('VLAN ID harus berada di antara 1 dan 4094.');
    }

    const vlanDev = `${parent}.${vlanIdNum}`;
    let yaml = '';
    if (mode === 'static') {
      yaml = `network:
  version: 2
  renderer: networkd
  vlans:
    ${vlanDev}:
      id: ${vlanIdNum}
      link: ${parent}
      dhcp4: false
      addresses:
        - ${ip}/${prefix}
`;
    } else {
      yaml = `network:
  version: 2
  renderer: networkd
  vlans:
    ${vlanDev}:
      id: ${vlanIdNum}
      link: ${parent}
      dhcp4: true
`;
    }

    fs.writeFileSync(filePath, yaml, 'utf8');
    const res = await runCmd('netplan apply');
    if (!res.success) throw new Error(`Gagal mengonfigurasi VLAN: ${res.stderr}`);

    return {
      success: true,
      vlan_dev: vlanDev,
      vlan_id: vlanIdNum,
      message: `VLAN ID ${vlanIdNum} pada antarmuka virtual ${vlanDev} berhasil dibuat.`
    };
  }

  // 7. Ping Diagnostics
  async pingTest(target = '1.1.1.1') {
    const cleanTarget = (target || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}$/.test(cleanTarget)) {
      throw new Error('Target ping tidak valid.');
    }
    const res = await runCmdFile('ping', ['-c', '3', '-W', '2', '--', cleanTarget]);
    const lossMatch = res.stdout.match(/(\d+)%\s*packet loss/i);
    const rttMatch = res.stdout.match(/rtt min\/avg\/max\/mdev =\s*([0-9.]+)\/([0-9.]+)\/([0-9.]+)/i);

    return {
      target: cleanTarget,
      success: res.success && (!lossMatch || lossMatch[1] !== '100'),
      packet_loss_percent: lossMatch ? parseInt(lossMatch[1], 10) : (res.success ? 0 : 100),
      latency_min: rttMatch ? parseFloat(rttMatch[1]) : null,
      latency_avg: rttMatch ? parseFloat(rttMatch[2]) : null,
      latency_max: rttMatch ? parseFloat(rttMatch[3]) : null,
      raw_output: res.stdout
    };
  }

  // 8. DNS Lookup Diagnostics
  async dnsTest(host = 'google.com') {
    const cleanHost = host.replace(/[^a-zA-Z0-9.-]/g, '');
    const startTime = Date.now();
    try {
      const records = await dns.lookup(cleanHost, { all: true });
      const durationMs = Date.now() - startTime;
      return {
        success: true,
        host: cleanHost,
        duration_ms: durationMs,
        addresses: records.map(r => r.address)
      };
    } catch (err) {
      return {
        success: false,
        host: cleanHost,
        duration_ms: Date.now() - startTime,
        error: err.message
      };
    }
  }

  // 9. SoftAP Hotspot Management
  async getSoftApStatus() {
    try {
      const statePath = '/run/mantaprint/softap.json';
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
      }
    } catch {}
    const { wifiIface } = detectPhysicalInterfaces();
    return { active: false, ssid: null, ip: null, interface: wifiIface };
  }

  async toggleSoftAp(enable = true, customSsid = '') {
    const action = enable ? 'start' : 'stop';
    const args = [action];
    if (customSsid && typeof customSsid === 'string') {
      const sanitizedSsid = customSsid.trim().slice(0, 32);
      if (sanitizedSsid) args.push(sanitizedSsid);
    }
    const res = await runCmdFile('/usr/local/bin/mantaprint-softap.sh', args, 15000);
    const status = await this.getSoftApStatus();
    return {
      success: res.success,
      ...status,
      output: res.stdout || res.stderr
    };
  }

  // 10. Reset Factory Network Settings
  async resetFactoryNetwork() {
    const { ethIface, wifiIface } = detectPhysicalInterfaces();
    try {
      if (fs.existsSync(`/etc/netplan/10-mantaprint-${ethIface}.yaml`)) fs.unlinkSync(`/etc/netplan/10-mantaprint-${ethIface}.yaml`);
      if (fs.existsSync('/etc/netplan/10-mantaprint-eth0.yaml')) fs.unlinkSync('/etc/netplan/10-mantaprint-eth0.yaml');
      if (fs.existsSync('/etc/netplan/20-mantaprint-vlan.yaml')) fs.unlinkSync('/etc/netplan/20-mantaprint-vlan.yaml');
      if (fs.existsSync('/etc/netplan/90-mantaprint-wifi.yaml')) fs.unlinkSync('/etc/netplan/90-mantaprint-wifi.yaml');
    } catch {}

    // Also stop SoftAP if running
    await this.toggleSoftAp(false).catch(() => {});

    await runCmd('rfkill unblock wifi 2>/dev/null || true');
    await runCmd(`ip link set ${wifiIface} up 2>/dev/null || true`);
    await runCmd('netplan apply 2>/dev/null || true');
    await this.applyEthernetConfig({ mode: 'dhcp' }).catch((err) => console.warn('[HDMI-NET] Ethernet DHCP reset failed:', err.message));

    return {
      success: true,
      message: 'Seluruh konfigurasi jaringan kustom berhasil direset ke standar pabrik (DHCP).'
    };
  }
}

export class RemoteWizardEngine {
  constructor() {
    this.active = false;
    this.evtestProc = null;
    this.steps = [
      { id: 'dpad_up', name: 'DPAD UP', keycode: 'KEY_UP', icon: '▲', desc: 'Tombol Panah Atas' },
      { id: 'dpad_down', name: 'DPAD DOWN', keycode: 'KEY_DOWN', icon: '▼', desc: 'Tombol Panah Bawah' },
      { id: 'dpad_left', name: 'DPAD LEFT', keycode: 'KEY_LEFT', icon: '◄', desc: 'Tombol Panah Kiri' },
      { id: 'dpad_right', name: 'DPAD RIGHT', keycode: 'KEY_RIGHT', icon: '►', desc: 'Tombol Panah Kanan' },
      { id: 'ok', name: 'OK / SELECT', keycode: 'KEY_ENTER', icon: '◉', desc: 'Tombol Tengah OK' },
      { id: 'back', name: 'BACK / RETURN', keycode: 'KEY_BACK', icon: '⮌', desc: 'Tombol Kembali / Back' },
      { id: 'home', name: 'HOME', keycode: 'KEY_HOMEPAGE', icon: '⌂', desc: 'Tombol Home / Beranda' },
      { id: 'vol_up', name: 'VOLUME UP', keycode: 'KEY_VOLUMEUP', icon: '🔊+', desc: 'Tombol Tambah Volume' },
      { id: 'vol_down', name: 'VOLUME DOWN', keycode: 'KEY_VOLUMEDOWN', icon: '🔉-', desc: 'Tombol Kurangi Volume' },
      { id: 'p_up', name: 'PAGE UP / P UP', keycode: 'KEY_PAGEUP', icon: '⯅', desc: 'Tombol Page Up / Channel Up' },
      { id: 'p_down', name: 'PAGE DOWN / P DOWN', keycode: 'KEY_PAGEDOWN', icon: '⯆', desc: 'Tombol Page Down / Channel Down' }
    ];
    this.currentIndex = 0;
    this.mappings = {};
    this.lastDetected = null;
    this.completed = false;
    this.lastTimestamp = 0;
    this.cooldownUntil = 0;
    this.lastScancode = null;
  }

  async start() {
    this.stop();
    this.active = true;
    this.completed = false;
    this.currentIndex = 0;
    this.mappings = {};
    this.lastDetected = null;
    this.lastTimestamp = 0;
    this.cooldownUntil = 0;
    this.lastScancode = null;

    // Clear existing driver keytable to prevent stale mappings
    await runCmdFile('ir-keytable', ['-c']);

    // Enable all kernel protocols on rc0
    await runCmdFile('ir-keytable', ['-p', 'rc-5,rc-5-sz,jvc,sony,nec,sanyo,mce_kbd,rc-6,sharp,xmp,imon,rc-mm']);

    // Spawn evtest /dev/input/event0
    this.evtestProc = spawn('evtest', ['/dev/input/event0'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';
    this.evtestProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const match = line.match(/type 4 \(EV_MSC\), code 4 \(MSC_SCAN\), value ([0-9a-fA-F]+)/);
        if (match) {
          const rawHex = match[1];
          const scancode = '0x' + rawHex.toLowerCase();
          this.handleScancode(scancode);
        }
      }
    });

    this.evtestProc.on('error', (err) => {
      console.error('[RemoteWizard] evtest error:', err.message);
    });

    this.evtestProc.on('exit', () => {
      this.evtestProc = null;
    });

    return this.getStatus();
  }

  async handleScancode(scancode) {
    if (!this.active || this.completed || this.currentIndex >= this.steps.length) return;

    const now = Date.now();
    // 1. Cooldown between consecutive button presses (800ms)
    if (now < this.cooldownUntil) return;

    // 2. Reject accidental repeat of previous key's scancode within 1.5 seconds
    if (this.lastScancode === scancode && (now - this.lastTimestamp < 1500)) return;

    this.lastTimestamp = now;
    this.cooldownUntil = now + 800; // 800ms pause before accepting next key
    this.lastScancode = scancode;

    const currentStep = this.steps[this.currentIndex];
    this.mappings[currentStep.keycode] = scancode;

    this.lastDetected = {
      stepId: currentStep.id,
      name: currentStep.name,
      keycode: currentStep.keycode,
      scancode: scancode,
      timestamp: now
    };

    // Apply immediately to running kernel so user can use it immediately!
    if (/^0x[0-9a-fA-F]+$/.test(scancode) && /^[A-Z0-9_]+$/.test(currentStep.keycode)) {
      await runCmdFile('ir-keytable', ['-k', `${scancode}=${currentStep.keycode}`]);
    }

    this.currentIndex++;

    if (this.currentIndex >= this.steps.length) {
      await this.finish();
    }
  }

  async undo() {
    if (!this.active || this.currentIndex <= 0) return this.getStatus();
    this.currentIndex--;
    const step = this.steps[this.currentIndex];
    const prevScancode = this.mappings[step.keycode];
    delete this.mappings[step.keycode];
    if (prevScancode && /^0x[0-9a-fA-F]+$/.test(prevScancode)) {
      await runCmdFile('ir-keytable', ['-k', `${prevScancode}=KEY_UNKNOWN`]);
    }
    this.lastDetected = null;
    this.lastScancode = null;
    this.cooldownUntil = Date.now() + 600;
    return this.getStatus();
  }

  async skip() {
    if (!this.active || this.completed || this.currentIndex >= this.steps.length) return this.getStatus();
    this.currentIndex++;
    this.cooldownUntil = Date.now() + 500;
    if (this.currentIndex >= this.steps.length) {
      await this.finish();
    }
    return this.getStatus();
  }

  async reset() {
    return this.start();
  }

  async finish() {
    this.completed = true;
    this.stopEvtest();

    try {
      let tomlContent = `[[protocols]]\nname = "mantaprint_remote"\nprotocol = "nec"\n[protocols.scancodes]\n`;
      for (const [keycode, scancode] of Object.entries(this.mappings)) {
        if (/^0x[0-9a-fA-F]+$/.test(scancode) && /^[A-Z0-9_]+$/.test(keycode)) {
          tomlContent += `${scancode} = "${keycode}"\n`;
        }
      }
      fs.mkdirSync('/etc/rc_keymaps', { recursive: true });
      fs.writeFileSync('/etc/rc_keymaps/mantaprint_remote.toml', tomlContent, 'utf8');
      fs.writeFileSync('/etc/rc_maps.cfg', `* * mantaprint_remote.toml\n`, 'utf8');

      const irService = `[Unit]\nDescription=MantaPrint IR Remote Keytable Loader\nAfter=multi-user.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/ir-keytable -p rc-5,rc-5-sz,jvc,sony,nec,sanyo,mce_kbd,rc-6,sharp,xmp,imon,rc-mm -w /etc/rc_keymaps/mantaprint_remote.toml\nRemainAfterExit=true\n\n[Install]\nWantedBy=multi-user.target\n`;
      fs.writeFileSync('/etc/systemd/system/mantaprint-ir.service', irService, 'utf8');
      await runCmdFile('systemctl', ['daemon-reload']);
      await runCmdFile('systemctl', ['enable', '--now', 'mantaprint-ir.service']);
    } catch (err) {
      console.error('[RemoteWizard] Failed to persist keymap:', err.message);
    }
  }

  stopEvtest() {
    if (this.evtestProc) {
      try {
        this.evtestProc.kill('SIGTERM');
      } catch {}
      this.evtestProc = null;
    }
  }

  stop() {
    this.active = false;
    this.stopEvtest();
  }

  getStatus() {
    return {
      active: this.active,
      completed: this.completed,
      currentIndex: this.currentIndex,
      totalSteps: this.steps.length,
      currentStep: this.currentIndex < this.steps.length ? this.steps[this.currentIndex] : null,
      lastDetected: this.lastDetected,
      mappings: this.mappings
    };
  }
}

export const hdmiNetworkEngine = new HdmiNetworkEngine();
export const remoteWizardEngine = new RemoteWizardEngine();
