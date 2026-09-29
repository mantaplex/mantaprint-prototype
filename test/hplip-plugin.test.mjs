import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pluginVersionFromName, hplipBaseVersion, modelSectionName, parseModelsDat, findModelEntry,
  pluginNeed, parseHplipState, connectedHpDevices, installPluginFile
} from '../src/web/server/hplip-plugin.mjs';

const MODELS = `
# HPLIP models database (excerpt)
[hp_laserjet_mfp_m130]
plugin=0
plugin-reason=64
scan-type=5
usb-vid=0x3f0
tech-class=LJZjsMono

[hp_laserjet_1020]
plugin=1
plugin-reason=1
scan-type=0
fw-download=True

[hp_deskjet_2130_series]
plugin=0
plugin-reason=0
scan-type=6
`;

describe('hplip-plugin: names and versions', () => {
  it('reads the plugin version from the canonical file name only', () => {
    assert.equal(pluginVersionFromName('hplip-3.22.10-plugin.run'), '3.22.10');
    assert.equal(pluginVersionFromName('HPLIP-3.23.12-PLUGIN.RUN'), '3.23.12');
    assert.equal(pluginVersionFromName('hplip-3.22.10-plugin.run.asc'), null);
    assert.equal(pluginVersionFromName('hplip-3.22.10.run'), null);
    assert.equal(pluginVersionFromName('setup.exe'), null);
  });

  it('strips Debian packaging suffixes from the HPLIP version', () => {
    assert.equal(hplipBaseVersion('3.22.10+dfsg0-8.1+deb13u1'), '3.22.10');
    assert.equal(hplipBaseVersion('3.23.12+dfsg0-0ubuntu5'), '3.23.12');
    assert.equal(hplipBaseVersion(''), null);
  });
});

describe('hplip-plugin: models.dat lookup', () => {
  const models = parseModelsDat(MODELS);

  it('normalizes product strings the way HPLIP names sections', () => {
    assert.equal(modelSectionName('HP LaserJet MFP M130a'), 'hp_laserjet_mfp_m130a');
    assert.equal(modelSectionName('HP LaserJet Pro MFP M130fw'), 'hp_laserjet_pro_mfp_m130fw');
    assert.equal(modelSectionName('  HP DeskJet 2130 series '), 'hp_deskjet_2130_series');
  });

  it('parses sections and lower-cases keys', () => {
    assert.equal(models.hp_laserjet_1020.plugin, '1');
    assert.equal(models.hp_laserjet_mfp_m130['plugin-reason'], '64');
    assert.equal(Object.keys(models).length, 3);
  });

  it('matches a variant (M130a) to its series entry (m130) by longest prefix', () => {
    const e = findModelEntry(models, 'HP LaserJet MFP M130a');
    assert.equal(e.section, 'hp_laserjet_mfp_m130');
    assert.equal(findModelEntry(models, 'HP DeskJet 2130 series').section, 'hp_deskjet_2130_series');
    assert.equal(findModelEntry(models, 'HP OfficeJet 9999'), null);
    assert.equal(findModelEntry(models, ''), null);
  });

  it('decides plugin need from plugin= and the scan bit of plugin-reason', () => {
    assert.deepEqual(pluginNeed(findModelEntry(models, 'HP LaserJet MFP M130a')), { needed: true, reason: 'scan', scan_type: 5 });
    assert.equal(pluginNeed(findModelEntry(models, 'HP LaserJet 1020')).needed, true);
    assert.deepEqual(pluginNeed(findModelEntry(models, 'HP DeskJet 2130 series')), { needed: false, reason: 'not_needed', scan_type: 6 });
    assert.deepEqual(pluginNeed(null), { needed: null, reason: 'unknown_model' });
  });
});

describe('hplip-plugin: state file and sysfs', () => {
  it('parses hplip.state', () => {
    assert.deepEqual(parseHplipState('[plugin]\ninstalled = 1\neula = 1\nversion = 3.22.10\n'), { installed: true, eula: true, version: '3.22.10' });
    assert.deepEqual(parseHplipState(''), { installed: false, eula: false, version: null });
  });

  it('lists connected HP USB devices with their verdict from a fake sysfs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-sysfs-'));
    const mk = (name, files) => {
      fs.mkdirSync(path.join(root, name));
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(root, name, k), `${v}\n`);
    };
    mk('1-1', { idVendor: '03f0', idProduct: '2a2a', product: 'HP LaserJet MFP M130a', serial: 'VNB1234' });
    mk('1-2', { idVendor: '04a9', idProduct: '18da', product: 'G3030 series' });
    mk('1-1:1.0', { bInterfaceClass: '07' });
    const modelsPath = path.join(root, 'models.dat');
    fs.writeFileSync(modelsPath, MODELS);

    const devs = connectedHpDevices({ sysRoot: root, modelsPath });
    assert.equal(devs.length, 1);
    assert.equal(devs[0].usb_id, '03f0:2a2a');
    assert.equal(devs[0].model, 'HP LaserJet MFP M130a');
    assert.equal(devs[0].section, 'hp_laserjet_mfp_m130');
    assert.equal(devs[0].plugin.needed, true);

    // Without models.dat the hub says "unknown" rather than guessing.
    const unknown = connectedHpDevices({ sysRoot: root, modelsPath: path.join(root, 'missing.dat') });
    assert.equal(unknown[0].plugin.needed, null);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('hplip-plugin: install guard rails', () => {
  it('rejects files that are not a plugin before touching the system', async () => {
    const r = await installPluginFile({ filePath: '/nonexistent/x.bin', fileName: 'driver.zip' });
    assert.deepEqual(r, { ok: false, code: 'not_a_plugin' });
  });
});

describe('hplip-plugin: runWithTty', () => {
  it('answers nested yes/no prompts through a pseudo-terminal and streams the log', async () => {
    const { runWithTty, PROMPT_RE } = await import('../src/web/server/hplip-plugin.mjs');
    const py = 'import subprocess\nprint("Do you still want to install the plug-in? (y=yes, n=no*, q=quit) ? ", end="", flush=True)\na=input()\nprint("parent got", a)\nsubprocess.call(["python3", "-c", "print(\\"Do you accept the license terms for the plug-in (y=yes*, n=no, q=quit) ? \\", end=\\"\\", flush=True); b=input(); print(\\"child got\\", b)"])\n';
    const lines = [];
    const r = await runWithTty('python3', ['-c', py], { timeoutMs: 20000, onLine: (l) => lines.push(l) });
    assert.equal(r.code, 0);
    assert.equal(r.answers, 2);
    assert.ok(lines.some((l) => l.includes('parent got y')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('child got y')), lines.join('|'));
    assert.ok(!PROMPT_RE.test('Downloading plug-in: [\\\\      ] 10%'));
  });
  it('kills the installer and its children on timeout', async () => {
    const { runWithTty, descendants } = await import('../src/web/server/hplip-plugin.mjs');
    const t0 = Date.now();
    const r = await runWithTty('sh', ['-c', 'sleep 30 & sleep 30'], { timeoutMs: 1500, onLine: () => {} });
    assert.notEqual(r.code, 0);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(descendants(process.pid).filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('sleep'); } catch { return false; } }), []);
  });
});
