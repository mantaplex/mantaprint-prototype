export class MantaClient {
  static getBaseUrl() {
    return window.location.origin;
  }

  static async request(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const res = await fetch(url, {
      ...options,
      headers
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `Request failed with status ${res.status}`);
    }
    return data;
  }

  // Hubs
  static async listHubs(filter = {}) {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.site_id) params.set('site_id', filter.site_id);
    if (filter.is_online !== undefined) params.set('is_online', String(filter.is_online));
    return this.request(`/api/v1/hubs?${params.toString()}`);
  }

  static async getHub(id) {
    return this.request(`/api/v1/hubs/${id}`);
  }

  static async adoptHub({ hubId, pin, siteId, customName, forceAdopt = false }) {
    return this.request('/api/v1/hubs/adopt', {
      method: 'POST',
      body: JSON.stringify({ hubId, pin, siteId, customName, forceAdopt })
    });
  }

  static async updateHub(id, data) {
    return this.request(`/api/v1/hubs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  static async unadoptHub(id) {
    return this.request(`/api/v1/hubs/${id}/unadopt`, { method: 'POST' });
  }

  static async deleteHub(id) {
    return this.request(`/api/v1/hubs/${id}`, { method: 'DELETE' });
  }

  static async purgeStaleHubs() {
    return this.request('/api/v1/hubs/purge-stale', { method: 'POST' });
  }

  static async syncAllHubs() {
    return this.request('/api/v1/hubs/sync-all', { method: 'POST' });
  }

  static async getHubSso(hubId) {
    return this.request(`/api/v1/hubs/${hubId}/sso`, { method: 'POST' });
  }

  static async sendCommand(hubId, command, params = {}) {
    return this.request(`/api/v1/hubs/${hubId}/command`, {
      method: 'POST',
      body: JSON.stringify({ command, params })
    });
  }

  // Peripherals (Printers & Scanners)
  static async listPeripherals() {
    return this.request('/api/v1/peripherals');
  }

  static async updatePrinter(data) {
    return this.request('/api/v1/peripherals/printer/update', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  static async testPrintPrinter(hub_id, queue_name) {
    return this.request('/api/v1/peripherals/printer/test-print', {
      method: 'POST',
      body: JSON.stringify({ hub_id, queue_name })
    });
  }

  static async clearPrinterQueue(hub_id, queue_name) {
    return this.request('/api/v1/peripherals/printer/clear-queue', {
      method: 'POST',
      body: JSON.stringify({ hub_id, queue_name })
    });
  }

  static async generateChallengePin(hubId) {
    return this.request(`/api/v1/hubs/${hubId}/pin`, { method: 'POST' });
  }

  static async scanSubnet(cidr) {
    return this.request('/api/v1/discovery/scan', {
      method: 'POST',
      body: JSON.stringify({ cidr })
    });
  }

  static async probeNode(ip) {
    return this.request('/api/v1/discovery/probe', {
      method: 'POST',
      body: JSON.stringify({ ip })
    });
  }

  // Sites
  static async listSites() {
    return this.request('/api/v1/sites');
  }

  static async createSite(siteData) {
    return this.request('/api/v1/sites', {
      method: 'POST',
      body: JSON.stringify(siteData)
    });
  }

  static async updateSite(id, siteData) {
    return this.request(`/api/v1/sites/${id}`, {
      method: 'PUT',
      body: JSON.stringify(siteData)
    });
  }

  static async deleteSite(id) {
    return this.request(`/api/v1/sites/${id}`, {
      method: 'DELETE'
    });
  }

  // Batch Tasks
  static async listBatchTasks() {
    return this.request('/api/v1/batch/tasks');
  }

  static async createBatchTask(taskData) {
    return this.request('/api/v1/batch/tasks', {
      method: 'POST',
      body: JSON.stringify(taskData)
    });
  }

  // Audit
  static async listAuditLogs() {
    return this.request('/api/v1/audit/logs');
  }

  // System & Updates
  static async getSystemVersion() {
    return this.request('/api/v1/system/version');
  }

  static async checkForUpdates() {
    return this.request('/api/v1/system/updates/check');
  }

  static async installUpdate() {
    return this.request('/api/v1/system/updates/install', { method: 'POST' });
  }

  static async listBackups() {
    return this.request('/api/v1/system/updates/backups');
  }

  static async rollbackDatabase(backupFilename) {
    return this.request('/api/v1/system/updates/rollback', {
      method: 'POST',
      body: JSON.stringify({ backupFilename })
    });
  }
}
