/**
 * Proves an untagged release's changelog heading comes from the calendar
 * version rather than from the clock, and that every generator invocation in
 * this package asks for that.
 *
 * Why this exists separately from `npm run changelog:check`: that script only
 * exercises the `package.json` invocation. `.github/workflows/release.yml`
 * calls the generator directly. If either side lost `--date-from-version` the
 * two would disagree during a release -- one heading derived from the clock,
 * the other from the version -- and the release would fail on the divergence
 * rather than on the stale date the flag exists to remove.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Repository root, derived from this file's location. */
const root = resolve(import.meta.dirname, "..");

/** Every spelling that tells the generator which version it is rendering.
 *
 * All three matter. `--release-version` is a declared alias of `--version`, and
 * a workflow that names the pending tag explicitly uses one of those two rather
 * than `--release-version-from-package`. A scan that recognised only the
 * package-derived spelling skipped exactly the release-time invocations it was
 * written to protect. */
const VERSION_INPUTS = ["--release-version-from-package", "--release-version", "--version"] as const;

/** The flag under audit: it makes the no-tag heading version-derived. */
const DATE_FLAG = "--date-from-version";

/**
 * Run a command and return its stdout.
 *
 * @param file - Executable to run.
 * @param args - Arguments passed to it.
 * @returns Standard output with the trailing newline removed.
 */
function run(file: string, args: string[]): string {
  return execFileSync(file, args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name to the flag text it holds.
 */
function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)/g)) {
    arrays.set(match[1], match[2].replace(/\s+/g, " "));
  }
  return arrays;
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g, (whole, name: string) =>
    arrays.get(name) ?? whole);
}

/** One generator invocation found in a tracked file. */
interface Invocation {
  /** File the invocation was found in. */
  file: string;
  /** The logical command, with continuations joined and arrays expanded. */
  command: string;
}

/**
 * Find every generator invocation in one tracked file.
 *
 * An invocation is a logical command that runs the generator -- by binary name,
 * or as the built `dist/cli.js` in pm-changelog's own repository -- and carries
 * at least one version input. Comment lines are excluded: a file may describe
 * these flags without running anything, and holding prose to the rule is a
 * false positive that trains people to weaken the gate.
 *
 * @param file - Repository-relative path.
 * @returns The invocations found, in file order.
 */
function invocationsIn(file: string): Invocation[] {
  const text = joinContinuations(readFileSync(resolve(root, file), "utf-8"));
  const arrays = bashArrays(text);
  const found: Invocation[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    if (!/pm-changelog|dist\/cli\.js/.test(raw)) continue;
    const command = expandArrays(raw, arrays);
    if (!VERSION_INPUTS.some((flag) => command.includes(flag))) continue;
    found.push({ file, command });
  }
  return found;
}

const failures: string[] = [];

// 1. Static invariant: every generator invocation, in every tracked file, asks
//    for the version-derived date.
//
//    Judged per INVOCATION rather than by counting. Counting matching lines
//    misses a line holding several invocations where only one is flagged;
//    counting occurrences file-wide lets an unflagged invocation hide behind a
//    mention of the flag on a line that invokes nothing at all.
const tracked = run("git", ["ls-files", "--", "package.json", ".github/workflows/*.yml", ".github/workflows/*.yaml"])
  .split("\n")
  .filter((file) => file.length > 0 && existsSync(resolve(root, file)));
const invocations = tracked.flatMap(invocationsIn);
const counted = new Map<string, { total: number; unflagged: number }>();
for (const invocation of invocations) {
  const tally = counted.get(invocation.file) ?? { total: 0, unflagged: 0 };
  tally.total += 1;
  if (!invocation.command.includes(DATE_FLAG)) {
    tally.unflagged += 1;
    failures.push(
      `${invocation.file}: a generator invocation carries a version input but not ${DATE_FLAG}: `
      + invocation.command.trim().slice(0, 160),
    );
  }
  counted.set(invocation.file, tally);
}
if (invocations.length === 0) {
  failures.push("no generator invocation was found in any tracked file - the scan is looking in the wrong place");
}
for (const [file, tally] of counted) {
  if (tally.unflagged > 0) continue;
  console.log(`ok - ${file}: ${tally.total} generator invocation(s), each carrying ${DATE_FLAG}`);
}

// 2. Behavioural: the flag is what makes the date version-derived. A probe
//    version deliberately unequal to today, so a clock-derived heading and a
//    version-derived heading cannot coincide and the assertion discriminates.
const probe = "2026.1.2";
const expected = `## ${probe} - 2026-01-02`;
const todayHeading = `## ${probe} - ${new Date().toISOString().slice(0, 10)}`;
// In pm-changelog's own repository the generator is the build output, not a
// dependency, so resolve it in that order rather than assuming node_modules.
const local = resolve(root, "node_modules/.bin/pm-changelog");
const built = resolve(root, "dist/cli.js");
const [bin, lead] = existsSync(local)
  ? [local, [] as string[]]
  : existsSync(built)
    ? [process.execPath, [built]]
    : ["npx", ["pm-changelog"]];
// The generator refuses a truncated workspace read rather than silently
// omitting entries, so the unbounded controls the real scripts pass are
// required here too.
const common = [
  ...lead,
  "--pm-root", ".agents/pm",
  "--stdout",
  "--pm-bin", "./node_modules/.bin/pm",
  "--pm-arg=--output-budget", "--pm-arg=unbounded",
  "--pm-arg=--output-limit", "--pm-arg=unbounded",
  "--release-version", probe,
];

/**
 * Generate against the probe version and return its first heading.
 *
 * Failure is reported rather than swallowed. The unflagged run is the control
 * that gives the comparison its meaning, so a control that did not run leaves
 * the assertion unmade -- previously it was suppressed with `|| true` and its
 * failure downgraded to a note, letting the script exit zero having proved
 * nothing.
 *
 * @param flagged - Whether to pass the flag under audit.
 * @returns The first `## ` heading, or a description of why there was none.
 */
function heading(flagged: boolean): { ok: boolean; text: string } {
  try {
    const out = execFileSync(bin, flagged ? [...common, DATE_FLAG] : common, {
      cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
    });
    const line = out.split("\n").find((candidate) => candidate.startsWith("## "));
    return line === undefined ? { ok: false, text: "the run produced no '## ' heading" } : { ok: true, text: line };
  } catch (error) {
    return { ok: false, text: `the run failed: ${(error as Error).message.split("\n")[0]}` };
  }
}

const withFlag = heading(true);
if (!withFlag.ok) failures.push(`with ${DATE_FLAG}, ${withFlag.text}`);
else if (withFlag.text !== expected) failures.push(`with ${DATE_FLAG} expected '${expected}', got '${withFlag.text}'`);
else console.log(`ok - with the flag the heading is version-derived: ${withFlag.text}`);

const withoutFlag = heading(false);
if (!withoutFlag.ok) failures.push(`without ${DATE_FLAG}, ${withoutFlag.text}, so the comparison proves nothing`);
else if (withoutFlag.text !== todayHeading) {
  failures.push(`without ${DATE_FLAG} expected the clock-derived '${todayHeading}', got '${withoutFlag.text}' - the control is not measuring the clock`);
} else console.log(`ok - without the flag the heading is clock-derived: ${withoutFlag.text} (this is the defect the flag removes)`);

for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
