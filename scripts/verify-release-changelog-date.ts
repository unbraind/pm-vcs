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
 * The analysis is separated from the I/O so the rules below are executed by the
 * test suite against fixtures rather than only against this repository, which
 * happens to satisfy them.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Every spelling that tells the generator which version it is rendering.
 *
 * All three matter. `--release-version` is a declared alias of `--version`, and
 * a workflow that names the pending tag explicitly uses one of those two rather
 * than `--release-version-from-package`. A scan that recognised only the
 * package-derived spelling skipped exactly the release-time invocations it was
 * written to protect. */
export const VERSION_INPUTS = ["--release-version-from-package", "--release-version", "--version"] as const;

/** The flag under audit: it makes the no-tag heading version-derived. */
export const DATE_FLAG = "--date-from-version";

/** One generator invocation found in a tracked file. */
export interface Invocation {
  /** File the invocation was found in. */
  file: string;
  /** The logical command, with continuations joined and arrays expanded. */
  command: string;
}

/** A tracked file's path and contents. */
export interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
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
export function joinContinuations(text: string): string {
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
 * @returns Array name mapped to the flag text it holds.
 */
export function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)/g)) {
    arrays.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
export function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g, (whole, name: string) =>
    arrays.get(name) ?? whole);
}

/**
 * Find every generator invocation in one file's contents.
 *
 * An invocation is a logical command that runs the generator -- by binary name,
 * or as the built `dist/cli.js` in pm-changelog's own repository -- and carries
 * at least one version input. Comment lines are excluded: a file may describe
 * these flags without running anything, and holding prose to the rule is a
 * false positive that trains people to weaken the gate.
 *
 * @param source - The file's path and contents.
 * @returns The invocations found, in file order.
 */
export function invocationsIn(source: SourceFile): Invocation[] {
  const text = joinContinuations(source.text);
  const arrays = bashArrays(text);
  const found: Invocation[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    if (!/pm-changelog|dist\/cli\.js/.test(raw)) continue;
    // Split on shell separators AFTER expanding arrays. One line can hold
    // several invocations -- a package.json script chaining two generator calls
    // with `&&` is the common case -- and judging the line as a whole lets a
    // flagged call cover for an unflagged one beside it.
    for (const segment of expandArrays(raw, arrays).split(/\s(?:&&|\|\||;|\|)\s/)) {
      if (!/pm-changelog|dist\/cli\.js/.test(segment)) continue;
      if (!VERSION_INPUTS.some((flag) => segment.includes(flag))) continue;
      found.push({ file: source.file, command: segment });
    }
  }
  return found;
}

/** The outcome of one verifier run. */
export interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}

/**
 * Audit every generator invocation across the given files.
 *
 * Judged per invocation rather than by counting: counting matching lines misses
 * a line holding several invocations where only one is flagged, and counting
 * occurrences file-wide lets an unflagged invocation hide behind a mention of
 * the flag on a line that invokes nothing at all.
 *
 * @param sources - The tracked files to scan.
 * @returns Failures and per-file notes.
 */
export function auditInvocations(sources: SourceFile[]): VerifierResult {
  const invocations = sources.flatMap(invocationsIn);
  const failures: string[] = [];
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
  const notes: string[] = [];
  for (const [file, tally] of counted) {
    if (tally.unflagged > 0) continue;
    notes.push(`ok - ${file}: ${tally.total} generator invocation(s), each carrying ${DATE_FLAG}`);
  }
  return { failures, notes };
}

/** A generator run's first `## ` heading, or why there was none. */
export interface HeadingResult {
  /** Whether the run produced a heading at all. */
  ok: boolean;
  /** The heading, or a description of the failure. */
  text: string;
}

/**
 * Compare the flagged and unflagged headings for one probe version.
 *
 * The unflagged run is the control: it is what proves the flag is doing the
 * work rather than the heading happening to be right for another reason. A
 * control that failed to run leaves the comparison unmade, so its failure is a
 * failure here -- it was previously suppressed with `|| true` and downgraded to
 * a note, letting the script exit zero having proved nothing.
 *
 * @param probe - Probe version, deliberately not today's date.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @param generate - Runs the generator; `flagged` selects `--date-from-version`.
 * @returns Failures and notes for the behavioural half.
 */
