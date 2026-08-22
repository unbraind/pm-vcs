import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import { VcsError } from "../git.ts";
import extension, {
  assertPreflightPassed,
  assertPreviewWithinThreshold,
  previewExitCode,
  readStringOption,
  resolveRoots,
} from "../index.ts";
import type { PreflightReport } from "../preflight.ts";
import type { PreviewReport } from "../preview.ts";
import { type Sandbox, createDivergedSandbox, createSandbox, packageRoot } from "./helpers/sandbox.ts";

const sandboxes: Sandbox[] = [];

/**
 * Registers a sandbox for teardown and returns it.
 *
 * @param sandbox - Sandbox to track.
 * @returns The same sandbox.
 */
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

/**
 * Capability list the harness accepts, derived from its own signature rather
 * than restated, so a capability added to the host shows up here automatically.
 */
type HarnessCapabilities = NonNullable<
  NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]
>;

/** The shipped manifest, read from disk so tests assert against the real file. */
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  name: string;
  version: string;
  entry: string;
  capabilities: HarnessCapabilities;
};

/**
 * Activates the extension through the host's own activation path.
 *
 * The SDK harness runs the real loader, so a registration the runtime would
 * reject fails here too. Asserting against a hand-built `api` double would only
 * assert against this test's assumptions — and the loader rejects registrations
 * the type system accepts (see unbraind/pm-cli#825), so the double would pass
 * exactly when the package is broken.
 *
 * The harness takes an in-memory module and so cannot read `manifest.json`
 * itself; the capabilities are therefore handed to it **from that file** rather
 * than written out here. A capability missing from the shipped manifest then
 * fails activation in this suite exactly as it would at runtime, which is the
 * whole point of activating through the loader.
 *
 * @returns The activated harness.
 */
function activate(): ReturnType<typeof createExtensionTestHarness> {
  return createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
}

test("the manifest, package metadata and module agree on identity", () => {
  // Three files carry the version and the release job restamps two of them, so a
  // drift here means a published package whose manifest disagrees with itself.
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
    pm: { aliases: string[] };
  };

  assert.equal(manifest.name, "pm-vcs");
  assert.equal(pkg.name, "pm-vcs");
  assert.equal(extension.name, "pm-vcs");
  assert.equal(manifest.version, pkg.version);
  assert.equal(extension.version, pkg.version);
  assert.deepEqual(pkg.pm.aliases, ["vcs"]);
  // `flags` on a registerCommand counts as a registerFlags surface, which the
  // loader gates behind the `schema` capability.
  assert.ok(manifest.capabilities.includes("commands"));
  assert.ok(manifest.capabilities.includes("schema"));
});

test("activation registers every command with no host-owned flag collision", async () => {
  const harness = await activate();

  for (const command of ["vcs git preflight", "vcs git preview", "vcs git items"]) {
    harness.assertCommandContract({ command });
  }

  // A command declaring a host-owned global flag aborts registration at that
  // command and silently drops every later sibling, so the absence of any such
  // flag is the invariant worth pinning rather than the presence of ours.
  const hostOwned = new Set([
    "--json",
    "--lean",
    "--quiet",
    "--path",
    "--pm-path",
    "--author",
    "--id-only",
    "--no-changed-fields",
    "--full-changed-fields",
  ]);
  const flags = harness.assertFlags({ targetCommand: "vcs git preview" });
  const declared = flags.flags.map((flag) => flag.long ?? "");
  assert.deepEqual(declared, ["--fail-on"]);
  for (const flag of declared) {
    assert.ok(!hostOwned.has(flag), `${flag} is host-owned and must not be declared`);
  }
});

