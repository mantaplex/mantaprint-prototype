import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { scannerHardwareLock, scannerPairingManager } from '../src/web/server/scanner-pairing-manager.mjs';

test('Scanner API & Mutex Integration Logic', async (t) => {
  await t.test('Scanner probe returns valid telemetry and UUID', () => {
    const hubUuid = scannerPairingManager.getHubUuid();
    assert.ok(hubUuid.startsWith('hub_'));
    const status = scannerHardwareLock.getStatus();
    assert.equal(status.is_busy, false);
  });

  let generatedCode;
  let pairedClient;

  await t.test('generates pairing code with 5-minute expiry', () => {
    generatedCode = scannerPairingManager.generatePairingCode('mantaprint.local', '192.0.2.10', 80);
    assert.ok(generatedCode.pin);
    assert.ok(generatedCode.pairing_token);
    assert.equal(generatedCode.expires_in_sec, 300);
  });

  await t.test('verifies pairing and creates client session', () => {
    const res = scannerPairingManager.verifyPairing(generatedCode.pin, {
      device_name: 'Cashier iPad',
      platform: 'iPadOS',
      ip: '192.168.1.50'
    });
    assert.equal(res.success, true);
    assert.ok(res.token);
    assert.ok(res.client_id);
    pairedClient = res;
  });

  await t.test('verifies valid client token and checks revocation', () => {
    // Valid
    let check = scannerPairingManager.verifyClientToken(pairedClient.token, '192.168.1.50');
    assert.equal(check.valid, true);

    // Revoke
    scannerPairingManager.revokeClient(pairedClient.client_id, 'admin');
    check = scannerPairingManager.verifyClientToken(pairedClient.token, '192.168.1.50');
    assert.equal(check.valid, false);
    assert.equal(check.code, 'ERR_CLIENT_REVOKED');

    // Reauthorize
    scannerPairingManager.reauthorizeClient(pairedClient.client_id);
    check = scannerPairingManager.verifyClientToken(pairedClient.token, '192.168.1.50');
    assert.equal(check.valid, true);
  });

  await t.test('hardware mutex protects concurrent scanning jobs', () => {
    const lock1 = scannerHardwareLock.acquire(pairedClient.client_id, 'Cashier iPad');
    assert.equal(lock1.acquired, true);

    const lock2 = scannerHardwareLock.acquire('other_client', 'Warehouse Android');
    assert.equal(lock2.acquired, false);
    assert.equal(lock2.error, 'SCANNER_BUSY');
    assert.equal(lock2.holder, 'Cashier iPad');

    // Release
    scannerHardwareLock.release(pairedClient.client_id);
    assert.equal(scannerHardwareLock.getStatus().is_busy, false);

    // Now other client can acquire
    const lock3 = scannerHardwareLock.acquire('other_client', 'Warehouse Android');
    assert.equal(lock3.acquired, true);
    scannerHardwareLock.release('other_client');
  });

  // Cleanup
  scannerPairingManager.deleteClient(pairedClient.client_id);
});
