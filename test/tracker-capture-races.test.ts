import "./helpers/isolate-session.ts";
/** Real-process confinement regressions for native tracker capture. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, readdirSync, unlinkSync, chmodSync, utimesSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { TrackerCapture, trackerAdmissionBoundary } from "../engine/tracker-admission.ts";
import { readTrackerSource, trackerSourceBoundary } from "../engine/tracker-source.ts";
import { worktreeMutationCapabilities } from "../engine/worktree-mutation.ts";
import { objectFiles } from "../engine/object-files.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { readCommit } from "../engine/model.ts";
import { flattenTree } from "../engine/worktree.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { testEnvironment } from "./helpers/test-environment.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const originalBoundary = trackerAdmissionBoundary.visit;
const originalSourceBoundary = trackerSourceBoundary.visit;
const originalDescriptorPaths = worktreeMutationCapabilities.descriptorPaths;
const options = { message: "Confined capture", author: { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } };
afterEach(() => { trackerAdmissionBoundary.visit = originalBoundary; trackerSourceBoundary.visit = originalSourceBoundary; worktreeMutationCapabilities.descriptorPaths = originalDescriptorPaths; for (const dir of owned.splice(0)) dir.cleanup(); });

/** Create a real SDK pair inside a non-git workspace and retain its original byte identity. */
async function fixture() {
  const scratch = makeTempDir(); owned.push(scratch);
  const root = join(scratch.root, "workspace"); const outside = join(scratch.root, "outside");
  mkdirSync(root); mkdirSync(outside);
  const pmRoot = join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true, author: "fixture" });
  await client.init("capture", { defaults: true, agentGuidance: "skip", author: "fixture" });
  const { item } = await client.create({ type: "Task", title: "SYNTHETIC_EXTERNAL_CONTENT", author: "fixture", unset: ["parent", "sprint", "release"] });
  const paths = [`tasks/${item.id}.toon`, `history/${item.id}.jsonl`].map(path => join(pmRoot, path));
  const bytes = paths.map(path => readFileSync(path));
  const repo = Repository.init(root, "main", { recordPaths: [], recordPolicy: {} });
  return { root, outside, pmRoot, item, paths, bytes, repo, capture: new TrackerCapture(repo, pmRoot, { items: [item.id], expectedTip: null }) };
}

/** Execute the competing mutation to completion before returning to the capture reader. */
function replaceLinks(paths: readonly string[]): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", "import {unlinkSync,writeFileSync} from 'node:fs'; for (const path of process.argv.slice(1)) { unlinkSync(path); writeFileSync(path, 'local replacement'); }", ...paths], { env: testEnvironment() });
}

/** A peer atomically removes the original name and installs a link, replacement file, or changed bytes. */
function compete(path: string, target: string, mutation: string): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", "import {renameSync,symlinkSync,writeFileSync} from 'node:fs'; const [path,target,mutation] = process.argv.slice(1); if (mutation === 'edit') writeFileSync(path, 'peer content'); else { renameSync(path, path + '.retained'); if (mutation === 'file') writeFileSync(path, 'replacement'); else symlinkSync(target, path); }", path, target, mutation], { env: testEnvironment() });
}

/** No source bytes, index entries or revision may escape a refused read. */
function unpublished(f: Awaited<ReturnType<typeof fixture>>, objects: readonly string[]): void {
  assert.equal(f.repo.refs.readHead().target, null); assert.deepEqual(f.repo.readIndex(), []);
  assert.deepEqual(readdirSync(join(f.repo.controlDirectory, "objects"), { recursive: true, encoding: "utf8" }), objects);
}

for (const selection of [[0], [1], [0, 1]]) for (const replace of [false, true]) {
  test(`external ${selection.map(index => index === 0 ? "item" : "history").join("/")} links ${replace ? "replaced by an OS process after capture" : "left unchanged"} refuse without publication`, async () => {
    const f = await fixture();
    const paths = selection.map(index => f.paths[index]);
    for (const [index, path] of paths.entries()) { const target = join(f.outside, String(index)); renameSync(path, target); symlinkSync(target, path); }
    trackerAdmissionBoundary.visit = async step => { if (replace && step === "captured") replaceLinks(paths); };
    await assert.rejects(f.capture.commit(options, new Date(1)), { code: "path_ignored" });
    assert.equal(f.repo.refs.readHead().target, null); assert.deepEqual(f.repo.readIndex(), []);
  });
}