test("preflight runs through the host and exits non-zero on a broken checkout", async () => {
  const harness = await activate();
  const sandbox = track(createSandbox());

  const clean = await harness.runCommand({ command: "vcs git preflight", pmRoot: sandbox.pmRoot });
  assert.equal(clean.handled, true);
  const payload = clean.result as { ok: boolean; preflight: PreflightReport };
  assert.equal(payload.ok, true);
  assert.equal(payload.preflight.checks.length, 5);

  // Break the fence, then assert the command reports it as a failure. Throwing is
  // the only channel an extension command has for a non-zero exit.
  sandbox.git("config", "--remove-section", "merge.pm-history");
  const broken = await harness.runCommand({ command: "vcs git preflight", pmRoot: sandbox.pmRoot });
  assert.ok(
    broken.errorMessage !== undefined || broken.handled === false,
    `a failed preflight must not report success: ${JSON.stringify(broken)}`,
  );
});

test("preview runs through the host and gates on a threshold", async () => {
  const harness = await activate();
  const { sandbox, itemId } = createDivergedSandbox();
  track(sandbox);

  const report = await harness.runCommand({
    command: "vcs git preview",
    args: ["agent-b"],
    pmRoot: sandbox.pmRoot,
  });
  const payload = report.result as { ok: boolean; preview: PreviewReport };
  assert.equal(payload.ok, true, "without a threshold, a conflict is reported not gated");
  assert.equal(payload.preview.totals.conflict, 1);
  assert.ok(payload.preview.entries.some((entry) => entry.item_id === itemId));

  // `--fail-on` arrives camel-cased, which is the single most common cause of a
  // silently ignored extension flag.
  const gated = await harness.runCommand({
    command: "vcs git preview",
    args: ["agent-b"],
    options: { failOn: "conflict" },
    pmRoot: sandbox.pmRoot,
  });
  assert.ok(
    gated.errorMessage !== undefined || gated.handled === false,
    `a breached threshold must not report success: ${JSON.stringify(gated)}`,
  );
});

test("items runs through the host and reports the range's items", async () => {
  const harness = await activate();
  const sandbox = track(createSandbox());
  const start = sandbox.git("rev-parse", "HEAD");
  const itemId = sandbox.createItem("Task", "Item in the range");
  sandbox.commit("Add an item");

  const result = await harness.runCommand({
    command: "vcs git items",
    args: [`${start}..HEAD`],
    pmRoot: sandbox.pmRoot,
  });
  const payload = result.result as {
    ok: boolean;
    items: { items: { id: string }[]; totals: { created: number } };
  };
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.items.items.map((item) => item.id), [itemId]);
  assert.equal(payload.items.totals.created, 1);
});

test("a missing positional argument is refused with a remediation", async () => {
  const harness = await activate();
  const sandbox = track(createSandbox());

  for (const command of ["vcs git preview", "vcs git items"]) {
    const blank = await harness.runCommand({ command, args: ["   "], pmRoot: sandbox.pmRoot });
    assert.ok(
      blank.errorMessage !== undefined || blank.handled === false,
      `${command} must refuse a blank argument: ${JSON.stringify(blank)}`,
    );
    const absent = await harness.runCommand({ command, pmRoot: sandbox.pmRoot });
    assert.ok(
      absent.errorMessage !== undefined || absent.handled === false,
      `${command} must refuse an absent argument: ${JSON.stringify(absent)}`,
    );
  }
});

test("roots resolve from the context, from git, or fail with a remediation", () => {
  const sandbox = track(createSandbox());
  const base = { command: "vcs git preflight", args: [], options: {}, global: {} };

  // The host supplies repo_root when it can resolve one.
  const supplied = resolveRoots({
    ...base,
    pm_root: sandbox.pmRoot,
    repo_root: sandbox.root,
  } as Parameters<typeof resolveRoots>[0]);
  assert.equal(supplied.repoRoot, sandbox.root);
  assert.equal(supplied.trackerPrefix, ".agents/pm");

  // Without it, the tracker root is asked of git directly.
  const derived = resolveRoots({
    ...base,
    pm_root: sandbox.pmRoot,
  } as Parameters<typeof resolveRoots>[0]);
  assert.equal(derived.repoRoot, sandbox.root);
  assert.equal(derived.trackerPrefix, ".agents/pm");

  // A tracker that *is* the repository root has an empty prefix, so every path
  // is in scope rather than none.
  const atRoot = resolveRoots({
    ...base,
    pm_root: sandbox.root,
    repo_root: sandbox.root,
  } as Parameters<typeof resolveRoots>[0]);
  assert.equal(atRoot.trackerPrefix, "");

  assert.throws(
    () =>
      resolveRoots({
        ...base,
        pm_root: join(sandbox.root, ".."),
      } as Parameters<typeof resolveRoots>[0]),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "not_a_git_repository");
      assert.match(error.message, /git init/);
      return true;
    },
  );
});

