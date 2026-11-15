/** Execute every quick-tier detector against inert records and tracker programs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('quick routing excludes only inert tracker formats and gates executable tracker files', { skip: process.platform === 'win32' && 'The workflow detector runs in Ubuntu Bash' }, t => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 30000 });
  if ((bash.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.CI) {
    t.skip('bash is unavailable on PATH');
    return;
  }
  assert.equal(bash.error, undefined, 'bash is required in CI');
  assert.equal(bash.status, 0, bash.stderr);
  const document = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { uniqueKeys: true, strict: true });
  assert.deepEqual(document.errors, []);
  const jobs = Object.values(document.toJS().jobs) as { steps: { id?: string; run?: string }[] }[];
  const scripts = jobs.flatMap(job => job.steps.filter(step => step.id === 'changes').map(step => step.run!));
  assert.ok(scripts.length > 0);
  const root = mkdtempSync(join(tmpdir(), 'ci-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const script of scripts) for (const [path, code] of [
    ['.agents/pm/tasks/a.toon', false], ['.agents/pm/history/a.jsonl', false],
    ['.agents/pm/settings.json', false], ['README.md', false],
    ['.agents/pm/scripts/check.ts', true], ['.agents/pm/scripts/check.sh', true],
    ['.agents/pm/scripts/check.py', true], ['src/index.ts', true],
  ] as const) {
    const input = join(root, 'input'); const output = join(root, 'output');
    writeFileSync(input, path + '\0'); writeFileSync(output, '');
    const child = spawnSync('bash', ['--noprofile', '--norc', '-c', 'git() { cat "$CI_PATH_INPUT"; };\n' + script], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
        BASE_SHA: 'base', HEAD_SHA: 'head', RUNNER_TEMP: root, CI_PATH_INPUT: input, GITHUB_OUTPUT: output },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(output, 'utf8').trim(), `code=${code}`, path);
  }
});
