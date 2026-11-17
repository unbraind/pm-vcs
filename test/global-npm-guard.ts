/**
 * Threat model: catch accidental replacement of the runner's shared npm in
 * this repository's own reviewed workflows. False positives are acceptable;
 * misses are not. This guard never executes shell input. Deliberate
 * obfuscation is out of scope: an npm command held in a variable, `eval`,
 * shell aliases, and scripts outside the workflow YAML would not pass review.
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

/** Family words from npm 11.21.0 commands and aliases, without expanded abbreviations. */
const installFamily = ['install', 'install-test', 'install-ci-test', 'ci', 'clean-install', 'clean-install-test',
  'isntall', 'add', 'it', 'cit', 'ic', 'install-clean', 'isntall-clean', 'sit',
  'update', 'upgrade', 'udpate', 'u', 'uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'link', 'ln'];
const updateFamily = ['update', 'upgrade', 'udpate', 'u'];

/** Normalize quoted camelCase commands, then conservatively accept every nonempty family prefix. */
function familyCommand(word: string, family: string[]): boolean {
  const normalized = unquote(word).replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
  return normalized.length > 0 && family.some(command => command.startsWith(normalized));
}

/** npm reads these environment keys case-insensitively. */
function relevantEnvKey(key: string): boolean {
  return key.toLowerCase() === 'npm_config_global' || key.toLowerCase() === 'npm_config_location';
}

/** Only exact safe values opt out; npm env keys, but not values, ignore case. */
function envForcesGlobal(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) => relevantEnvKey(key) &&
    (key.toLowerCase() === 'npm_config_global' ?
      !['false', '0', ''].includes(value) : !['project', 'user'].includes(value)));
}

/** Every mention must be a recognized safe assignment; unknown shell writers fail closed. */
function runForcesGlobal(script: string): boolean {
  return [...script.matchAll(/\bnpm_config_(global|location)\b/giu)].some(mention => {
    const assignment = /^npm_config_(global|location)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/iu.exec(script.slice(mention.index));
    return !assignment || envForcesGlobal({ [`npm_config_${assignment[1]}`]: unquote(assignment[2]) });
  });
}

/** Remove one surrounding pair of single or double quotes, if the token has one. */
function unquote(word: string): string {
  return word.length > 1 && (word[0] === '"' && word[word.length - 1] === '"' ||
    word[0] === "'" && word[word.length - 1] === "'") ? word.slice(1, -1) : word;
}

/** Word checks split at whitespace and shell punctuation, then remove surrounding quotes. */
function lineTokens(line: string): string[] {
  return line.trim().split(/[\s;&|<>()`]+/u).filter(Boolean).map(unquote);
}

/** One of the tokens marks this line as installing globally. */
function globalMarker(tokens: string[]): boolean {
  return tokens.some((word, index) => {
    const option = unquote(word).split('=', 1)[0];
    if (/^-[a-z]*g[a-z]*$/iu.test(option)) return true; // -g, -fg, -gpld
    if (word.toLowerCase().includes('global')) return true; // --global, --location=global, -L=global
    if (/^-L$/iu.test(option)) return word.includes('=') || index + 1 < tokens.length; // -L=<value> or -L <value>
    const name = /^--([a-z]+)$/iu.exec(option)?.[1]?.toLowerCase(); // --g, --gl, --glob, --loc, --location
    return name !== undefined && ('global'.startsWith(name) ||
      name.length >= 2 && 'location'.startsWith(name));
  });
}

/** Only plain registry name-specs with known non-npm identities are safe. */
function safeGlobalOperands(line: string, implicitGlobalLink: boolean): boolean {
  // Keep quoted words together, but preserve punctuation, backticks and quote
  // fragments for the allowlist to reject. This remains a line-based scan.
  const rawWords = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+|["']/gu) ?? [];
  // Shell syntax can make a following word a redirect target, comment or
  // separate command. It cannot provide evidence of a package operand.
  if (rawWords.some(word => /[;&|<>()`#\\]/u.test(word.replace(/"[^"]*"|'[^']*'/gu, '')))) return false;
  const words = rawWords.map(unquote);
  // Link options can consume an apparent registry operand, leaving a bare
  // global link. Require inline option values, apart from the -g shorthand.
  if (implicitGlobalLink && words.some((word, index) => word.startsWith('-') &&
    (word.endsWith('=') || (word === '-g' ? /^(?:true|false|0|1)$/iu.test(words[index + 1] ?? '') : !word.includes('='))))) return false;
  const registrySpec = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~<>=*|+_ -]+)?$/u;
  // A command word after a valueless option may be its value. Check every
  // possible command, so an earlier option value cannot supply an operand to
  // what is really a bare install.
  const commands = words.flatMap((word, index) => familyCommand(word, installFamily) ? [index] : []);
  return commands.length > 0 && commands.every(index => {
    const args = words.slice(index + 1);
    const optionEnd = args.indexOf('--');
    const possibleOperands = args.flatMap((word, offset) => {
      const afterOptions = optionEnd !== -1 && offset > optionEnd;
      if (word.startsWith('-') && !afterOptions) return [];
      return [{word, definite: afterOptions || !/^--[^=]+$/u.test(args[offset - 1] ?? '')}];
    });
    // Check npm identity even in ambiguous values. Only definite safe
    // operands can rule out installing or linking the current directory.
    return possibleOperands.every(({word}) => !/npm/iu.test(word) && registrySpec.test(word) &&
      !/\.(?:tgz|tar(?:\.gz)?)$/iu.test(word)) && possibleOperands.some(({definite}) => definite);
  });
}