test("option reading treats blank and non-string values as absent", () => {
  assert.equal(readStringOption({ failOn: "conflict" }, "failOn"), "conflict");
  assert.equal(readStringOption({ failOn: "  conflict  " }, "failOn"), "conflict");
  assert.equal(readStringOption({ failOn: "   " }, "failOn"), undefined);
  assert.equal(readStringOption({ failOn: 1 }, "failOn"), undefined);
  assert.equal(readStringOption({}, "failOn"), undefined);
});

/**
 * Builds a preview report with the given totals, for threshold assertions.
 *
 * @param totals - Counts to report.
 * @param entries - Entries backing those counts.
 * @returns A report shaped like a real preview.
 */
function previewWith(
  totals: PreviewReport["totals"],
  entries: PreviewReport["entries"] = [],
): PreviewReport {
  return {
    ref: "other",
    theirs: "b".repeat(40),
    ours: "a".repeat(40),
    base: "c".repeat(40),
    already_merged: false,
    entries,
    totals,
  };
}

test("threshold evaluation grades conflict and unprotected separately", () => {
  const clean = previewWith({ clean: 2, union: 1, conflict: 0, delete_modify: 0, unprotected: 0 });
  const conflicted = previewWith({ clean: 0, union: 0, conflict: 1, delete_modify: 0, unprotected: 0 });
  const unprotected = previewWith({ clean: 0, union: 0, conflict: 0, delete_modify: 0, unprotected: 1 });

  // No threshold: a preview is a report, never a gate.
  assert.equal(previewExitCode(conflicted, undefined), 0);

  assert.equal(previewExitCode(clean, "conflict"), 0);
  assert.equal(previewExitCode(conflicted, "conflict"), 1);
  // An unprotected artifact is a silent line-merge risk, not a conflict, so the
  // stricter threshold exists to catch what `conflict` cannot see.
  assert.equal(previewExitCode(unprotected, "conflict"), 0);
  assert.equal(previewExitCode(unprotected, "unprotected"), 1);
  assert.equal(previewExitCode(conflicted, "unprotected"), 1);
  assert.equal(previewExitCode(clean, "unprotected"), 0);

  assert.throws(
    () => previewExitCode(clean, "whatever"),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "invalid_fail_on");
      assert.match(error.message, /"conflict" or "unprotected"/);
      return true;
    },
  );
});

test("gate assertions name what failed and what to do about it", () => {
  const passing: PreflightReport = {
    ok: true,
    repo_root: "/repo",
    pm_root: "/repo/.agents/pm",
    checks: [{ name: "a", status: "pass", detail: "fine", remediation: null }],
    failed: [],
  };
  assert.equal(assertPreflightPassed(passing), undefined);

  const failing: PreflightReport = {
    ok: false,
    repo_root: "/repo",
    pm_root: "/repo/.agents/pm",
    checks: [
      { name: "merge_drivers_configured", status: "fail", detail: "no drivers", remediation: "Run pm merge install." },
      { name: "tracker_worktree_clean", status: "warn", detail: "dirty", remediation: "Commit first." },
      // A failed check with no remediation must not put a stray separator or an
      // "undefined" into the message.
      { name: "other", status: "fail", detail: "also broken", remediation: null },
    ],
    failed: ["merge_drivers_configured", "other"],
  };
  assert.throws(
    () => assertPreflightPassed(failing),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "preflight_failed");
      assert.match(error.message, /\[merge_drivers_configured\] no drivers/);
      assert.match(error.message, /\[other\] also broken/);
      assert.match(error.message, /Run pm merge install\./);
      // Warnings are not failures and must not appear in the thrown verdict.
      assert.ok(!error.message.includes("dirty"), "a warning is not a failure");
      assert.ok(!error.message.includes("undefined"));
      return true;
    },
  );
});