for (const which of [0, 1]) for (const step of ["checked", "opened", "read"]) for (const kind of ["leaf", "ancestor", "target"]) {
  test(`${which === 0 ? "item" : "history"} ${kind} replacement at ${step} refuses with descriptor cleanup`, async () => {
    const f = await fixture(); const path = f.paths[which];
    const target = join(f.root, `source-${which}`); writeFileSync(target, f.bytes[which]);
    if (kind === "target") { renameSync(path, path + ".original"); symlinkSync(target, path); }
    const outside = kind === "ancestor" ? f.outside : join(f.outside, "payload");
    if (kind !== "ancestor") writeFileSync(outside, f.bytes[which]);
    const attacked = kind === "ancestor" ? dirname(path) : kind === "target" ? target : path;
    const coordinate = relative(f.root, step === "checked" ? attacked : path).split("\\").join("/");
    const baseline = objectFiles.active.size; const objects = readdirSync(join(f.repo.controlDirectory, "objects"), { recursive: true, encoding: "utf8" });
    let fired = false;
    trackerSourceBoundary.visit = (observed, name) => {
      if (!fired && observed === step && name === coordinate) { fired = true; compete(attacked, outside, "link"); }
    };
    const result = await f.capture.commit(options, new Date(1));
    assert.equal(fired, true); assert.equal(result.ok, false);
    if (result.ok) assert.fail(); assert.deepEqual(result.retry, [{ id: f.item.id, reason: "pair_unavailable" }]);
    unpublished(f, objects); assert.equal(objectFiles.active.size, baseline);
  });
}

for (const mutation of ["file", "edit"]) for (const which of [0, 1]) {
  test(`${which === 0 ? "item" : "history"} ${mutation} change during the SDK read invalidates its bytes`, async () => {
    const f = await fixture(); let fired = false;
    const objects = readdirSync(join(f.repo.controlDirectory, "objects"), { recursive: true, encoding: "utf8" });
    trackerSourceBoundary.visit = (step, path) => {
      if (step === "read" && path === relative(f.root, f.paths[which])) { fired = true; compete(f.paths[which], "", mutation); }
    };
    const result = await f.capture.commit(options, new Date(1));
    assert.equal(fired, true); assert.equal(result.ok, false); unpublished(f, objects);
  });
}

for (const absolute of [false, true]) {
  test(`unchanged legal ${absolute ? "absolute" : "relative"} leaf links preserve exact SDK item and history bytes`, async () => {
    const f = await fixture();
    for (const [index, path] of f.paths.entries()) {
      const target = join(f.root, `source-${index}`); renameSync(path, target);
      symlinkSync(absolute ? target : relative(dirname(path), target), path);
    }
    const result = await f.capture.commit(options, new Date(1)); assert.ok(result.ok);
    const tree = flattenTree(f.repo.objects, readCommit(f.repo.objects, result.revision).tree);
    for (const [index, path] of f.paths.entries()) assert.deepEqual(f.repo.objects.readTyped(tree.get(relative(f.root, path))!.id, "blob"), f.bytes[index]);
  });
}

for (const kind of ["ancestor", "chain", "control", "external-history"]) {
  test(`unchanged ${kind} link keeps the path_ignored refusal`, async () => {
    const f = await fixture(); const path = f.paths[kind === "external-history" ? 1 : 0];
    if (kind === "ancestor") { const folder = dirname(path); renameSync(folder, folder + ".original"); symlinkSync(folder + ".original", folder); }
    else {
      const target = join(kind === "control" ? f.repo.controlDirectory : f.outside, "payload"); renameSync(path, target);
      if (kind === "chain") { const middle = join(f.root, "middle"); symlinkSync(target, middle); symlinkSync(middle, path); }
      else symlinkSync(target, path);
    }
    await assert.rejects(f.capture.commit(options, new Date(1)), { code: "path_ignored" });
  });
}

