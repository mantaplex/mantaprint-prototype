import test from 'node:test';
import assert from 'node:assert/strict';
import { ScannerHardwareLock, scannerHardwareLock } from '../src/web/server/scanner-pairing-manager.mjs';

test('Scanner Hardware Mutex Logic (MantaPage Scan Studio)', async (t) => {
  await t.test('initial hardware lock status is idle', () => {
    const status = scannerHardwareLock.getStatus();
    assert.equal(status.is_busy, false);
    assert.equal(status.holder, null);
  });

  await t.test('hardware mutex protects concurrent scanning jobs and enforces holder release', () => {
    const lock1 = scannerHardwareLock.acquire('studio_session_1', 'Scan Studio');
    assert.equal(lock1.acquired, true);
    assert.equal(scannerHardwareLock.getStatus().is_busy, true);

    const lock2 = scannerHardwareLock.acquire('studio_session_2', 'Other Session');
    assert.equal(lock2.acquired, false);
    assert.equal(lock2.error, 'SCANNER_BUSY');
    assert.equal(lock2.holder, 'Scan Studio');

    // Non-holder cannot release
    assert.equal(scannerHardwareLock.release('studio_session_2'), false);
    assert.equal(scannerHardwareLock.getStatus().is_busy, true);

    // Holder releases cleanly
    assert.equal(scannerHardwareLock.release('studio_session_1'), true);
    assert.equal(scannerHardwareLock.getStatus().is_busy, false);

    // Next session can now acquire
    const lock3 = scannerHardwareLock.acquire('studio_session_2', 'Other Session');
    assert.equal(lock3.acquired, true);
    scannerHardwareLock.release('studio_session_2');
  });

  await t.test('auto-releases stale locks after watchdog timeout', async () => {
    const shortLock = new ScannerHardwareLock(30);
    const first = shortLock.acquire('session_a', 'Session A');
    assert.equal(first.acquired, true);

    await new Promise((r) => setTimeout(r, 50));
    const second = shortLock.acquire('session_b', 'Session B');
    assert.equal(second.acquired, true);
    shortLock.forceRelease();
  });
});