export function auditHeadings(
  probe: string,
  today: string,
  generate: (flagged: boolean) => HeadingResult,
): VerifierResult {
  const expected = `## ${probe} - ${probe.replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2}).*$/, (_all, y: string, m: string, d: string) =>
    `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`)}`;
  const todayHeading = `## ${probe} - ${today}`;
  const failures: string[] = [];
  const notes: string[] = [];

  const flagged = generate(true);
  if (!flagged.ok) failures.push(`with ${DATE_FLAG}, ${flagged.text}`);
  else if (flagged.text !== expected) failures.push(`with ${DATE_FLAG} expected '${expected}', got '${flagged.text}'`);
  else notes.push(`ok - with the flag the heading is version-derived: ${flagged.text}`);

  const control = generate(false);
  if (!control.ok) failures.push(`without ${DATE_FLAG}, ${control.text}, so the comparison proves nothing`);
  else if (control.text === flagged.text) {
    failures.push(
      `the heading is '${control.text}' with and without ${DATE_FLAG} - the flag is changing nothing, so`
      + " nothing here proves the date is version-derived",
    );
  } else {
    // What must hold is that the flag CHANGES the outcome. Asserting the
    // control equals today's date instead would pin the generator's current
    // default, so a compatible dependency update that changed it would fail
    // this gate for no defect; and today's date is sampled once for two
    // subprocess runs, so a run crossing UTC midnight would fail for no defect
    // either. Whether the control happens to be the clock is reported, not
    // required.
    const derivation = control.text === todayHeading ? "clock-derived" : "derived some other way";
    notes.push(`ok - the flag changes the heading: '${flagged.text}' with it, '${control.text}' without (${derivation})`);
  }

  return { failures, notes };
}

/**
 * Resolve the generator this repository should run.
 *
 * In pm-changelog's own repository the generator is the build output rather
 * than a dependency, so resolve in that order instead of assuming node_modules.
 *
 * @param root - Repository root.
 * @returns The executable and any leading arguments.
 */
export function resolveGenerator(root: string): { bin: string; lead: string[] } {
  const local = resolve(root, "node_modules/.bin/pm-changelog");
  if (existsSync(local)) return { bin: local, lead: [] };
  const built = resolve(root, "dist/cli.js");
  if (existsSync(built)) return { bin: process.execPath, lead: [built] };
  return { bin: "npx", lead: ["pm-changelog"] };
}

/**
 * Run the generator once and return its first `## ` heading.
 *
 * A run that fails is reported as a failed run rather than as an absent
 * heading, because the two have different remedies and conflating them is how
 * a broken generator reads as a passing gate.
 *
 * @param bin - Executable to run.
 * @param args - Arguments to pass.
 * @param cwd - Directory to run in.
 * @returns The heading, or why there was none.
 */
export function generateHeading(bin: string, args: string[], cwd: string): HeadingResult {
  try {
    const out = execFileSync(bin, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    const line = out.split("\n").find((candidate) => candidate.startsWith("## "));
    return line === undefined ? { ok: false, text: "the run produced no '## ' heading" } : { ok: true, text: line };
  } catch (error) {
    return { ok: false, text: `the run failed: ${(error as Error).message.split("\n")[0]}` };
  }
}

/**
 * Run both halves of the verifier against a real checkout.
 *
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @returns Failures and notes from both halves.
 */
export function verify(root: string, today: string): VerifierResult {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "package.json", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
    { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  )
    .trimEnd()
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));
  const sources = tracked.map((file) => ({ file, text: readFileSync(resolve(root, file), "utf-8") }));
  const statics = auditInvocations(sources);

  const probe = "2026.1.2";
  const { bin, lead } = resolveGenerator(root);
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
  const behavioural = auditHeadings(probe, today, (flagged) =>
    generateHeading(bin, flagged ? [...common, DATE_FLAG] : common, root));

  return {
    failures: [...statics.failures, ...behavioural.failures],
    notes: [...statics.notes, ...behavioural.notes],
  };
}

/**
 * Report a verifier result on the process streams and set the exit code.
 *
 * @param result - The result to report.
 */
export function report(result: VerifierResult): void {
  for (const note of result.notes) process.stdout.write(`${note}\n`);
  for (const failure of result.failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exitCode = result.failures.length === 0 ? 0 : 1;
}

/**
 * Whether this module is the process entry point.
 *
 * Kept as a named function rather than an inline comparison so the suite can
 * execute both answers; a guard nothing exercises is how an entry point stops
 * running and nobody notices.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - The module's own `import.meta.url`.
 * @returns True when argv names this module as the script being run.
 */
export function isMainInvocation(argv: string[], moduleUrl: string): boolean {
  const script = argv[1];
  return script !== undefined && moduleUrl === pathToFileURL(resolve(script)).href;
}

/**
 * Verify this repository and report the result.
 *
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 */
export function main(root: string, today: string): void {
  report(verify(root, today));
}

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from
 * any in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @returns True when the verifier ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string, today: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  main(root, today);
  return true;
}

// Run only as main, so the suite can import the rules above and execute them
// against fixtures rather than only against this repository.
runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."), new Date().toISOString().slice(0, 10));
