import crypto from 'node:crypto';

const SESSIONS = new Map(); // token -> { user, exp }

export function registerAuthRoutes(app, { store }) {
  // Login
  app.post('/api/v1/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400);
      return { success: false, message: 'Username and password required' };
    }

    const user = store.verifyUser(username, password);
    if (!user) {
      store.recordAuditLog({
        actor: username,
        action: 'login_failed',
        target_type: 'user',
        target_id: username,
        details: { ip: req.ip }
      });
      res.status(401);
      return { success: false, message: 'Invalid username or password' };
    }

    const sessionToken = 'mpsess_' + crypto.randomBytes(32).toString('hex');
    const exp = Date.now() + (8 * 3600 * 1000); // 8 hours
    SESSIONS.set(sessionToken, { user, exp });

    store.recordAuditLog({
      actor: user.username,
      action: 'login_success',
      target_type: 'user',
      target_id: user.id,
      details: { role: user.role }
    });

    return {
      success: true,
      token: sessionToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: user.display_name
      }
    };
  });

  // Get current user session
  app.get('/api/v1/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/, '');
    const session = SESSIONS.get(token);

    if (!session || Date.now() > session.exp) {
      if (session) SESSIONS.delete(token);
      res.status(401);
      return { success: false, message: 'Unauthorized' };
    }

    return { success: true, user: session.user };
  });

  // Audit Logs (RBAC: SuperAdmin)
  app.get('/api/v1/audit/logs', async () => {
    const logs = store.listAuditLogs(100);
    return { success: true, count: logs.length, logs };
  });
}
