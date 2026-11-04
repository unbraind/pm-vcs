import "./helpers/isolate-session.ts";
/** Audit every workflow's effective permissions, publication approval and npm authentication. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';

const repository = 'unbraind/pm-vcs';
const repositoryAtom = `github.repository == '${repository}'`;
const approvalAtom = "vars.PM_RELEASE_APPROVED == 'true'";
const mainAtom = "github.ref == 'refs/heads/main'";
const workflowRoot = new URL('../.github/workflows/', import.meta.url);

/** Narrow parsed YAML values without relying on an untyped workflow schema. */
function mapping(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Parse YAML mappings, resolving flow collections and aliases and rejecting malformed input. */
function document(source: string): Record<string, unknown> {
  const parsed = parseDocument(source, { uniqueKeys: true, strict: true, prettyErrors: false });
  assert.equal(parsed.errors.length, 0, 'invalid workflow YAML');
  const value: unknown = parsed.toJS({ maxAliasCount: 100 });
  const result = mapping(value);
  assert.ok(result, 'workflow must be a YAML mapping');
  return result;
}

/** Recognize writes in every permission scope, including future scopes and write-all. */
function writes(permissions: unknown): boolean {
  if (permissions === undefined || permissions === 'read-all') return false;
  if (permissions === 'write-all') return true;
  const scopes = mapping(permissions);
  assert.ok(scopes, 'permissions must be a literal mapping, read-all or write-all');
  assert.ok(Object.values(scopes).every(value => ['read', 'write', 'none'].includes(String(value))), 'invalid permission level');
  return Object.values(scopes).some(value => value === 'write');
}

/** Identify structural characters while preserving escaped single- and double-quoted literals. */
function structuralCharacters(source: string): { index: number; character: string }[] {
  const result: { index: number; character: string }[] = [];
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) index += 1;
        else quote = '';
      } else if (character === '\\' && quote === '"') index += 1;
    } else if (character === "'" || character === '"') quote = character;
    else result.push({ index, character });
  }
  return result;
}

/** Split only top-level logical operators, preserving quoted strings and nested expressions. */
function logicalParts(source: string, operator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (const { index, character } of structuralCharacters(source)) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0 && index >= start && source.startsWith(operator, index)) {
      result.push(source.slice(start, index).trim());
      start = index + operator.length;
    }
  }
  result.push(source.slice(start).trim());
  return result;
}

/** Remove expression wrappers only when they enclose the entire condition. */
function unwrap(source: string): string {
  let result = source.trim();
  if (result.startsWith('${{') && result.endsWith('}}')) result = result.slice(3, -2).trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    const encloses = structuralCharacters(result).every(({ index, character }) => {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      return depth > 0 || depth === 0 && index === result.length - 1;
    });
    if (!encloses || depth !== 0) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

/** Prove the exact positive comparison is necessary in every disjunct, not just mentioned. */
function requiresAtom(condition: string, atom: string): boolean {
  const source = unwrap(condition);
  const alternatives = logicalParts(source, '||');
  if (alternatives.length > 1) return alternatives.every(part => requiresAtom(part, atom));
  const conjunction = logicalParts(source, '&&');
  if (conjunction.length > 1) return conjunction.some(part => requiresAtom(part, atom));
  return source.replace(/\s*==\s*/gu, ' == ').trim() === atom;
}

/** Tokenize shell command boundaries without treating quoted log messages as commands. */
function shellWords(script: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  const flush = (): void => { if (word) words.push(word); word = ''; };
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (quote) {
      if (character === quote) quote = '';
      else if (character === '\\' && quote === '"' && index + 1 < script.length) word += script[++index];
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '\\' && index + 1 < script.length) {
      if (script[index + 1] === '\n') index += 1;
      else word += script[++index];
      continue;
    }
    if (character === '#' && !word) {
      while (index < script.length && script[index] !== '\n') index += 1;
      flush(); words.push(';'); continue;
    }
    if (';&|(){}\n'.includes(character)) { flush(); words.push(';'); continue; }
    if (/\s/u.test(character)) flush();
    else word += character;
  }
  flush();
  return words;
}

