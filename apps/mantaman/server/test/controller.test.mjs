import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MantaStore } from '../db/store.mjs';
import { AdoptionEngine } from '../controller/adoption-engine.mjs';
import { SubnetScanner } from '../discovery/subnet-scanner.mjs';

test('MantaMan Controller Test Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantaman-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const store = new MantaStore(dbPath);
  const adoptionEngine = new AdoptionEngine(store);

  await t.test('1. Database Store Initialization & Seed Admin', () => {
    const sites = store.listSites();
    assert.ok(sites.length >= 1, 'Default site should be seeded');
    assert.strictEqual(sites[0].slug, 'hq-default');

    const admin = store.verifyUser('admin', 'mantaprint2026!');
    assert.ok(admin, 'Default admin should authenticate successfully');
    assert.strictEqual(admin.username, 'admin');
    assert.strictEqual(admin.role, 'SuperAdmin');
  });

  await t.test('2. Discovery Registry & Hub Upsertion', () => {
    const hub = store.upsertDiscoveredHub({
      id: 'mantaprint-testnode',
      name: 'Test Office Hub',
      ip_address: '192.168.1.150',
      mac_address: 'aa:bb:cc:dd:ee:ff',
      arch: 'arm64',
      model: 'MantaPrint STB',
      version: 'v0.2.1'
    });

    assert.ok(hub, 'Hub should be inserted');
    assert.strictEqual(hub.id, 'mantaprint-testnode');
    assert.strictEqual(hub.status, 'unadopted');
    assert.strictEqual(hub.is_online, false);

    const retrieved = store.getHub('mantaprint-testnode');
    assert.strictEqual(retrieved.ip_address, '192.168.1.150');
  });

  await t.test('3. Adoption Handshake via Ephemeral PIN Challenge', async () => {
    // Generate PIN
    const { pin } = adoptionEngine.generateChallengePin('mantaprint-testnode');
    assert.ok(pin && pin.length === 6, 'Challenge PIN should be 6 digits');

    // Adopt with PIN
    const adoption = await adoptionEngine.adoptHub({
      hubId: 'mantaprint-testnode',
      pin,
      siteId: 'site_default',
      customName: 'Floor 1 Reception Hub',
      actor: 'admin_test'
    });

    assert.ok(adoption.auth_token, 'Should issue capability token');
    assert.ok(adoption.auth_token.startsWith('mp_flt_'), 'Token should have mp_flt_ prefix');
    assert.strictEqual(adoption.hub.status, 'managed');
    assert.strictEqual(adoption.hub.name, 'Floor 1 Reception Hub');

    // Token verification
    const isValid = adoptionEngine.verifyHubToken('mantaprint-testnode', adoption.auth_token);
    assert.strictEqual(isValid, true, 'Issued token should verify successfully');

    const isFakeValid = adoptionEngine.verifyHubToken('mantaprint-testnode', 'fake_token');
    assert.strictEqual(isFakeValid, false, 'Invalid token should be rejected');
  });

  await t.test('4. Telemetry Batching & Storage Updating', async () => {
    store.queueTelemetryUpdate('mantaprint-testnode', {
      system: { cpu_temp: 52.4, ram_used_mb: 320, ram_total_mb: 1918, uptime: '4h 12m' },
      printer: { name: 'Canon LBP2900', state: 'idle' },
      toner: { k: 88 }
    });

    // Force flush
    store._flushTelemetryQueue();

    const hub = store.getHub('mantaprint-testnode');
    assert.strictEqual(hub.cpu_temp, 52.4);
    assert.strictEqual(hub.ram_used_mb, 320);
    assert.strictEqual(hub.printer_name, 'Canon LBP2900');
    assert.strictEqual(hub.cups_state, 'idle');
    assert.strictEqual(hub.toner_cmyk.k, 88);
  });

  await t.test('5. Cryptographic Hash-Chained Audit Ledger', () => {
    const entry1 = store.recordAuditLog({
      actor: 'admin',
      action: 'test_action_1',
      target_type: 'hub',
      target_id: 'mantaprint-testnode',
      details: { foo: 'bar' }
    });

    const entry2 = store.recordAuditLog({
      actor: 'admin',
      action: 'test_action_2',
      target_type: 'hub',
      target_id: 'mantaprint-testnode',
      details: { bar: 'baz' }
    });

    assert.ok(entry1.recordHash, 'Entry 1 should have cryptographic hash');
    assert.ok(entry2.recordHash, 'Entry 2 should have cryptographic hash');
    assert.notStrictEqual(entry1.recordHash, entry2.recordHash, 'Hashes must be unique');

    const logs = store.listAuditLogs(10);
    assert.ok(logs.length >= 2, 'Audit logs should be queryable');
    assert.strictEqual(logs[0].prev_hash, entry1.recordHash, 'Log N prev_hash must equal Log N-1 record_hash');
  });

  await t.test('6. Subnet Scanner CIDR Range Parsing', () => {
    const scanner = new SubnetScanner({});
    const ips = scanner.cidrToIpList('192.168.1.0/29');
    // /29 mask gives 8 addresses, 6 usable hosts (192.168.1.1 to 192.168.1.6)
    assert.strictEqual(ips.length, 6);
    assert.strictEqual(ips[0], '192.168.1.1');
    assert.strictEqual(ips[ips.length - 1], '192.168.1.6');
  });

  await t.test('7. Unadoption / Revocation', () => {
    const unadopted = adoptionEngine.unadoptHub('mantaprint-testnode', 'admin');
    assert.strictEqual(unadopted.status, 'unadopted');
    assert.strictEqual(unadopted.auth_token_hash, null);

    const isTokenStillValid = adoptionEngine.verifyHubToken('mantaprint-testnode', 'any');
    assert.strictEqual(isTokenStillValid, false, 'Revoked hub token should not verify');
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
