import test from 'node:test';
import assert from 'node:assert/strict';
import { configManager } from '../src/web/server/config-manager.mjs';

test('ConfigManager & Telemetry Serialization Tests', async (t) => {
  await t.test('configManager.getConfig() returns complete configuration object with scanner and updates defaults', () => {
    const cfg = configManager.getConfig();
    assert.ok(cfg, 'getConfig() should return an object');
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg.scanner, 'cfg.scanner must exist');
    assert.equal(cfg.scanner.portal_enabled, true);
    assert.equal(cfg.scanner.remote_pwa_api_enabled, true);
  });

  await t.test('configManager.get() respects nested and scalar properties correctly', () => {
    assert.equal(configManager.get('language'), configManager.getLanguage());
    assert.equal(configManager.get('nonexistent_key', 'fallback_val'), 'fallback_val');
  });

  await t.test('scanner portal and PWA switches can be evaluated safely without ReferenceError', () => {
    const cfg = configManager.getConfig();
    const portalEnabled = cfg?.scanner?.portal_enabled !== false;
    const pwaEnabled = cfg?.scanner?.remote_pwa_api_enabled !== false;
    assert.equal(portalEnabled, true);
    assert.equal(pwaEnabled, true);
  });

  await t.test('default admin credentials resolve to mantaprint / mantapgan', () => {
    const cfg = configManager.getConfig();
    assert.equal(cfg.admin.username, 'mantaprint');
    assert.equal(cfg.admin.password, 'mantapgan');
  });
});
