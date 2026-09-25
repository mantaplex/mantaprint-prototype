
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ALLOWED_EXTRACT_DIRS = ['/opt/heykprint/drivers', '/usr/lib/cups/filter'];

function isPathWithinAllowedDirs(targetPath) {
  const resolved = path.resolve(targetPath);
  return ALLOWED_EXTRACT_DIRS.some(allowed => resolved === allowed || resolved.startsWith(allowed + path.sep));
}

export async function testDriverInstall({ archivePath, expectedSha, targetDir }) {
  // 1. SHA-256 Verification
  const fileBytes = fs.readFileSync(archivePath);
  const actualSha = crypto.createHash('sha256').update(fileBytes).digest('hex');
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`SHA-256 verification failed! Expected ${expectedSha}, got ${actualSha}`);
  }

  // 2. Destination check
  const resolvedTarget = path.resolve(targetDir);
  if (!isPathWithinAllowedDirs(resolvedTarget)) {
    throw new Error(`Target destination '${resolvedTarget}' is not in allowed directories: ${ALLOWED_EXTRACT_DIRS.join(', ')}`);
  }

  // 3. Pre-scan archive members for Zip-Slip
  const { stdout } = await execFileAsync('tar', ['-tf', archivePath]);
  const entries = stdout.split('\n').map(s => s.trim()).filter(Boolean);

  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\0')) {
      throw new Error(`Zip-Slip / Path Traversal blocked: absolute or null path detected: '${entry}'`);
    }
    const segments = entry.replace(/\/g, '/').split('/');
    if (segments.includes('..')) {
      throw new Error(`Zip-Slip / Path Traversal blocked: parent traversal segment '..' in entry: '${entry}'`);
    }
    const resolvedEntry = path.resolve(resolvedTarget, entry);
    if (!resolvedEntry.startsWith(resolvedTarget + path.sep) && resolvedEntry !== resolvedTarget) {
      throw new Error(`Zip-Slip / Path Traversal blocked: entry '${entry}' escapes destination '${resolvedTarget}'`);
    }
    if (!isPathWithinAllowedDirs(resolvedEntry)) {
      throw new Error(`Zip-Slip / Path Traversal blocked: entry '${entry}' resolves outside allowed system roots`);
    }
  }

  return { success: true, verifiedEntries: entries.length };
}
