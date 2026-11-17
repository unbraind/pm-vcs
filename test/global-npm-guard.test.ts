import "./helpers/isolate-session.ts";
/** Positive and negative fixtures for the workflow-wide shared-npm guard. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globalNpmInstalls, workflowGlobalNpmInstalls } from './global-npm-guard.ts';

const rejected = [
  // Round AN: quoted hashes must not split a continued global install.
  'npm install --cache "$RUNNER_TEMP/npm #cache" \\\n  -g npm@11.19.0',
  "npm install --cache '$RUNNER_TEMP/a #b' \\\n  -g npm",
  'npm install npm@11 --cache "$RUNNER_TEMP/cache #1" \\\n  -g',
  'npm --user-agent "ci # bootstrap" install \\\n  -g npm@11.21.0',
  // Round AM: punctuation, comment boundaries, operandless installs and persistent setters.
  "npm install npm@11.19.0 -g;",
  "npm install>/dev/null -g npm",
  "npm \"install\" '-g' npm",
  "npm install --prefix \"$RUNNER_TEMP/npm-local\" npm@11.19.0 # bootstrap \\\nnpm install -g npm@11.19.0",
  "npm install --prefix \"$RUNNER_TEMP/npm-11.19.0\" npm@11.19.0 # bootstrap \\\nnpm install -g npm",
  "npm install -g npm --prefix \"$RUNNER_TEMP/npm-local\" # approved bootstrap",
  "npm update -g",
  "npm up -g",
  "npm install -g",
  "npm i -g --no-audit",
  "npm install>bootstrap.log -g npm@11.21.0",
  "npm install npm -g; echo done",
  "npm install npm -g>/dev/null",
  "npm install npm@11.19.0 -g; echo ready",
  "npm install npm@11.19.0 -g>install.log",
  "npm config set global=true",
  "npm config set global true",
  "npm set location global",
  "npm c set location=global",
  'npm install -g npm "--prefix $RUNNER_TEMP/npm-local"',
  'npm install -g npm "npm_config_prefix=$RUNNER_TEMP/npm-local"',
  // Round AH: run-wide signals, install families, redirects and effective prefixes.
  'export NPM_CONFIG_GLOBAL=true; npm install npm@11.21.0',
  'declare -x npm_config_location=global; npm install npm@11.21.0',
  'npm install npm@11.21.0; env NPM_CONFIG_GLOBAL=true echo ready',
  'NPM_CONFIG_LOCATION=$LOCATION; npm install npm@11.21.0',
  'NPM_CONFIG_LOCATION=$(printf global); npm install npm@11.21.0',
  'NPM_CONFIG_GLOBAL="${{ inputs.global }}"; npm install npm@11.21.0',
  'npm install-test -g npm',
  'npm it -g npm',
  'npm install-ci-test -g npm',
  'npm cit -g npm',
  'npm ci -g npm',
  'npm install -L global npm',
  'npm install -L=global npm',
  'npm install -fg npm@11.21.0',
  'npm install -g 2>&1 npm@11.21.0',
  ...['>&2', '&>output', '&>>output', '<&0'].map(redirect => `npm install -g ${redirect} npm@11.21.0`),
  'npm install -g npm # --prefix "$RUNNER_TEMP/npm-local"',
  'npm install -g npm # npm_config_prefix="$RUNNER_TEMP/npm-local"',
  'npm install --prefix "$RUNNER_TEMP/bootstrap" npm@11.21.0 && npm install -g npm@11.21.0',
  'npm install --prefix "$RUNNER_TEMP/bootstrap" npm@11.21.0 && npm install npm@11.21.0; export NPM_CONFIG_GLOBAL=true',
  'echo --prefix "$RUNNER_TEMP/npm-local" "npm install -g npm"',
  'npm install -g npm -- --prefix "$RUNNER_TEMP/npm-local"',
  'npm install -g npm npm_config_prefix="$RUNNER_TEMP/npm-local"',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-local" --prefix /shared',
  "npm install -g npm --prefix '$RUNNER_TEMP/npm-local'",
  'npm install --prefix "$RUNNER_TEMP/npm-local" npm # npm install -g npm',
  'npx npm install -g npm@latest',
  'echo "npm install -g npm@latest"',
  '# npm install -g npm@latest',
  'npm install --prefix npm -g pnpm',
  'if true; then npm install -g npm; fi',
  '(npm install -g npm)',
  'echo ready & npm install -g npm',
  'npm_config_global=true npm install npm@11.19.0',
  'NPM_CONFIG_GLOBAL=true npm install npm@11.21.0',
  'npm_config_location=global npm install npm',
  'npm --scope @x install -g npm@11.21.0',
  'npm install -g npm@11.21.0',
  ...['i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'].map(alias => `npm ${alias} -g npm@11.21.0`),
  'npm -g install npm@11.21.0',
  'npm install npm@11.21.0 -g',
  'npm install --location=global npm@11.21.0',
  'npm install --location global npm@11.21.0',
  'npm --location global install npm@11.21.0',
  'npm install --global=true npm@11.21.0',
  'npm install -g npm',
  'npm install -g npm@latest',
  'npm install -g npm@^11',
  'npm install -gpld npm@11.19.0',
  'npm install -dg npm@11.19.0',
  'npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@11.19.0 && npm install -g npm@11.19.0',
  'npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0; npm install -g npm@11.19.0',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0" "unclosed',
  'npm install --global \\\n  npm@11.21.0',
  'npm install --global \\\r\n  npm@11.21.0',
  '"$npm_bin/npm" install --global "npm@latest"',
  '"/synthetic tool/bin/npm" install -g npm',
  "npm 'add' '--location=global' 'npm@^11'",
  // Round AJ: update aliases, config-set run-wide signals, option abbreviations,
  // shell forms the line-based rule scans like any other text, and computed
  // or partial-flag operands. The marker rule cannot read option values, so
  // --global=false is rejected fail-closed, and pnpm/npm-helper name npm as a
  // substring - accepted false positives by design.
  'npm update -g npm@latest',
  'npm up -g npm',
  'npm upgrade -g npm',
  'npm udpate -g npm',
  'npm config set global=true\nnpm install npm@11.21.0',
  'npm config set global=true; npm install npm@11.21.0',
  'npm set location global; npm install npm@11.21.0',
  'npm c set global=true; npm install npm@11.21.0',
  'npm install -g https://registry.npmjs.org/npm/-/npm-11.21.0.tgz',
  'npm install --locatio=global npm@11.21.0',
  'npm install --glob npm',
  'npm install --gl npm',
  'npm install --loc npm',
  'npm install -L user npm',
  'if true; then npm install -g npm@11.19.0; fi',
  'command npm install -g npm@11.19.0',
  'npx -y npm@latest install -g npm@latest',
  'npm install -g "$pkg"',
  'npm install -g pnpm',
  'npm install -gpld pnpm',
  'npm install --global -- npm-helper',
  'npm install --global=false npm',
  // An npm_config_global assignment contains the marker substring regardless
  // of its value; only a false/0/empty env scope (not a script line) stays safe.
  'export NPM_CONFIG_GLOBAL=false; npm install npm',
  'NPM_CONFIG_GLOBAL=0; npm install npm',
  'NPM_CONFIG_GLOBAL=""; npm install npm',
  'echo "NPM_CONFIG_GLOBAL=true" >> "$GITHUB_ENV"',
  'echo "global=true" >> ~/.npmrc',
  'printf "location=global\\n" | tee -a .npmrc >/dev/null',
];
const accepted = [
  'npm install -g npm "--prefix" "$RUNNER_TEMP/npm-local"',
  'env NPM_CONFIG_PREFIX="$RUNNER_TEMP/npm-local" NPM_CONFIG_GLOBAL=true npm install npm',
  'NPM_CONFIG_LOCATION=project; npm install npm',
  'npm install --prefix "$RUNNER_TEMP/npm-11.21.0" npm@11.21.0 --ignore-scripts --no-audit --no-fund',
  'npm --prefix "$RUNNER_TEMP/npm-11.21.0" install npm@11.21.0',
  'npm ci',
  'npm install -g some-other-package',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0"',
  'npm_config_prefix="$RUNNER_TEMP/npm-local" npm_config_global=true npm install npm',
  'npm --prefix install run ci',
  'npm install -g npm --prefix "$RUNNER_TEMP/npm-11.21.0" && npm ci',
  // Round AJ: comments and here-document text are scanned like any other
  // text, so the surviving safe lines never mention npm at all.
  'cat << EOF\nhello\nEOF',
  'n=$(( ${#arr[@]} - 1 ))',
  'echo $(( 1 << 2 ))',
  'npm install -D pnpm',
];
for (const command of rejected) test(`rejects ${JSON.stringify(command)}`, () => {
  assert.ok(globalNpmInstalls(command).length > 0);
  const workflow = `jobs:\n  audit:\n    steps:\n      - run: |\n${command.split('\n').map(line => `          ${line}`).join('\n')}\n`;
  assert.deepEqual(workflowGlobalNpmInstalls(workflow), globalNpmInstalls(command));
  if (!command.includes('\n')) assert.deepEqual(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    steps:\n      - run: ${JSON.stringify(command)}\n`), globalNpmInstalls(command));
});
for (const command of accepted) test(`allows ${JSON.stringify(command)}`, () => {
  assert.deepEqual(globalNpmInstalls(command), []);
  assert.deepEqual(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    steps:\n      - run: ${JSON.stringify(command)}\n`), []);
});
test('shell punctuation and quoted text cannot hide a replacement', () => {
  for (const separator of [';', '&', '&&', '||', '|', '(', ')', '{', '}', '\n']) {
    assert.equal(globalNpmInstalls(`echo safe ${separator} npm install -g npm`).length, 1);
    if (separator !== '\n') assert.equal(globalNpmInstalls(`echo 'safe ${separator} npm install -g npm'`).length, 1);
  }
});

test('writing npm configuration to GITHUB_ENV rejects the writing step, not the reading one', () => {
  const workflow = `jobs:\n  audit:\n    steps:\n      - run: |\n          echo "NPM_CONFIG_GLOBAL=true" >> "$GITHUB_ENV"\n      - run: npm install npm@11.21.0\n`;
  assert.equal(workflowGlobalNpmInstalls(workflow).length, 1);
  assert.deepEqual(globalNpmInstalls('npm install npm@11.21.0'), []);
});

/** Build a minimal workflow with real step-level fields. */
function workflow(step: string): string {
  return `jobs:\n  audit:\n    steps:\n      - ${step}\n`;
}

