/**
 * MantaPrint Hub - Network & mDNS / CUPS Diagnostic Engine
 * Comprehensive detection for mDNS, Avahi, CUPS, and Router AP Isolation / Multicast Filtering
 */

import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Cache quick status for 5 seconds to prevent spamming
let quickStatusCache = null;
let quickStatusCacheTime = 0;

/**
 * Identify primary interface and network topology
 */
function getNetworkTopology() {
  let primaryIface = 'eth0';
  let isWifi = false;

  try {
    const routeData = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = routeData.trim().split('\n').slice(1);
    for (const l of lines) {
      const parts = l.trim().split(/\s+/);
      if (parts[1] === '00000000') { // Default route 0.0.0.0
        primaryIface = parts[0];
        break;
      }
    }
  } catch (err) {
    primaryIface = 'eth0';
  }

  isWifi = primaryIface.startsWith('wl');

  let arpPeersCount = 0;
  const arpPeers = [];
  try {
    const arpData = fs.readFileSync('/proc/net/arp', 'utf8');
    const arpLines = arpData.trim().split('\n').slice(1);
    for (const line of arpLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6 && parts[3] !== '00:00:00:00:00:00') {
        arpPeersCount++;
        arpPeers.push({ ip: parts[0], mac: parts[3], device: parts[5] });
      }
    }
  } catch (err) {
    arpPeersCount = 0;
  }

  let joinedMcast224 = false;
  try {
    const igmpData = fs.readFileSync('/proc/net/igmp', 'utf8');
    // 224.0.0.251 in little-endian hex is FB0000E0
    joinedMcast224 = igmpData.includes('FB0000E0');
  } catch (err) {
    joinedMcast224 = false;
  }

  let rxMulticastPackets = 0;
  try {
    const statPath = `/sys/class/net/${primaryIface}/statistics/rx_multicast`;
    if (fs.existsSync(statPath)) {
      rxMulticastPackets = parseInt(fs.readFileSync(statPath, 'utf8').trim(), 10) || 0;
    }
  } catch (err) {
    rxMulticastPackets = 0;
  }

  return {
    primaryIface,
    isWifi,
    arpPeersCount,
    arpPeers: arpPeers.slice(0, 10),
    joinedMcast224,
    rxMulticastPackets
  };
}

/**
 * Check CUPS Daemon, binding, and HTTP IPP connectivity
 */
