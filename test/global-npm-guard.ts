/**
 * Threat model: catch accidental replacement of the runner's shared npm in
 * this repository's own reviewed workflows. False positives are acceptable;
 * misses are not. This guard never executes shell input. Deliberate
 * obfuscation is out of scope: an npm command held in a variable, `eval`,
 * shell aliases, and scripts outside the workflow YAML would not pass review.
 */
/**
 * Install-family commands: install and its abbreviated and misspelled
 * aliases (i, in, ins, inst, insta, instal, isnt, isnta, isntal, isntall),
 * add, install-test/it, install-ci-test/cit, ci, and update with its aliases
 * (up, upgrade, udpate) all count as installing.
 */
const installFamily = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it', 'ci', 'install-ci-test', 'cit', 'update', 'up', 'upgrade', 'udpate']);

/** Update-family lines bypass install operand classification. */
const updateFamily = new Set(['update', 'up', 'upgrade', 'udpate']);

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

/** Inspect assignments anywhere, including export, env and declare -x forms. */
function runForcesGlobal(script: string): boolean {
  return [...script.matchAll(/\bnpm_config_(global|location)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/giu)]
    .some(match => envForcesGlobal({ [`npm_config_${match[1]}`]: unquote(match[2]) }));
}

/** An env scope the parser refuses to interpret forces every install to be checked as global. */
const unreadableEnvScope = (): Record<string, string> => ({ npm_config_global: '${{ unreadable env scope }}' });

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
    const name = /^--([a-z]+)$/iu.exec(option)?.[1]?.toLowerCase(); // --gl, --glob, --loc, --location
    return name !== undefined && name.length >= 2 &&
      ('global'.startsWith(name) || 'location'.startsWith(name));
  });
}

/** Only plain registry name-specs with known non-npm identities are safe. */
function safeGlobalOperands(line: string): boolean {
  // Keep quoted words together, but preserve punctuation, backticks and quote
  // fragments for the allowlist to reject. This remains a line-based scan.
  const words = (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+|["']/gu) ?? []).map(unquote);
  const installIndex = words.findIndex(word => installFamily.has(word));
  if (installIndex === -1) return false;
  const operands = words.slice(installIndex + 1).filter(word => !word.startsWith('-'));
  const registrySpec = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~<>=*|+_ -]+)?$/u;
  return operands.length > 0 && operands.every(word => registrySpec.test(word) && !/npm/iu.test(word) &&
    // Bare archive names are file operands too, even without a ./ prefix.
    !['.tgz', '.tar.gz', '.tar'].some(suffix => word.endsWith(suffix)));
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
 * Scan both unconditionally joined backslash continuations and physical lines,
 * taking the union of findings. Quoted hashes need joining; comment backslashes
 * need physical boundaries. No shell parsing chooses between those forms.
 * An exact approved bootstrap is exempt only in the form where it is exact.
 * Comment and here-document text is scanned like any other text; false positives
 * are acceptable. Persistent npm configuration rejects the writing step.
 */
export function globalNpmInstalls(script: string, env?: Record<string, string>): string[][] {
  const findings = [
    ...scanNpmLines(script.replace(/\\\r?\n/gu, ''), env),
    ...scanNpmLines(script, env),
  ];
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
  for (const line of lines) {
    if (setsGlobalConfig(line)) findings.push(['npm configuration persisted by set', line]);
    // A written npmrc line names its target path and a write operator; the
    // value being global or location-selected is what makes it a replacement.
    if (/npmrc/iu.test(line) && (line.includes('>') || /\btee\b/iu.test(line) || /config\s+set/u.test(line)) &&
      /global|location/iu.test(line))
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
    if (!/\bnpm\b/iu.test(line)) continue;
    const installIndex = tokens.findIndex(word => installFamily.has(word));
    if (installIndex === -1) continue;
    if (!globalConfigured && !globalMarker(tokens)) continue;
    // Every global update-family line is a violation, whatever its operands.
    // Option values, redirect targets and comments can look like packages;
    // rejecting updates of unrelated packages is an accepted false positive.
    // Only install-family lines retain operand classification.
    if (!tokens.some(word => updateFamily.has(word)) && safeGlobalOperands(line)) continue;
    if (approvedBootstrapShapes.some(shape => shape.test(line))) continue;
    findings.push(tokens);
  }
  return findings;
}

/** Represent extraction failures as violations, never as a successful empty scan. */
function unreadableRun(): string[][] {
  return [['unextractable step run']];
}
/** Decode one quoted YAML scalar, rejecting unsupported or malformed values. */
function quotedScalar(value: string): string | undefined {
  const single = /^'((?:[^']|'')*)'(?:\s+#.*)?$/u.exec(value);
  if (single) return single[1].replace(/''/gu, "'");
  const double = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/u.exec(value);
  if (!double) return undefined;
  const escapes: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };
  let valid = true;
  const decoded = double[1].replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/gu, (_match, escape: string) => {
    if (escape in escapes) return escapes[escape];
    if (/^[xuU][\da-fA-F]+$/u.test(escape)) {
      const point = Number.parseInt(escape.slice(1), 16);
      if (point <= 0x10ffff) return String.fromCodePoint(point);
    }
    valid = false;
    return '';
  });
  return valid ? decoded : undefined;
}

