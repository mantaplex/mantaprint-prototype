import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  parseEpjitsuConf,
  getConnectedUsbIds,
  getFirmwareStatus,
  validateNal,
  planInstall,
  extractNalFiles,
  processFirmwareUpload,
  getExtractionTools,
  NAL_MIN_BYTES
} from '../src/web/server/scanner-firmware.mjs';

const CONF = `# NOTE: the firmware line must occur BEFORE the usb line for your scanner

# Fujitsu fi-60F
firmware /usr/share/sane/epjitsu/60f_0A00.nal
usb 0x04c5 0x10c7

# Fujitsu S1300
firmware /usr/share/sane/epjitsu/1300_0C26.nal
usb 0x04c5 0x11ed

# Fujitsu S1300i
firmware /usr/share/sane/epjitsu/1300i_0D12.nal
usb 0x04c5 0x128d
#usb 0x04c5 0x9999

firmware ../relative/evil.nal
usb 0x04c5 0x0001
`;

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeNal(dir, name, size = NAL_MIN_BYTES) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(size));
  return p;
}

function fixture() {
  const root = tmpdir('mp-fw-');
  const confPath = path.join(root, 'epjitsu.conf');
  fs.writeFileSync(confPath, CONF);
  const sysRoot = path.join(root, 'sys');
  for (const [dev, vid, pid] of [['1-1', '04c5', '11ed'], ['1-2', '1d6b', '0002'], ['1-1:1.0', 'ffff', 'ffff']]) {
    fs.mkdirSync(path.join(sysRoot, dev), { recursive: true });
    fs.writeFileSync(path.join(sysRoot, dev, 'idVendor'), `${vid}\n`);
    fs.writeFileSync(path.join(sysRoot, dev, 'idProduct'), `${pid}\n`);
  }
  const firmwareDir = path.join(root, 'fw');
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  return { root, confPath, sysRoot, firmwareDir, src, work: fs.mkdtempSync(path.join(root, 'work-')) };
}

test('parseEpjitsuConf reads model, firmware and usb id; ignores commented and relative entries', () => {
  const devices = parseEpjitsuConf(CONF);
  assert.deepEqual(devices.map((d) => [d.model, d.filename, d.usb_id]), [
    ['Fujitsu fi-60F', '60f_0A00.nal', '04c5:10c7'],
    ['Fujitsu S1300', '1300_0C26.nal', '04c5:11ed'],
    ['Fujitsu S1300i', '1300i_0D12.nal', '04c5:128d']
  ]);
  assert.equal(devices[1].firmware_path, '/usr/share/sane/epjitsu/1300_0C26.nal');
});

test('getConnectedUsbIds reads sysfs devices only (not interfaces)', () => {
  const f = fixture();
  const ids = getConnectedUsbIds(f.sysRoot);
  assert.ok(ids.has('04c5:11ed'));
  assert.ok(ids.has('1d6b:0002'));
  assert.ok(!ids.has('ffff:ffff'));
});

test('status flags a connected S1300 without firmware, then clears once installed', () => {
  const f = fixture();
  let st = getFirmwareStatus({ confPath: f.confPath, sysRoot: f.sysRoot, firmwareDir: f.firmwareDir });
  assert.equal(st.conf_found, true);
  assert.deepEqual(st.needs_firmware.map((d) => d.filename), ['1300_0C26.nal']);
  assert.equal(st.devices.find((d) => d.filename === '60f_0A00.nal').connected, false);

  fs.mkdirSync(f.firmwareDir, { recursive: true });
  fakeNal(f.firmwareDir, '1300_0C26.nal', 1000); // truncated file does not count
  st = getFirmwareStatus({ confPath: f.confPath, sysRoot: f.sysRoot, firmwareDir: f.firmwareDir });
  assert.equal(st.needs_firmware.length, 1);

  fakeNal(f.firmwareDir, '1300_0C26.nal');
  st = getFirmwareStatus({ confPath: f.confPath, sysRoot: f.sysRoot, firmwareDir: f.firmwareDir });
  assert.equal(st.needs_firmware.length, 0);
  assert.equal(st.connected[0].installed, true);
});

test('validateNal enforces the size SANE load_fw needs', () => {
  const dir = tmpdir('mp-nal-');
  assert.equal(validateNal(fakeNal(dir, 'a.nal', NAL_MIN_BYTES - 1)).code, 'invalid_size');
  assert.equal(validateNal(fakeNal(dir, 'b.nal')).ok, true);
  assert.equal(validateNal(path.join(dir, 'missing.nal')).code, 'not_found');
});

