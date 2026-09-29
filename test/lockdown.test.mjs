import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCidr, parseAdminIps, hashPin, verifyPin, validPin, buildRuleset, defaultConfig, loadConfig, saveConfig, DEFAULT_PIN, TABLE } from '../src/web/server/lockdown.mjs';

describe('lockdown: admin IPs', () => {
  it('normalizes hosts and CIDRs and rejects junk', () => {
    assert.equal(normalizeCidr('192.168.10.5'), '192.168.10.5');
    assert.equal(normalizeCidr('192.168.10.5/32'), '192.168.10.5');
    assert.equal(normalizeCidr(' 10.20.0.0/16 '), '10.20.0.0/16');
    assert.equal(normalizeCidr('10.20.0.0/33'), null);
    assert.equal(normalizeCidr('300.1.1.1'), null);
    assert.equal(normalizeCidr('admin-pc'), null);
    assert.equal(normalizeCidr('10.0.0.1; drop table'), null);
  });
  it('parses a comma/space separated list', () => {
    assert.deepEqual(parseAdminIps('10.1.1.5, 10.1.2.0/24 10.1.1.5'), { ips: ['10.1.1.5', '10.1.2.0/24'], bad: [] });
    assert.deepEqual(parseAdminIps(['10.1.1.5', 'nope']).bad, ['nope']);
    assert.deepEqual(parseAdminIps(''), { ips: [], bad: [] });
  });
});

describe('lockdown: PIN', () => {
  it('hashes with a salt and verifies in constant time', () => {
    const h = hashPin('1234');
    assert.ok(h.includes('$'));
    assert.equal(verifyPin('1234', h), true);
    assert.equal(verifyPin('1235', h), false);
    assert.equal(verifyPin('', h), false);
    assert.equal(verifyPin('1234', 'garbage'), false);
    assert.notEqual(hashPin('1234'), h, 'fresh salt each time');
  });
  it('accepts 4-8 digits only', () => {
    assert.equal(validPin('1234'), true);
    assert.equal(validPin('12345678'), true);
    assert.equal(validPin('123'), false);
    assert.equal(validPin('abcd'), false);
  });
  it('ships the documented default PIN', () => {
    const cfg = defaultConfig();
    assert.equal(DEFAULT_PIN, '1234');
    assert.equal(verifyPin('1234', cfg.pin_hash), true);
    assert.equal(cfg.pin_is_default, true);
    assert.equal(cfg.enabled, false);
  });
});

describe('lockdown: ruleset', () => {
  it('only opens IPP, mDNS and DHCP inbound when no admin IPs are set', () => {
    const r = buildRuleset({ admin_ips: [], ssh_from_admin: false });
    assert.ok(r.includes(`table inet ${TABLE} {`));
    assert.ok(r.includes('policy drop;'));
    assert.ok(r.includes('tcp dport 631 accept'));
    assert.ok(r.includes('udp dport 5353 accept'));
    assert.ok(!r.includes('tcp dport 80'), 'no admin web without admin IPs');
    assert.ok(!r.includes('tcp dport 22'));
    assert.ok(!r.includes('60000'), 'ipp-usb eSCL stays closed');
  });
  it('opens the admin web (and SSH only when asked) from the admin set', () => {
    const base = { admin_ips: ['10.1.1.5', '10.1.2.0/24'], ssh_from_admin: false };
    const r = buildRuleset(base);
    assert.ok(r.includes('ip saddr { 10.1.1.5, 10.1.2.0/24 } tcp dport 80 accept'));
    assert.ok(!r.includes('tcp dport 22'));
    assert.ok(buildRuleset({ ...base, ssh_from_admin: true }).includes('ip saddr { 10.1.1.5, 10.1.2.0/24 } tcp dport 22 accept'));
  });
  it('drops all other outbound traffic (updates, MantaPool) but keeps DHCP/DNS/NTP/mDNS', () => {
    const r = buildRuleset({ admin_ips: [] });
    const out = r.slice(r.indexOf('chain output'));
    assert.ok(out.includes('policy drop;'));
    for (const p of ['udp dport 53', 'udp dport 123', 'udp dport 5353', 'udp sport 68 udp dport 67']) assert.ok(out.includes(p), p);
    assert.ok(!out.includes('tcp dport 443'));
  });
  it('is deterministic and ignores invalid admin entries', () => {
    const a = buildRuleset({ admin_ips: ['10.0.0.1', 'bogus'] });
    assert.equal(a, buildRuleset({ admin_ips: ['10.0.0.1', 'bogus'] }));
    assert.ok(a.includes('{ 10.0.0.1 }'));
    assert.ok(!a.includes('bogus'));
  });
});

describe('lockdown: config file', () => {
  it('round-trips and falls back to defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-'));
    const p = path.join(dir, 'lockdown.json');
    assert.equal(loadConfig(p).enabled, false);
    const cfg = { ...defaultConfig(), enabled: true, admin_ips: ['10.0.0.9'] };
    saveConfig(cfg, p);
    assert.equal((fs.statSync(p).mode & 0o777), 0o600);
    assert.deepEqual(loadConfig(p).admin_ips, ['10.0.0.9']);
    assert.equal(loadConfig(p).enabled, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