/** Apply YAML folding: ordinary line breaks fold, empty/more-indented lines do not. */
function blockScalar(lines: string[], indent: number, folded: boolean, chomp: string): string {
  const content = lines.map(line => line.trim() ? line.slice(indent) : '');
  let value = '';
  for (let index = 0; index < content.length; index++) {
    const line = content[index];
    const next = content[index + 1];
    value += line;
    if (!folded || next === undefined || /^\s/u.test(line) || /^\s/u.test(next)) value += '\n';
    else if (line && next) value += ' ';
    else if (!line) value += '\n';
  }
  if (chomp === '-') return value.replace(/\n+$/u, '');
  if (chomp === '+') return value;
  return value.replace(/\n*$/u, '\n');
}

/** One composed npm-readable env scope; unreadable scopes fail closed. */
interface EnvScope { entries: Record<string, string>; unknown: boolean }
const emptyEnvScope = (): EnvScope => ({ entries: {}, unknown: false });

/** Decode one env entry scalar; undefined means the value is not a confident string. */
function envScalar(value: string): string | undefined {
  if (/^["']/u.test(value)) return quotedScalar(value);
  if (/^[#|>&*![{]/u.test(value)) return undefined;
  return value.replace(/\s+#.*$/u, '');
}

/** Decode a single-line YAML flow mapping of env entries; undefined means the mapping is unsupported. */
function flowEnvEntries(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  const entries: Record<string, string> = {};
  let index = 1;
  for (;;) {
    while (index < trimmed.length && /[\s,]/u.test(trimmed[index])) index++;
    if (index >= trimmed.length) return undefined;
    if (trimmed[index] === '}') { index++; break; }
    const keyStart = index;
    if (/["']/u.test(trimmed[index])) {
      const keyQuoted = trimmed[index] === '"' ? /^"(?:[^"\\]|\\.)*"/u.exec(trimmed.slice(index)) : /^'(?:[^']|'')*'/u.exec(trimmed.slice(index));
      if (!keyQuoted) return undefined;
      index += keyQuoted[0].length;
    } else {
      while (index < trimmed.length && /[\w-]/u.test(trimmed[index])) index++;
    }
    const rawKey = trimmed.slice(keyStart, index);
    while (index < trimmed.length && /\s/u.test(trimmed[index])) index++;
    if (!rawKey || index >= trimmed.length || trimmed[index] !== ':') return undefined;
    index++;
    while (index < trimmed.length && /\s/u.test(trimmed[index])) index++;
    let rawValue = '';
    if (index < trimmed.length && /["']/u.test(trimmed[index])) {
      const valueQuoted = trimmed[index] === '"' ? /^"(?:[^"\\]|\\.)*"/u.exec(trimmed.slice(index)) : /^'(?:[^']|'')*'/u.exec(trimmed.slice(index));
      if (!valueQuoted) return undefined;
      rawValue = valueQuoted[0];
      index += rawValue.length;
    } else {
      rawValue = /^[^,}]*/u.exec(trimmed.slice(index))![0].trim();
      index += /^[^,}]*/u.exec(trimmed.slice(index))![0].length;
    }
    const key = /^["']/u.test(rawKey) ? quotedScalar(rawKey) : rawKey;
    const decoded = /^["']/u.test(rawValue) ? quotedScalar(rawValue) :
      rawValue && !/^[#|>&*![{]/u.test(rawValue) ? rawValue.replace(/\s+#.*$/u, '') : rawValue ? undefined : '';
    if (key === undefined) return undefined;
    if (decoded !== undefined) entries[key] = decoded;
    else if (relevantEnvKey(key)) entries[key] = '${{ unreadable env entry }}';
  }
  return /^[\s]*(?:#.*)?$/u.test(trimmed.slice(index)) ? entries : undefined;
}

/**
 * No direct YAML dependency: extract the block mapping/sequence layout used by
 * this repository. Unsupported executable layouts or run scalars fail closed.
 * Metadata scalars and nested env.run keys never become shell input.
 */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  const lines = source.replace(/\r\n/gu, '\n').split('\n');
  const parents: { indent: number; path: string[] }[] = [];
  const findings: string[][] = [];
  const workflowEnv = emptyEnvScope();
  const jobEnvs: Record<string, EnvScope> = {};
  const stepEnvs: Record<string, EnvScope> = {};
  // Runs are buffered until every env scope is known: env may follow run in the step.
  const runs: { job: string; step: number; script: string }[] = [];
  let jobKey = '';
  let stepIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (/^ *\t/u.test(line)) return unreadableRun();
    const indent = /^ */u.exec(line)![0].length;
    while (parents.length && parents[parents.length - 1].indent >= indent) {
      const last = parents[parents.length - 1];
      // YAML also permits an indentationless sequence under steps.
      if (last.indent === indent && last.path.length === 3 && last.path[0] === 'jobs' && last.path[2] === 'steps' && line.slice(indent).startsWith('- ')) break;
      parents.pop();
    }
    let parent = parents[parents.length - 1]?.path ?? [];
    let text = line.slice(indent);
    let keyIndent = indent;
    let sequence = false;
    if (text.startsWith('- ')) {
      if (parent.length === 3 && parent[0] === 'jobs' && parent[2] === 'steps') {
        parent = [...parent, '*'];
        parents.push({ indent, path: parent });
        stepIndex += 1;
      }
      text = text.slice(2);
      keyIndent += 2;
      sequence = true;
    }
    const entry = /^(?:([\w-]+)|'([^']+)'|"([^"\\]+)")\s*:\s*(.*)$/u.exec(text);
    // Sequence items outside steps (a job's needs list, for example) are
    // inert metadata: only steps[*].run is executable, so consume them.
    if (sequence && !entry && parent.length === 3 && parent[0] === 'jobs' && parent[2] !== 'steps') continue;
    if (!entry) {
      // Unsupported env entries cannot silently erase effective npm settings.
      if (parent[0] === 'env' ||
        (parent[0] === 'jobs' && (parent[2] === 'env' || parent[4] === 'env'))) return unreadableRun();
      if ((!parent.length && !['---', '...'].includes(text)) ||
        (parent[0] === 'jobs' && (parent.length <= 3 || (parent.length === 4 && parent[3] === '*')))) return unreadableRun();
      continue;
    }
    const key = entry[1] ?? entry[2] ?? entry[3];
    const path = [...parent, key];
    if (path.length === 2 && path[0] === 'jobs') { jobKey = key; stepIndex = -1; }
    const value = entry[4].trim();
    parents.push({ indent: keyIndent, path });
    const run = path.length === 5 && path[0] === 'jobs' && path[2] === 'steps' && path[3] === '*' && key === 'run';
    const container = path[0] === 'jobs' && (path.length <= 2 || (path.length === 3 && key === 'steps'));
    if (container && value && !value.startsWith('#')) return unreadableRun();
    // Compose workflow, job and step env scopes; the step scope wins. npm reads
    // the keys case-insensitively, and an unreadable scope fails closed.
    const envContainer = (path.length === 1 && path[0] === 'env') ||
      (path.length === 3 && path[0] === 'jobs' && path[2] === 'env') ||
      (path.length === 5 && path[0] === 'jobs' && path[2] === 'steps' && path[3] === '*' && path[4] === 'env');
    const envEntry = (path.length === 2 && path[0] === 'env') ||
      (path.length === 4 && path[0] === 'jobs' && path[2] === 'env') ||
      (path.length === 6 && path[0] === 'jobs' && path[2] === 'steps' && path[3] === '*' && path[4] === 'env');
    if (envContainer || envEntry) {
      const scope = path.length <= 2 ? workflowEnv : path.length <= 4 ?
        (jobEnvs[path[1]] ??= emptyEnvScope()) : (stepEnvs[`${path[1]}\u0000${stepIndex}`] ??= emptyEnvScope());
      if (envContainer) {
        if (!value || value.startsWith('#') || /^(?:null|~)$/u.test(value)) {
          // Block-style env mapping: the entries follow as separate lines.
        } else if (value.startsWith('{')) {
          const flow = flowEnvEntries(value);
          if (flow === undefined) scope.unknown = true; else Object.assign(scope.entries, flow);
        } else scope.unknown = true;
      } else if (!value || value.startsWith('#')) {
        // An empty entry value is null or a nested mapping; only the latter is unreadable.
        const nested = lines.slice(index + 1).find(part => part.trim() && !/^\s*#/u.test(part));
        if (nested && /^ */u.exec(nested)![0].length > keyIndent) {
          if (relevantEnvKey(key)) scope.unknown = true;
        } else scope.entries[key] = '';
      } else {
        const decoded = envScalar(value);
        if (decoded === undefined) { if (relevantEnvKey(key)) scope.unknown = true; }
        else scope.entries[key] = decoded;
      }
    }
    // Consume all block scalars, including names/metadata, before structural scanning.
    const block = /^([|>])([-+]?)(?:\s+#.*)?$/u.exec(value);
    if (block) {
      const body: string[] = [];
      while (index + 1 < lines.length && (!lines[index + 1].trim() || /^ */u.exec(lines[index + 1])![0].length > keyIndent)) body.push(lines[++index]);
      if (run) {
        const first = body.find(part => part.trim());
        if (!first) return unreadableRun();
        const contentIndent = /^ */u.exec(first)![0].length;
        if (body.some(part => part.trim() && /^ */u.exec(part)![0].length < contentIndent)) return unreadableRun();
        runs.push({ job: jobKey, step: stepIndex, script: blockScalar(body, contentIndent, block[1] === '>', block[2]) });
      }
      continue;
    }
    if (!run) continue;
    const next = lines.slice(index + 1).find(part => part.trim() && !/^\s*#/u.test(part));
    if (next && /^ */u.exec(next)![0].length > keyIndent) return unreadableRun();
    const scalar = /^["']/u.test(value) ? quotedScalar(value) :
      !value || /^[#|>&*![{]/u.test(value) || /^(?:null|true|false|~|\d+)$/u.test(value) ? undefined : value.replace(/\s+#.*$/u, '');
    if (scalar === undefined) return unreadableRun();
    runs.push({ job: jobKey, step: stepIndex, script: scalar });
  }
  for (const run of runs) {
    const jobScope = jobEnvs[run.job] ?? emptyEnvScope();
    const stepScope = stepEnvs[`${run.job}\u0000${run.step}`] ?? emptyEnvScope();
    const effective = workflowEnv.unknown || jobScope.unknown || stepScope.unknown ? unreadableEnvScope() :
      { ...workflowEnv.entries, ...jobScope.entries, ...stepScope.entries };
    findings.push(...globalNpmInstalls(run.script, effective));
  }
  return findings;
}
