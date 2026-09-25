import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSemver, compareSemver, isUpdateAvailable, applianceUpdater, UpdaterState } from '../src/web/server/updater.mjs';

describe('Appliance Updater & Zero-Dependency SemVer Engine', () => {
  it('correctly parses semver strings', () => {
    const v1 = parseSemver('0.1.0');
    assert.strictEqual(v1.major, 0);
    assert.strictEqual(v1.minor, 1);
    assert.strictEqual(v1.patch, 0);
    assert.strictEqual(v1.prerelease, '');

    const v2 = parseSemver('v1.2.3-beta.1+arm64');
    assert.strictEqual(v2.major, 1);
    assert.strictEqual(v2.minor, 2);
    assert.strictEqual(v2.patch, 3);
    assert.strictEqual(v2.prerelease, 'beta.1');
  });

  it('correctly compares semantic versions', () => {
    assert.strictEqual(compareSemver('0.1.0', '0.0.1'), 1);
    assert.strictEqual(compareSemver('0.0.1', '0.1.0'), -1);
    assert.strictEqual(compareSemver('0.1.0', '0.1.0'), 0);
    assert.strictEqual(compareSemver('1.0.0', '0.9.9'), 1);
    assert.strictEqual(compareSemver('0.2.0', '0.1.9'), 1);
    assert.strictEqual(compareSemver('0.1.1', '0.1.0'), 1);
  });

  it('correctly identifies update availability', () => {
    assert.strictEqual(isUpdateAvailable('0.0.1', '0.1.0'), true);
    assert.strictEqual(isUpdateAvailable('0.1.0', '0.1.0'), false);
    assert.strictEqual(isUpdateAvailable('0.2.0', '0.1.0'), false);
  });

  it('loads canonical version.json manifest', () => {
    assert.ok(applianceUpdater.currentVersion);
    assert.strictEqual(typeof applianceUpdater.currentVersion, 'string');
    assert.ok(applianceUpdater.installedManifest);
    assert.strictEqual(applianceUpdater.installedManifest.name, 'mantaprint-hub');
    assert.ok(['prototype', 'stable', 'beta', 'edge'].includes(applianceUpdater.installedManifest.channel));
  });

  it('has deterministic FSM states', () => {
    assert.strictEqual(UpdaterState.IDLE, 'IDLE');
    assert.strictEqual(UpdaterState.CHECKING, 'CHECKING');
    assert.strictEqual(UpdaterState.UPDATE_AVAILABLE, 'UPDATE_AVAILABLE');
    assert.strictEqual(UpdaterState.PREFLIGHT, 'PREFLIGHT');
    assert.strictEqual(UpdaterState.BACKING_UP, 'BACKING_UP');
    assert.strictEqual(UpdaterState.DOWNLOADING, 'DOWNLOADING');
    assert.strictEqual(UpdaterState.INSTALLING, 'INSTALLING');
    assert.strictEqual(UpdaterState.RESTARTING, 'RESTARTING');
    assert.strictEqual(UpdaterState.VERIFYING, 'VERIFYING');
    assert.strictEqual(UpdaterState.COMPLETED, 'COMPLETED');
    assert.strictEqual(UpdaterState.ROLLING_BACK, 'ROLLING_BACK');
    assert.strictEqual(UpdaterState.FAILED, 'FAILED');
  });

  it('registers and unregisters SSE clients properly', () => {
    const mockRes = {
      writeHead: () => {},
      write: (data) => { mockRes.written.push(data); },
      on: () => {},
      written: []
    };
    applianceUpdater.addSseClient(mockRes);
    assert.strictEqual(applianceUpdater.sseClients.has(mockRes), true);
    assert.ok(mockRes.written.length > 0);

    applianceUpdater.appendLog('INFO', 'Test live log stream entry');
    assert.ok(mockRes.written.some(msg => msg.includes('Test live log stream entry')));

    applianceUpdater.removeSseClient(mockRes);
    assert.strictEqual(applianceUpdater.sseClients.has(mockRes), false);
  });
});
