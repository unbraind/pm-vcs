/**
 * Convergence tests for the publish-attestation gate.
 *
 * This repository no longer implements the gate; it consumes the canonical
 * auditor from `pm-ops/attestation`. So these tests deliberately do NOT
 * re-test the shell model - that suite lives with the implementation, where a
 * fix reaches every consumer at once. What they assert instead is that this
 * repository is still a consumer: that the gate resolves to the package export
 * rather than to a local copy, and that it still refuses an unattested publish
 * through that resolved path.
 *
 * The first is the one that matters over time. Fifteen fail-open constructions
 * have been found in this gate, three of them introduced by the fix for an
 * earlier one, and a copy frozen at any point in that sequence still admits
 * every construction closed after it. A hand-edit that re-forks the lineage
 * would otherwise be invisible.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auditPublishAttestation, report, verify } from "pm-ops/attestation";

import { auditPublishAttestation as launcherAudit, runIfMain, verify as launcherVerify } from "../scripts/verify-release-publish-attestation.ts";

const root = resolve(import.meta.dirname, "..");

test("the gate is the resolved package export, not a local copy", async () => {
  // Identity, not similarity. A vendored copy that happens to behave the same
  // today is exactly what this fleet spent a session removing, because it stops
  // behaving the same the moment the canonical implementation is fixed again.
  assert.equal(
    existsSync(resolve(root, "scripts/shell-command-scan.ts")),
    false,
    "a local shell-command-scan.ts means the lineage has been re-forked",
  );

  const launcher = await readFile(resolve(root, "scripts/verify-release-publish-attestation.ts"), "utf-8");
  assert.match(launcher, /from "pm-ops\/attestation"/u, "the gate must import the canonical auditor");
  assert.doesNotMatch(
    launcher,
    /from "\.\/shell-command-scan/u,
    "the gate must not resolve any part of its shell model locally",
  );

  // The functions the launcher re-exports are the package's own, by reference.
  assert.equal(typeof launcherVerify, "function");
  assert.equal(typeof launcherAudit, "function");
  assert.equal(typeof report, "function");
  assert.equal(launcherVerify, verify, "the launcher must re-export the package's own verify");
  assert.equal(launcherAudit, auditPublishAttestation, "the launcher must re-export the package's own audit");
});

test("the resolved gate still refuses an unattested publish", () => {
  // A behavioural check through the real resolved module, so "it imports the
  // package" cannot pass while the package fails to load or changes shape.
  const workflow = (publish: string): string =>
    ["jobs:", "  release:", "    steps:", "      - run: |", `          ${publish}`].join("\n");

  const unattested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public") },
  ]);
  assert.equal(unattested.failures.length, 1);

  const attested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public --provenance") },
  ]);
  assert.deepEqual(attested.failures, []);
  assert.deepEqual(attested.recognition, { kind: "recognized", count: 1 });
});

/**
 * Shell constructions that hand `npm publish` an unreadable `--provenance`
 * binding, each of which a fail-open auditor accepts as attested.
 *
 * These seven were admitted by the canonical auditor at pm-ops 2026.9.7 — the
 * version this repository's lockfile installed until 2026.9.9 — and are refused
 * from 2026.9.9 on. They are reproduced here, at consumer level, because a
 * dependency bump is not a guard: nothing in this repository failed while it was
 * installing an auditor that accepted all seven, and nothing would fail again if
 * a later lockfile change put one back. The property asserted is behavioural —
 * *this* construction is refused by whichever auditor is installed — not a
 * version comparison, which would still pass against a regressed release
 * numbered above any floor.
 */
const FAIL_OPEN_CONSTRUCTIONS: ReadonlyArray<{ id: string; script: string }> = [
  { id: "nonliteral-overwrite", script: "FLAG=--provenance\nFLAG=$OTHER\nnpm publish $FLAG --access public\n" },
  { id: "nonliteral-overwrite-cmdsub", script: "FLAG=--provenance\nFLAG=$(cat /tmp/x)\nnpm publish $FLAG --access public\n" },
  { id: "quoted-metachar-value", script: "FLAG=\"--provenance;\"\nnpm publish $FLAG --access public\n" },
  { id: "single-quoted-metachar-value", script: "FLAG='--provenance;'\nnpm publish $FLAG --access public\n" },
  { id: "multiword-unreadable-tail", script: "FLAG=--provenance\nNOOP=x FLAG=$(true)\nnpm publish $FLAG --access public\n" },
  { id: "quoted-paren-in-substitution", script: "FLAG=--provenance\nFLAG=$(printf ') ' )\nnpm publish $FLAG --access public\n" },
  { id: "unterminated-substitution", script: "FLAG=--provenance\nFLAG=$(unterminated\nnpm publish $FLAG --access public\n" },
];