async function checkCups(serverIp, defaultQueue) {
  let active = false;
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'cups']);
    active = stdout.trim() === 'active';
  } catch {
    active = false;
  }

  let listeningAll = false;
  let rawSockets = '';
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp', 'sport = :631']);
    rawSockets = stdout.trim();
    listeningAll = rawSockets.includes('0.0.0.0:631') || rawSockets.includes('[::]:631') || rawSockets.includes('*:631');
  } catch {
    listeningAll = false;
  }

  // Probe HTTP loopback
  const loopbackOk = await new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:631/printers/', { timeout: 1200 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  // Probe LAN IP HTTP
  let lanIpOk = false;
  if (serverIp && serverIp !== '127.0.0.1') {
    lanIpOk = await new Promise((resolve) => {
      const req = http.get(`http://${serverIp}:631/printers/`, { timeout: 1200 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } else {
    lanIpOk = loopbackOk;
  }

  return {
    active,
    listeningAll,
    loopbackOk,
    lanIpOk,
    port: 631,
    status: (active && listeningAll && loopbackOk) ? 'ok' : 'error'
  };
}

/**
 * Check Avahi daemon, published services, and test active mDNS query loopback
 */
async function checkAvahi(defaultQueue) {
  let active = false;
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'avahi-daemon']);
    active = stdout.trim() === 'active';
  } catch {
    active = false;
  }

  let port5353Open = false;
  try {
    const { stdout } = await execFileAsync('ss', ['-ulnp', 'sport = :5353']);
    port5353Open = stdout.includes('5353');
  } catch {
    port5353Open = false;
  }

  let publishedServices = [];
  try {
    if (fs.existsSync('/etc/avahi/services')) {
      publishedServices = fs.readdirSync('/etc/avahi/services').filter(f => f.endsWith('.service'));
    }
  } catch {
    publishedServices = [];
  }

  let hasPrinterPublished = false;
  if (defaultQueue) {
    hasPrinterPublished = publishedServices.some(s => s.includes(defaultQueue));
  } else {
    hasPrinterPublished = publishedServices.length > 0;
  }

  // Active mDNS Multicast Probe: Send DNS query for _ipp._tcp.local to 224.0.0.251:5353
  const probeResult = await new Promise((resolve) => {
    let client = null;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (client) {
          try { client.close(); } catch {}
        }
        resolve({ queryLoopbackOk: false, responseBytes: 0, fromAddress: null });
      }
    }, 1500);

    try {
      client = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      client.on('message', (msg, rinfo) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { client.close(); } catch {}
          resolve({ queryLoopbackOk: true, responseBytes: msg.length, fromAddress: rinfo.address });
        }
      });

      client.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { client.close(); } catch {}
          resolve({ queryLoopbackOk: false, responseBytes: 0, fromAddress: null });
        }
      });

      client.bind(0, () => {
        try {
          client.addMembership('224.0.0.251');
        } catch {}

        // Standard DNS query for _ipp._tcp.local (PTR)
        const q = Buffer.from([
          0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x04, 0x5f, 0x69, 0x70,
          0x70, 0x04, 0x5f, 0x74, 0x63, 0x70, 0x05, 0x6c,
          0x6f, 0x63, 0x61, 0x6c, 0x00, 0x00, 0x0c, 0x00, 0x01
        ]);
        client.send(q, 5353, '224.0.0.251', (err) => {
          if (err && !resolved) {
            resolved = true;
            clearTimeout(timer);
            try { client.close(); } catch {}
            resolve({ queryLoopbackOk: false, responseBytes: 0, fromAddress: null });
          }
        });
      });
    } catch {
      clearTimeout(timer);
      resolve({ queryLoopbackOk: false, responseBytes: 0, fromAddress: null });
    }
  });

  return {
    active,
    port5353Open,
    publishedServices,
    hasPrinterPublished,
    queryLoopbackOk: probeResult.queryLoopbackOk,
    responseBytes: probeResult.responseBytes,
    fromAddress: probeResult.fromAddress,
    status: (active && port5353Open && probeResult.queryLoopbackOk) ? 'ok' : 'error'
  };
}

/**
 * Run comprehensive diagnostic test
 */