/** Collect config paths from effective workflow env and assignments in this run. */
function npmConfigPaths(run: string, env: Record<string, string>): Set<string> {
  const paths = new Set(Object.entries(env).filter(([key, value]) =>
    value !== '' && /^npm_config_(?:userconfig|globalconfig)$/iu.test(key)).map(([, value]) => value));
  for (const [, value] of run.matchAll(/\bnpm_config_(?:userconfig|globalconfig)[ \t]*=[ \t]*("[^"\r\n]*"|'[^'\r\n]*'|[^\s"';&|<>]+)/giu)) {
    const path = unquote(value);
    if (path) paths.add(path);
  }
  return paths;
}

/** Recognize standard npmrc names, config variables and their assigned paths. */
function targetsNpmrc(line: string, paths: Set<string>): boolean {
  // Plain inspection does not persist settings. Output and command separators
  // leave the line eligible for a write, including cat with a here-document.
  if (/^(?:cat|type|Get-Content|npm[ \t]+config[ \t]+get)\b/iu.test(line) &&
    !/[>;&|]/u.test(line.replace(/"[^"]*"|'[^']*'/gu, ''))) return false;
  if (/npmrc|\$(?:\{npm_config_(?:userconfig|globalconfig)\}|(?:env:)?npm_config_(?:userconfig|globalconfig)\b)/iu.test(line)) return true;
  const words = line.match(/(?:[^\s"';&|<>()]+|"[^"]*"|'[^']*')+/gu) ?? [];
  return words.some(word => paths.has(unquote(word)));
}

/** Persistent global/location setters affect later steps even without an install in this run. */
function setsGlobalConfig(line: string): boolean {
  return /\bnpm\b/iu.test(line) && lineTokens(line).includes('set') && /global|location/iu.test(line);
}

/**
 * The approved bootstrap shapes: whole logical lines that install npm into a
 * job-local prefix under $RUNNER_TEMP, built from the real release workflows
 * and the approved fixtures. A global install line with an npm operand is a
 * violation unless its whole trimmed text matches one of these exactly, so
 * the exemption comes only from an exact line, never from text elsewhere on
 * the line, from a comment, or from another command. Trailing comments never
 * receive an exemption.
 */
const approvedBootstrapShapes: RegExp[] = [
  // The release workflow bootstrap: the pinned npm into $RUNNER_TEMP, followed
  // by any of --ignore-scripts, --no-audit and --no-fund.
  /^npm install --prefix "\$RUNNER_TEMP\/npm-[\w.-]+" npm@\d+(?:\.\d+)*(?: --ignore-scripts)?(?: --no-audit)?(?: --no-fund)?$/u,
  // The same bootstrap with the prefix option before the install-family word.
  /^npm --prefix "\$RUNNER_TEMP\/npm-[\w.-]+" install npm@\d+(?:\.\d+)*$/u,
  // An approved fixture form: -g with a job-local --prefix, which relocates
  // the global location, optionally followed by npm ci.
  /^npm install -g npm --prefix "\$RUNNER_TEMP\/npm-[\w.-]+"(?: && npm ci)?$/u,
  // The same fixture form with the prefix flag quoted.
  /^npm install -g npm "--prefix" "\$RUNNER_TEMP\/npm-[\w.-]+"$/u,
  // Env-assignment prefixes must precede npm and carry a job-local prefix.
  /^env NPM_CONFIG_PREFIX="\$RUNNER_TEMP\/npm-[\w.-]+" NPM_CONFIG_GLOBAL=true npm install npm$/u,
  /^npm_config_prefix="\$RUNNER_TEMP\/npm-[\w.-]+" npm_config_global=true npm install npm$/u,
];

/**
 * Scan physical lines and three separately joined forms: backslash, backtick
 * and Cmd caret. Take the union of all four scans. Joining different markers
 * together can swallow commands after comments; quoted hashes still need joining.
 * Trailing blanks and CRLF do not hide continuations. No shell parsing chooses
 * between those forms.
 * An exact approved bootstrap is exempt only in the form where it is exact.
 * Comment and here-document text is scanned like any other text; false positives
 * are acceptable. Persistent npm configuration rejects the writing step.
 */
export function globalNpmInstalls(script: string, env?: Record<string, string>): string[][] {
  const physical = script.split('\n').map(line => line.replace(/\r$/u, '')).join('\n');
  const forms = [physical, ...[/\\[\t ]*\n/gu, /`[\t ]*\n/gu, /\^[\t ]*\n/gu]
    .map(continuation => physical.replace(continuation, ''))];
  const findings = forms.flatMap(form => scanNpmLines(form, env));
  return [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()];
}

/** Evaluate one line form with its own exact bootstrap exemptions. */
function scanNpmLines(run: string, env?: Record<string, string>): string[][] {
  const lines = run.split('\n').map(line => line.trim()).filter(Boolean);
  const findings: string[][] = [];
  // A global npm_config_* exported through GITHUB_ENV reaches every later
  // step of the job; there is no way to check those steps, so reject the
  // writing step itself instead of tracking state across steps.
  if (/github_env/iu.test(run) && /npm_config_(?:global|location|prefix)/iu.test(run))
    findings.push(['npm configuration written to GITHUB_ENV']);
  // Release workflows inspect globalconfig and scrub auth from npmrc files.
  // Comment-only descriptions and path fragments (such as global.npmrc) do
  // not set keys. Keep standalone setting words, including heredoc bodies.
  // printf, echo -e and ANSI-C quoting can put setting keys after escaped
  // line breaks. Collapse any number of escape backslashes for this scan.
  const npmrcSettings = lines.filter(line => !line.startsWith('#')).join('\n').replace(/\\+[nr]/gu, '\n');
  const setsNpmrcKey = /(?:^|[^\w./\\-])(?:global|location)(?=$|[^\w./\\-])/imu.test(npmrcSettings);
  const configPaths = setsNpmrcKey ? npmConfigPaths(run, env ?? {}) : new Set<string>();
  for (const line of lines) {
    if (setsGlobalConfig(line)) findings.push(['npm configuration persisted by set', line]);
    if (setsNpmrcKey && targetsNpmrc(line, configPaths))
      findings.push(['npm configuration written to an npmrc file', line]);
  }
  // Only a set token configures: the release workflow's read-only
  // `npm config get globalconfig` must not force the run global.
  const globalConfigured = envForcesGlobal(env ?? {}) || runForcesGlobal(run) || lines.some(setsGlobalConfig);
  for (const line of lines) {
    const tokens = lineTokens(line);
    // A line is an npm install line when it mentions npm at a word boundary
    // — /usr/bin/npm, npx npm@…, command npm and `then npm` included — and
    // any token is an install-family word.
    if (!/\bnpm\b/iu.test(line) || setsGlobalConfig(line)) continue;
    const installIndex = tokens.findIndex(word => familyCommand(word, installFamily));
    if (installIndex === -1) continue;
    // Link/ln may write to the global prefix even without a global flag.
    const implicitGlobalLink = tokens.some(word => familyCommand(word, ['link', 'ln']));
    if (!globalConfigured && !globalMarker(tokens) && !implicitGlobalLink) continue;
    // Every global update-family line is a violation, whatever its operands.
    // Option values, redirect targets and comments can look like packages;
    // rejecting updates of unrelated packages is an accepted false positive.
    // Install, uninstall and link families retain operand classification.
    if (!tokens.some(word => familyCommand(word, updateFamily)) && safeGlobalOperands(line, implicitGlobalLink)) continue;
    if (approvedBootstrapShapes.some(shape => shape.test(line))) continue;
    findings.push(tokens);
  }
  return findings;
}

/** Represent extraction failures as violations, never as a successful empty scan. */
function unreadableRun(): string[][] {
  return [['unextractable step run']];
}
/** Merge keys and aliases must never supply hidden executable fields. */
function hasMerge(node: unknown): boolean {
  return isMap(node) && node.items.some(pair => !isScalar(pair.key) || pair.key.value === '<<');
}

/** Read a mapping entry without resolving aliases or YAML merge keys. */
function entry(node: unknown, key: string): unknown {
  return isMap(node) ? node.get(key, true) : undefined;
}

/** Decode only plain env maps with scalar values; null scopes remain empty. */
function envEntries(node: unknown): Record<string, string> | undefined {
  // Existing workflows/fixtures use a null env scope to mean no overrides.
  if (node === undefined || isScalar(node) && node.value === null) return {};
  if (!isMap(node) || node.anchor) return undefined;
  const entries: Record<string, string> = {};
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' ||
      !isScalar(pair.value) || !['string', 'number', 'boolean'].includes(typeof pair.value.value) || pair.value.anchor) return undefined;
    // Merge workflow scopes by exact name before checking npm's case-insensitive keys.
    // YAML numeric/boolean env entries (for example PM_TEST_TIME_SCALE: 3)
    // are scalar strings at the runner boundary, not executable structures.
    entries[pair.key.value] = String(pair.value.value);
  }
  return entries;
}

/**
 * Parse with the declared yaml@2.9.1 package dependency.
 * Walk only jobs.*.steps[*].run and real env scopes; matrix.env is metadata.
 * Parse errors, aliases, merges and non-string executable values fail closed.
 * Retain rejection of flow executable layouts from the original guard contract.
 */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  const document = parseDocument(source);
  if (document.errors.length || !isMap(document.contents) || document.contents.flow || document.contents.anchor || hasMerge(document.contents)) return unreadableRun();
  const root = document.contents;
  const workflowEnv = envEntries(entry(root, 'env'));
  if (!workflowEnv) return unreadableRun();
  const jobs = entry(root, 'jobs');
  if (jobs === undefined) return [];
  if (!isMap(jobs) || jobs.flow || jobs.anchor || hasMerge(jobs)) return unreadableRun();
  const findings: string[][] = [];
  for (const pair of jobs.items) {
    const job = pair.value;
    if (!isMap(job) || job.flow || job.anchor || hasMerge(job)) return unreadableRun();
    const jobEnv = envEntries(entry(job, 'env'));
    const container = entry(job, 'container');
    const containerEnv = envEntries(entry(container, 'env'));
    if (!jobEnv || !containerEnv || container !== undefined &&
      (!isMap(container) && (!isScalar(container) || typeof container.value !== 'string' || container.value.includes('${{')) ||
        isMap(container) && (container.flow || container.anchor || hasMerge(container)))) return unreadableRun();
    const services = entry(job, 'services');
    if (services !== undefined && (!isMap(services) || hasMerge(services))) return unreadableRun();
    // Services run separately: no service's safe value may mask another's
    // unsafe setting. Keep the existing conservative service-scope rule.
    const serviceEnv: Record<string, string> = {};
    if (isMap(services)) for (const service of services.items) {
      if (!isMap(service.value) || hasMerge(service.value)) return unreadableRun();
      const env = envEntries(entry(service.value, 'env'));
      if (!env) return unreadableRun();
      for (const [key, value] of Object.entries(env)) {
        if (!(key in serviceEnv) || envForcesGlobal({ [key]: value })) serviceEnv[key] = value;
      }
    }
    const steps = entry(job, 'steps');
    if (steps === undefined) continue; // Reusable workflow jobs have no steps.
    if (!isSeq(steps) || steps.flow || steps.anchor) return unreadableRun();
    for (const step of steps.items) {
      if (!isMap(step) || step.flow || step.anchor || hasMerge(step)) return unreadableRun();
      const stepEnv = envEntries(entry(step, 'env'));
      if (!stepEnv) return unreadableRun();
      const run = entry(step, 'run');
      if (run === undefined) continue;
      if (!isScalar(run) || typeof run.value !== 'string' || run.anchor) return unreadableRun();
      const shell = entry(step, 'shell');
      if (shell !== undefined && (!isScalar(shell) || typeof shell.value !== 'string')) return unreadableRun();
      // Retain the shell with the collected script. All continuation forms
      // are scanned conservatively even for custom/unspecified shells.
      const collected = { script: run.value, shell: isScalar(shell) ? shell.value : undefined };
      const effective = { ...serviceEnv, ...containerEnv, ...workflowEnv, ...jobEnv, ...stepEnv };
      findings.push(...globalNpmInstalls(collected.script, effective));
    }
  }
  return findings;
}