test("preview gate assertions describe the conflicting and unprotected paths", () => {
  const conflicted = previewWith({ clean: 0, union: 0, conflict: 1, delete_modify: 0, unprotected: 0 }, [
    {
      path: ".agents/pm/tasks/a.toon",
      item_id: "a",
      driver: "pm-item-toon",
      artifact: "item",
      resolution: "conflict",
      conflict_fields: ["priority", "status"],
      union_fields: [],
      fields_from_theirs: [],
      stream_strategy: null,
      entries_total: null,
    },
  ]);
  // Below the threshold nothing is thrown at all.
  assert.equal(assertPreviewWithinThreshold(conflicted, undefined), undefined);

  assert.throws(
    () => assertPreviewWithinThreshold(conflicted, "conflict"),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "preview_threshold_breached");
      assert.match(error.message, /a\.toon conflicts on priority, status/);
      assert.match(error.message, /Resolve the conflicting fields/);
      return true;
    },
  );

  const unprotected = previewWith({ clean: 0, union: 0, conflict: 0, delete_modify: 0, unprotected: 1 }, [
    {
      path: ".agents/pm/scratch.txt",
      item_id: null,
      driver: null,
      artifact: null,
      resolution: "unprotected",
      conflict_fields: [],
      union_fields: [],
      fields_from_theirs: [],
      stream_strategy: null,
      entries_total: null,
    },
  ]);
  // Under the `conflict` threshold an unprotected path is reported, not gated.
  assert.equal(assertPreviewWithinThreshold(unprotected, "conflict"), undefined);
  assert.throws(
    () => assertPreviewWithinThreshold(unprotected, "unprotected"),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.match(error.message, /scratch\.txt is covered by no merge driver/);
      assert.match(error.message, /pm merge install/);
      return true;
    },
  );
});

test("the preview gate names a delete/modify as blocking", () => {
  // Git leaves delete/modify unresolved in the working tree, so a branch carrying
  // one is no more mergeable than one carrying a field collision — the gate has to
  // stop on it, and say which artifact and why.
  const report = previewWith({ clean: 0, union: 0, conflict: 0, delete_modify: 1, unprotected: 0 }, [
    {
      path: ".agents/pm/tasks/gone.toon",
      item_id: "gone",
      driver: "pm-item-toon",
      artifact: "item",
      resolution: "delete_modify",
      conflict_fields: [],
      union_fields: [],
      fields_from_theirs: [],
      stream_strategy: null,
      entries_total: null,
    },
  ]);

  assert.equal(previewExitCode(report, "conflict"), 1, "a delete/modify blocks the conflict gate");
  assert.equal(previewExitCode(report, "unprotected"), 1);
  assert.equal(previewExitCode(report, undefined), 0, "still only a report without a threshold");

  assert.throws(
    () => assertPreviewWithinThreshold(report, "conflict"),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "preview_threshold_breached");
      assert.match(error.message, /gone\.toon is deleted on one side and changed on the other/);
      return true;
    },
  );
});

