import test from 'node:test';
import assert from 'node:assert/strict';
import { ScannerHardwareLock, ScannerPairingManager } from '../src/web/server/scanner-pairing-manager.mjs';

test('ScannerHardwareLock - Mutual Exclusion & Watchdog', async (t) => {
  const lock = new ScannerHardwareLock(500); // 500ms watchdog for test

  await t.test('acquires lock for single client', () => {
    const res = lock.acquire('client_1', 'Kasir iPhone');
    assert.equal(res.acquired, true);
    assert.ok(res.job);
    assert.equal(res.job.clientId, 'client_1');
    assert.equal(lock.getStatus().is_busy, true);
  });

  await t.test('rejects concurrent client with SCANNER_BUSY', () => {
    const res = lock.acquire('client_2', 'Gudang Tablet');
    assert.equal(res.acquired, false);
    assert.equal(res.error, 'SCANNER_BUSY');
    assert.equal(res.holder, 'Kasir iPhone');
    assert.ok(res.estimatedRemainingSec >= 0);
  });

  await t.test('releases lock properly by lock holder', () => {
    const released = lock.release('client_1');
    assert.equal(released, true);
    assert.equal(lock.getStatus().is_busy, false);
  });

  await t.test('prevents non-holder from releasing lock', () => {
    lock.acquire('client_1', 'Kasir iPhone');
    const released = lock.release('imposter_client');
    assert.equal(released, false);
    assert.equal(lock.getStatus().is_busy, true);
    lock.forceRelease();
  });

  await t.test('auto-clears stale lock after watchdog timeout', async () => {
    lock.acquire('stale_client', 'Frozen Phone');
    assert.equal(lock.getStatus().is_busy, true);
    // Wait for watchdog expiry (> 500ms)
    await new Promise(r => setTimeout(r, 600));
    // New acquire should succeed by clearing stale lock
    const res = lock.acquire('fresh_client', 'New Phone');
    assert.equal(res.acquired, true);
    assert.equal(res.job.clientId, 'fresh_client');
    lock.forceRelease();
  });
});

test('ScannerPairingManager - Ephemeral Code, Tokens & Lifecycle', async (t) => {
  const pm = new ScannerPairingManager();

  await t.test('generates valid 6-digit PIN and dynamic QR payload', () => {
    const code = pm.generatePairingCode('mantaprint.local', '192.0.2.10', 80);
    assert.ok(code.pin.length === 6);
    assert.ok(/^\d{6}$/.test(code.pin));
    assert.ok(code.pairing_token.startsWith('pt_'));
    assert.equal(code.expires_in_sec, 300);
    const parsedQr = JSON.parse(code.qr_payload);
    assert.equal(parsedQr.pin, code.pin);
    assert.equal(parsedQr.ip, '192.0.2.10');
    assert.equal(parsedQr.hub_id, pm.getHubUuid());
  });

  let pairedClient = null;

  await t.test('verifies pairing via PIN and registers active client', () => {
    const code = pm.generatePairingCode();
    const result = pm.verifyPairing(code.pin, {
      device_name: 'iPhone 15 Pro (Safari)',
      platform: 'iOS',
      ip: '192.168.1.145'
    });
    assert.equal(result.success, true);
    assert.ok(result.token.startsWith('mp_tok_v1.'));
    assert.ok(result.client_id.startsWith('c_'));
    pairedClient = result;

    const clients = pm.listClients();
    const found = clients.find(c => c.client_id === pairedClient.client_id);
    assert.ok(found);
    assert.equal(found.status, 'ACTIVE');
    assert.equal(found.device_name, 'iPhone 15 Pro (Safari)');
    assert.equal(found.platform, 'iOS');
  });

  await t.test('verifies client token cryptographically', () => {
    const auth = pm.verifyClientToken(pairedClient.token, '192.168.1.145');
    assert.equal(auth.valid, true);
    assert.equal(auth.client.client_id, pairedClient.client_id);
  });

  await t.test('rejects tampered or malformed tokens', () => {
    const tampered = pairedClient.token.slice(0, -4) + 'abcd';
    const auth = pm.verifyClientToken(tampered);
    assert.equal(auth.valid, false);
    assert.equal(auth.code, 'ERR_INVALID_SIGNATURE');

    const malformed = 'bad_token_format';
    const auth2 = pm.verifyClientToken(malformed);
    assert.equal(auth2.valid, false);
    assert.equal(auth2.code, 'ERR_TOKEN_FORMAT');
  });

  await t.test('handles 1-click revoke and blocks subsequent requests with ERR_CLIENT_REVOKED', () => {
    const revoked = pm.revokeClient(pairedClient.client_id, 'admin');
    assert.equal(revoked, true);

    const auth = pm.verifyClientToken(pairedClient.token);
    assert.equal(auth.valid, false);
    assert.equal(auth.code, 'ERR_CLIENT_REVOKED');

    const client = pm.listClients().find(c => c.client_id === pairedClient.client_id);
    assert.equal(client.status, 'REVOKED');
    assert.ok(client.revoked_at);
  });

  await t.test('handles 1-click re-authorization restoring access without re-pairing', () => {
    const restored = pm.reauthorizeClient(pairedClient.client_id);
    assert.equal(restored, true);

    const auth = pm.verifyClientToken(pairedClient.token);
    assert.equal(auth.valid, true);
    assert.equal(auth.client.status, 'ACTIVE');
  });

  await t.test('allows renaming and deleting paired devices', () => {
    pm.renameClient(pairedClient.client_id, 'Kasir Depan (iPad)');
    let client = pm.listClients().find(c => c.client_id === pairedClient.client_id);
    assert.equal(client.device_name, 'Kasir Depan (iPad)');

    pm.deleteClient(pairedClient.client_id);
    client = pm.listClients().find(c => c.client_id === pairedClient.client_id);
    assert.equal(client, undefined);
  });
});