test("the installed auditor refuses every known fail-open provenance handoff", () => {
  for (const { id, script } of FAIL_OPEN_CONSTRUCTIONS) {
    const audited = auditPublishAttestation([
      { file: `.github/case-${id}.sh`, text: `#!/usr/bin/env bash\n${script}` },
    ]);
    assert.ok(
      audited.failures.length > 0,
      `the installed pm-ops auditor accepted the ${id} construction as attested; `
      + "an unattested publish would reach the registry",
    );
  }
});

test("the fail-open guard still admits a genuinely attested publish", () => {
  // Without this control the guard above passes against an auditor that refuses
  // everything, which would be just as broken and far easier to ship.
  const audited = auditPublishAttestation([
    {
      file: ".github/case-control.sh",
      text: "#!/usr/bin/env bash\nFLAG=--provenance\nnpm publish $FLAG --access public\n",
    },
  ]);
  assert.deepEqual(audited.failures, [], "a readable --provenance binding must still pass");
});

test("this repository's own workflows pass the gate", () => {
  // The gate pointed at this checkout, which is what CI runs. Reported through
  // captured streams rather than the process ones so a failure is readable.
  const lines: string[] = [];
  let exitCode = 0;
  report(verify(root), (line) => lines.push(line), (code) => { exitCode = code; });
  assert.equal(exitCode, 0, `the gate must pass on this repository:\n${lines.join("\n")}`);
  assert.ok(lines.some((line) => line.includes("every publish invocation is attested")));
});

test("the launcher runs only as the process entry point", () => {
  // A bare `if` at module scope leaves its own body unreachable from any
  // in-process test, which is how an entry point quietly stops running.
  // A real path that is not this module: isMainInvocation resolves the argv
  // entry, so a nonexistent one throws rather than answering the question.
  assert.equal(runIfMain(["node", resolve(root, "package.json")], import.meta.url, root), false);
  // An argv with no entry at all: node was given no script, so there is no path
  // to compare and nothing can be the entry point. Reached in practice when the
  // module is imported by a runner that rewrites argv, and it must answer false
  // rather than resolve `undefined` as a path.
  assert.equal(runIfMain(["node"], import.meta.url, root), false);
});

/**
 * A throwaway git repository containing one file, for the gate to discover.
 *
 * Staged rather than committed: the gate finds files through `git ls-files`,
 * which reads the index, so a commit would add nothing except a dependency on
 * ambient git identity configuration.
 *
 * @param prefix - Temp directory name prefix, for readable failures.
 * @param file - Repository-relative path to write.
 * @param contents - What to write there.
 * @param use - Receives the repository root; the tree is removed afterwards.
 * @returns Whatever `use` returned.
 */
