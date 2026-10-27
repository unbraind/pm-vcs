/** Keep owner approval, fork exclusion and tokenless provenance in every release. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const repository = 'unbraind/pm-vcs';
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const executable = withoutComments(workflow);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Ignore comments and explicit token removal, while retaining every token assignment. */
function withoutComments(source: string): string {
  return source.split('\n').filter(line => !line.trimStart().startsWith('#') &&
    !/^\s*unset (?:NODE_AUTH_TOKEN|NPM_TOKEN)(?:\s+(?:NODE_AUTH_TOKEN|NPM_TOKEN))*\s*$/u.test(line)).join('\n');
}

/** Read a workflow or job permission map, including inline maps and write-all. */
function permissions(source: string, indent: string): string | undefined {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`${indent}permissions:`));
  if (start < 0) return undefined;
  const entries = [lines[start].slice(`${indent}permissions:`.length)];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (!line.startsWith(`${indent} `)) break;
    entries.push(line.trim());
  }
  return entries.join('\n');
}

/** Enumerate every job in the affected release and CI workflows, not a name allowlist. */
function jobs(source: string): { name: string; block: string }[] {
  const body = source.split(/^jobs:\s*$/mu)[1];
  assert.ok(body, 'the workflow must declare jobs');
  const starts = [...body.matchAll(/^  ([a-zA-Z_][\w-]*):[ \t]*$/gmu)];
  assert.ok(starts.length > 0, 'the workflow must contain inspectable jobs');
  return starts.map((match, index) => ({
    name: match[1],
    block: body.slice(match.index, starts[index + 1]?.index ?? body.length),
  }));
}

test('daily and manual release triggers remain available', () => {
  assert.match(executable, /^  schedule:\s*\n    - cron: ["']23 3 \* \* \*["']/mu);
  assert.match(executable, /^  workflow_dispatch:/mu);
});

test('every release preparation and publication job requires this repository and owner approval on main', () => {
  for (const name of ['prepare', 'release', 'resume_release']) {
    const block = jobs(executable).find(job => job.name === name)?.block;
    if (block === undefined) { assert.notEqual(name, 'release'); continue; }
    const condition = block.match(/^    if: (.+)$/mu)?.[1];
    assert.ok(condition, `${name} must gate the entire job`);
    const prefix = `github.repository == '${repository}' && `;
    assert.ok(condition.startsWith(prefix), `${name} must exclude forks at job level`);
    const rest = condition.slice(prefix.length);
    const gate = "vars.PM_RELEASE_APPROVED == 'true'";
    const main = "github.ref == 'refs/heads/main'";
    assert.ok(rest === `${gate} && ${main}` || rest === `${main} && ${gate}` ||
      rest === `${main} && ${gate} && needs.prepare.outputs.should_release == 'true'` ||
      rest === `${main} && ${gate} && needs.prepare.outputs.resume_release_notes == 'true'`,
    `${name} must require owner approval and main without an alternative condition`);
  }
});

test('every write-permission or publishing job in release and CI workflows excludes forks', () => {
  for (const file of ['release.yml', 'ci.yml']) {
    const source = withoutComments(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const inherited = permissions(source.split(/^jobs:\s*$/mu)[0], '') ?? '';
    assert.doesNotMatch(source, /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/u);
    for (const { name, block } of jobs(source)) {
      const effective = permissions(block, '    ') ?? inherited;
      const writable = /\bwrite-all\b|\b(?:contents|pull-requests|actions|id-token|packages)["']?\s*:\s*["']?write\b/u.test(effective);
      const publishes = /\b(?:npm|bun) publish\b|\bgh release create\b/u.test(block);
      if (!writable && !publishes) continue;
      const condition = block.match(/^    if: (.+)$/mu)?.[1] ?? '';
      assert.ok(condition.startsWith(`github.repository == '${repository}' && `), `${file}:${name} must exclude forks at job level`);
      assert.ok(!condition.includes('||'), `${file}:${name} must not bypass fork exclusion`);
      if (file === 'release.yml') {
        assert.ok(condition.includes("vars.PM_RELEASE_APPROVED == 'true'"), `${name} must require approval`);
        assert.ok(condition.includes("github.ref == 'refs/heads/main'"), `${name} must require main`);
      }
    }
  }
});

test('publishing uses a recent npm, OIDC permission and provenance without token environments', () => {
  assert.match(executable, /^\s+id-token: write$/mu);
  assert.match(executable, /npm install -g npm@11\.(?:[6-9]|[1-9]\d+)\.\d+/u);
  assert.doesNotMatch(executable, /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/u);
  const publishes = executable.split('\n').filter(line => /^\s*npm publish\s/u.test(line));
  assert.ok(publishes.length > 0);
  for (const line of publishes) {
    assert.match(line, /(?:^|\s)--provenance(?:\s|$)/u);
    assert.match(line, /(?:^|\s)--access public(?:\s|$)/u);
  }
});

test('release activation stays manual without an automatic setup workflow', () => {
  assert.equal(existsSync(new URL('../.github/workflows/release-gate-setup.yml', import.meta.url)), false);
});

test('the manifest remains public and names its catalog and public author', () => {
  assert.notEqual(manifest.private, true);
  for (const key of ['name', 'version', 'description', 'license', 'repository', 'bugs', 'engines']) assert.ok(manifest[key], key);
  assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true });
  assert.equal(manifest.homepage, `https://pm-cli.unbrained.dev/packages/${repository.split('/')[1]}`);
  assert.deepEqual(manifest.author, { name: 'unbrained', url: 'https://unbrained.dev/about' });
  assert.ok(manifest.files.length > 0);
  assert.ok(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').length > 0);
});
