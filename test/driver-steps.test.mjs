import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecipes, familySteps, deviceSteps, presentHpFirmware, allPackageNames, requiredPackageName, HP_FIRMWARE } from '../src/web/server/driver-center.mjs';

const { recipes } = loadRecipes();
const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
const kinds = (steps) => steps.map((s) => `${s.kind}:${s.status}`);

describe('driver-steps: catalog families', () => {
  it('every family has a short name, models and a computable checklist', () => {
    for (const r of recipes) {
      assert.ok(r.name && r.name.length < 48, `${r.id} name`);
      assert.ok(Array.isArray(r.models), `${r.id} models`);
      const { steps, summary } = familySteps(r, {});
      assert.ok(steps.length >= 1, `${r.id} steps`);
      assert.ok(['ready', 'setup', 'unsupported'].includes(summary.state));
    }
  });

  it('HP MFP: packages -> plugin (blocked until hplip) -> connect -> verify', () => {
    const r = byId['hp-mfp-hplip-plugin'];
    let res = familySteps(r, { installed: new Set(), hplip: { hplip_installed: false } });
    assert.deepEqual(kinds(res.steps), ['packages:todo', 'plugin:blocked', 'connect:todo', 'verify:blocked']);
    assert.equal(res.steps[1].blocked_by, 'packages');
    assert.equal(res.summary.state, 'setup');
    assert.equal(res.summary.todo, 2);

    res = familySteps(r, { installed: new Set(r.apt), hplip: { hplip_installed: true, hplip_version: '3.22.10', required_file: 'hplip-3.22.10-plugin.run', plugin_installed: false } });
    assert.deepEqual(kinds(res.steps), ['packages:done', 'plugin:todo', 'connect:todo', 'verify:blocked']);
    assert.equal(res.steps[1].actions[0].type, 'upload');
    assert.equal(res.steps[1].actions[0].expect, 'hplip-plugin');
    assert.equal(res.steps[1].required_file, 'hplip-3.22.10-plugin.run');

    const dev = { type: 'scanner', name: 'HP LaserJet MFP M130a', readiness: 'needs_file', usb_id: '03f0:2a2a' };
    res = familySteps(r, { installed: new Set(r.apt), hplip: { hplip_installed: true, plugin_installed: true, plugin_matches: true }, devices: [dev] });
    assert.deepEqual(kinds(res.steps), ['packages:done', 'plugin:done', 'connect:done', 'verify:todo']);
    assert.equal(res.summary.state, 'ready');
    assert.ok(res.steps[3].actions.some((a) => a.type === 'open-scan'));
  });

  it('Canon UFR II LT: vendor .deb step is done once dpkg has the package', () => {
    const r = byId['canon-lbp6030-ufr2lt'];
    let res = familySteps(r, { installed: new Set() });
    const deb = res.steps.find((s) => s.kind === 'deb');
    assert.equal(deb.status, 'todo');
    assert.equal(deb.actions[0].type, 'upload');
    assert.equal(deb.actions[0].expect, 'deb');
    assert.equal(res.summary.state, 'setup');
    res = familySteps(r, { installed: new Set(['cnrdrvcups-ufr2lt-uk']) });
    assert.equal(res.steps.find((s) => s.kind === 'deb').status, 'done');
    assert.equal(res.summary.state, 'ready');
  });

  it('HP host-based LaserJet: firmware step lists missing files with getweb + upload actions', () => {
    const r = byId['hp-laserjet-hostbased-firmware'];
    let res = familySteps(r, { installed: new Set(r.apt), hpfw: new Set(['sihp1020.dl']) });
    const dl = res.steps.find((s) => s.kind === 'dl');
    assert.equal(dl.status, 'todo');
    assert.ok(dl.models.find((m) => m.filename === 'sihp1020.dl').present);
    assert.ok(dl.models.find((m) => m.filename === 'sihpP1005.dl').models.includes('P1007'), 'P1007 shares P1005 firmware');
    assert.deepEqual(dl.actions.map((a) => a.type), ['getweb', 'upload']);
    assert.ok(!dl.actions[0].models.includes('1020'));
    res = familySteps(r, { installed: new Set(r.apt), hpfw: new Set(Object.values(HP_FIRMWARE).map((f) => f.toLowerCase())) });
    assert.equal(res.steps.find((s) => s.kind === 'dl').status, 'done');
    assert.equal(res.summary.state, 'ready');
  });

  it('ScanSnap S-series: firmware step follows the connected scanner', () => {
    const r = byId['fujitsu-scansnap-epjitsu'];
    const nal = { devices: [{ model: 'ScanSnap S1300', filename: '1300_0C26.nal', usb_id: '04c5:11ed', installed: false, connected: true }, { model: 'ScanSnap S1100', filename: '1100_0A00.nal', usb_id: '04c5:1200', installed: true, connected: false }] };
    let res = familySteps(r, { installed: new Set(r.apt), nal });
    const step = res.steps.find((s) => s.kind === 'nal');
    assert.equal(step.status, 'todo');
    assert.equal(step.actions[0].target, '1300_0C26.nal');
    assert.equal(step.actions[0].endpoint, '/api/scanner/firmware');
    nal.devices[0].installed = true;
    res = familySteps(r, { installed: new Set(r.apt), nal });
    assert.equal(res.steps.find((s) => s.kind === 'nal').status, 'done');
  });

  it('unsupported and driverless families', () => {
    assert.deepEqual(kinds(familySteps(byId['fujitsu-sv600'], {}).steps), ['unsupported:info']);
    assert.equal(familySteps(byId['fujitsu-sv600'], {}).summary.state, 'unsupported');
    const g = familySteps(byId['canon-g3030'], { installed: new Set(['ipp-usb', 'sane-airscan']) });
    assert.deepEqual(kinds(g.steps), ['packages:done', 'connect:todo', 'verify:blocked']);
    assert.equal(g.summary.state, 'ready');
  });
});

