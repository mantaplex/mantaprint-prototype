export function registerPeripheralRoutes(app, { store, fleetManager }) {
  // 1. List all Printers and Scanners across all managed Hubs
  app.get('/api/v1/peripherals', async (req, res) => {
    try {
      const hubs = store.listHubs({ status: 'managed' });
      const printers = [];
      const scanners = [];

      for (const hub of hubs) {
        const periph = hub.peripherals || {};
        const hubPrinters = Array.isArray(periph.printers) ? periph.printers : [];
        const hubScanner = periph.scanner || null;

        // Collect Printers
        for (const p of hubPrinters) {
          printers.push({
            id: `${hub.id}_${p.queue_name || p.name || 'default'}`,
            hub_id: hub.id,
            hub_name: hub.name,
            hub_ip: hub.ip_address,
            hub_online: hub.is_online,
            site_id: hub.site_id,
            queue_name: p.queue_name || p.name,
            display_name: p.display_name || p.raw_display_name || p.name,
            model: p.model || 'Generic Printer',
            vendor: p.vendor || 'Unknown',
            state: p.state || 'idle',
            connected: p.connected !== undefined ? p.connected : true,
            is_published: Boolean(p.is_published),
            custom_broadcast_name: p.custom_broadcast_name || '',
            location: p.location || '',
            device_uri: p.device_uri || '',
            protocol: p.protocol || 'usb',
            is_default: Boolean(p.is_default),
            jobs_count: Array.isArray(p.jobs) ? p.jobs.length : 0,
            markers: p.markers || []
          });
        }

        // Collect Scanner
        if (hubScanner && (hubScanner.name || hubScanner.connected !== undefined)) {
          scanners.push({
            id: `${hub.id}_scanner`,
            hub_id: hub.id,
            hub_name: hub.name,
            hub_ip: hub.ip_address,
            hub_online: hub.is_online,
            site_id: hub.site_id,
            name: hubScanner.name || 'Scanner',
            connected: Boolean(hubScanner.connected),
            message: hubScanner.message || '',
            profiles: hubScanner.profiles || []
          });
        }
      }

      return {
        success: true,
        count_printers: printers.length,
        count_scanners: scanners.length,
        printers,
        scanners
      };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 2. Configure Remote Printer Settings (Display Name, Location, mDNS, Sharing)
  app.post('/api/v1/peripherals/printer/update', async (req, res) => {
    const {
      hub_id,
      queue_name,
      display_name,
      location,
      publish_broadcast,
      is_default,
      custom_broadcast_name
    } = req.body || {};

    if (!hub_id || !queue_name) {
      res.status(400);
      return { success: false, message: 'hub_id and queue_name are required' };
    }

    try {
      await fleetManager.updatePrinterConfig(hub_id, {
        queue_name,
        display_name,
        location,
        publish_broadcast,
        is_default,
        custom_broadcast_name
      });

      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'update_printer_config',
        target_type: 'hub',
        target_id: hub_id,
        details: { queue_name, display_name, location, publish_broadcast, is_default }
      });

      return { success: true, message: `Printer '${queue_name}' configuration updated successfully!` };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 3. Send Test Page to Specific Remote Printer
  app.post('/api/v1/peripherals/printer/test-print', async (req, res) => {
    const { hub_id, queue_name } = req.body || {};
    if (!hub_id || !queue_name) {
      res.status(400);
      return { success: false, message: 'hub_id and queue_name are required' };
    }

    const hub = store.getHub(hub_id);
    if (!hub) {
      res.status(404);
      return { success: false, message: 'Hub not found' };
    }

    try {
      const token = await fleetManager.getHubAdminToken(hub_id);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Admin-Token'] = token;

      const testRes = await fetch(`http://${hub.ip_address}/api/print/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ printer: queue_name }),
        signal: AbortSignal.timeout(10000)
      });

      if (!testRes.ok) {
        const errJson = await testRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Test print failed with HTTP ${testRes.status}`);
      }

      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'test_print_printer',
        target_type: 'hub',
        target_id: hub_id,
        details: { queue_name }
      });

      return { success: true, message: `Test page sent to printer '${queue_name}' on ${hub.name}` };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 4. Clear/Purge Spool Queue on Specific Remote Printer
  app.post('/api/v1/peripherals/printer/clear-queue', async (req, res) => {
    const { hub_id, queue_name } = req.body || {};
    if (!hub_id) {
      res.status(400);
      return { success: false, message: 'hub_id is required' };
    }

    const hub = store.getHub(hub_id);
    if (!hub) {
      res.status(404);
      return { success: false, message: 'Hub not found' };
    }

    try {
      const token = await fleetManager.getHubAdminToken(hub_id);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Admin-Token'] = token;

      const clearRes = await fetch(`http://${hub.ip_address}/api/printer/cancel-all`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ printer: queue_name || undefined }),
        signal: AbortSignal.timeout(10000)
      });

      if (!clearRes.ok) {
        const errJson = await clearRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Purge queue failed with HTTP ${clearRes.status}`);
      }

      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'clear_printer_queue',
        target_type: 'hub',
        target_id: hub_id,
        details: { queue_name }
      });

      return { success: true, message: `Spool queue purged for '${queue_name || 'all'}' on ${hub.name}` };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });
}
