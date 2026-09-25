import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readInstalledVersion, normalizeVersion, INSTALLED_VERSION } from '../src/web/server/version.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const frontendPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'frontend/package.json'), 'utf8'));

test('normalizeVersion strips a leading v and whitespace', () => {
  assert.equal(normalizeVersion(' v1.2.3 '), '1.2.3');
  assert.equal(normalizeVersion(undefined), '');
});

test('installed version resolves to version.json', () => {
  const info = readInstalledVersion();
  assert.equal(info.version, manifest.version);
  assert.equal(INSTALLED_VERSION, manifest.version);
  assert.equal(info.manifest.name, 'mantaprint-hub');
  assert.ok(info.source && info.source.endsWith('version.json'));
});

test('version.json, package.json, frontend/package.json and README agree', () => {
  assert.equal(pkg.version, manifest.version);
  assert.equal(frontendPkg.version, manifest.version);
  assert.equal(manifest.git.tag, `v${manifest.version}`);
  assert.equal(manifest.semantic.patch, Number(manifest.version.split('.')[2]));
  for (const k of ['core', 'web', 'frontend']) assert.equal(manifest.components[k], manifest.version);
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(readme.includes(`version-v${manifest.version}-blue`), 'README version badge is stale');
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## [${manifest.version}]`), 'CHANGELOG has no entry for the current version');
});
