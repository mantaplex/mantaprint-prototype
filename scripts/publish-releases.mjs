#!/usr/bin/env node
// ==============================================================================
// MantaPrint Prototype - Automated GitHub Releases Synchronizer
// Synchronizes releases from CHANGELOG.md and git tags to GitHub Releases API
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const REPO = process.env.GITHUB_REPOSITORY || 'mantaplex/mantaprint-prototype';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// Optional custom titles. Tags not listed here get "MantaPrint Prototype <tag>".
const RELEASE_TITLES = {
  'v0.3.0': 'MantaPrint Prototype v0.3.0 - Prototype Disclosure, New Repository & Installer Risk Acknowledgement'
};

// Every release of this repository is a prototype build. This notice leads every release body.
const PROTOTYPE_NOTICE = [
  '> [!WARNING]',
  '> **PROTOTYPE - NOT FOR PRODUCTION.** MantaPrint is an experimental prototype. It has known security',
  `> weaknesses (see [SECURITY.md](https://github.com/${REPO}/blob/main/SECURITY.md) and`,
  `> [docs/KNOWN-LIMITATIONS.md](https://github.com/${REPO}/blob/main/docs/KNOWN-LIMITATIONS.md)). Do not use it with personal or`,
  '> sensitive data, in regulated environments, or on networks reachable from the internet.',
  '> Provided "AS IS", without warranty of any kind (MIT License).'
].join('\n');

function parseChangelog() {
  const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
  const content = fs.readFileSync(changelogPath, 'utf8');
  const sections = {};
  
  const versionRegex = /^##\s+\[v?([0-9a-zA-Z.-]+)\](?:\s+-\s+([0-9-]+))?/gm;
  const matches = [];
  let match;
  while ((match = versionRegex.exec(content)) !== null) {
    matches.push({
      version: match[1],
      date: match[2] || '',
      index: match.index,
      headerEnd: versionRegex.lastIndex
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (cur.version.toLowerCase() === 'unreleased') continue;
    
    const nextStart = (i + 1 < matches.length) ? matches[i + 1].index : content.indexOf('\n[v');
    const rawSection = (nextStart !== -1)
      ? content.slice(cur.headerEnd, nextStart)
      : content.slice(cur.headerEnd);

    const body = rawSection.trim().replace(/^---\s*$/gm, '').trim();
    const tag = `v${cur.version.replace(/^v/, '')}`;
    sections[tag] = {
      tag,
      version: cur.version,
      date: cur.date,
      body
    };
  }

  return sections;
}

function currentVersionTag() {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'version.json'), 'utf8'));
    return version ? `v${String(version).replace(/^v/, '')}` : null;
  } catch (err) {
    console.error('[ERROR] Could not read version.json:', err.message);
    return null;
  }
}

function listGitTags() {
  try {
    const out = execSync('git tag --list "v*" --sort=v:refname', { cwd: ROOT_DIR, encoding: 'utf8' });
    return out.split('\n').map(t => t.trim()).filter(Boolean);
  } catch (err) {
    console.error('[ERROR] Could not list git tags:', err.message);
    return [];
  }
}

async function getExistingReleases() {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'MantaPrint-Release-Sync'
  };
  if (TOKEN) {
    headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[WARN] Failed to fetch existing releases (HTTP ${res.status}): ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data.map(r => r.tag_name) : [];
  } catch (err) {
    console.error(`[ERROR] Network error fetching releases:`, err);
    return [];
  }
}