/** Find literal npm/Bun and GitHub publication commands, including shell control wrappers. */
function publications(script: string): { registry: boolean; args: string[] }[] {
  const words = shellWords(script);
  const result: { registry: boolean; args: string[] }[] = [];
  let command = true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === ';') { command = true; continue; }
    if (!command) continue;
    if (['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', 'command', 'exec', 'env'].includes(word) || /^[A-Za-z_]\w*=/u.test(word)) continue;
    const registry = (word === 'npm' || word === 'bun') && words[index + 1] === 'publish';
    const github = word === 'gh' && words[index + 1] === 'release' && words[index + 2] === 'create';
    if (registry || github) {
      let end = index + (registry ? 2 : 3);
      while (end < words.length && words[end] !== ';') end += 1;
      result.push({ registry, args: words.slice(index + (registry ? 2 : 3), end) });
    }
    command = false;
  }
  return result;
}

/** Detect npm token environments at all levels and token references in executable shell. */
function authenticationIssues(value: unknown, location: string): string[] {
  const issues: string[] = [];
  const object = mapping(value);
  if (Array.isArray(value)) return value.flatMap(entry => authenticationIssues(entry, location));
  if (!object) return issues;
  for (const [key, entry] of Object.entries(object)) {
    if (key === 'env') {
      const env = mapping(entry);
      if (!env) issues.push(`${location}: environment must be a literal mapping`);
      else if (Object.keys(env).some(name => ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_AUTH_TOKEN'].includes(name))) issues.push(`${location}: npm token environment`);
    }
    if (key === 'run' && typeof entry === 'string') {
      const executable = entry.split('\n').filter(line => !line.trimStart().startsWith('#') &&
        !/^\s*unset (?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)(?:\s+(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN))*\s*$/u.test(line)).join('\n');
      if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN)\b/u.test(executable)) issues.push(`${location}: npm token shell environment`);
    }
    if (typeof entry === 'string' && /secrets(?:\.(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN)|\[['"](?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN)['"]\])/u.test(entry)) issues.push(`${location}: npm token secret`);
    issues.push(...authenticationIssues(entry, location));
  }
  return issues;
}

/** Audit parsed jobs using job permissions as a complete override of workflow defaults. */
function inspectWorkflow(source: string, filename: string): string[] {
  let workflow: Record<string, unknown>;
  try { workflow = document(source); }
  catch { return [`${filename}: invalid YAML`]; }
  const issues = authenticationIssues(workflow, filename);
  const jobs = mapping(workflow.jobs);
  if (!jobs || Object.keys(jobs).length === 0) return [...issues, `${filename}: missing jobs`];
  for (const [name, raw] of Object.entries(jobs)) {
    const job = mapping(raw);
    if (!job) { issues.push(`${filename}:${name}: invalid job`); continue; }
    const location = `${filename}:${name}`;
    const effective = job.permissions === undefined ? workflow.permissions : job.permissions;
    let writable = false;
    try { writable = writes(effective); }
    catch { issues.push(`${location}: invalid permissions`); }
    const condition = typeof job.if === 'string' ? job.if : '';
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const commands = steps.flatMap(step => {
      const value = mapping(step)?.run;
      return typeof value === 'string' ? publications(value) : [];
    });
    const reusablePublisher = typeof job.uses === 'string' && /\/(?:release|publish)[^/]*\.ya?ml@/u.test(job.uses);
    const publishes = commands.length > 0 || reusablePublisher;
    if ((writable || publishes) && !requiresAtom(condition, repositoryAtom)) issues.push(`${location}: exact repository guard required`);
    if (condition.includes('github.repository_owner')) issues.push(`${location}: repository_owner is not a repository guard`);
    if (publishes && !requiresAtom(condition, approvalAtom)) issues.push(`${location}: publishing approval required`);
    if (publishes && !requiresAtom(condition, mainAtom)) issues.push(`${location}: publishing requires main`);
    for (const publication of commands.filter(command => command.registry)) {
      if (!publication.args.includes('--provenance') || publication.args.some(arg => arg === '--no-provenance' || arg.startsWith('--provenance='))) issues.push(`${location}: npm provenance required`);
      if (!(publication.args.includes('--access=public') || publication.args.some((arg, index) => arg === '--access' && publication.args[index + 1] === 'public'))) issues.push(`${location}: public npm access required`);
      if (!(effective === 'write-all' || mapping(effective)?.['id-token'] === 'write')) issues.push(`${location}: publishing requires OIDC permission`);
    }
  }
  return issues;
}

/** Discover all YAML workflows recursively, with no workflow-name or permission-scope allowlist. */
function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    if (!/\.ya?ml$/iu.test(entry.name)) return [];
    assert.ok(entry.isFile(), 'workflow YAML must be a regular file');
    return [path];
  }).sort();
}

/** Audit every discovered file; this also works in a plain directory without Git. */
function inspectDirectory(directory: string): string[] {
  return workflowFiles(directory).flatMap(path => inspectWorkflow(readFileSync(path, 'utf8'), relative(directory, path)));
}

/** Render small synthetic fixtures through the same YAML parser used for repository files. */
function fixture(job: Record<string, unknown>, permissions: unknown = { contents: 'read' }, name = 'audit'): string {
  return stringify({ name: 'Synthetic workflow', on: 'workflow_dispatch', permissions, jobs: { [name]: job } });
}

const guarded = `${repositoryAtom} && ${approvalAtom} && ${mainAtom}`;
const publisher = { if: guarded, permissions: { contents: 'read', 'id-token': 'write' }, steps: [{ run: 'npm publish --provenance --access public' }] };

test('all workflow files enforce exact-repository writes and approved tokenless publishing', () => {
  assert.deepEqual(inspectDirectory(fileURLToPath(workflowRoot)), []);
});

test('daily/manual release triggers and preparation gates remain enforced', () => {
  const release = document(readFileSync(new URL('release.yml', workflowRoot), 'utf8'));
  const events = mapping(release.on);
  assert.ok(events && Object.hasOwn(events, 'workflow_dispatch'));
  assert.deepEqual(events.schedule, [{ cron: '23 3 * * *' }]);
  const jobs = mapping(release.jobs);
  assert.ok(jobs?.release);
  for (const name of ['prepare', 'release', 'resume_release']) {
    const job = mapping(jobs[name]);
    if (!job) continue;
    assert.ok(typeof job.if === 'string');
    for (const atom of [repositoryAtom, approvalAtom, mainAtom]) assert.ok(requiresAtom(job.if, atom), `${name} must require ${atom}`);
  }
});

test('publishing installs an npm version supporting trusted publishing', () => {
  const release = document(readFileSync(new URL('release.yml', workflowRoot), 'utf8'));
  const scripts = Object.values(mapping(release.jobs) ?? {}).flatMap(job => {
    const steps = mapping(job)?.steps;
    return Array.isArray(steps) ? steps.map(step => mapping(step)?.run).filter(value => typeof value === 'string') : [];
  }).join('\n');
  const version = scripts.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  assert.ok(version && (version[0] > 11 || version[0] === 11 && (version[1] > 5 || version[1] === 5 && version[2] >= 1)));
});

test('automatic release activation is absent and publishing documentation matches behaviour', () => {
  assert.equal(existsSync(new URL('release-gate-setup.yml', workflowRoot)), false);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /local publishing is blocked|release workflow is dispatch-only/iu);
});

