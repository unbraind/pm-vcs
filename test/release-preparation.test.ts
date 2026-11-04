import "./helpers/isolate-session.ts";
/** Verify release metadata stays reproducible after the calendar version changes. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testEnvironment } from './helpers/test-environment.ts';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('a release commit carries the archive generated from its staged metadata', () => {
  const step = workflow.split('      - name: Commit release files\n')[1].split('      # Refuse non-main release runs')[0];
  const script = step.split('        run: |\n')[1].replace(/^          /gmu, '');
  const root = mkdtempSync(join(tmpdir(), 'vcs-release-metadata-'));
  try {
    const env = testEnvironment({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    for (const path of ['package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md', 'selfhost.bundle']) writeFileSync(join(root, path), 'old\n');
    execFileSync('git', ['add', 'package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md', 'selfhost.bundle'], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'Fixture baseline'], { cwd: root, env });
    writeFileSync(join(root, 'CHANGELOG.md'), 'new calendar release\n');
    const expected = execFileSync('git', ['hash-object', 'CHANGELOG.md'], { cwd: root, env, encoding: 'utf8' });
    // The fixture records the staged changelog; the real writer's integrity is covered by self-host tests.
    writeFileSync(join(root, 'npm'), '#!/bin/bash\nset -euo pipefail\n[[ "$*" == "run self-host:write" ]]\ngit rev-parse :CHANGELOG.md > selfhost.bundle\n', { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      script.replaceAll('${{ github.event.repository.name }}', 'fixture').replaceAll('${{ steps.decide.outputs.tag }}', 'v2026.10.26')],
    { cwd: root, env: { ...env, PATH: `${root}:${env.PATH}` }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(execFileSync('git', ['show', 'HEAD:selfhost.bundle'], { cwd: root, env, encoding: 'utf8' }), expected);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, env, encoding: 'utf8' }), '');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('changelog currency follows the package version instead of the bootstrap date', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['changelog:full', 'release:notes']) {
    assert.match(manifest.scripts[name], /--date-from-version/u);
    assert.doesNotMatch(manifest.scripts[name], /--date \d{4}-\d{2}-\d{2}/u);
  }
});
