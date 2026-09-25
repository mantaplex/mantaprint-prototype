/**
 * 3-Tiered Auto-Healing Hub Locator
 * Seamlessly rediscovers MantaPrint Hub when DHCP reassigns IP addresses.
 */

async function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

export class HubLocator {
  /**
   * Probe an endpoint to see if it's our MantaPrint Hub
   */
  static async probeEndpoint(endpoint, expectedHubUuid = null) {
    try {
      const normalized = endpoint.replace(/\/+$/, '');
      const url = `${normalized}/api/scanner/probe`;
      const res = await fetchWithTimeout(url, { method: 'GET' }, 600);
      if (res.ok) {
        const data = await res.json();
        if (data && data.hub_uuid) {
          if (!expectedHubUuid || data.hub_uuid === expectedHubUuid) {
            return {
              reachable: true,
              endpoint: normalized,
              hub_uuid: data.hub_uuid,
              hostname: data.hostname,
              ip: data.ip,
              version: data.version,
              is_busy: data.is_busy,
              portal_enabled: data.portal_enabled,
              pwa_api_enabled: data.pwa_api_enabled
            };
          }
        }
      }
    } catch {
      // Endpoint unreachable or timed out
    }
    return { reachable: false };
  }

  /**
   * 3-Tiered Locate:
   * 1. Last Known Endpoint (400ms)
   * 2. mDNS mantaprint.local (600ms)
   * 3. 16-worker parallel /24 subnet sweep (< 1.2s total)
   */
  static async locateHub(knownEndpoint, expectedHubUuid = null, onProgress = null) {
    // Tier 1: Test Last Known Endpoint
    if (knownEndpoint) {
      onProgress?.({ tier: 1, message: `Memeriksa alamat tersimpan (${knownEndpoint})...` });
      const tier1 = await this.probeEndpoint(knownEndpoint, expectedHubUuid);
      if (tier1.reachable) {
        return tier1;
      }
    }

    // Tier 2: Test mDNS mantaprint.local
    onProgress?.({ tier: 2, message: 'Mencari via mDNS (mantaprint.local)...' });
    const tier2 = await this.probeEndpoint('http://mantaprint.local', expectedHubUuid);
    if (tier2.reachable) {
      return tier2;
    }

    // Determine subnet from known endpoint or default 192.168.1.x
    let subnetPrefix = '192.168.1';
    if (knownEndpoint) {
      const match = knownEndpoint.match(/(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/);
      if (match) subnetPrefix = match[1];
    }

    onProgress?.({ tier: 3, message: `Memindai subnet lokal (${subnetPrefix}.0/24)...` });

    // Tier 3: Batched 16-worker parallel sweep across /24 subnet
    const ipList = [];
    for (let i = 1; i <= 254; i++) {
      ipList.push(`${subnetPrefix}.${i}`);
    }

    const BATCH_SIZE = 16;
    for (let i = 0; i < ipList.length; i += BATCH_SIZE) {
      const batch = ipList.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(ip => 
        this.probeEndpoint(`http://${ip}`, expectedHubUuid).then(res => res.reachable ? res : null)
      );

      const results = await Promise.all(batchPromises);
      const found = results.find(r => r !== null);
      if (found) {
        return found;
      }
    }

    return { reachable: false };
  }
}
