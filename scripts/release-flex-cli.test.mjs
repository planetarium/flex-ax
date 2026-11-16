import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { assets, releaseNotes, validateVersion, isPublished } from './release-flex-cli.mjs';

const script = resolve('scripts/release-flex-cli.mjs');
const notes = '# flex-ax\n\n## 1.0.0\n\n### Major Changes\n\n- New format\n\n  **Breaking:** run login again.\n\n## 0.9.0\n\nOld notes\n';

test('release notes preserve migration guidance without including older versions', () => {
  assert.equal(releaseNotes(notes, '1.0.0'), '## 1.0.0\n\n### Major Changes\n\n- New format\n\n  **Breaking:** run login again.\n');
  assert.throws(() => releaseNotes(notes, '1.1.0'), /Missing/);
  assert.throws(() => releaseNotes('## 1.0.0\n\n## 0.9.0', '1.0.0'), /Empty/);
  assert.equal(validateVersion('1.0.0'), 'flex-cli@1.0.0');
  for (const invalid of ['1.0.0-beta.1', '01.0.0', '1.0', '1.0.0\nother']) assert.throws(() => validateVersion(invalid));
  assert.throws(() => isPublished({ draft: false, assets: [] }), /incomplete/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flex-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', join(dir, 'remote.git'));
  git('init');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('remote', 'add', 'origin', join(dir, 'remote.git'));
  mkdirSync(join(repo, 'apps/flex-cli'), { recursive: true });
  const pkg = version => writeFileSync(join(repo, 'apps/flex-cli/package.json'), JSON.stringify({ version }));
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture'); };
  pkg('0.9.0'); commit();
  pkg('1.0.0');
  writeFileSync(join(repo, 'apps/flex-cli/CHANGELOG.md'), notes);
  commit();
  mkdirSync(join(repo, 'dist'));
  for (const asset of assets) writeFileSync(join(repo, 'dist', asset), 'executable');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const state = join(dir, 'release.json');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
const file = process.env.STATE;
const release = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
if (args[0] === 'api') {
  if (process.env.API_FAIL) { console.error('gh: unavailable (HTTP 503)'); process.exit(1); }
  if (!release) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify(release));
} else if (args[1] === 'create') {
  fs.writeFileSync(file, JSON.stringify({ draft: true, assets: [] }));
} else if (args[1] === 'upload') {
  if (process.env.UPLOAD_FAIL) process.exit(1);
  release.assets = args.slice(3).filter(x => x !== '--clobber').map(x => ({ name: x.split('/').at(-1) }));
  fs.writeFileSync(file, JSON.stringify(release));
} else if (args[1] === 'edit') {
  release.draft = false;
  fs.writeFileSync(file, JSON.stringify(release));
} else process.exit(2);
`, { mode: 0o755 });
  const output = join(dir, 'output');
  const run = (mode, env = {}) => spawnSync(process.execPath, [script, mode], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state, CALLS: calls,
      GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'test/repo', RELEASE_TAG: '', ...env },
  });
  return { dir, repo, git, pkg, commit, run, state, calls, output };
}

function success(result) { assert.equal(result.status, 0, result.stderr); }

test('only version-changing commits schedule release of their exact SHA', t => {
  const f = fixture(t);
  success(f.run('plan'));
  assert.equal(readFileSync(f.output, 'utf8'), `tag=flex-cli@1.0.0\nsha=${f.git('rev-parse', 'HEAD')}\n`);
  rmSync(f.output);
  writeFileSync(join(f.repo, 'ordinary.txt'), 'ordinary change'); f.commit();
  success(f.run('plan'));
  assert.equal(existsSync(f.output), false);
});

test('draft upload failure can resume; published assets are never overwritten', t => {
  const f = fixture(t);
  assert.notEqual(f.run('publish', { UPLOAD_FAIL: '1' }).status, 0);
  assert.equal(JSON.parse(readFileSync(f.state)).draft, true);
  assert.match(f.git('ls-remote', 'origin', 'refs/tags/flex-cli@1.0.0'), new RegExp(f.git('rev-parse', 'HEAD')));
  success(f.run('publish'));
  assert.equal(JSON.parse(readFileSync(f.state)).draft, false);
  assert.equal(readFileSync(join(f.repo, 'release-notes.md'), 'utf8'), releaseNotes(notes, '1.0.0'));
  const callsBefore = readFileSync(f.calls, 'utf8').trim().split('\n').length;
  success(f.run('publish'));
  const newCalls = readFileSync(f.calls, 'utf8').trim().split('\n').slice(callsBefore).map(JSON.parse);
  assert.deepEqual(newCalls.map(call => call[0]), ['api']);
  success(f.run('plan'));
  assert.equal(existsSync(f.output), false);
});

test('conflicting tag, API outage, mismatched version and missing notes fail before publishing', t => {
  const f = fixture(t);
  assert.notEqual(f.run('plan', { API_FAIL: '1' }).status, 0);
  assert.equal(existsSync(f.output), false);
  assert.notEqual(f.run('publish', { RELEASE_TAG: 'flex-cli@2.0.0' }).status, 0);
  f.git('tag', 'flex-cli@1.0.0', 'HEAD^');
  f.git('push', 'origin', 'refs/tags/flex-cli@1.0.0');
  assert.match(f.run('publish').stderr, /another commit/);
  assert.equal(existsSync(f.state), false);
  writeFileSync(join(f.repo, 'apps/flex-cli/CHANGELOG.md'), '');
  assert.match(f.run('plan').stderr, /Missing CHANGELOG/);
});

test('downgrades and incomplete public releases fail closed', t => {
  const f = fixture(t);
  writeFileSync(f.state, JSON.stringify({ draft: false, assets: [] }));
  assert.match(f.run('publish').stderr, /incomplete/);
  f.pkg('0.8.0');
  assert.match(f.run('plan').stderr, /Version must increase/);
});
