/** Test-only workflow adapter using the repository's existing YAML dependency. */
import { parseDocument } from 'yaml';

/** Inspect shell commands without executing them or expanding variables. */
const installAliases = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
/** Configuration operands must never become the npm subcommand or a package. */
const valueFlags = new Set(['--prefix', '--cache', '--registry', '--userconfig', '--globalconfig', '--location', '-L', '--workspace', '-w', '--tag', '--access', '--otp', '--loglevel', '--omit', '--include']);

/** Join continuations and split/tokenize only outside simple shell quotes. */
function shellCommands(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let active = false;
  const finishWord = (): void => {
    if (active) words.push(word);
    word = '';
    active = false;
  };
  const finishCommand = (): void => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const script = source.replace(/\\\r?\n/gu, '');
  for (let index = 0; index < script.length; index++) {
    const character = script[index];
    if (character === '\\' && quote !== "'") {
      const next = script[index + 1];
      if (next !== undefined && (!quote || /["\\$`]/u.test(next))) {
        word += next;
        active = true;
        index++;
        continue;
      }
    }
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      active = true;
    } else if (character === '#' && !active) {
      while (index < script.length && script[index] !== '\n') index++;
      finishCommand();
    } else if (';|\n'.includes(character) || (character === '&' && script[index + 1] === '&')) {
      finishCommand();
      if ((character === '&' || character === '|') && script[index + 1] === character) index++;
    } else if (/\s/u.test(character)) finishWord();
    else {
      word += character;
      active = true;
    }
  }
  finishCommand();
  return commands;
}

/** Return global npm replacement commands, allowing prefix-local and other-package installs. */
export function globalNpmInstalls(script: string): string[][] {
  return shellCommands(script).filter(words => {
    let index = 0;
    while (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(words[index] ?? '')) index++;
    if (!/(?:^|\/)npm$/u.test(words[index++] ?? '')) return false;
    let subcommand: string | undefined;
    let global = false;
    let options = true;
    const packages: string[] = [];
    for (; index < words.length; index++) {
      const word = words[index];
      if (options && word === '--') { options = false; continue; }
      if (options && ['-g', '--global', '--global=true'].includes(word)) {
        global = true;
        if (words[index + 1] === 'true' || words[index + 1] === 'false') global = words[++index] === 'true';
      } else if (options && (word === '--location=global' || word === '-L=global')) global = true;
      else if (options && valueFlags.has(word)) {
        const value = words[++index];
        if ((word === '--location' || word === '-L') && value === 'global') global = true;
      } else if (options && word.startsWith('-')) continue;
      else if (subcommand === undefined) subcommand = word;
      else packages.push(word);
    }
    return installAliases.has(subcommand ?? '') && global && packages.some(word => word === 'npm' || word.startsWith('npm@'));
  });
}

/** Inspect only run scripts; comments, names and unrelated YAML scalars are inert. */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error('invalid workflow YAML');
  const scripts: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'run' && typeof entry === 'string') scripts.push(entry);
      else visit(entry);
    }
  };
  visit(document.toJS({ maxAliasCount: 100 }));
  return scripts.flatMap(globalNpmInstalls);
}
