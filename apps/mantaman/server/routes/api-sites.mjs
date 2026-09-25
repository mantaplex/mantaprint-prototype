export function registerSiteRoutes(app, { store }) {
  app.get('/api/v1/sites', async () => {
    const sites = store.listSites();
    return { success: true, count: sites.length, sites };
  });

  app.post('/api/v1/sites', async (req, res) => {
    const { name, slug, address, subnet_cidr, contact_email } = req.body || {};
    if (!name || !slug) {
      res.status(400);
      return { success: false, message: 'name and slug are required' };
    }

    try {
      const site = store.createSite({ name, slug, address, subnet_cidr, contact_email });
      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'create_site',
        target_type: 'site',
        target_id: site.id,
        details: { name, slug }
      });
      return { success: true, site };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  app.put('/api/v1/sites/:id', async (req, res) => {
    const { name, slug, address, subnet_cidr, contact_email } = req.body || {};
    try {
      const site = store.updateSite(req.params.id, { name, slug, address, subnet_cidr, contact_email });
      if (!site) {
        res.status(404);
        return { success: false, message: 'Site not found' };
      }
      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'update_site',
        target_type: 'site',
        target_id: site.id,
        details: { name: site.name }
      });
      return { success: true, site };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });

  app.delete('/api/v1/sites/:id', async (req, res) => {
    try {
      store.deleteSite(req.params.id);
      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: 'delete_site',
        target_type: 'site',
        target_id: req.params.id
      });
      return { success: true, message: 'Site deleted successfully' };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });
}