async function createRelease(releasePayload) {
  const url = `https://api.github.com/repos/${REPO}/releases`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'MantaPrint-Release-Sync',
    'Authorization': `Bearer ${TOKEN}`
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(releasePayload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  console.log(`======================================================================`);
  console.log(`  MANTAPRINT PROTOTYPE - GITHUB RELEASES SYNCHRONIZER`);
  console.log(`  Target Repository: ${REPO}`);
  console.log(`======================================================================\n`);

  const changelogReleases = parseChangelog();
  console.log(`[+] Found ${Object.keys(changelogReleases).length} documented versions in CHANGELOG.md`);

  const existingReleases = await getExistingReleases();
  console.log(`[+] Currently published GitHub Releases (${existingReleases.length}):`, existingReleases.join(', ') || 'None');

  // Release every version that has both a pushed git tag and a CHANGELOG section, oldest first.
  const tags = listGitTags();
  const releaseOrder = tags.filter(tag => changelogReleases[tag]);

  // Auto-tagging: on a push to main, the version in version.json is released even when its tag has
  // not been pushed. Creating the release with target_commitish makes GitHub create the tag on
  // that commit, so a new version only needs a version bump + CHANGELOG section on main.
  const autoTag = currentVersionTag();
  const onMain = process.env.GITHUB_REF === 'refs/heads/main' && Boolean(process.env.GITHUB_SHA);
  const autoTargets = {};
  if (autoTag && !tags.includes(autoTag)) {
    if (!onMain) {
      console.log(`[i] ${autoTag} (version.json) has no tag yet; it is created automatically on the next push to main.`);
    } else if (!changelogReleases[autoTag]) {
      console.warn(`[WARN] ${autoTag} (version.json) has no CHANGELOG.md section; not creating the tag or release.`);
    } else {
      releaseOrder.push(autoTag);
      autoTargets[autoTag] = process.env.GITHUB_SHA;
      console.log(`[+] ${autoTag} will be tagged on ${process.env.GITHUB_SHA} and released.`);
    }
  }
  const latestTag = releaseOrder[releaseOrder.length - 1];

  const pendingReleases = releaseOrder.filter(tag => !existingReleases.includes(tag));
  console.log(`[!] Missing GitHub Releases to create (${pendingReleases.length}):\n    ${pendingReleases.join(', ')}\n`);

  if (!TOKEN) {
    console.warn(`[!] No GH_TOKEN or GITHUB_TOKEN environment variable found.`);
    console.log(`[i] Script generated release payload preview successfully.`);
    console.log(`[i] Run this via GitHub Actions or provide GITHUB_TOKEN=ghp_... to publish.`);
    process.exit(0);
  }

  let createdCount = 0;
  for (const tag of pendingReleases) {
    const info = changelogReleases[tag] || {
      tag,
      version: tag.replace(/^v/, ''),
      date: new Date().toISOString().split('T')[0],
      body: `Release ${tag}`
    };

    const title = RELEASE_TITLES[tag] || `MantaPrint Prototype ${tag}`;
    // Prototype builds are always published as pre-releases.
    const isPrerelease = true;
    // GitHub never marks a pre-release as "Latest"; the newest tag is still logged for clarity.
    const isNewest = tag === latestTag;

    let body = info.body.trim();
    if (!body) {
      body = `### ${title}\n\nAutomated release build for **${tag}**.`;
    }
    body = `${PROTOTYPE_NOTICE}\n\n${body}`;

    const payload = {
      tag_name: tag,
      ...(autoTargets[tag] ? { target_commitish: autoTargets[tag] } : {}),
      name: title,
      body: body,
      draft: false,
      prerelease: isPrerelease,
      make_latest: 'false'
    };

    console.log(`[-->] Publishing ${tag} - "${title}" (Newest: ${isNewest}, Prerelease: ${isPrerelease})...`);

    try {
      const created = await createRelease(payload);
      console.log(`      [SUCCESS] Created: ${created.html_url}`);
      createdCount++;
      // Polite sleep to stay well within GitHub API secondary rate limits
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`      [FAILED] Could not create release for ${tag}: ${err.message}`);
    }
  }

  console.log(`\n======================================================================`);
  console.log(`  Synchronizer Finished: ${createdCount} of ${pendingReleases.length} releases published.`);
  console.log(`======================================================================`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
