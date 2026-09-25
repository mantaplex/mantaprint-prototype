import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MantaStore } from '../db/store.mjs';
import { MantaPoolUpdater } from '../updater/manta-pool-updater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.resolve(__dirname, 'test-updater.sqlite');

describe('MantaPool Updater & Backup Engine', () => {
  let store;
  let updater;

  test('1. Updater Initialization & Version Contract', () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    store = new MantaStore(TEST_DB);
    updater = new MantaPoolUpdater(store);

    const version = updater.getVersion();
    assert.ok(version.version, 'Should have a semver version');
    assert.strictEqual(typeof version.is_docker, 'boolean');
    assert.strictEqual(version.name, 'mantapool-console');
  });

  test('2. GitHub Releases Query or Fallback Contract', async () => {
    const check = await updater.checkForUpdates();
    assert.ok('updateAvailable' in check, 'Should return updateAvailable boolean');
    assert.ok(check.currentVersion, 'Should report currentVersion');
    assert.ok(check.latestVersion, 'Should report latestVersion');
  });

  test('3. Database Point-in-Time Snapshot Creation', async () => {
    const backupRes = await updater.createDatabaseBackup();
    assert.ok(backupRes.success, 'Backup should succeed');
    assert.ok(backupRes.backupName, 'Backup filename should be returned');
    assert.ok(fs.existsSync(backupRes.destPath), 'Backup file should physically exist on disk');

    const backupsList = updater.listBackups();
    assert.ok(backupsList.length > 0, 'Backups list should not be empty');
    assert.ok(backupsList.some(b => b.filename === backupRes.backupName));

    // Cleanup test backup file
    try {
      fs.unlinkSync(backupRes.destPath);
    } catch {}
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
});