test('all six block scalar styles are extracted with YAML folding', () => {
  for (const style of ['|', '|-', '|+', '>', '>-', '>+']) {
    const body = style.startsWith('>') ? 'npm install\n          --global\n          npm@11.19.0' : 'npm install -g npm';
    assert.equal(workflowGlobalNpmInstalls(workflow(`run: ${style}\n          ${body}`)).length, 1);
  }
  // More-indented lines and blank lines preserve logical-line boundaries.
  for (const body of ['npm install\n            --global\n          npm', 'npm install\n\n          --global npm']) {
    assert.deepEqual(workflowGlobalNpmInstalls(workflow(`run: >-\n          ${body}`)), []);
  }
});

test('only step run values are scripts, regardless of metadata quotes and run keys', () => {
  assert.equal(workflowGlobalNpmInstalls(workflow("name: Don't mutate npm\n        run: npm install -g npm")).length, 1);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env: {run: "npm install -g npm"}\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env:\n          run: npm install -g npm\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('name: npm install -g npm\n        run: echo safe')), []);
  assert.deepEqual(workflowGlobalNpmInstalls('env:\n  run: npm install -g npm\n' + workflow('run: echo safe')), []);
});

test('plain and quoted single-line run scalars are decoded independently', () => {
  for (const value of ['npm install -g npm', '"npm install -g npm"', "'npm install -g npm'", "'echo ''npm install -g npm'''", '"npm install\\u0020-g npm"']) {
    assert.equal(workflowGlobalNpmInstalls(workflow(`run: ${value}`)).length, 1);
  }
});