describe('driver-steps: connected devices', () => {
  it('unsupported Canon queue: vendor .deb first, PPD as optional fallback, verify blocked', () => {
    const r = byId['canon-lbp6030-ufr2lt'];
    const dev = { type: 'printer', name: 'Canon LBP6030', queue: 'Canon_LBP6030', connected: true, readiness: 'unsupported', readiness_reason: 'no_driver_match' };
    const { steps, summary } = deviceSteps(dev, r, { installed: new Set() });
    assert.deepEqual(kinds(steps), ['deb:todo', 'ppd:optional', 'verify:blocked']);
    assert.equal(steps[1].queue, 'Canon_LBP6030');
    assert.equal(steps[1].actions[0].queue, 'Canon_LBP6030');
    assert.equal(summary.state, 'setup');
  });

  it('LaserJet 1020 waiting for firmware: send-now action plus upload, targeted at the queue', () => {
    const r = byId['hp-laserjet-hostbased-firmware'];
    const dev = { type: 'printer', name: 'HP LaserJet 1020', queue: 'HP_LaserJet_1020', connected: true, readiness: 'needs_firmware' };
    const { steps } = deviceSteps(dev, r, { installed: new Set(r.apt), hpfw: new Set() });
    const dl = steps.find((s) => s.kind === 'dl');
    assert.equal(dl.actions[0].type, 'provision');
    assert.equal(dl.actions[0].queue, 'HP_LaserJet_1020');
    assert.ok(dl.actions.some((a) => a.type === 'getweb'));
  });

  it('LaserJet 1020 card only talks about its own firmware file', () => {
    const r = byId['hp-laserjet-hostbased-firmware'];
    const dev = { type: 'printer', name: 'HP LaserJet 1020', model: 'LaserJet 1020', queue: 'HP_LaserJet_1020', connected: true, readiness: 'needs_firmware' };
    let { steps } = deviceSteps(dev, r, { installed: new Set(r.apt), hpfw: new Set(['sihpp1005.dl']) });
    let dl = steps.find((s) => s.kind === 'dl');
    assert.deepEqual(dl.models.map((m) => m.filename), ['sihp1020.dl']);
    assert.deepEqual(dl.actions.map((a) => a.type), ['provision', 'getweb', 'upload']);
    assert.deepEqual(dl.actions[1].models, ['1020']);
    // file already cached: nothing to fetch, just send it to the printer
    ({ steps } = deviceSteps(dev, r, { installed: new Set(r.apt), hpfw: new Set(['sihp1020.dl']) }));
    dl = steps.find((s) => s.kind === 'dl');
    assert.equal(dl.status, 'todo');
    assert.deepEqual(dl.actions.map((a) => a.type), ['provision']);
    // P1007 shares the P1005 file
    ({ steps } = deviceSteps({ type: 'printer', name: 'HP LaserJet P1007', queue: 'P1007', connected: true, readiness: 'ready' }, r, { installed: new Set(r.apt), hpfw: new Set(['sihpp1005.dl']) }));
    assert.equal(steps.find((s) => s.kind === 'dl').status, 'done');
    assert.deepEqual(steps.find((s) => s.kind === 'dl').models.map((m) => m.filename), ['sihpP1005.dl']);
  });

  it('ready Brother queue: only verify with a test page', () => {
    const r = byId['brother-brlaser'];
    const dev = { type: 'printer', name: 'Brother HL-L2320D', queue: 'Brother', connected: true, readiness: 'ready' };
    const { steps, summary } = deviceSteps(dev, r, { installed: new Set(r.apt) });
    assert.deepEqual(kinds(steps), ['packages:done', 'verify:todo']);
    assert.equal(steps[1].actions[0].type, 'test-print');
    assert.equal(summary.state, 'ready');
  });

  it('ScanSnap S1300 plugged in without firmware: the upload targets its own file', () => {
    const r = byId['fujitsu-scansnap-epjitsu'];
    const dev = { type: 'scanner', name: 'Fujitsu ScanSnap S1300', usb_id: '04c5:11ed', connected: true, readiness: 'needs_file' };
    const nal = { devices: [{ model: 'ScanSnap S1300', filename: '1300_0C26.nal', usb_id: '04c5:11ed', installed: false, connected: true }, { model: 'ScanSnap S1100', filename: '1100_0A00.nal', usb_id: '04c5:1200', installed: false, connected: false }] };
    const { steps } = deviceSteps(dev, r, { installed: new Set(r.apt), nal });
    const step = steps.find((s) => s.kind === 'nal');
    assert.equal(step.targets.length, 1);
    assert.equal(step.actions[0].target, '1300_0C26.nal');
  });

  it('unknown USB printer without a recipe gets a PPD step', () => {
    const { steps } = deviceSteps({ type: 'usb', name: 'Frobnicator 9000', connected: true, readiness: null }, null, {});
    assert.deepEqual(kinds(steps), ['ppd:todo']);
  });
});

