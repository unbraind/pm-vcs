/** A manually disabled schedule is reactivated only after guarded code reaches main. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('main bootstrap verifies the release contract before enabling its schedule', () => {
  const source = readFileSync(new URL('../.github/workflows/release-gate-setup.yml', import.meta.url), 'utf8');
  assert.match(source, /^    branches: \[main\]$/mu);
  assert.match(source, /^    if: github.ref == 'refs\/heads\/main'$/mu);
  assert.match(source, /^      actions: write$/mu);
  assert.match(source, /persist-credentials: false/u);
  assert.match(source, /git\/ref\/heads\/main.*\$GITHUB_SHA/u);
  const verify = source.indexOf('run: node --test test/release-approval.test.ts');
  const enable = source.indexOf('gh api --method PUT "repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/enable"');
  assert.ok(verify >= 0 && enable > verify);
  assert.doesNotMatch(source, /npm publish|npm trust|gh variable set|secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
});