test('unextractable step run values fail closed', () => {
  for (const value of ['{script: echo safe}', '[echo safe]', 'null', '"unterminated', '*missing', '']) {
    assert.ok(workflowGlobalNpmInstalls(workflow(`run: ${value}`)).length > 0, value);
  }
});

test('unsupported executable workflow layouts fail closed', () => {
  for (const source of ['{jobs: {audit: {steps: [{run: echo safe}]}}}', 'jobs: {audit: {steps: [{run: echo safe}]}}', 'jobs:\n  audit:\n    steps:\n      - {run: echo safe}']) {
    assert.deepEqual(workflowGlobalNpmInstalls(source), [['unextractable step run']]);
  }
});

test('inert job-level sequence values never hide a run script', () => {
  // A needs list consumes its items as metadata; a run script inside a job
  // is still inspected, and a steps sequence without entries fails closed.
  const source = 'jobs:\n  audit:\n    needs:\n      - prepare\n      - release\n    steps:\n      - run: npm install -g npm\n';
  assert.equal(workflowGlobalNpmInstalls(source).length, 1);
  assert.deepEqual(workflowGlobalNpmInstalls('jobs:\n  audit:\n    needs:\n      - prepare\n    steps:\n      - run: echo safe\n'), []);
});

test('indentationless step sequences still inspect only step run values', () => {
  const prefix = 'jobs:\n  audit:\n    steps:\n    - env: {run: "npm install -g npm"}\n      run: ';
  assert.deepEqual(workflowGlobalNpmInstalls(prefix + 'echo safe\n'), []);
  assert.deepEqual(workflowGlobalNpmInstalls(prefix + 'npm install -g npm\n'), globalNpmInstalls('npm install -g npm'));
});

