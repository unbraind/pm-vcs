import "./helpers/isolate-session.ts";
/** Preserve PR-time analysis for executable tracker files. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { testEnvironment } from './helpers/test-environment.ts';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

/** Apply the workflow's star patterns in order, including paths in dot directories. */
function selectedByPaths(path: string, patterns: readonly string[]): boolean {
  return patterns.reduce((selected, entry) => {
    const pattern = entry.replace(/^!/, '');
    assert.doesNotMatch(pattern, /[?+[\]{}()\\]/, 'unsupported workflow path pattern');
    const expression = pattern.split(/(\*\*\/|\*\*|\*)/).map(part => {
      if (part === '**/') return '(?:[^/]+/)*';
      if (part === '**') return '[\\s\\S]*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return new RegExp('^' + expression + '$').test(path) ? !entry.startsWith('!') : selected;
  }, false);
}

test('CodeQL filters inert data and re-includes every executable tracker extension', () => {
  const document = parseDocument(readFileSync('.github/workflows/codeql.yml', 'utf8'), { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  for (const event of ['push', 'pull_request']) {
    const patterns: string[] = workflow.on[event].paths;
    const trackerExclusion = '!.agents/pm/**';
    const trackerItem = '.agents/pm/tasks/a.toon';
    const assertTrackerExcluded = (paths: readonly string[]) => {
      assert.equal(selectedByPaths(trackerItem, paths), false, event + ': ' + trackerItem);
    };
    assert.ok(patterns.includes(trackerExclusion), event + ': tracker exclusion is required');
    assertTrackerExcluded(patterns);
    assert.throws(
      () => assertTrackerExcluded(patterns.filter(pattern => pattern !== trackerExclusion)),
      { code: 'ERR_ASSERTION' },
      event + ': removing the tracker exclusion must fail the contract',
    );
    for (const [path, expected] of [
      ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx'].flatMap(extension =>
        ['.agents/pm/check.', '.agents/pm/nested/check.', '.agents/pm/.nested/check.'].map(stem => [stem + extension, true] as const)),
      ['README.md', false], ['docs/example.json', false], ['package-lock.json', false],
      ['.agents/pm/history/a.jsonl', false], ['.agents/pm/settings.json', false], ['index.ts', true],
    ] as const) {
      assert.equal(selectedByPaths(path, patterns), expected, event + ': ' + path);
    }
  }
});


test('the engines floor shards the complete test inventory', () => {
  const workflow = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { strict: true, uniqueKeys: true }).toJS();
  const steps = workflow.jobs['quick-shard'].steps as {name:string;run?:string}[];
  assert.equal(steps.find(step=>step.name==='Run quick shard')?.run, 'node test/helpers/ci-shards.ts ${{ matrix.shard }}/8');
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