describe('driver-steps: per-file rows', () => {
  it('plugin step lists the signature (optional) and the .run with their own state', () => {
    const r = byId['hp-mfp-hplip-plugin'];
    let step = familySteps(r, { installed: new Set(r.apt), hplip: { hplip_installed: true, hplip_version: '3.22.10', required_file: 'hplip-3.22.10-plugin.run', plugin_installed: false } }).steps.find((s) => s.kind === 'plugin');
    assert.deepEqual(step.files.map((f) => [f.id, f.name, f.done, Boolean(f.optional)]), [['asc', 'hplip-3.22.10-plugin.run.asc', false, true], ['run', 'hplip-3.22.10-plugin.run', false, false]]);
    step = familySteps(r, { installed: new Set(r.apt), hplip: { hplip_installed: true, required_file: 'hplip-3.22.10-plugin.run', plugin_installed: false, asc_pending: true } }).steps.find((s) => s.kind === 'plugin');
    assert.equal(step.files[0].done, true);
    step = familySteps(r, { installed: new Set(r.apt), hplip: { hplip_installed: true, required_file: 'hplip-3.22.10-plugin.run', plugin_installed: true, plugin_matches: true, signature_verified: true } }).steps.find((s) => s.kind === 'plugin');
    assert.deepEqual(step.files.map((f) => f.done), [true, true]);
  });
  it('firmware steps carry one row per file, narrowed on a device card', () => {
    const r = byId['hp-laserjet-hostbased-firmware'];
    const fam = familySteps(r, { installed: new Set(r.apt), hpfw: new Set(['sihp1020.dl']) }).steps.find((s) => s.kind === 'dl');
    assert.ok(fam.files.length > 3);
    assert.equal(fam.files.find((f) => f.name === 'sihp1020.dl').done, true);
    const dev = deviceSteps({ type: 'printer', name: 'HP LaserJet 1018', queue: 'Q', connected: true, readiness: 'needs_firmware' }, r, { installed: new Set(r.apt), hpfw: new Set() }).steps.find((s) => s.kind === 'dl');
    assert.deepEqual(dev.files.map((f) => [f.name, f.done]), [['sihp1018.dl', false]]);
    const s = byId['fujitsu-scansnap-epjitsu'];
    const nal = { devices: [{ model: 'ScanSnap S1300', filename: '1300_0C26.nal', usb_id: '04c5:11ed', installed: true, connected: true }, { model: 'ScanSnap S1100', filename: '1100_0A00.nal', usb_id: '04c5:1200', installed: false, connected: false }] };
    const ns = familySteps(s, { installed: new Set(s.apt), nal }).steps.find((x) => x.kind === 'nal');
    assert.deepEqual(ns.files.map((f) => [f.target, f.done, f.endpoint]), [['1300_0C26.nal', true, '/api/scanner/firmware'], ['1100_0A00.nal', false, '/api/scanner/firmware']]);
  });
});

describe('driver-steps: helpers', () => {
  it('requiredPackageName takes the first dpkg name', () => {
    assert.equal(requiredPackageName({ package: 'brscan4 / <model>lpr' }), 'brscan4');
    assert.equal(requiredPackageName({ package: 'cnrdrvcups-ufr2lt-uk' }), 'cnrdrvcups-ufr2lt-uk');
    assert.equal(requiredPackageName({}), null);
  });
  it('allPackageNames covers apt lists, requirements and the allowlist', () => {
    const names = allPackageNames(recipes);
    for (const n of ['hplip', 'cnrdrvcups-ufr2lt-uk', 'epsonscan2', 'brscan4', 'printer-driver-brlaser', 'nftables']) assert.ok(names.includes(n), n);
  });
  it('presentHpFirmware reports non-empty .dl files across directories', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-b-'));
    fs.writeFileSync(path.join(a, 'sihp1020.dl'), Buffer.alloc(10, 1));
    fs.writeFileSync(path.join(b, 'sihpP1005.dl'), Buffer.alloc(0));
    const set = presentHpFirmware([a, b, '/nonexistent']);
    assert.ok(set.has('sihp1020.dl'));
    assert.ok(!set.has('sihpp1005.dl'), 'empty file does not count');
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
  });
});
