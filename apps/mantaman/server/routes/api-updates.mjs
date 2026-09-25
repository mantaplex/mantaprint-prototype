export function registerUpdateRoutes(app, { updater }) {
  // Get current version & runtime info
  app.get('/api/v1/system/version', async () => {
    return {
      success: true,
      ...updater.getVersion()
    };
  });

  // Check for updates against GitHub Releases
  app.get('/api/v1/system/updates/check', async () => {
    try {
      const updateInfo = await updater.checkForUpdates();
      return {
        success: true,
        ...updateInfo
      };
    } catch (err) {
      return {
        success: false,
        message: err.message
      };
    }
  });

  // Start update installation pipeline
  app.post('/api/v1/system/updates/install', async (req, res) => {
    if (updater.isUpdating) {
      res.status(409);
      return { success: false, message: 'Update already in progress' };
    }

    try {
      // Trigger background update execution
      updater.installUpdate().catch(err => {
        console.error('[MantaPoolUpdater] Update execution error:', err.message);
      });

      return {
        success: true,
        message: 'Update initiated',
        state: updater.updateState
      };
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });

  // SSE Stream for real-time progress and logs
  app.get('/api/v1/system/updates/stream', async (req, res) => {
    const rawRes = res.rawRes || res;
    updater.addSseClient(rawRes);
  });

  // List available database backups
  app.get('/api/v1/system/updates/backups', async () => {
    const backups = updater.listBackups();
    return {
      success: true,
      backups
    };
  });

  // Rollback database to a previous backup snapshot
  app.post('/api/v1/system/updates/rollback', async (req, res) => {
    const { backupFilename } = req.body || {};
    if (!backupFilename) {
      res.status(400);
      return { success: false, message: 'backupFilename is required' };
    }

    try {
      const result = await updater.rollbackDatabase(backupFilename);
      return result;
    } catch (err) {
      res.status(500);
      return { success: false, message: err.message };
    }
  });
}