test('planInstall: exact name, newer revision of the same model, explicit target', () => {
  const devices = parseEpjitsuConf(CONF);
  const f = (name) => ({ path: `/x/${name}`, name, size: NAL_MIN_BYTES });
  let plan = planInstall([f('1300_0C26.NAL'), f('1300i_0D12.nal')], devices);
  assert.deepEqual(plan.map((p) => [p.device.filename, p.source.name]), [['1300_0C26.nal', '1300_0C26.NAL'], ['1300i_0D12.nal', '1300i_0D12.nal']]);

  plan = planInstall([f('1300_0C20.nal'), f('1300_0C2A.nal')], devices);
  assert.deepEqual(plan.map((p) => [p.device.filename, p.source.name]), [['1300_0C26.nal', '1300_0C2A.nal']]);

  assert.equal(planInstall([f('firmware.nal')], devices).length, 0);
  plan = planInstall([f('firmware.nal')], devices, { target: '1300_0C26.nal' });
  assert.deepEqual(plan.map((p) => [p.device.filename, p.source.name]), [['1300_0C26.nal', 'firmware.nal']]);
});

test('direct .nal upload with an unrecognised name installs to the named target', async () => {
  const f = fixture();
  const upload = fakeNal(f.src, 'upload.bin');
  const common = { confPath: f.confPath, firmwareDir: f.firmwareDir, workDir: f.work };
  let res = await processFirmwareUpload({ ...common, filePath: upload, fileName: 'scanner.nal' });
  assert.equal(res.code, 'unknown_target');
  res = await processFirmwareUpload({ ...common, filePath: upload, fileName: 'scanner.nal', target: '1300_0C26.nal' });
  assert.equal(res.code, 'installed');
  const installed = path.join(f.firmwareDir, '1300_0C26.nal');
  assert.equal(fs.statSync(installed).mode & 0o777, 0o644);
  assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(upload));

  const small = fakeNal(f.src, 'small.bin', 4096);
  res = await processFirmwareUpload({ ...common, filePath: small, fileName: '1300_0C26.nal' });
  assert.equal(res.code, 'invalid_size');
});

const tools = getExtractionTools();
const haveZip = Boolean(tools.sevenZip) && fs.existsSync('/usr/bin/zip');
const haveGcab = Boolean(tools.sevenZip || tools.cabextract) && fs.existsSync('/usr/bin/gcab');

test('finds firmware inside a zip archive', { skip: !haveZip && 'zip/7z not installed' }, async () => {
  const f = fixture();
  fakeNal(f.src, '1300_0C26.nal');
  fakeNal(f.src, '300_0C00.nal');
  fs.writeFileSync(path.join(f.src, 'readme.txt'), 'hello');
  const archive = path.join(f.root, 'driver.zip');
  execFileSync('zip', ['-q', '-j', archive, path.join(f.src, '1300_0C26.nal'), path.join(f.src, '300_0C00.nal'), path.join(f.src, 'readme.txt')]);
  const res = await processFirmwareUpload({ filePath: archive, fileName: 'driver.zip', workDir: f.work, confPath: f.confPath, firmwareDir: f.firmwareDir });
  assert.equal(res.code, 'installed');
  assert.deepEqual(res.installed.map((i) => i.filename), ['1300_0C26.nal']);
});

test('finds firmware in a cab nested inside a zip (installer layout)', { skip: !(haveZip && haveGcab) && 'gcab/zip not installed' }, async () => {
  const f = fixture();
  fakeNal(f.src, '1300i_0D12.nal');
  const cab = path.join(f.root, 'Driver.cab');
  execFileSync('gcab', ['-c', '-n', cab, path.join(f.src, '1300i_0D12.nal')]);
  const outer = path.join(f.root, 'ScanSnapSetup.zip');
  execFileSync('zip', ['-q', '-j', outer, cab]);
  const res = await extractNalFiles(outer, f.work);
  assert.equal(res.code, 'ok');
  assert.deepEqual(res.nal.map((n) => n.name), ['1300i_0D12.nal']);
});

test('reports no_nal_found / extract_failed / too_large honestly', { skip: !haveZip && 'zip/7z not installed' }, async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.src, 'readme.txt'), 'nothing to see');
  const archive = path.join(f.root, 'empty.zip');
  execFileSync('zip', ['-q', '-j', archive, path.join(f.src, 'readme.txt')]);
  let res = await processFirmwareUpload({ filePath: archive, fileName: 'empty.zip', workDir: f.work, confPath: f.confPath, firmwareDir: f.firmwareDir });
  assert.equal(res.code, 'no_nal_found');

  const junk = path.join(f.root, 'junk.exe');
  fs.writeFileSync(junk, crypto.randomBytes(4096));
  res = await processFirmwareUpload({ filePath: junk, fileName: 'junk.exe', workDir: fs.mkdtempSync(path.join(f.root, 'w2-')), confPath: f.confPath, firmwareDir: f.firmwareDir });
  assert.equal(res.code, 'extract_failed');

  fakeNal(f.src, '1300_0C26.nal');
  const big = path.join(f.root, 'big.zip');
  execFileSync('zip', ['-q', '-j', big, path.join(f.src, '1300_0C26.nal')]);
  res = await extractNalFiles(big, fs.mkdtempSync(path.join(f.root, 'w3-')), { maxBytes: 1024 });
  assert.equal(res.code, 'too_large');
});
