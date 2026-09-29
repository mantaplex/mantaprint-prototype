import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRecipes, matchRecipes, publicRecipe, classifyUpload, parseSaneHwdb, searchDriverIndex, searchSaneHwdb,
  lookupModel, deviceNeeds, parseDebControl, readRegistry, addRecord, removeRecord, isAllowedPackage, installDl, normalize
} from '../src/web/server/driver-center.mjs';
import { parseModelsDat, findModelEntry, pluginNeed } from '../src/web/server/hplip-plugin.mjs';

const { recipes } = loadRecipes();

describe('driver-center: catalog', () => {
  it('ships a catalog with the families the docs promise', () => {
    assert.ok(recipes.length >= 15);
    for (const r of recipes) {
      assert.ok(['verified', 'available', 'needs_file', 'unsupported'].includes(r.status), `${r.id} status`);
      assert.ok(['printer', 'scanner', 'mfp'].includes(r.kind), `${r.id} kind`);
    }
  });

  it('matches by USB product id first, then vendor + model, then model only', () => {
    assert.equal(matchRecipes(recipes, { usb_vendor: '04a9', usb_product: '18da', model: 'G3030 series' })[0].id, 'canon-g3030');
    assert.equal(matchRecipes(recipes, { usb_vendor: '04c5', usb_product: '11ed', model: 'ScanSnap S1300' })[0].id, 'fujitsu-scansnap-epjitsu');
    assert.equal(matchRecipes(recipes, { usb_vendor: '03f0', model: 'HP LaserJet MFP M130a' })[0].id, 'hp-mfp-hplip-plugin');
    assert.equal(matchRecipes(recipes, { usb_vendor: '03f0', model: 'HP LaserJet 1020' })[0].id, 'hp-laserjet-hostbased-firmware');
    assert.equal(matchRecipes(recipes, { model: 'Canon LBP6030' })[0].id, 'canon-lbp6030-ufr2lt');
    assert.equal(matchRecipes(recipes, { model: 'Canon LBP2900' })[0].id, 'canon-capt');
    assert.equal(matchRecipes(recipes, { usb_vendor: '04b8', model: 'EPSON L3110 Series' })[0].id, 'epson-ecotank-escpr');
    assert.equal(matchRecipes(recipes, { usb_vendor: '04a9', model: 'Brother HL-L2320D' }).length, 0, 'vendor id must agree with the recipe');
    assert.equal(matchRecipes(recipes, { model: 'Brother HL-L2320D' })[0].id, 'brother-brlaser');
  });

  it('publicRecipe drops the compiled matchers', () => {
    const r = publicRecipe(recipes[0]);
    assert.ok(!('_modelRe' in r) && !('_products' in r) && r.id);
  });
});

describe('driver-center: upload classification', () => {
  it('recognises every supported kind by name', () => {
    assert.equal(classifyUpload('1300_0C26.nal'), 'nal');
    assert.equal(classifyUpload('hplip-3.22.10-plugin.run'), 'hplip-plugin');
    assert.equal(classifyUpload('hplip-3.22.10-plugin.run.asc'), 'asc');
    assert.equal(classifyUpload('Canon-LBP6030.ppd'), 'ppd');
    assert.equal(classifyUpload('brother.PPD.GZ'), 'ppd');
    assert.equal(classifyUpload('cnrdrvcups-ufr2lt-uk_5.10-1.00_arm64.deb'), 'deb');
    assert.equal(classifyUpload('sihp1020.dl'), 'dl');
    assert.equal(classifyUpload('setup.exe'), 'archive');
    assert.equal(classifyUpload('driver.tar.gz'), 'archive');
    assert.equal(classifyUpload('notes.txt'), 'unknown');
    assert.equal(classifyUpload('evil.run'), 'unknown');
  });
});