test('workflow, job and step env compose and can force installs global', () => {
  // npm reads npm_config_* case-insensitively; the step scope wins over the job.
  const envRuns = (env: string, run: string) => workflowGlobalNpmInstalls(`${env}${workflow(`run: ${run}`)}`);
  assert.equal(envRuns('env:\n  NPM_CONFIG_GLOBAL: "true"\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(envRuns('env:\n  npm_config_global: ${{ matrix.global }}\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(envRuns('env:\n  NPM_CONFIG_LOCATION: global\n', 'npm install npm@11.19.0').length, 1);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install npm@11.19.0')).length, 1);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_LOCATION: global, NPM_CONFIG_GLOBAL: "false"}\n        run: npm install npm@11.19.0')).length, 1);
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env: {NPM_CONFIG_GLOBAL: "true"}\n    steps:\n      - run: npm install npm@11.19.0\n`).length, 1);
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env:\n      NPM_CONFIG_GLOBAL: "true"\n    steps:\n      - run: npm install npm@11.19.0\n`).length, 1);
  // A safe step scope overrides an unsafe job scope.
  assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    env: {NPM_CONFIG_GLOBAL: "true"}\n    steps:\n      - env: {NPM_CONFIG_GLOBAL: "false"}\n        run: npm install npm@11.19.0\n`).length, 0);
  // Only an approved bootstrap shape covers a forced install.
  assert.deepEqual(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0')), []);
  assert.equal(workflowGlobalNpmInstalls(workflow('env: {NPM_CONFIG_GLOBAL: "true"}\n        run: npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0 && npm install npm@11.19.0')).length, 1);
  // Explicitly safe values stay accepted at every level.
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: "false"\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: "0"\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  NPM_CONFIG_GLOBAL: ""\n', 'npm install npm@11.19.0'), []);
  assert.deepEqual(envRuns('env:\n  OTHER_KEY: "true"\n', 'npm install npm@11.19.0'), []);
  // Unreadable env scopes fail closed when a run installs npm.
  assert.equal(workflowGlobalNpmInstalls(workflow('env: ${{ matrix.env }}\n        run: npm install npm@11.19.0')).length, 1);
});

test('computed location values reject installs at every effective env scope', () => {
  for (const value of ['${{ inputs.location }}', "${{ 'global' }}", '$LOCATION', '$(printf global)']) {
    const entry = `NPM_CONFIG_LOCATION: ${JSON.stringify(value)}`;
    for (const source of [
      `env:\n  ${entry}\n${workflow('run: npm install npm@11.21.0')}`,
      `jobs:\n  audit:\n    env:\n      ${entry}\n    steps:\n      - run: npm install npm@11.21.0\n`,
      workflow(`env:\n          ${entry}\n        run: npm install npm@11.21.0`),
    ]) assert.equal(workflowGlobalNpmInstalls(source).length, 1, source);
  }
});

test('only an exact approved bootstrap line is exempt, whatever surrounds it', () => {
  // The exemption comes only from the whole line; text elsewhere on the line,
  // in a comment, or in another command never grants it.
  assert.deepEqual(globalNpmInstalls('npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@11.19.0 --ignore-scripts --no-audit --no-fund'), []);
  assert.equal(globalNpmInstalls('npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@11.19.0 --ignore-scripts --no-audit --no-fund && npm install -g npm').length, 1);
  assert.equal(globalNpmInstalls('npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@latest --ignore-scripts --no-audit --no-fund').length, 0);
  assert.equal(globalNpmInstalls('npm install --prefix "$RUNNER_TEMP/npm-11.19.0" npm@11.19.0 --ignore-scripts --no-audit --no-fund --prefix /shared').length, 0);
});

test('only actual separators isolate a sibling prefix exemption', () => {
  for (const separator of [';', '&&', '||', '|', '&', '\n']) {
    assert.equal(globalNpmInstalls(`npm install -g npm ${separator} npm install --prefix "$RUNNER_TEMP/npm-local" npm`).length, 1);
    assert.equal(globalNpmInstalls(`npm install --prefix "$RUNNER_TEMP/npm-local" npm ${separator} npm install -g npm`).length, 1);
  }
  // Quoted # is an argument; an unquoted word-start # begins a comment.
  assert.equal(globalNpmInstalls('npm install -g npm "#" --prefix /shared # --prefix "$RUNNER_TEMP/npm-local"').length, 1);
  for (const redirect of ['2>&1', '>&2', '&>output', '&>>output', '<&0']) {
    assert.equal(globalNpmInstalls(`npm install -g ${redirect} npm`).length, 1);
    // A redirect may not lend the local prefix of a sibling to an unsafe install.
    assert.equal(globalNpmInstalls(`npm install -g ${redirect} npm && npm install --prefix "$RUNNER_TEMP/npm-local" npm`).length, 1);
  }
});

test('attached shell punctuation never hides command words or global markers', () => {
  for (const punctuation of [';', '&', '|', '<', '>', '(', ')', '`']) {
    assert.equal(globalNpmInstalls(`npm install${punctuation}output -g npm`).length, 1);
    assert.equal(globalNpmInstalls(`npm install npm -g${punctuation}output`).length, 1);
  }
});

