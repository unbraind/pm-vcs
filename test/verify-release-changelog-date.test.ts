/**
 * Executes the changelog-date verifier's rules against fixtures.
 *
 * The verifier's own repository satisfies its rules, so running it here would
 * only prove that today's tree is fine. What these cases prove is that each
 * rule still FAILS on the defect it exists to catch -- including the two shapes
 * that defeated the previous line-oriented implementation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DATE_FLAG,
  VERSION_INPUTS,
  auditHeadings,
  auditInvocations,
  bashArrays,
  stripComment,
  expandArrays,
  invocationsIn,
  joinContinuations,
  generateHeading,
  isMainInvocation,
  main,
  runIfMain,
  report,
  resolveGenerator,
  verify,
} from "../scripts/verify-release-changelog-date.ts";

const FLAGGED = `pm-changelog --pm-root .agents/pm --release-version-from-package ${DATE_FLAG}`;

test("every version-input spelling is recognised, because pm-changelog accepts all three", () => {
  for (const input of VERSION_INPUTS) {
    const found = invocationsIn({ file: "package.json", text: `pm-changelog ${input} v2026.1.2` });
    assert.equal(found.length, 1, `${input} must be recognised as a version input`);
  }
});

test("an invocation naming the pending tag is caught, not skipped", () => {
  // The regression Greptile found: the scan matched only the package-derived
  // spelling, so a workflow passing --version "$RELEASE_TAG" was invisible and
  // its missing flag went unreported.
  const result = auditInvocations([{
    file: ".github/workflows/release.yml",
    text: 'pm-changelog --pm-root .agents/pm --all-release-tags --version "$RELEASE_TAG" --mode replace',
  }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /carries a version input but not --date-from-version/);
});

test("a shared bash options array is expanded into each invocation that uses it", () => {
  // Declared once so the invocations cannot drift, with the effect that the
  // invocation line itself carries almost no flags.
  const text = [
    'common=(',
    '  --pm-root .agents/pm',
    `  --version "$RELEASE_TAG"`,
    `  ${DATE_FLAG}`,
    ')',
    './node_modules/.bin/pm-changelog "${common[@]}" --mode replace',
  ].join("\n");
  assert.deepEqual(auditInvocations([{ file: ".github/workflows/release.yml", text }]).failures, []);

  const withoutFlag = text.replace(`  ${DATE_FLAG}\n`, "");
  assert.equal(auditInvocations([{ file: ".github/workflows/release.yml", text: withoutFlag }]).failures.length, 1);
});

test("an unknown array reference is left in place rather than erased", () => {
  // Erasing it would turn "this scan does not understand the command" into
  // "this command carries no flags", which reads as a pass.
  assert.equal(expandArrays('cmd "${missing[@]}"', new Map()), 'cmd "${missing[@]}"');
  assert.equal(expandArrays('cmd "${known[@]}"', new Map([["known", "--a --b"]])), "cmd --a --b");
});

test("bashArrays collapses whitespace so a multi-line declaration is one flag string", () => {
  assert.equal(bashArrays("common=(\n  --a\n  --b\n)").get("common"), "--a --b");
});

test("a backslash continuation is one logical command, not fragments", () => {
  const text = `pm-changelog \\\n  --release-version-from-package \\\n  ${DATE_FLAG}`;
  assert.equal(joinContinuations(text).split("\n").length, 1);
  assert.deepEqual(auditInvocations([{ file: "package.json", text }]).failures, []);
});

test("one line holding two invocations is judged per invocation", () => {
  const unflagged = "pm-changelog --pm-root . --release-version-from-package";
  const result = auditInvocations([{ file: "package.json", text: `${FLAGGED} && ${unflagged}` }]);
  assert.equal(result.failures.length, 1, "the unflagged half must be reported even though the line carries the flag");
});

test("a mention of the flag on a non-invoking line cannot cover for an unflagged invocation", () => {
  const result = auditInvocations([{
    file: "package.json",
    text: `pm-changelog --release-version-from-package\necho "the date comes from ${DATE_FLAG}"`,
  }]);
  assert.equal(result.failures.length, 1);
});

test("a mention inside a comment is not an invocation", () => {
  const result = auditInvocations([
    { file: ".github/workflows/release.yml", text: "  # pm-changelog --release-version-from-package explains the flag" },
    { file: "package.json", text: FLAGGED },
  ]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.notes.length, 1, "the comment-only file must not be reported as verified");
});

test("finding no invocation anywhere is a failure, not a silent pass", () => {
  const result = auditInvocations([{ file: "package.json", text: "{}" }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /looking in the wrong place/);
});

test("the generator is resolved from node_modules, then dist, then the registry", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-generator-"));
  try {
    // Nothing to find: fall back to the registry rather than silently doing
    // nothing, so the failure names a missing generator.
    assert.deepEqual(resolveGenerator(root), { bin: "npx", lead: ["pm-changelog"] });

    // pm-changelog's own repository builds the generator it verifies with, so
    // the built entry point is used when there is no installed dependency.
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist/cli.js"), "");
    assert.deepEqual(resolveGenerator(root), { bin: process.execPath, lead: [join(root, "dist/cli.js")] });

    // An installed dependency wins: it is the version the package actually runs.
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.bin/pm-changelog"), "");
    assert.deepEqual(resolveGenerator(root), { bin: join(root, "node_modules/.bin/pm-changelog"), lead: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell segment that runs something else is not judged as a generator invocation", () => {
  // The release workflow pipes the generator's output through awk and sed; only
  // the segment that runs the generator carries the contract this gate audits.
  const text = `pm-changelog --release-version-from-package ${DATE_FLAG} --stdout | awk '/^## /' | sed -n '1p'`;
  assert.deepEqual(auditInvocations([{ file: ".github/workflows/release.yml", text }]).failures, []);
  assert.equal(auditInvocations([{ file: ".github/workflows/release.yml", text }]).notes.length, 1);
});

test("the behavioural half passes only when the flag changes the heading", () => {
  const good = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2026-01-02" : "## 2026.1.2 - 2026-08-27" }));
  assert.deepEqual(good.failures, []);
  assert.equal(good.notes.length, 2);
});

test("a control that fails is a failure, not a note", () => {
  // Previously `|| true` swallowed this and the script exited 0 having never
  // made the comparison that gives it meaning.
  const result = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    flagged ? { ok: true, text: "## 2026.1.2 - 2026-01-02" } : { ok: false, text: "the run failed: exit 2" });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /so the comparison proves nothing/);
});

test("a control identical to the flagged run fails, because then the flag discriminates nothing", () => {
  const result = auditHeadings("2026.1.2", "2026-08-27", () => ({ ok: true, text: "## 2026.1.2 - 2026-01-02" }));
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /the flag is changing nothing/);
});

test("a control derived some other way still passes, because the contract is that the flag changes the heading", () => {
  // Deliberately NOT today's date. Asserting the control equals today would pin
  // the generator's current default -- a compatible dependency update that
  // changed it would fail this gate with no defect -- and today's date is
  // sampled once for two subprocess runs, so a run crossing UTC midnight would
  // fail for no defect either.
  const result = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2026-01-02" : "## 2026.1.2 - 2030-12-31" }));
  assert.deepEqual(result.failures, []);
  assert.match(result.notes[1], /derived some other way/);
});

test("a flagged run that fails, or that derives the wrong date, both fail", () => {
  const failed = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    flagged ? { ok: false, text: "the run failed: exit 1" } : { ok: true, text: "## 2026.1.2 - 2026-08-27" });
  assert.equal(failed.failures.length, 1);

  const wrong = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2020-01-02" : "## 2026.1.2 - 2026-08-27" }));
  assert.equal(wrong.failures.length, 1);
  assert.match(wrong.failures[0], /expected '## 2026\.1\.2 - 2026-01-02'/);
});

test("verify runs both halves against this checkout and reports through the process streams", () => {
  const result = verify(resolve(import.meta.dirname, ".."), new Date().toISOString().slice(0, 10));
  assert.deepEqual(result.failures, [], result.failures.join("\n"));
  const previous = process.exitCode;
  report(result);
  assert.equal(process.exitCode, 0);
  report({ failures: ["a failure"], notes: [] });
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
});

test("a generator that cannot run is reported as a failed run, not as a missing heading", () => {
  const failed = generateHeading(process.execPath, ["-e", "process.exit(2)"], import.meta.dirname);
  assert.equal(failed.ok, false);
  assert.match(failed.text, /^the run failed: /);

  const silent = generateHeading(process.execPath, ["-e", "console.log('no heading here')"], import.meta.dirname);
  assert.equal(silent.ok, false);
  assert.match(silent.text, /produced no '## ' heading/);

  const good = generateHeading(process.execPath, ["-e", "console.log('## 1.2.3 - 2026-01-02')"], import.meta.dirname);
  assert.deepEqual(good, { ok: true, text: "## 1.2.3 - 2026-01-02" });
});

test("the main-invocation guard answers both ways", () => {
  const self = fileURLToPath(import.meta.resolve("../scripts/verify-release-changelog-date.ts"));
  const url = import.meta.resolve("../scripts/verify-release-changelog-date.ts");
  assert.equal(isMainInvocation(["node", self], url), true);
  assert.equal(isMainInvocation(["node", fileURLToPath(import.meta.url)], url), false);
  assert.equal(isMainInvocation(["node"], url), false);
});

test("runIfMain runs only when argv names this module, and refuses otherwise", () => {
  const url = import.meta.resolve("../scripts/verify-release-changelog-date.ts");
  assert.equal(runIfMain(["node", fileURLToPath(import.meta.url)], url, ".", "2026-01-01"), false,
    "a process entered through some other script must not run the verifier");
});

test("main verifies this checkout and reports through the process streams", () => {
  const savedExit = process.exitCode;
  const out = process.stdout.write;
  const err = process.stderr.write;
  const written: string[] = [];
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stderr.write;
  let ran = false;
  try {
    ran = runIfMain(
      ["node", fileURLToPath(import.meta.resolve("../scripts/verify-release-changelog-date.ts"))],
      import.meta.resolve("../scripts/verify-release-changelog-date.ts"),
      resolve(import.meta.dirname, ".."),
      new Date().toISOString().slice(0, 10),
    );
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.equal(ran, true, "argv naming this module must run the verifier");
  assert.equal(process.exitCode, 0, written.join(""));
  assert.ok(written.some((line) => line.startsWith("ok - ")), "main must report what it checked");
  process.exitCode = savedExit;
});

test("an unquoted trailing comment cannot supply the flag the command is missing", () => {
  // A substring check cannot tell a comment from an argument, so a comment
  // mentioning the flag satisfies the very check it complains about.
  const commented = `pm-changelog --release-version-from-package --stdout  # ${DATE_FLAG} belongs here`;
  const result = auditInvocations([{ file: "package.json", text: commented }]);
  assert.equal(result.failures.length, 1, "the comment must not stand in for the flag");

  // A `#` inside quotes is an argument: these invocations pass URLs with one.
  const quoted = `pm-changelog --release-version-from-package ${DATE_FLAG} --item-url-base "https://example.test/#anchor"`;
  assert.deepEqual(auditInvocations([{ file: "package.json", text: quoted }]).failures, []);

  assert.equal(stripComment('cmd --flag "a # b" # trailing'), 'cmd --flag "a # b" ');
  assert.equal(stripComment("cmd --flag 'a # b'"), "cmd --flag 'a # b'");
  assert.equal(stripComment("cmd --flag\\# not-a-comment"), "cmd --flag\\# not-a-comment");
  assert.equal(stripComment("#leading"), "");
});