test('the manifest remains public and identifies its catalog and public author', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.notEqual(manifest.private, true);
  for (const key of ['name', 'version', 'description', 'license', 'repository', 'bugs', 'engines']) assert.ok(manifest[key], key);
  assert.deepEqual(manifest.publishConfig, { access: 'public', provenance: true });
  assert.equal(manifest.homepage, `https://pm-cli.unbrained.dev/packages/${repository.split('/')[1]}`);
  assert.deepEqual(manifest.author, { name: 'unbrained', url: 'https://unbrained.dev/about' });
  assert.ok(manifest.files.length > 0);
  assert.ok(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').length > 0);
});

const negativeFixtures: { name: string; source: string; issue: RegExp }[] = [
  { name: 'CodeQL analyze security-events write', source: fixture({ permissions: { 'security-events': 'write' }, steps: [] }, undefined, 'analyze'), issue: /exact repository guard/u },
  { name: 'Dependabot owner-only guard', source: fixture({ if: "github.repository_owner == 'unbraind' && github.actor == 'dependabot[bot]'", permissions: { 'pull-requests': 'write' } }, undefined, 'enable-auto-merge'), issue: /repository_owner/u },
  { name: 'another repository under the same owner', source: fixture({ if: "github.repository == 'unbraind/another-package'", permissions: { contents: 'write' } }), issue: /exact repository guard/u },
  { name: 'inherited workflow-level write', source: fixture({ steps: [] }, { 'security-events': 'write' }), issue: /exact repository guard/u },
  { name: 'write-granted reusable workflow call', source: fixture({ uses: 'example/shared/.github/workflows/sync.yml@revision', permissions: { contents: 'write' } }), issue: /exact repository guard/u },
  { name: 'inherited write on a reusable call', source: fixture({ uses: './.github/workflows/sync.yml' }, { actions: 'write' }), issue: /exact repository guard/u },
  { name: 'job-level write-all', source: fixture({ permissions: 'write-all' }), issue: /exact repository guard/u },
  { name: 'inherited write-all', source: fixture({ steps: [] }, 'write-all'), issue: /exact repository guard/u },
  { name: 'a future write permission scope', source: fixture({ permissions: { 'future-scope': 'write' } }), issue: /exact repository guard/u },
  { name: 'publishing without approval', source: fixture({ ...publisher, if: `${repositoryAtom} && ${mainAtom}` }), issue: /publishing approval/u },
  { name: 'publication without provenance', source: fixture({ ...publisher, steps: [{ run: 'npm publish --access public' }] }), issue: /npm provenance/u },
  { name: 'publication overriding provenance', source: fixture({ ...publisher, steps: [{ run: 'npm publish --provenance --provenance=false --access public' }] }), issue: /npm provenance/u },
  { name: 'workflow-level npm token environment', source: `${fixture({ steps: [] })}env: { NPM_TOKEN: synthetic }\n`, issue: /npm token environment/u },
  { name: 'job-level npm token environment', source: fixture({ env: { NODE_AUTH_TOKEN: 'synthetic' }, steps: [] }), issue: /npm token environment/u },
  { name: 'step-level npm token environment', source: fixture({ steps: [{ env: { NPM_TOKEN: 'synthetic' }, run: 'echo synthetic' }] }), issue: /npm token environment/u },
  { name: 'inline npm token assignment', source: fixture({ ...publisher, steps: [{ run: 'NPM_TOKEN=synthetic npm publish --provenance --access public' }] }), issue: /npm token shell/u },
  { name: 'OR bypass of the exact repository', source: fixture({ ...publisher, if: `${repositoryAtom} || ${approvalAtom} && ${mainAtom}` }), issue: /exact repository guard/u },
  { name: 'negated repository guard', source: fixture({ ...publisher, if: `!(${repositoryAtom}) && ${approvalAtom} && ${mainAtom}` }), issue: /exact repository guard/u },
  { name: 'YAML alias granting write', source: 'permissions: &rights { security-events: write }\njobs:\n  analyze:\n    permissions: *rights\n    steps: []\n', issue: /exact repository guard/u },
  { name: 'flow-style quoted scope', source: 'jobs: { analyze: { permissions: { "security-events": "write" }, steps: [] } }\n', issue: /exact repository guard/u },
  { name: 'malformed YAML', source: 'jobs: [\n', issue: /invalid YAML/u },
];

