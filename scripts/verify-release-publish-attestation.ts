/**
 * Refuse a release whose `npm publish` would run without `--provenance`.
 *
 * Thin launcher over the canonical auditor published as `pm-ops/attestation`,
 * so the fleet enforces one shell model rather than a vendored copy per
 * repository. That distinction is not stylistic. This gate decides whether an
 * artefact may reach the registry, so a *false pass* is the failure that
 * matters, and the canonical implementation has had fifteen separate fail-open
 * constructions found and closed in it - three of them introduced by the fix
 * for an earlier one. A copy of this file frozen at any point in that sequence
 * is a copy that still admits every construction closed after it.
 *
 * Every rule lives in the auditor: which files GitHub Actions executes as
 * shell, how YAML block scalars are dedented and folded before bash sees them,
 * how a scalar binding becomes visible or stops being visible across
 * conditional arms, and what counts as a publish. This file only chooses the
 * root, maps the report onto the process streams, and sets the exit code.
 *
 * Deliberately carries no shebang. The auditor reads a shebang naming a SHELL
 * interpreter as saying the file's body is shell, so `#!/bin/bash` or
 * `#!/usr/bin/env sh` pulls this file into its own scan - and its prose, which
 * necessarily names the command it is guarding, then reads as an unattested
 * invocation. A shebang naming a non-shell interpreter does not: a shebang says
 * a file executes, it does not say it executes AS shell, so `#!/usr/bin/env node`
 * leaves this file unscanned. The suite reproduces six interpreters rather than
 * asserting any of them, because an earlier wording of this paragraph claimed a
 * rule the auditor does not have. The vendored predecessor had no shebang for the same reason.
 */

import { resolve } from "node:path";

import { auditPublishAttestation, report, verify } from "pm-ops/attestation";

import { isMainInvocation } from "./main-invocation.ts";

export { auditPublishAttestation, verify };

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from any
 * in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @returns True when the verifier ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  report(verify(root), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));