describe('driver-center: lookups', () => {
  const hwdb = parseSaneHwdb(`
# This file is part of SANE
# Canon CanoScan LiDE 100
usb:v04A9p1904*
 libsane_matched=yes

# Fujitsu ScanSnap S1300
usb:v04C5p11ED*
 libsane_matched=yes
`);
  const drivers = [
    { uri: 'drv:///brlaser.drv/br2320d.ppd', driver: 'brlaser', make_model: 'Brother HL-L2320D, using brlaser v6', mfg: 'Brother', mdl: 'HL-L2320D' },
    { uri: 'lsb/usr/hplip/HP/hp-laserjet_1020.ppd', driver: 'hplip', make_model: 'HP LaserJet 1020, hpcups 3.22.10', mfg: 'HP', mdl: 'LaserJet 1020' },
    { uri: 'gutenprint.5.3://escp2-l310/expert', driver: 'gutenprint', make_model: 'Epson L310 Series', mfg: 'Epson', mdl: 'L310 Series', aliases: ['L360', 'L380'] }
  ];

  it('parses the SANE hwdb into usb ids with names', () => {
    assert.deepEqual(hwdb, [{ usb_id: '04a9:1904', name: 'Canon CanoScan LiDE 100' }, { usb_id: '04c5:11ed', name: 'Fujitsu ScanSnap S1300' }]);
    assert.equal(searchSaneHwdb(hwdb, 'lide 100')[0].usb_id, '04a9:1904');
    assert.equal(searchSaneHwdb(hwdb, '04c5:11ed')[0].name, 'Fujitsu ScanSnap S1300');
  });

  it('searches the PPD index with exact/fuzzy confidence', () => {
    assert.equal(searchDriverIndex(drivers, 'Brother HL-L2320D')[0].confidence, 'exact');
    assert.equal(searchDriverIndex(drivers, 'HL-L2320D')[0].confidence, 'exact');
    assert.equal(searchDriverIndex(drivers, 'Epson L360')[0].confidence, 'exact', 'alias');
    assert.equal(searchDriverIndex(drivers, 'laserjet')[0]?.confidence, 'fuzzy');
    assert.equal(searchDriverIndex(drivers, 'xx').length, 0);
  });

  it('gives one verdict per query', () => {
    const models = parseModelsDat('[hp_laserjet_mfp_m130]\nplugin=0\nplugin-reason=64\nscan-type=5\n');
    const src = { drivers, hwdb, recipes, models, findModelEntry, pluginNeed };
    assert.equal(lookupModel('Brother HL-L2320D', src).verdict, 'supported');
    assert.equal(lookupModel('Canon G3030', src).verdict, 'supported');
    assert.equal(lookupModel('HP LaserJet MFP M130a', src).verdict, 'needs_file');
    assert.equal(lookupModel('ScanSnap SV600', src).verdict, 'unsupported');
    assert.equal(lookupModel('ScanSnap S1300', src).verdict, 'needs_file');
    assert.equal(lookupModel('Samsung ML-2160', src).verdict, 'likely');
    assert.equal(lookupModel('Frobnicator 9000', src).verdict, 'unknown');
    assert.equal(lookupModel('HP LaserJet MFP M130a', src).hp.plugin.needed, true);
  });
});

