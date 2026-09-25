export class SubnetScanner {
  constructor({ onDiscoveredHub, timeoutMs = 1500, maxConcurrency = 32 }) {
    this.onDiscoveredHub = onDiscoveredHub;
    this.timeoutMs = timeoutMs;
    this.maxConcurrency = maxConcurrency;
    this.isScanning = false;
  }

  // Parse simple CIDR (e.g. "192.168.1.0/24") into IP array
  cidrToIpList(cidr) {
    if (!cidr || typeof cidr !== 'string') return [];
    const parts = cidr.trim().split('/');
    if (parts.length !== 2) return [];

    const baseIp = parts[0];
    const prefix = parseInt(parts[1], 10);
    if (isNaN(prefix) || prefix < 22 || prefix > 30) return []; // Limit to /22 - /30 (up to 1,022 hosts) to prevent unbounded sweeps

    const octets = baseIp.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) return [];

    const ipInt = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = (ipInt & mask) >>> 0;
    const broadcast = (network | ~mask) >>> 0;

    const ips = [];
    // Sweep host range (skip network & broadcast)
    for (let current = network + 1; current < broadcast; current++) {
      const o1 = (current >>> 24) & 255;
      const o2 = (current >>> 16) & 255;
      const o3 = (current >>> 8) & 255;
      const o4 = current & 255;
      ips.push(`${o1}.${o2}.${o3}.${o4}`);
    }
    return ips;
  }

  async probeIp(ip) {
    const url = `http://${ip}/api/status`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': 'MantaMan-Scanner/1.0' }
      });
      if (res.ok) {
        const json = await res.json();
        // Check for MantaPrint signatures
        if (json.system || json.printer || json.app === 'mantaprint' || json.version) {
          const rawMid = json.system?.machine_id || json.system?.id;
          let hubId;
          if (rawMid && rawMid.length >= 6) {
            hubId = `mantaprint-${rawMid.slice(-6).toLowerCase()}`;
          } else if (json.system?.mac) {
            hubId = `mantaprint-${json.system.mac.replace(/[: -]/g, '').slice(-6).toLowerCase()}`;
          } else {
            hubId = `mantaprint-${ip.replace(/\./g, '')}`;
          }

          const hubInfo = {
            id: hubId,
            name: json.system?.hostname || json.printer?.display_name || `Hub at ${ip}`,
            ip_address: ip,
            mac_address: json.system?.mac || '',
            arch: json.system?.arch || 'arm64',
            model: json.system?.model || 'MantaPrint Hub',
            version: json.version || 'v0.2.1',
            peripherals: {
              printers: json.printers || (json.printer ? [json.printer] : []),
              scanner: json.scanner || null
            }
          };
          if (typeof this.onDiscoveredHub === 'function') {
            this.onDiscoveredHub(hubInfo);
          }
          return hubInfo;
        }
      }
    } catch {
      // Offline / not a MantaPrint Hub
    }
    return null;
  }

  async scanCidr(cidr, onProgress) {
    if (this.isScanning) {
      throw new Error('A scan is already in progress.');
    }

    const ips = this.cidrToIpList(cidr);
    if (ips.length === 0) {
      throw new Error('Invalid CIDR format or prefix out of bounds. Must be a valid IPv4 CIDR with prefix between /22 and /30 (e.g. 192.168.1.0/24).');
    }

    this.isScanning = true;

    try {
      const ips = this.cidrToIpList(cidr);
      const total = ips.length;
      let scanned = 0;
      let found = 0;

      const queue = [...ips];
      const workers = [];

      const worker = async () => {
        while (queue.length > 0) {
          const targetIp = queue.shift();
          if (!targetIp) break;

          const res = await this.probeIp(targetIp);
          scanned++;
          if (res) found++;

          if (typeof onProgress === 'function' && (scanned % 5 === 0 || scanned === total)) {
            onProgress({ scanned, total, found, percent: Math.round((scanned / total) * 100) });
          }
        }
      };

      const workerCount = Math.min(this.maxConcurrency, total);
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
      return { total, found };
    } finally {
      this.isScanning = false;
    }
  }
}
