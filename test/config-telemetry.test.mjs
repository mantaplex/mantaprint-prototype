import test from 'node:test';
import assert from 'node:assert/strict';
import { configManager, redactConfigForClient } from '../src/web/server/config-manager.mjs';

test('ConfigManager & Telemetry Serialization Tests', async (t) => {
  await t.test('configManager.getConfig() returns complete configuration object with scanner and updates defaults', () => {
    const cfg = configManager.getConfig();
    assert.ok(cfg, 'getConfig() should return an object');
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg.scanner, 'cfg.scanner must exist');
    assert.equal(cfg.scanner.portal_enabled, true);
  });

  await t.test('configManager.get() respects nested and scalar properties correctly', () => {
    assert.equal(configManager.get('language'), configManager.getLanguage());
    assert.equal(configManager.get('nonexistent_key', 'fallback_val'), 'fallback_val');
  });

  await t.test('scanner portal switch can be evaluated safely without ReferenceError', () => {
    const cfg = configManager.getConfig();
    const portalEnabled = cfg?.scanner?.portal_enabled !== false;
    assert.equal(portalEnabled, true);
  });

  await t.test('default admin credentials resolve to mantaprint / mantapgan internally', () => {
    const cfg = configManager.getConfig();
    assert.equal(cfg.admin.username, 'mantaprint');
    assert.equal(cfg.admin.password, 'mantapgan');
  });

  await t.test('redactConfigForClient() strips admin credentials and secrets while keeping public settings', () => {
    const cfg = {
      ...configManager.getConfig(),
      secret: 'secret-val',
      token: 'token-val',
      lockdown_override: { pin_hash: 'abc' }
    };
    const redacted = redactConfigForClient(cfg);
    assert.equal(redacted.admin, undefined);
    assert.equal(redacted.secret, undefined);
    assert.equal(redacted.token, undefined);
    assert.equal(redacted.lockdown_override, undefined);
    assert.equal(redacted.hostname, cfg.hostname);
    assert.equal(redacted.language, cfg.language);
    assert.equal(redacted.timezone, cfg.timezone);
    assert.deepEqual(redacted.ntp, cfg.ntp);
  });
});
