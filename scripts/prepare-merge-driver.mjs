import { execSync } from 'node:child_process';
import { accessSync, statSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';

// Wire pm-cli's field-aware Git merge drivers into this clone's local Git config on
// install/clone, but only when the `pm` CLI is actually available. Implemented in Node
// (not a POSIX `if ...; then ...; fi` shell guard) so it runs identically on POSIX shells
// and Windows cmd.exe (npm's default script shell) with no shell-operator parsing.

const isWindows = process.platform === 'win32';

/** A PATH candidate counts only if it is a regular, executable file — mirroring how a
 *  shell resolves a bare command name. Rejects directories and (on POSIX) non-executable
 *  files, so a stray `pm` dir/data file never makes `execSync` fail the whole install. */
function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false; // ENOENT / not accessible
  }
  if (isWindows) return true; // Windows keys executability off PATHEXT, not a mode bit
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is the `pm` executable resolvable on PATH? Resolved by inspecting PATH directly
 *  (never by executing `pm`), so a present-but-broken CLI is NOT mistaken for "absent":
 *  absence => silent skip, presence => run fail-loud below. npm prepends
 *  `node_modules/.bin` to PATH for lifecycle scripts, so a devDep-installed pm is found.
 *  PATH parsing mirrors shell semantics: an empty POSIX entry means the current
 *  directory, and Windows entries may be wrapped in double quotes. */
function pmOnPath() {
  const dirs = (process.env.PATH || '')
    .split(delimiter)
    .map((dir) => {
      let d = dir;
      if (isWindows && d.length >= 2 && d.startsWith('"') && d.endsWith('"')) {
        d = d.slice(1, -1);
      }
      // Empty component: current dir on POSIX; ignored on Windows.
      return d === '' ? (isWindows ? '' : '.') : d;
    })
    .filter((d) => d !== '');
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableFile(join(dir, `pm${ext}`))) return true;
    }
  }
  return false;
}

if (!pmOnPath()) {
  // `pm` is not installed (e.g. a production / `--omit=dev` install, or a consumer
  // machine without the CLI) — skip merge-driver wiring silently, don't fail install.
  process.exit(0);
}

// `pm` IS present: wire the drivers. If this genuinely fails (e.g. a broken or
// incompatible CLI), surface it fail-loud (non-zero exit) rather than swallowing it.
execSync('pm merge install', { stdio: 'inherit' });
