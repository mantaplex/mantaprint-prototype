import dgram from 'node:dgram';

export class UdpBeaconListener {
  constructor({ port = 9876, onDiscoveredHub }) {
    this.port = port;
    this.onDiscoveredHub = onDiscoveredHub;
    this.server = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    try {
      this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.server.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString('utf8');
          const data = JSON.parse(text);
          if (data && (data.type === 'mantaprint_beacon' || data.app === 'mantaprint')) {
            const hubInfo = {
              id: data.id || `mantaprint-${rinfo.address.replace(/\./g, '')}`,
              name: data.hostname || data.name || `Hub at ${rinfo.address}`,
              ip_address: rinfo.address,
              mac_address: data.mac || '',
              arch: data.arch || 'arm64',
              model: data.model || 'MantaPrint Hub',
              version: data.version || 'v0.2.1'
            };
            if (typeof this.onDiscoveredHub === 'function') {
              this.onDiscoveredHub(hubInfo);
            }
          }
        } catch {
          // Ignore invalid UDP noise
        }
      });

      this.server.on('error', (err) => {
        console.warn(`[MantaMan UDP Beacon] Socket warning on port ${this.port}:`, err.message);
      });

      this.server.bind(this.port, () => {
        this.isRunning = true;
        console.log(`[MantaMan UDP Beacon] Listening for broadcast beacons on 0.0.0.0:${this.port}`);
      });
    } catch (err) {
      console.warn('[MantaMan UDP Beacon] Failed binding UDP port:', err.message);
    }
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.isRunning = false;
  }
}
