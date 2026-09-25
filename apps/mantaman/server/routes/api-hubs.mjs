export function registerHubRoutes(app, { store, adoptionEngine, fleetManager, subnetScanner }) {
  // 1. List Hubs
  app.get('/api/v1/hubs', async (req, res) => {
    const filter = {
      status: req.query.status,
      site_id: req.query.site_id,
      is_online: req.query.is_online !== undefined ? req.query.is_online === 'true' : undefined
    };
    const hubs = store.listHubs(filter);
    return { success: true, count: hubs.length, hubs };
  });

  // 2. Get Hub Details
  app.get('/api/v1/hubs/:id', async (req, res) => {
    const hub = store.getHub(req.params.id);
    if (!hub) {
      res.status(404);
      return { success: false, message: 'Hub not found' };
    }
    const safeHub = { ...hub };
    delete safeHub.auth_token_hash;
    return { success: true, hub: safeHub };
  });

  // 3. Adopt Hub
  app.post('/api/v1/hubs/adopt', async (req, res) => {
    const { hubId, pin, siteId, customName, forceAdopt } = req.body || {};
    if (!hubId) {
      res.status(400);
      return { success: false, message: 'hubId is required' };
    }

    try {
      const result = await adoptionEngine.adoptHub({
        hubId,
        pin,
        siteId,
        customName,
        actor: req.user?.username || 'admin',
        forceAdopt: Boolean(forceAdopt)
      });
      return { success: true, message: `Hub '${hubId}' adopted successfully!`, ...result };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  // 3b. Update Hub Details (Friendly Name, Site Assignment)
  app.put('/api/v1/hubs/:id', async (req, res) => {
    const { name, site_id } = req.body || {};
    const hubId = req.params.id;

    try {
      const updated = store.updateHub(hubId, { name, site_id });
      if (!updated) {
        res.status(404);
        return { success: false, message: 'Hub not found' };
      }
      return { success: true, message: 'Hub updated successfully', hub: updated };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  // 4. Unadopt Hub
  app.post('/api/v1/hubs/:id/unadopt', async (req, res) => {
    try {
      const result = adoptionEngine.unadoptHub(req.params.id, req.user?.username || 'admin');
      return { success: true, message: `Hub '${req.params.id}' unadopted successfully`, hub: result };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  // 5. Send Command to Hub
  app.post('/api/v1/hubs/:id/command', async (req, res) => {
    const hubId = req.params.id;
    const { command, params } = req.body || {};
    if (!command) {
      res.status(400);
      return { success: false, message: 'command is required' };
    }

    try {
      const result = await fleetManager.sendCommand(hubId, command, params || {}, 30000);
      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: `command_${command}`,
        target_type: 'hub',
        target_id: hubId,
        details: { result }
      });
      return { success: true, result };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 6. Generate Ephemeral Challenge PIN
  app.post('/api/v1/hubs/:id/pin', async (req, res) => {
    try {
      const challenge = adoptionEngine.generateChallengePin(req.params.id);
      return { success: true, ...challenge };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  // 7. Trigger Subnet Sweep
  app.post('/api/v1/discovery/scan', async (req, res) => {
    const { cidr } = req.body || {};
    if (!cidr) {
      res.status(400);
      return { success: false, message: 'cidr is required (e.g. 192.168.1.0/24)' };
    }

    try {
      // Run sweep asynchronously
      subnetScanner.scanCidr(cidr, (progress) => {
        // Can emit via SSE / WS if hooked
      }).catch(err => {
        console.warn('[MantaMan Discovery] Subnet scan error:', err.message);
      });

      return { success: true, message: `Subnet sweep initiated for ${cidr}` };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  // 8. Probe Single IP / Hostname for Instant Direct Discovery
  app.post('/api/v1/discovery/probe', async (req, res) => {
    const { ip } = req.body || {};
    if (!ip || typeof ip !== 'string') {
      res.status(400);
      return { success: false, message: 'ip or hostname is required' };
    }

    try {
      const hubInfo = await subnetScanner.probeIp(ip.trim());
      if (hubInfo) {
        return { success: true, message: `Discovered MantaPrint Hub at ${ip}`, hub: hubInfo };
      } else {
        res.status(404);
        return { success: false, message: `No active MantaPrint Hub responded at ${ip}` };
      }
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 9. Sync All Hubs
  app.post('/api/v1/hubs/sync-all', async (req, res) => {
    try {
      const summary = await fleetManager.syncAllHubs();
      return { success: true, message: `Synced ${summary.synced}/${summary.total} hubs`, ...summary };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 10. Delete / Purge Specific Hub
  app.delete('/api/v1/hubs/:id', async (req, res) => {
    const hubId = req.params.id;
    const hub = store.getHub(hubId);
    if (!hub) {
      res.status(404);
      return { success: false, message: 'Hub not found' };
    }

    try {
      store.deleteHub(hubId);
      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'delete_hub',
        target_type: 'hub',
        target_id: hubId,
        details: { name: hub.name, ip: hub.ip_address }
      });
      return { success: true, message: `Hub '${hubId}' deleted successfully` };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 11. Purge Stale Unadopted Hubs
  app.post('/api/v1/hubs/purge-stale', async (req, res) => {
    try {
      const result = store.purgeStaleUnadopted(10 * 60 * 1000);
      return { success: true, message: `Purged ${result.deleted} stale offline node(s)`, ...result };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // 12. Direct Single Sign-On (SSO) to Hub Admin without Re-login
  app.post('/api/v1/hubs/:id/sso', async (req, res) => {
    const hubId = req.params.id;
    const hub = store.getHub(hubId);
    if (!hub) {
      res.status(404);
      return { success: false, message: 'Hub not found' };
    }

    try {
      const token = await fleetManager.getHubAdminToken(hubId);
      const targetUrl = token 
        ? `http://${hub.ip_address}/admin?token=${encodeURIComponent(token)}`
        : `http://${hub.ip_address}/admin`;

      return {
        success: true,
        authenticated: Boolean(token),
        url: targetUrl,
        token: token || null
      };
    } catch (err) {
      return {
        success: true,
        authenticated: false,
        url: `http://${hub.ip_address}/admin`,
        token: null,
        error: err.message
      };
    }
  });
}