test('comment backslashes retain physical findings in the union for LF and CRLF input', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const comment of ['# bootstrap', '  # bootstrap', 'echo safe # bootstrap']) {
      const findings = globalNpmInstalls(`${comment} \\${newline}npm install -g npm`);
      assert.ok(findings.some(finding => JSON.stringify(finding) === JSON.stringify(['npm', 'install', '-g', 'npm'])));
    }
    assert.ok(globalNpmInstalls(`npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0 # bootstrap \\${newline}npm install -g npm@11.19.0`).length > 0);
  }
});

test('continuation union keeps bootstrap exemptions local to each form', () => {
  for (const newline of ['\n', '\r\n']) {
    // Joining produces an approved bootstrap, but its physical install is unsafe.
    const continued = `npm install -g npm \\${newline}--prefix "$RUNNER_TEMP/npm-local"`;
    assert.deepEqual(globalNpmInstalls(continued), [['npm', 'install', '-g', 'npm', '\\']]);
    assert.deepEqual(globalNpmInstalls('npm install -g npm --prefix "$RUNNER_TEMP/npm-local"'), []);
    // The quoted hash needs joining to expose the global marker.
    assert.ok(globalNpmInstalls(`npm install --cache "$RUNNER_TEMP/npm #cache" \\${newline}  -g npm@11.19.0`).length > 0);
  }
  // A single-line violation appears in both forms but is reported only once.
  assert.deepEqual(globalNpmInstalls('npm install -g npm'), [['npm', 'install', '-g', 'npm']]);
});

test('no approved bootstrap shape tolerates trailing comments', () => {
  for (const bootstrap of [
    'npm install --prefix "$RUNNER_TEMP/npm-local" npm@11.19.0',
    'npm --prefix "$RUNNER_TEMP/npm-local" install npm@11.19.0',
    'npm install -g npm --prefix "$RUNNER_TEMP/npm-local"',
    'npm install -g npm "--prefix" "$RUNNER_TEMP/npm-local"',
    'env NPM_CONFIG_PREFIX="$RUNNER_TEMP/npm-local" NPM_CONFIG_GLOBAL=true npm install npm',
    'npm_config_prefix="$RUNNER_TEMP/npm-local" npm_config_global=true npm install npm',
  ]) {
    assert.deepEqual(globalNpmInstalls(bootstrap, { NPM_CONFIG_GLOBAL: 'true' }), []);
    assert.equal(globalNpmInstalls(`${bootstrap} # bootstrap`, { NPM_CONFIG_GLOBAL: 'true' }).length, 1);
  }
});

test('persistent npm setters reject the writing step without requiring a same-run install', () => {
  for (const setter of ['npm config set global=true', 'npm config set global true', 'npm set location global', 'npm c set location=global']) {
    const source = `jobs:\n  audit:\n    steps:\n      - run: ${setter}\n      - run: npm install npm@11.19.0\n`;
    assert.deepEqual(workflowGlobalNpmInstalls(source), [['npm configuration persisted by set', setter]]);
  }
  assert.deepEqual(globalNpmInstalls('npm config get globalconfig'), []);
});

test('spaced and unsupported env entries cannot hide effective global settings', () => {
  for (const entry of ['NPM_CONFIG_GLOBAL : "true"', '"NPM_CONFIG_GLOBAL" : "true"', "'NPM_CONFIG_LOCATION' : global", '? unsupported']) {
    for (const source of [
      `env:\n  ${entry}\n${workflow('run: npm install npm@11.19.0')}`,
      `jobs:\n  audit:\n    env:\n      ${entry}\n    steps:\n      - run: npm install npm@11.19.0\n`,
      workflow(`env:\n          ${entry}\n        run: npm install npm@11.19.0`),
    ]) assert.equal(workflowGlobalNpmInstalls(source).length, 1, source);
  }
});
