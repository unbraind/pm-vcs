import "./helpers/isolate-session.ts";
/** Preserve PR-time analysis for executable tracker files. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { testEnvironment } from './helpers/test-environment.ts';
import { join, matchesGlob } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('CodeQL filters inert data and re-includes every executable tracker extension', () => {
  const document = parseDocument(readFileSync('.github/workflows/codeql.yml', 'utf8'), { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  for (const event of ['push', 'pull_request']) {
    const patterns: string[] = workflow.on[event].paths;
    for (const [path, expected] of [
      ...['js', 'mjs', 'cjs', 'ts'].flatMap(extension => [`.agents/pm/check.${extension}`, `.agents/pm/nested/check.${extension}`].map(path => [path, true] as const)),
      ['README.md', false], ['docs/example.json', false], ['package-lock.json', false],
      ['.agents/pm/tasks/a.toon', false], ['.agents/pm/history/a.jsonl', false], ['.agents/pm/settings.json', false], ['index.ts', true],
    ] as const) {
      assert.equal(patterns.reduce((selected, pattern) => matchesGlob(path, pattern.replace(/^!/, '')) ? !pattern.startsWith('!') : selected, false), expected, path);
    }
  }
});


test('the engines floor uses the same complete batched suite as coverage', () => {
  const workflow = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { strict: true, uniqueKeys: true }).toJS();
  const step = workflow.jobs.test.steps.find((step: { name: string }) => step.name === 'Engines floor build and quick tests');
  assert.deepEqual(step.run.trim().split('\n'), ['npm run build', 'npm run build:test', 'node test/helpers/release-suite.ts']);
  assert.match(readFileSync('test/helpers/release-suite.ts', 'utf8'), /every test file must run exactly once/);
});


test('a failing ordinary file cannot suppress the serial test batch', t => {
  const root = mkdtempSync(join(tmpdir(), 'ci-batches-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'test/helpers'), {recursive: true});
  for (const name of ['release-suite.ts', 'test-environment.ts']) cpSync(join('test/helpers', name), join(root, 'test/helpers', name));
  writeFileSync(join(root, 'test/ordinary.test.ts'), "import test from 'node:test'; test('ordinary refusal', () => { throw new Error('expected refusal'); });");
  writeFileSync(join(root, 'test/exact-gates.test.ts'), "import test from 'node:test'; import {writeFileSync} from 'node:fs'; test('serial still runs', () => writeFileSync('serial-marker', 'ran'));");
  const result = spawnSync(process.execPath, ['test/helpers/release-suite.ts'], {cwd: root, env: testEnvironment(), encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readFileSync(join(root, 'serial-marker'), 'utf8'), 'ran');
});
