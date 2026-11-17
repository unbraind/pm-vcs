import './helpers/isolate-session.ts';
/** Verify the package archive hook stages the exact metadata carried by the shared release commit. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testEnvironment } from './helpers/test-environment.ts';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

test('a release commit carries the archive generated from its staged metadata', () => {
  const script = manifest.scripts['release:changelog'];
  assert.ok(script);
  assert.match(workflow, /changelog-script: release:changelog/u);
  assert.match(workflow, /release-files: selfhost\.bundle/u);
  const root = mkdtempSync(join(tmpdir(), 'vcs-release-metadata-'));
  try {
    const env = testEnvironment({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    mkdirSync(join(root, '.agents/pm'), { recursive: true });
    const paths = ['package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md', 'index.ts', 'selfhost.bundle', '.agents/pm/README.md'];
    for (const path of paths) writeFileSync(join(root, path), 'old\n');
    execFileSync('git', ['add', '--', ...paths], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'Fixture baseline'], { cwd: root, env });
    const expected = execFileSync('git', ['hash-object', '--stdin'], { cwd: root, env, input: 'new calendar release\n', encoding: 'utf8' });
    writeFileSync(join(root, 'npm'), '#!/bin/bash\nset -euo pipefail\nif [[ "$*" == "run changelog:full" ]]; then printf "new calendar release\\n" > CHANGELOG.md; exit 0; fi\n[[ "$*" == "run self-host:write" ]]\ngit rev-parse :CHANGELOG.md > selfhost.bundle\n', { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { cwd: root, env: { ...env, PATH: `${root}:${env.PATH}` }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    // This is the generic shared commit boundary; writer integrity is exercised by accept:self-host.
    execFileSync('git', ['add', '--', 'selfhost.bundle'], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'Fixture shared release commit'], { cwd: root, env });
    assert.equal(execFileSync('git', ['show', 'HEAD:selfhost.bundle'], { cwd: root, env, encoding: 'utf8' }), expected);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, env, encoding: 'utf8' }), '');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('changelog currency follows the package version instead of the bootstrap date', () => {
  for (const name of ['changelog:full', 'release:notes']) {
    assert.match(manifest.scripts[name], /--date-from-version/u);
    assert.doesNotMatch(manifest.scripts[name], /--date \d{4}-\d{2}-\d{2}/u);
  }
});
