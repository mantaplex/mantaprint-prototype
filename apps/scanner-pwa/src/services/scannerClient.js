export class ScannerClient {
  constructor(endpoint, credentials, onRevoked = null) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.credentials = credentials;
    this.onRevoked = onRevoked;
  }

  updateEndpoint(newEndpoint) {
    this.endpoint = newEndpoint.replace(/\/+$/, '');
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-MantaPrint-Token': this.credentials?.token || '',
      'X-MantaPrint-Client-Id': this.credentials?.client_id || '',
      'Authorization': `Bearer ${this.credentials?.token || ''}`
    };
  }

  async handleResponse(res) {
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.error_code === 'ERR_CLIENT_REVOKED' || data.action_required === 'PURGE_LOCAL_CREDENTIALS') {
        this.onRevoked?.(data);
        throw new Error('ERR_CLIENT_REVOKED');
      }
    }

    if (res.status === 423) {
      const data = await res.json().catch(() => ({}));
      const error = new Error('SCANNER_BUSY');
      error.isBusy = true;
      error.holder = data.holder;
      error.elapsedSec = data.elapsed_sec;
      error.estimatedRemainingSec = data.estimated_remaining_sec || 15;
      throw error;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    return res.json();
  }

  async getStatus() {
    const res = await fetch(`${this.endpoint}/api/scanner/status`, {
      headers: this.getHeaders()
    });
    return this.handleResponse(res);
  }

  async acquireScan(options = {}) {
    const res = await fetch(`${this.endpoint}/api/scanner/scan`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(options)
    });
    return this.handleResponse(res);
  }

  async downloadScanBlob(fileUrl) {
    const fullUrl = fileUrl.startsWith('http') ? fileUrl : `${this.endpoint}${fileUrl}`;
    const res = await fetch(fullUrl, {
      headers: {
        'X-MantaPrint-Token': this.credentials?.token || '',
        'X-MantaPrint-Client-Id': this.credentials?.client_id || '',
        'Authorization': `Bearer ${this.credentials?.token || ''}`
      }
    });
    if (!res.ok) {
      throw new Error(`Failed to download scan file: ${res.statusText}`);
    }
    return res.blob();
  }
}