describe('driver-center: your devices', () => {
  it('folds printers, scanner hints and raw USB devices into one list with needs', () => {
    const devices = deviceNeeds({
      printers: [
        { queue_name: 'Canon_LBP6030', display_name: 'Canon LBP6030', model: 'LBP6030', vendor: 'Canon', connected: true, device_uri: 'usb://Canon/LBP6030?serial=ABC', readiness: 'unsupported', readiness_reason: 'no_driver_match' },
        { queue_name: 'HP_LaserJet_1020', display_name: 'LaserJet 1020', model: 'HP LaserJet 1020', vendor: 'HP', connected: true, device_uri: 'usb://HP/LaserJet%201020?serial=XYZ', readiness: 'needs_firmware', readiness_reason: 'firmware_downloading' },
        { queue_name: 'Brother', display_name: 'Brother HL-L2320D', model: 'HL-L2320D', vendor: 'Brother', connected: true, device_uri: 'usb://Brother/HL-L2320D?serial=B1', readiness: 'ready' }
      ],
      scanner: { connected: false },
      hp: { needs_plugin: [{ usb_id: '03f0:2a2a', model: 'HP LaserJet MFP M130a', serial: 'V1' }], required_file: 'hplip-3.22.10-plugin.run', download_url: 'https://developers.hp.com/x', hplip_installed: true },
      firmware: { needs_firmware: [{ usb_id: '04c5:11ed', model: 'Fujitsu ScanSnap S1300', filename: '1300_0C26.nal' }] },
      usb: [
        { dev: '1-1', mfg: 'Canon', prod: 'LBP6030', serial: 'ABC', idVendor: '04a9', idProduct: '26da' },
        { dev: '1-4', mfg: 'Fujitsu', prod: 'ScanSnap SV600', serial: '', idVendor: '04c5', idProduct: '128e' }
      ],
      recipes,
      installed: new Set()
    });
    const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
    assert.equal(byId['printer:Canon_LBP6030'].needs[0].kind, 'deb', 'unsupported Canon points at its vendor .deb');
    assert.equal(byId['printer:Canon_LBP6030'].usb_id, '04a9:26da');
    assert.equal(byId['printer:HP_LaserJet_1020'].needs[0].kind, 'dl');
    assert.deepEqual(byId['printer:Brother'].needs, []);
    assert.equal(byId['scanner:03f0:2a2a:V1'].needs[0].kind, 'hplip-plugin');
    assert.equal(byId['scanner:04c5:11ed'].needs[0].filename, '1300_0C26.nal');
    assert.equal(byId['usb:1-4'].readiness, 'unsupported');
    assert.ok(!byId['usb:1-1'], 'a USB device already represented by a queue is not listed twice');
  });

  it('drops a deb requirement once the package is installed', () => {
    const d = deviceNeeds({ printers: [{ queue_name: 'c', model: 'LBP6030', vendor: 'Canon', connected: true, device_uri: 'usb://x', readiness: 'unsupported' }], recipes, installed: new Set(['cnrdrvcups-ufr2lt-uk']) });
    assert.equal(d[0].needs[0].kind, 'ppd');
  });
});

describe('driver-center: deb control, registry, dl, allowlist', () => {
  it('parses dpkg-deb -f output including folded lines', () => {
    const c = parseDebControl('Package: cnrdrvcups-ufr2lt-uk\nVersion: 5.10-1.00\nArchitecture: arm64\nDescription: Canon UFRII LT Printer Driver for Linux\n Canon UFRII LT Printer Driver for Linux.\n');
    assert.equal(c.package, 'cnrdrvcups-ufr2lt-uk');
    assert.equal(c.architecture, 'arm64');
    assert.ok(c.description.startsWith('Canon UFRII LT'));
  });

  it('keeps a registry of installed extras', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reg-'));
    const p = path.join(dir, 'drivers.json');
    assert.deepEqual(readRegistry(p).items, []);
    const rec = addRecord({ kind: 'ppd', name: 'a.ppd', sha256: 'x' }, p);
    addRecord({ kind: 'ppd', name: 'a.ppd', sha256: 'y' }, p); // same kind+name replaces
    assert.equal(readRegistry(p).items.length, 1);
    assert.equal(readRegistry(p).items[0].sha256, 'y');
    assert.ok(rec.id && rec.installed_at);
    removeRecord(readRegistry(p).items[0].id, p);
    assert.deepEqual(readRegistry(p).items, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('installs HP firmware only under its expected name and size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dl-'));
    const src = path.join(dir, 'sihp1020.dl');
    fs.writeFileSync(src, Buffer.alloc(200 * 1024, 1));
    const dest = path.join(dir, 'fw');
    assert.equal(installDl(src, 'sihp1020.dl', { dirs: [dest] }).ok, true);
    assert.ok(fs.existsSync(path.join(dest, 'sihp1020.dl')));
    assert.equal(installDl(src, 'evil.dl', { dirs: [dest] }).code, 'bad_name');
    fs.writeFileSync(src, Buffer.alloc(10));
    assert.equal(installDl(src, 'sihp1020.dl', { dirs: [dest] }).code, 'invalid_size');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only allows the fixed apt package list', () => {
    assert.equal(isAllowedPackage('hplip'), true);
    assert.equal(isAllowedPackage('openssh-server'), false);
    assert.equal(isAllowedPackage('hplip; rm -rf /'), false);
    assert.equal(normalize('HP LaserJet 1020'), 'hplaserjet1020');
  });
});