export async function runComprehensiveMdnsCupsDiagnostic(serverIp = '192.0.2.10', defaultQueue = '') {
  const topo = getNetworkTopology();
  const [cups, avahi] = await Promise.all([
    checkCups(serverIp, defaultQueue),
    checkAvahi(defaultQueue)
  ]);

  const issues = [];
  const mitigations = [];

  // 1. CUPS Issues
  if (!cups.active) {
    issues.push({
      level: 'error',
      component: 'cups',
      message: 'Layanan Spooler CUPS tidak berjalan (inactive).'
    });
  } else if (!cups.listeningAll) {
    issues.push({
      level: 'error',
      component: 'cups',
      message: 'Port CUPS 631 hanya terikat ke localhost dan menolak koneksi dari jaringan LAN.'
    });
  } else if (!cups.lanIpOk) {
    issues.push({
      level: 'warning',
      component: 'cups',
      message: 'Koneksi HTTP IPP ke IP lokal menolak akses (kemungkinan firewall lokal atau cupsd.conf restrict).'
    });
  }

  // 2. Avahi mDNS Issues
  if (!avahi.active) {
    issues.push({
      level: 'error',
      component: 'avahi',
      message: 'Layanan Avahi mDNS Daemon tidak berjalan. Broadcast ZeroConf/AirPrint terhenti.'
    });
  } else if (!avahi.port5353Open) {
    issues.push({
      level: 'error',
      component: 'avahi',
      message: 'Port UDP 5353 (mDNS) tidak terbuka pada sistem operasi.'
    });
  } else if (!avahi.queryLoopbackOk) {
    issues.push({
      level: 'warning',
      component: 'avahi',
      message: 'Query mDNS multicast (224.0.0.251:5353) tidak menerima respon loopback.'
    });
  }

  // 3. AP Isolation & Multicast Assessment
  let apIsolationSuspected = false;
  let apRiskLevel = 'low';
  let isolationReason = '';

  if (topo.isWifi) {
    if (!avahi.queryLoopbackOk || topo.rxMulticastPackets === 0) {
      apIsolationSuspected = true;
      apRiskLevel = 'high';
      isolationReason = 'STB terhubung via Wi-Fi nirkabel dan paket multicast lokal tidak terdeteksi berputar. Router Wi-Fi kemungkinan besar mengaktifkan AP / Client Isolation atau memfilter UDP 5353.';
      issues.push({
        level: 'warning',
        component: 'network_isolation',
        message: 'AP Isolation Terdeteksi: Router Wi-Fi Anda memblokir siaran AirPrint/Mopria antar perangkat klien.'
      });
    } else {
      apRiskLevel = 'medium';
      isolationReason = 'STB terhubung via Wi-Fi nirkabel. Jika printer tidak muncul otomatis di ponsel tertentu, periksa pengaturan AP Isolation pada router.';
    }
  } else {
    // Ethernet
    if (!avahi.queryLoopbackOk) {
      apRiskLevel = 'medium';
      isolationReason = 'Koneksi Ethernet aktif namun query multicast mDNS mengalami timeout. Periksa switch managed atau IGMP snooping.';
    } else {
      apRiskLevel = 'low';
      isolationReason = 'Koneksi Ethernet fisik aktif; lalu lintas multicast mDNS beroperasi normal tanpa terhalang isolasi klien nirkabel.';
    }
  }

  // Mitigations
  const safeQueue = defaultQueue || 'Canon_LBP6030_6040_6018L';
  const httpUrl = `http://${serverIp}:631/printers/${safeQueue}`;
  const ippUrl = `ipp://${serverIp}:631/printers/${safeQueue}`;
  const webUrl = `http://${serverIp}/`;

  mitigations.push({
    id: 'manual_add',
    title: 'Penambahan Manual via Alamat IP (Bypass mDNS)',
    summary: 'Jika printer tidak terdeteksi otomatis oleh HP/Laptop, tambahkan printer secara langsung menggunakan URL IPP.',
    steps: [
      `Android: Buka Layanan Cetak (Mopria/Default) > Titik Tiga > Tambah via Alamat IP > Masukkan ${serverIp}.`,
      `Windows: Settings > Printers > Add device > 'The printer that I want isn't listed' > 'Select a shared printer by name' > Masukkan ${httpUrl}.`,
      `macOS: System Settings > Printers > Add (+) > Tab IP (Bola Dunia) > Address: ${serverIp}, Protocol: IPP, Queue: printers/${safeQueue}.`,
      `ChromeOS: Settings > Advanced > Print and scan > Add printer manually > Address: ${serverIp}, Queue: printers/${safeQueue}.`,
      `Linux: lpadmin -p MantaPrint -E -v ${ippUrl} -m everywhere`
    ],
    httpUrl,
    ippUrl,
    ip: serverIp,
    port: 631,
    queue: `printers/${safeQueue}`
  });

  mitigations.push({
    id: 'router_config',
    title: 'Pengaturan Router Wi-Fi (Bebaskan AP Isolation)',
    summary: 'Nonaktifkan isolasi klien agar perangkat di Wi-Fi dapat saling melihat siaran printer.',
    steps: [
      'Buka antarmuka admin router Anda di browser (misal http://192.168.1.1 atau 192.168.0.1).',
      'Masuk ke menu Wireless / Wi-Fi > Advanced Wireless Settings.',
      'Cari opsi bernama AP Isolation, Station Isolation, atau Client Isolation, lalu ubah ke [DISABLED / NONAKTIF].',
      'Cari opsi IGMP Snooping atau Multicast Forwarding, lalu ubah ke [ENABLED / AKTIF].',
      'Simpan konfigurasi dan reboot router Wi-Fi Anda.'
    ]
  });

  mitigations.push({
    id: 'web_direct_print',
    title: 'Cetak Langsung via Web Dashboard MantaPrint',
    summary: 'Buka browser di ponsel/komputer Anda dan cetak dokumen secara instan tanpa perlu mDNS atau instal driver.',
    url: webUrl
  });

  if (topo.isWifi) {
    mitigations.push({
      id: 'use_ethernet',
      title: 'Solusi Fisik: Hubungkan STB Menggunakan Kabel LAN Ethernet',
      summary: 'Kabel Ethernet fisik langsung ke port LAN router secara otomatis terbebas dari isolasi nirkabel (AP isolation).'
    });
  }

  // Determine overall status
  let overallStatus = 'ok';
  let statusBadge = '[NORMAL]';
  let score = 100;

  if (issues.some(i => i.level === 'error')) {
    overallStatus = 'error';
    statusBadge = '[TERBLOKIR]';
    score = 40;
  } else if (issues.some(i => i.level === 'warning') || apIsolationSuspected) {
    overallStatus = 'warning';
    statusBadge = '[PERINGATAN]';
    score = 75;
  }

  let summary = 'Layanan mDNS & CUPS beroperasi optimal di jaringan lokal.';
  if (overallStatus === 'error') {
    summary = 'Layanan cetak atau mDNS mengalami kendala kritis. Perangkat klien tidak dapat mencetak.';
  } else if (overallStatus === 'warning') {
    summary = apIsolationSuspected
      ? 'Router Wi-Fi dicurigai mengisolasi multicast (AP Isolation). Gunakan penambahan IP manual.'
      : 'Terdapat peringatan pada siaran mDNS jaringan. Simak mitigasi di bawah.';
  }

  const result = {
    timestamp: Math.floor(Date.now() / 1000),
    status: overallStatus,
    statusBadge,
    score,
    summary,
    cups,
    avahi,
    network: {
      primaryIface: topo.primaryIface,
      isWifi: topo.isWifi,
      interfaceType: topo.isWifi ? 'Wi-Fi Nirkabel' : 'Ethernet Kabel (LAN)',
      ip: serverIp,
      arpPeersCount: topo.arpPeersCount,
      joinedMcast224: topo.joinedMcast224,
      rxMulticastPackets: topo.rxMulticastPackets,
      apIsolationRisk: apRiskLevel,
      apIsolationSuspected,
      isolationReason
    },
    issues,
    mitigations,
    manualAddUrls: {
      httpUrl,
      ippUrl,
      webUrl,
      ip: serverIp,
      port: 631,
      queue: `printers/${safeQueue}`
    }
  };

  quickStatusCache = {
    status: overallStatus,
    apIsolationSuspected,
    summary,
    issuesCount: issues.length
  };
  quickStatusCacheTime = Date.now();

  return result;
}

/**
 * Lightweight synchronous or cached check for /api/status telemetry polling
 */
export function getQuickMdnsStatus(serverIp = '192.0.2.10', defaultQueue = '') {
  if (quickStatusCache && (Date.now() - quickStatusCacheTime < 8000)) {
    return quickStatusCache;
  }

  // Quick fallback check
  const topo = getNetworkTopology();
  const safeQueue = defaultQueue || 'Canon_LBP6030_6040_6018L';

  const isWarning = topo.isWifi;
  return {
    status: isWarning ? 'warning' : 'ok',
    apIsolationSuspected: topo.isWifi,
    summary: topo.isWifi 
      ? 'Koneksi Wi-Fi aktif: Waspadai AP Isolation router jika printer tidak muncul di HP.' 
      : 'Koneksi Ethernet aktif: Siaran mDNS & CUPS beroperasi normal.',
    primaryIface: topo.primaryIface,
    isWifi: topo.isWifi,
    manualUrl: `http://${serverIp}:631/printers/${safeQueue}`
  };
}