test("the release version rewrite targets exactly the module's own version field", () => {
  // The release job restamps the version in `index.ts` with a regex embedded in
  // the workflow. An unanchored pattern matches the *first* `version:` anywhere in
  // the file — including inside a help string or a nested object — and rewrites
  // that instead. The damage never appears in a diff, because the job commits its
  // own edit, so it survives every review; pm-graph shipped exactly that defect
  // and restamped a nested help string on every release.
  //
  // This reconstructs the real pattern from the workflow rather than asserting on
  // the YAML text, so the guard cannot be satisfied by a cosmetic edit that leaves
  // the behaviour broken.
  const workflow = readFileSync(join(packageRoot, ".github", "workflows", "release.yml"), "utf8");

  const marker = "source.replace(/";
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, "release.yml still performs a source-level version rewrite");
  const patternStart = start + marker.length;
  const patternEnd = workflow.indexOf("/m,", patternStart);
  assert.ok(
    patternEnd > patternStart,
    "the rewrite must carry the multiline flag; without it the anchor cannot work",
  );

  // The workflow embeds the script in a double-quoted shell argument, so the file
  // stores `\"` where the running regex sees `"`.
  const source = workflow.slice(patternStart, patternEnd).replaceAll('\\"', '"');

  // Read the candidate file list out of the workflow too. A guard checking a fixed
  // subset stops covering the job the moment that list grows.
  const loopMarker = "for(const file of [";
  // The replace call sits *inside* the loop that declares the candidates, so the
  // list is behind it in the file, not ahead of it.
  const loopStart = workflow.lastIndexOf(loopMarker, start);
  assert.ok(loopStart >= 0, "release.yml still iterates a source-file candidate list");
  const candidates = workflow
    .slice(loopStart + loopMarker.length, workflow.indexOf("]", loopStart))
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.endsWith(".ts"));
  assert.deepEqual(candidates, ["index.ts"], "the candidate list was parsed, not silently emptied");

  const contents = readFileSync(join(packageRoot, "index.ts"), "utf8");
  const matches = [...contents.matchAll(new RegExp(source, "gm"))];
  assert.equal(
    matches.length,
    1,
    `the rewrite must hit exactly one line, got ${JSON.stringify(matches.map((hit) => hit[0]))}`,
  );
  // And it must be the module's own field, at the two-space indent of a property
  // of the default-exported object — not a `version:` inside any nested string.
  assert.equal(matches[0]?.[0], `  version: "${extension.version}"`);
});

