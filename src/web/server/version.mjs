/**
 * MantaPrint Hub - Installed version resolver (single source of truth)
 *
 * The appliance version lives in version.json (deployed to /etc/mantaprint and
 * /opt/mantaprint, and checked into the repo root). Every component that shows
 * or compares a version (updater, config manager, status API, test page, TUI)
 * derives it from here instead of carrying its own hard-coded fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const VERSION_MANIFEST_PATHS = [
  path.resolve(process.cwd(), 'version.json'),
  '/opt/mantaprint/version.json',
  '/etc/mantaprint/version.json',
  path.join(REPO_ROOT, 'version.json')
];

export const PACKAGE_JSON_PATHS = [
  path.resolve(process.cwd(), 'package.json'),
  '/opt/mantaprint/package.json',
  path.join(REPO_ROOT, 'package.json')
];

export const UNKNOWN_VERSION = '0.0.0';

export function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function readJson(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

/**
 * Returns { version, manifest, source }. `manifest` is the parsed version.json
 * (or a minimal object built from package.json); `source` is the file used.
 */
export function readInstalledVersion() {
  for (const p of VERSION_MANIFEST_PATHS) {
    const data = readJson(p);
    if (data && data.version) {
      const version = normalizeVersion(data.version);
      return { version, manifest: { ...data, name: data.name || data.appliance || 'mantaprint-hub', version }, source: p };
    }
  }
  for (const p of PACKAGE_JSON_PATHS) {
    const pkg = readJson(p);
    if (pkg && pkg.version) {
      const version = normalizeVersion(pkg.version);
      return { version, manifest: { name: 'mantaprint-hub', version }, source: p };
    }
  }
  return { version: UNKNOWN_VERSION, manifest: { name: 'mantaprint-hub', version: UNKNOWN_VERSION }, source: null };
}

export const INSTALLED_VERSION = readInstalledVersion().version;
