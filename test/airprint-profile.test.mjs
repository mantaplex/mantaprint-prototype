import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAirPrintProfile } from '../src/web/server/airprint-profile.mjs';

test('AirPrint profile points at the CUPS queue by IP', () => {
  const xml = buildAirPrintProfile({ ip: '192.0.2.10', queue: 'HP_LaserJet_P1102', name: 'HP <Office>', hostname: 'mantaprint' });
  assert.match(xml, /<key>PayloadType<\/key>\s*<string>com\.apple\.airprint<\/string>/);
  assert.match(xml, /<key>IPAddress<\/key>\s*<string>192\.168\.1\.114<\/string>/);
  assert.match(xml, /<key>ResourcePath<\/key>\s*<string>printers\/HP_LaserJet_P1102<\/string>/);
  assert.match(xml, /<key>Port<\/key>\s*<integer>631<\/integer>/);
  assert.ok(xml.includes('HP &lt;Office&gt;'), 'printer name is XML-escaped');
  assert.ok(!xml.includes('HP <Office>'));
});

test('AirPrint profile UUIDs are stable so reinstalling replaces the profile', () => {
  const a = buildAirPrintProfile({ ip: '10.0.0.2', queue: 'Q1', hostname: 'hub' });
  const b = buildAirPrintProfile({ ip: '10.0.0.3', queue: 'Q1', hostname: 'hub' });
  const uuids = (x) => [...x.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(uuids(a), uuids(b));
  assert.equal(new Set(uuids(a)).size, 2);
  for (const u of uuids(a)) assert.match(u, /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/);
});