test("confined reader refuses unsafe coordinates and non-file sources without reading", async () => {
  const dir = makeTempDir(); owned.push(dir); writeFileSync(join(dir.root, "file"), "content");
  const unread = async (): Promise<never> => assert.fail("unsafe source must never reach the SDK reader");
  for (const path of ["", ".", "..", "../file", "a/../file", "/absolute", ".pmvcs/index"]) await assert.rejects(readTrackerSource(dir.root, path, unread), { code: "path_ignored" });
  mkdirSync(join(dir.root, "directory"));
  for (const path of ["directory", "file/child"]) await assert.rejects(readTrackerSource(dir.root, path, unread), { code: "tracker_source_changed" });
  await assert.rejects(readTrackerSource(join(dir.root, "file"), "child", unread), { code: "tracker_source_changed" });
});

test("platforms without confined descriptor addressing fail closed with an actionable refusal", async () => {
  const f = await fixture(); worktreeMutationCapabilities.descriptorPaths = () => false;
  await assert.rejects(f.capture.commit(options, new Date(1)), { code: "tracker_source_unsupported" });
});

test("plain-file replacement between lstat and open is refused before its SDK read", async () => {
  const dir = makeTempDir(); owned.push(dir); const path = join(dir.root, "file"); writeFileSync(path, "original");
  trackerSourceBoundary.visit = (step, coordinate) => { if (step === "checked" && coordinate === "file") compete(path, "", "file"); };
  await assert.rejects(readTrackerSource(dir.root, "file", async () => assert.fail("replacement must not be read")), { code: "tracker_source_changed" });
});

test("unlink and same-length metadata changes invalidate an otherwise unchanged descriptor", async () => {
  for (const mutation of ["unlink", "mtime", "ctime"]) {
    const dir = makeTempDir(); owned.push(dir); const path = join(dir.root, "file"); writeFileSync(path, "original");
    await assert.rejects(readTrackerSource(dir.root, "file", async address => {
      const bytes = readFileSync(address);
      if (mutation === "unlink") unlinkSync(path);
      else if (mutation === "mtime") utimesSync(path, new Date(1), new Date(1));
      else chmodSync(path, 0o400);
      return bytes;
    }), { code: "tracker_source_changed" });
  }
});

test("a legal leaf link whose target changes during resolution is refused", async () => {
  const dir = makeTempDir(); owned.push(dir); const target = join(dir.root, "target"); writeFileSync(target, "original");
  const link = join(dir.root, "link"); symlinkSync("target", link);
  trackerSourceBoundary.visit = (step, path) => { if (step === "checked" && path === "target") compete(link, "target", "link"); };
  await assert.rejects(readTrackerSource(dir.root, "link", async () => assert.fail("changed link must not be read")), { code: "tracker_source_changed" });
});

for (const outcome of ["success", "reader-refusal", "link-refusal"]) {
  test(`close failures release every descriptor and preserve ${outcome}`, async () => {
    const dir = makeTempDir(); owned.push(dir); mkdirSync(join(dir.root, "nested"));
    writeFileSync(join(dir.root, "nested/file"), "safe"); symlinkSync("../../outside", join(dir.root, "nested/link"));
    const baseline = objectFiles.active.size; const originalOpened = objectFiles.opened;
    const closers: (() => void)[] = []; let attempts = 0;
    const primary = new ObjectStoreError("reader_refused", "Synthetic SDK read refusal.");
    const closeError = new Error("Synthetic close failure after native close.");
    objectFiles.opened = file => {
      const close = file.close; closers.push(close);
      file.close = () => { attempts++; close(); throw closeError; };
    };
    try {
      const pending = readTrackerSource(dir.root, outcome === "link-refusal" ? "nested/link" : "nested/file", async address => {
        if (outcome === "reader-refusal") throw primary;
        return readFileSync(address);
      });
      await assert.rejects(pending, error => outcome === "link-refusal" ? error instanceof ObjectStoreError && error.code === "path_ignored" : error === (outcome === "success" ? closeError : primary));
      assert.equal(attempts, closers.length); assert.ok(attempts >= 2); assert.equal(objectFiles.active.size, baseline);
    } finally { objectFiles.opened = originalOpened; for (const close of closers) close(); }
  });
}