test("the release workflow publishes only after main carries the release commit", () => {
  // pm-vcs 2026.8.10 reached npm while main was still at 2026.8.7: the job
  // published first and had its `git push origin HEAD:main` rejected with GH006
  // by the protected branch, and `set -e` killed the run before the tag push.
  // The ordering is therefore the invariant under test, read from the workflow
  // itself so a reorder cannot pass silently:
  //
  //   prepare -> merge through a PROTECTED PR (main advanced server-side)
  //          -> verify the merged commit -> publish -> push ONLY the tag.
  //
  // A direct `HEAD:main` push after this point is the old defect resurfacing,
  // whatever comment claims otherwise. The temporary `release/<tag>` branch is
  // the one exception: pushing it is how the protected pull request exists at
  // all, and the remote deletes it once the merge lands. The workflow's own
  // comments narrate the old `git push origin HEAD:main` defect, so prose must
  // never be scanned: only executable lines count, with comment-only lines
  // dropped and backslash continuations joined so multi-line pushes stay whole.
  const workflow = readFileSync(join(packageRoot, ".github", "workflows", "release.yml"), "utf8");
  const executable = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");

  const pushCommands = [...executable.matchAll(/git push [^\n]*/g)].map((m) => m[0]);
  assert.ok(pushCommands.length > 0, "the workflow must contain its release pushes");
  for (const push of pushCommands) {
    // Both refspec spellings name the same branch: `HEAD:refs/heads/main` is
    // the explicit form and `HEAD:main` the shorthand git expands it to. The
    // original GH006 was hit with the shorthand, so refusing only the long
    // spelling would let the defect walk back in through the form people
    // actually write.
    assert.ok(
      !/(?:^|["' ])(?:HEAD|[^"' ]+):(?:main|refs\/heads\/main)\b/.test(push),
      `the workflow must never push to main directly; found: ${JSON.stringify(push)}`,
    );
  }

  // The step positions are searched in the executable content, not the raw
  // file: a step's name label and its narration live outside any run block,
  // so raw-text positions can satisfy these orderings while the commands they
  // describe are reordered. The ordering of the pushes themselves is asserted
  // from the commands' own positions below, which no label or comment can
  // satisfy on a reordered step's behalf.
  const mergeStep = executable.indexOf("Merge release metadata through protected PR");
  assert.ok(mergeStep >= 0, "the protected-PR merge step must exist");
  const verifyStep = executable.indexOf("Verify merged release");
  assert.ok(verifyStep >= 0, "the merged-release verification step must exist");
  const publishStep = executable.indexOf("Publish npm package");
  assert.ok(publishStep >= 0, "the publish step must exist");
  const tagStep = executable.indexOf("Push release tag");
  assert.ok(tagStep >= 0, "the tag step must exist");

  assert.ok(mergeStep < publishStep, "publication must wait for the protected-PR merge");
  assert.ok(verifyStep < publishStep, "publication must wait for merged-release verification");
  assert.ok(publishStep < tagStep, "the tag may only be pushed after a successful publish");

  // Every push in the workflow is parsed, not pattern-matched: quoting is
  // stripped, the remote and flags (including --delete and
  // --force-with-lease=...) are dropped, and what remains is read as refspecs -
  // either src:dst or a bare name, which names both ends. This closes the
  // classification holes a regex chain grows: `--delete main` carries no colon
  // refspec, so a flag-based classifier waves it through as a release-branch
  // operation and permits deleting main outright.
  for (const match of executable.matchAll(/git push [^\n]*/g)) {
    const command = match[0];
    const position = match.index ?? 0;
    // Suffixed shell conditionals (`git push ... || true`) are part of the
    // statement, not of the push: cut at the first operator so their words
    // are not mistaken for refspecs.
    const statement = command.split(/\s+(?:\|\||&&|;|\||>>>?|<<?)\s+/)[0]!;
    const tokens = [...statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((token) => token[1] ?? token[2] ?? token[3] ?? "")
      .slice(2) // drop "git" and "push"
      .filter((token) => !token.startsWith("--") && token !== "origin");
    const targets = tokens.map((token) => (token.includes(":") ? token.slice(token.indexOf(":") + 1) : token));
    assert.ok(targets.length > 0, `every push must name its target; found: ${JSON.stringify(command)}`);
    for (const target of targets) {
      // The protected branch has exactly one writer: the merge API. No push,
      // delete, or shorthand form may name it.
      assert.ok(
        target !== "main" && target !== "refs/heads/main",
        `no push may move or delete main directly; found: ${JSON.stringify(command)}`,
      );
    }
    // A deletion may only target the temporary release branch: that branch's
    // lifecycle is create-for-PR then delete-after-merge. Deleting anything
    // else from a release job is out of scope by construction.
    const deleting = /(^|\s)--delete(\s|$)/.test(command);
    const kinds = targets.map((target) => {
      if (target.startsWith("refs/tags/")) return "tag";
      // The branch name is built at runtime (`release_branch="release/${...}"
      // `), so the release-branch push appears as refs/heads/${release_branch}
      // in the static text; the variable's own name is the identifiable part.
      if (/release/i.test(target)) return "release-branch";
      return "other";
    });
    if (deleting) {
      assert.ok(
        kinds.every((kind) => kind === "release-branch"),
        `a deletion may only target the temporary release branch; found: ${JSON.stringify(command)}`,
      );
    } else {
      assert.ok(
        kinds.every((kind) => kind === "tag" || kind === "release-branch"),
        `every push must move the temporary release branch or the tag; found: ${JSON.stringify(command)}`,
      );
    }
    assert.ok(
      new Set(kinds).size === 1,
      `each push moves one kind of ref; found mixed targets: ${JSON.stringify(command)}`,
    );
    if (kinds[0] === "tag") {
      assert.ok(
        position > publishStep,
        `the tag may only be pushed after a successful publish; found: ${JSON.stringify(command)}`,
      );
    } else {
      assert.ok(
        position < publishStep,
        `the release branch may only be pushed before publication; found: ${JSON.stringify(command)}`,
      );
    }
  }
});
