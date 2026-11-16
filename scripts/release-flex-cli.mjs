import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const assets = ['flex-ax-linux-x64', 'flex-ax-darwin-arm64', 'flex-ax-windows-x64.exe'];
const packagePath = 'apps/flex-cli/package.json';
const changelogPath = 'apps/flex-cli/CHANGELOG.md';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

export function releaseNotes(changelog, version) {
  const heading = `## ${version}`;
  const lines = changelog.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`Missing CHANGELOG entry for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!body) throw new Error(`Empty CHANGELOG entry for ${version}`);
  return `${heading}\n\n${body}\n`;
}

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Only stable SemVer releases are supported: ${version}`);
  }
  return `flex-cli@${version}`;
}

// A 404 means absent; authentication, rate-limit and network failures must fail closed.
function getRelease(tag) {
  try {
    return JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`]));
  } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
}

export function isPublished(release) {
  if (!release || release.draft) return false;
  if (release.prerelease || !assets.every(name => release.assets.some(asset => asset.name === name))) {
    throw new Error('Published release is incomplete or prerelease; investigate before retrying');
  }
  return true;
}

function verifyTag(tag, sha) {
  const refs = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (!refs) return false;
  const entries = refs.split('\n').map(line => line.split(/\s+/));
  const commit = (entries.find(([, ref]) => ref.endsWith('^{}')) ?? entries[0])[0];
  if (commit !== sha) throw new Error(`${tag} already points to another commit (${commit})`);
  return true;
}

export function main(mode) {
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  const tag = validateVersion(version);
  const sha = run('git', ['rev-parse', 'HEAD']);
  if (mode === 'plan') {
    const previous = JSON.parse(run('git', ['show', `HEAD^:${packagePath}`])).version;
    // Only the version-changing main commit is a release candidate. A later ordinary
    // commit must never silently become the source of an unreleased version.
    if (previous === version) return;
    const before = previous.split('.').map(Number);
    const after = version.split('.').map(Number);
    const difference = after.findIndex((part, index) => part !== before[index]);
    if (difference < 0 || after[difference] < before[difference]) throw new Error('Version must increase');
  } else if (mode !== 'publish') {
    throw new Error('Usage: node scripts/release-flex-cli.mjs plan|publish');
  }
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag) throw new Error('Tag/package version mismatch');
  const notes = releaseNotes(readFileSync(changelogPath, 'utf8'), version);
  const tagExists = verifyTag(tag, sha);
  const release = getRelease(tag);
  if (isPublished(release)) {
    if (!tagExists) throw new Error('Published release has no matching tag');
    console.log(`${tag} is already published; leaving assets unchanged`);
    return;
  }
  if (mode === 'plan') {
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nsha=${sha}\n`);
    return;
  }
  // All platform builds and smoke tests have passed before this command runs.
  for (const name of assets) {
    const asset = statSync(`dist/${name}`);
    if (!asset.isFile() || asset.size === 0) throw new Error(`Missing or empty asset: ${name}`);
  }
  if (!tagExists) {
    run('git', ['tag', tag, sha]);
    run('git', ['push', 'origin', `refs/tags/${tag}`]);
  }
  writeFileSync('release-notes.md', notes);
  if (!release) {
    run('gh', ['release', 'create', tag, '--verify-tag', '--draft', '--title', `flex-cli ${version}`, '--notes-file', 'release-notes.md']);
  }
  // Drafts can be repaired on retry. Published assets are never overwritten.
  run('gh', ['release', 'upload', tag, ...assets.map(name => `dist/${name}`), '--clobber']);
  run('gh', ['release', 'edit', tag, '--title', `flex-cli ${version}`, '--notes-file', 'release-notes.md', '--prerelease=false', '--draft=false']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
