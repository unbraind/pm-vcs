/** Positive and negative fixtures for the workflow-wide shared-npm guard. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globalNpmInstalls, workflowGlobalNpmInstalls } from './global-npm-guard.ts';

const rejected = [
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
  'npm install --global \\\n  npm@11.21.0',
  'npm install --global \\\r\n  npm@11.21.0',
  '"$npm_bin/npm" install --global "npm@latest"',
  '"/synthetic tool/bin/npm" install -g npm',
  "npm 'add' '--location=global' 'npm@^11'",
];
const accepted = [
  'npm install --prefix "$RUNNER_TEMP/npm-11.21.0" npm@11.21.0 --ignore-scripts --no-audit --no-fund',
  'npm --prefix "$RUNNER_TEMP/npm-11.21.0" install npm@11.21.0',
  'npm ci',
  'npm install -g pnpm',
  'npx npm install -g npm@latest',
  'echo "npm install -g npm@latest"',
  '# npm install -g npm@latest',
  'npm install --prefix npm -g pnpm',
  'npm --prefix install run ci',
  'npm install --global=false npm',
  'npm install --global -- npm-helper',
];
for (const command of rejected) test(`rejects ${JSON.stringify(command)}`, () => {
  assert.equal(globalNpmInstalls(command).length, 1);
  const workflow = `jobs:\n  audit:\n    steps:\n      - run: |\n${command.split('\n').map(line => `          ${line}`).join('\n')}\n`;
  assert.equal(workflowGlobalNpmInstalls(workflow).length, 1);
  if (!command.includes('\n')) assert.equal(workflowGlobalNpmInstalls(`jobs:\n  audit:\n    steps:\n      - run: ${JSON.stringify(command)}\n`).length, 1);
});
for (const command of accepted) test(`allows ${JSON.stringify(command)}`, () => {
  assert.deepEqual(globalNpmInstalls(command), []);
});
test('every shell separator starts a new command, while quoted separators stay in arguments', () => {
  for (const separator of [';', '&&', '||', '|', '\n']) {
    assert.equal(globalNpmInstalls(`echo safe ${separator} npm install -g npm`).length, 1);
    assert.deepEqual(globalNpmInstalls(`echo 'safe ${separator} npm install -g npm'`), []);
  }
});
