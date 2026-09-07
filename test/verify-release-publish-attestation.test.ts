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
import { resolve } from "node:path";
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

test("the launcher runs the gate and sets a failing exit code on an unattested publish when it is the entry point", () => {
  // The positive branch: argv[1] and moduleUrl both resolve to the launcher's
  // own path, so isMainInvocation answers true and runIfMain executes the gate
  // for real — writing to process.stdout and setting process.exitCode. Against
  // a fixture with an unattested publish, the gate must set exit code 1 and
  // return true. A regression that removes the `process.exitCode = code`
  // assignment from the launcher, or that makes isMainInvocation return false
  // for a real invocation, leaves the gate silently exiting 0 on an unattested
  // publish — exactly the failure this test's own comment warns about.
  const launcherPath = resolve(root, "scripts/verify-release-publish-attestation.ts");
  const launcherUrl = pathToFileURL(launcherPath).href;

  // A fixture repository with one unattested publish, tracked by git so
  // verify(root) — which calls `git ls-files` — discovers it.
  const fixture = mkdtempSync(resolve(tmpdir(), "pm-vcs-attestation-fixture-"));
  try {
    mkdirSync(resolve(fixture, ".github/workflows"), { recursive: true });
    writeFileSync(
      resolve(fixture, ".github/workflows/release.yml"),
      ["jobs:", "  release:", "    steps:", "      - run: |", "          npm publish --access public"].join("\n") + "\n",
    );
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: fixture });
    // Staged is enough: the gate discovers files through `git ls-files`, which
    // reads the index. Committing would also make the fixture depend on ambient
    // git identity configuration for no gain.
    execFileSync("git", ["add", ".github/workflows/release.yml"], { cwd: fixture });

    // What the ENTRY PATH actually produces. Re-export identity pins the
    // imported binding; it does not pin the one runIfMain calls, so a future
    // edit could divert the executed path alone and keep every other assertion
    // green. Capturing stdout and comparing it to the package's own
    // report(verify(...)) binds the two: a local reimplementation would have to
    // reproduce the canonical auditor's exact failure wording to pass, and
    // reproducing it IS being it.
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

    const savedExitCode = process.exitCode;
    try {
      let ran = false;
      const launcherOutput = capture(() => {
        ran = runIfMain(["node", launcherPath], launcherUrl, fixture);
      });
      assert.equal(ran, true, "the launcher must run the gate when it is the entry point");
      assert.equal(process.exitCode, 1, "an unattested publish must set a failing exit code");

      process.exitCode = savedExitCode;
      const packageOutput = capture(() => {
        report(verify(fixture), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
      });
      assert.equal(
        launcherOutput,
        packageOutput,
        "the entry path must produce the package verifier's own report, not a local equivalent",
      );
      assert.match(launcherOutput, /FAIL - /u, "the fixture must actually produce a failure to compare");
    } finally {
      process.exitCode = savedExitCode;
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
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
  const scannedAsShell = (shebang: string): boolean => {
    const dir = mkdtempSync(resolve(tmpdir(), "shebang-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(resolve(dir, "scripts"), { recursive: true });
      writeFileSync(resolve(dir, "scripts/verify-release-publish-attestation.ts"), shebang + body);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      // The file is reported by name only when the auditor read its body as
      // shell; otherwise the only failure is that the throwaway repository
      // contains no publish at all.
      return verify(dir).failures.some((failure) => failure.includes("scripts/verify-release-publish-attestation.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(scannedAsShell("#!/bin/bash\n"), true, "a bash shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env sh\n"), true, "an env sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/bin/sh\n"), true, "a plain sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env node\n"), false, "a node shebang does not make this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env python3\n"), false, "a non-shell interpreter does not make this file shell input");
  assert.equal(scannedAsShell(""), false, "with no shebang the file is not shell input, which is why it has none");
});