function withTrackedFixture<T>(prefix: string, file: string, contents: string, use: (root: string) => T): T {
  const fixture = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    mkdirSync(resolve(fixture, dirname(file)), { recursive: true });
    writeFileSync(resolve(fixture, file), contents);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", file], { cwd: fixture });
    return use(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * Structurally different publishes, so output equality means the executed path
 * agrees with the package across the SHAPE SPACE rather than on one string.
 *
 * A single fixture can be satisfied by a local verifier that hardcodes that one
 * report. These cannot: each exercises a different decision in the auditor -
 * whether a publish is recognised at all, whether an unresolved program is
 * audited, whether a foreign publisher counts, and whether an attested publish
 * is left alone. A local implementation that matched all of them across every
 * decision would be a reimplementation of the auditor, which is the thing being
 * ruled out.
 */
const ENTRY_PATH_FIXTURES: ReadonlyArray<{ name: string; publish: string; failing: boolean }> = [
  { name: "a plain unattested publish", publish: "npm publish --access public", failing: true },
  { name: "an unresolved program that cannot be proven not to publish", publish: "$(echo npm) publish", failing: true },
  { name: "a foreign publisher", publish: "pnpm publish --access public", failing: true },
  { name: "an attested publish, which must produce no failure", publish: "npm publish --provenance --access public", failing: false },
];

test("the entry path produces the package verifier's own report for every publish shape", () => {
  // The positive branch of the entry-point guard: argv[1] and moduleUrl both
  // resolve to the launcher's own path, so isMainInvocation answers true and
  // runIfMain executes the gate for real - writing to process.stdout and
  // setting process.exitCode.
  //
  // Re-export identity pins the IMPORTED binding, not the one runIfMain calls,
  // so a future edit could divert the executed path alone and leave every other
  // assertion green. Comparing what the entry path writes against the package's
  // own report(verify(...)) binds the two.
  //
  // What this does NOT establish, stated so it is not over-read: ESM gives no
  // way to observe the call target from outside the module, so this is agreement
  // across a shape space, not call-site identity. It is why the space is varied
  // rather than a single fixture.
  const launcherPath = resolve(root, "scripts/verify-release-publish-attestation.ts");
  const launcherUrl = pathToFileURL(launcherPath).href;

  const capture = (run: () => void): string => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      run();
    } finally {
      process.stdout.write = original;
    }
    return written.join("");
  };

  for (const shape of ENTRY_PATH_FIXTURES) {
    // Staged is enough: the gate discovers files through `git ls-files`, which
    // reads the index. Committing would also make the fixture depend on ambient
    // git identity configuration for no gain.
    withTrackedFixture(
      "pm-vcs-attestation-fixture-",
      ".github/workflows/release.yml",
      ["jobs:", "  release:", "    steps:", "      - run: |", `          ${shape.publish}`].join("\n") + "\n",
      (fixture) => {
      const savedExitCode = process.exitCode;
      try {
        let ran = false;
        const launcherOutput = capture(() => {
          ran = runIfMain(["node", launcherPath], launcherUrl, fixture);
        });
        assert.equal(ran, true, `${shape.name}: the launcher must run the gate when it is the entry point`);
        assert.equal(
          process.exitCode,
          shape.failing ? 1 : savedExitCode,
          `${shape.name}: the exit code must follow the verdict`,
        );

        process.exitCode = savedExitCode;
        const packageOutput = capture(() => {
          report(verify(fixture), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
        });
        assert.equal(
          launcherOutput,
          packageOutput,
          `${shape.name}: the entry path must produce the package verifier's own report, not a local equivalent`,
        );
        if (shape.failing) {
          // Name the file. `report` sets exit code 1 for ANY failure, so
          // asserting only that one occurred would let an unrelated failure - a
          // fixture that tracked nothing, say - stand in for the publish this
          // case exists to catch, and the byte comparison would still hold
          // because both sides made the same mistake.
          assert.match(
            launcherOutput,
            /FAIL - \.github\/workflows\/release\.yml/u,
            `${shape.name}: the failure must name the fixture's own workflow`,
          );
        } else {
          assert.doesNotMatch(launcherOutput, /FAIL - /u, `${shape.name}: an attested publish must produce no failure`);
        }
      } finally {
        process.exitCode = savedExitCode;
      }
      },
    );
  }
});

/**
 * Reproduce the shebang rule this file's own docstring relies on.
 *
 * The launcher deliberately carries no shebang, and the reason is a concrete
 * claim about the auditor: a shebang naming a SHELL interpreter makes the
 * file's body shell, at which point this file's prose - which necessarily names
 * the command it is guarding - reads as an unattested publish. The claim is
 * reproduced here rather than asserted, because an earlier wording of it said
 * ANY shebang had that effect, and that is not what the auditor does: a shebang
 * says a file executes, not that it executes as shell.
 */
test("only a shebang naming a shell interpreter pulls this file into the scan", () => {
  const body = readFileSync(resolve(root, "scripts/verify-release-publish-attestation.ts"), "utf8");
  // The whole test turns on this file's prose naming the command it guards: that
  // is what the auditor reads as an unattested publish once the body is treated
  // as shell. If the prose stopped mentioning it, every case below would report
  // "not shell input" and the test would pass for the wrong reason.
  assert.match(body, /npm publish/u, "this file must mention the command it guards for the scan to have anything to find");
  const scannedAsShell = (shebang: string): boolean =>
    withTrackedFixture("shebang-", "scripts/verify-release-publish-attestation.ts", shebang + body, (dir) =>
      // The file is reported by name only when the auditor read its body as
      // shell; otherwise the only failure is that the throwaway repository
      // contains no publish at all.
      verify(dir).failures.some((failure) => failure.includes("scripts/verify-release-publish-attestation.ts")));
  assert.equal(scannedAsShell("#!/bin/bash\n"), true, "a bash shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env sh\n"), true, "an env sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/bin/sh\n"), true, "a plain sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env node\n"), false, "a node shebang does not make this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env python3\n"), false, "a non-shell interpreter does not make this file shell input");
  assert.equal(scannedAsShell(""), false, "with no shebang the file is not shell input, which is why it has none");
});