for (const entry of negativeFixtures) {
  test(`negative fixture rejects ${entry.name}`, () => {
    assert.match(inspectWorkflow(entry.source, 'synthetic.yml').join('\n'), entry.issue);
  });
}

test('guarded CodeQL, Dependabot and reusable callers preserve their independent conditions', () => {
  for (const job of [
    { if: repositoryAtom, permissions: { 'security-events': 'write' } },
    { if: `${repositoryAtom} && (github.actor == 'dependabot[bot]' || github.event_name == 'workflow_dispatch')`, permissions: { 'pull-requests': 'write' } },
    { if: repositoryAtom, permissions: 'write-all', uses: './.github/workflows/sync.yml' },
    publisher,
    { ...publisher, if: `\${{ (${repositoryAtom} && (${approvalAtom}) && ${mainAtom}) }}` },
  ]) assert.deepEqual(inspectWorkflow(fixture(job), 'synthetic.yml'), []);
});

test('job permissions replace inherited writes instead of merging with them', () => {
  for (const permissions of [{}, { contents: 'read' }, 'read-all']) {
    assert.deepEqual(inspectWorkflow(fixture({ permissions, steps: [] }, 'write-all'), 'synthetic.yml'), []);
  }
});

test('quoted log messages do not masquerade as publication commands', () => {
  assert.deepEqual(publications('echo "The trusted publisher must allow npm publish"\nprintf "gh release create"\n'), []);
  assert.equal(publications('echo ready && npm publish --provenance --access public\n').length, 1);
});

test('an unlisted workflow is discovered in a plain directory without Git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-contract-'));
  try {
    writeFileSync(join(directory, 'ci.yml'), fixture({ steps: [] }));
    writeFileSync(join(directory, 'release.yml'), fixture({ steps: [] }));
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'new-security.yaml'), fixture({ permissions: { 'security-events': 'write' } }, undefined, 'analyze'));
    assert.match(inspectDirectory(directory).join('\n'), /new-security\.yaml:analyze: exact repository guard/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
