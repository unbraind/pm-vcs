/** Native change lenses on real SDK trackers, including malformed, conflicted and no-Git inputs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { explainChange, TRACKER_LENSES, type ExplainChangeOptions } from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { encodeConflict, fieldSide } from "../engine/conflicts.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { decodeRecord, encodeRecord, readCommit, writeCommit, type RecordDocument, type Signature } from "../engine/model.ts";
import { VcsError } from "../git.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { withoutPmContext, installPackedExtension } from "../scripts/pm-environment.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
afterEach(() => { for (const directory of owned.splice(0)) directory.cleanup(); });
/** Allocate isolated actual filesystem data. */
function temp() { const directory = makeTempDir(); owned.push(directory); return directory.root; }
/** Initialize an actual SDK tracker and record a native snapshot without Git. */
async function fixture() {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("lenses", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Explain native work", author: "fixture" })).item;
  const path = `.agents/pm/tasks/${item.id}.toon`;
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon"], recordPolicy: {} });
  repo.stage([path]); const first = repo.commit({ message: "initial", author }, new Date(1000));
  return { root, client, item, path, repo, first };
}
/** Snapshot every byte under a directory, including native control state. */
function hashes(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, hashes(root, path));
    else if (entry.isSymbolicLink()) result[path] = readlinkSync(join(root, path));
    else result[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  }
  return result;
}

test("SDK lenses opt in to real lifecycle dependency evidence and policy deltas with exact immutable citations", async () => {
  const { repo, client, item, path, first } = await fixture();
  await client.update(item.id, { status: "in_progress", risk: "high", acceptanceCriteria: "Verify all citations", author: "fixture" });
  await client.files(item.id, { add: ["engine/repo.ts"], author: "fixture" });
  const second = (await client.create({ type: "Task", title: "Dependency", author: "fixture" })).item;
  await client.update(item.id, { dep: [`id=${second.id},kind=blocked_by`], author: "fixture" });
  repo.stage([path]); const next = repo.commit({ message: "advance", author, items: [item.id] }, new Date(2000));
  const before = hashes(repo.root);
  const ordinary = explainChange(repo.objects, next, { limit: 100 });
  assert.ok(ordinary.statements.every(row => row.lens === "field"));
  const result = explainChange(repo.objects, next, { lenses: TRACKER_LENSES, limit: 100 });
  assert.equal(result.base, first); assert.equal(result.origin.items[0], item.id);
  for (const [field, lens] of [["status", "lifecycle"], ["dependencies", "dependency"], ["files", "evidence"], ["acceptance_criteria", "policy"]]) {
    const row = result.statements.find(row => row.field === field)!;
    assert.equal(row.lens, lens); assert.equal(row.item, item.id);
    assert.deepEqual(decodeRecord(repo.objects.readTyped(row.after!.object, "record"))[field],
      decodeRecord(repo.objects.readTyped(flattenTree(repo.objects, readCommit(repo.objects, next).tree).get(path)!.id, "record"))[field]);
    assert.equal(row.before!.commit, first); assert.equal(row.after!.commit, next); assert.equal(row.after!.path, path);
  }
  const status = result.statements.find(row => row.field === "status")!;
  assert.equal(status.was, "open"); assert.equal(status.now, "in_progress");
  assert.equal(result.statements.find(row => row.field === "dependencies")!.coordinate!.id, second.id);
  assert.equal(result.statements.find(row => row.field === "files")!.coordinate!.path, "engine/repo.ts");
  const root = explainChange(repo.objects, first, { lenses: ["lifecycle"], limit: 100 });
  assert.equal(root.base, null); assert.ok(root.statements.every(row => row.before === undefined));
  const page = explainChange(repo.objects, next, { lenses: TRACKER_LENSES, limit: 1 });
  assert.equal(page.nextOffset, 1); assert.equal(page.omitted, result.total - 1);
  assert.deepEqual(explainChange(repo.objects, next, { lenses: TRACKER_LENSES, offset: 1, limit: 100 }).statements, result.statements.slice(1));
  assert.equal(explainChange(repo.objects, next, { offset: 999 }).nextOffset, null);
  assert.deepEqual(hashes(repo.root), before);
  await client.update(item.id, { status: "closed", closeReason: "Fixture complete", author: "fixture" });
  assert.equal(explainChange(repo.objects, next, { lenses: TRACKER_LENSES }).statements.find(row => row.field === "status")!.now, "in_progress");
});

test("malformed tracker records and unconfigured blobs stay opaque while ordinary records retain field provenance", async () => {
  const { repo, path, first } = await fixture();
  const original = flattenTree(repo.objects, readCommit(repo.objects, first).tree); const entry = original.get(path)!;
  for (const fields of [{ status: "closed" }, { ...decodeRecord(repo.objects.readTyped(entry.id, "record")), priority: "urgent" },
    { ...decodeRecord(repo.objects.readTyped(entry.id, "record")), dependencies: [{ id: "other", kind: 123 }] },
    { ...decodeRecord(repo.objects.readTyped(entry.id, "record")), id: "wrong" },
    ...[{ tests: [null] }, { tests: [[]] }, { tests: [{}] }, { tests: [{ command: "", path: "" }] }, { files: "bad" }, { confidence: {} },
      { confidence: "not-confidence" }, { risk: "invented" },
      { files: [{ path: "a.ts", scope: 123 }] }, { files: [{ path: "a.ts" }] }, { files: [{ path: "a.ts", scope: "project", created_at: 123 }] },
      { dependencies: [{ id: "other", kind: "blocked_by", created_at: "invalid" }] },
      { dependencies: [{ id: "other", kind: "invented", created_at: "2026-10-21T00:00:00.000Z" }] },
      { created_at: "invalid" }, { tags: [false] }, { status: "unknown-state" }, { pm_format_version: 999 }]
      .map(fields => ({ ...decodeRecord(repo.objects.readTyped(entry.id, "record")), ...fields }))]) {
    const tree = new Map(original); tree.set(path, { ...entry, id: repo.objects.write("record", encodeRecord(fields as RecordDocument)) });
    const next = writeCommit(repo.objects, { ...readCommit(repo.objects, first), tree: buildTree(repo.objects, tree), parents: [first] });
    assert.deepEqual(explainChange(repo.objects, next, { lenses: TRACKER_LENSES }).statements.map(row => row.lens), ["opaque"]);
    const inverse = writeCommit(repo.objects, { ...readCommit(repo.objects, first), parents: [next] });
    assert.equal(explainChange(repo.objects, inverse, { lenses: TRACKER_LENSES }).statements[0].lens, "opaque");
  }
  writeFileSync(join(repo.root, "ordinary.json"), '{"status":"closed","large":"' + "x".repeat(200) + '","empty":null,"ok":true}');
  writeFileSync(join(repo.root, "text.txt"), "plain text");
  mkdirSync(join(repo.root, ".agents/pm/raw"), { recursive: true });
  writeFileSync(join(repo.root, ".agents/pm/raw/item.md"), "not an item");
  repo.stage(["ordinary.json", "text.txt", ".agents/pm/raw/item.md"]);
  // Configured ordinary JSON records have no tracker semantics.
  const tree = flattenTree(repo.objects, readCommit(repo.objects, first).tree);
  tree.set("ordinary.json", { id: repo.objects.write("record", encodeRecord({ status: "closed", large: "x".repeat(200), empty: null, ok: true })), mode: "100644" });
  tree.set("text.txt", { id: repo.objects.write("blob", Buffer.from("plain")), mode: "100644" });
  tree.set(".agents/pm/raw/item.md", { id: repo.objects.write("blob", Buffer.from("invalid")), mode: "100644" });
  const next = writeCommit(repo.objects, { ...readCommit(repo.objects, first), tree: buildTree(repo.objects, tree), parents: [first] });
  const rows = explainChange(repo.objects, next, { lenses: TRACKER_LENSES }).statements;
  assert.equal(rows.find(row => row.field === "status")!.lens, "field");
  assert.equal(typeof rows.find(row => row.field === "large")!.now, "object");
  assert.ok(rows.some(row => row.lens === "text")); assert.ok(rows.some(row => row.lens === "opaque"));
});

test("conflict metadata never claims a resolved lifecycle transition; deletion mode and empty record deltas keep sources", async () => {
  const { repo, first, path } = await fixture();
  const initial = readCommit(repo.objects, first); const original = flattenTree(repo.objects, initial.tree); const entry = original.get(path)!;
  const document = decodeRecord(repo.objects.readTyped(entry.id, "record"));
  const conflict = repo.objects.write("conflict", encodeConflict({ kind: "field", field: "status",
    base: fieldSide(repo.objects, "open"), ours: fieldSide(repo.objects, "in_progress"), theirs: fieldSide(repo.objects, "closed") }));
  const tree = new Map(original);
  tree.set(path, { ...entry, id: repo.objects.write("record", encodeRecord({ ...document, status: "in_progress", confidence: 95 })), conflicts: [conflict] });
  const disputed = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, tree), parents: [first] });
  const report = explainChange(repo.objects, disputed, { lenses: TRACKER_LENSES });
  assert.equal(report.statements.find(row => row.field === "status")!.lens, "field");
  assert.equal(report.statements.find(row => row.lens === "conflict")!.after!.object, tree.get(path)!.id);
  const resolved = writeCommit(repo.objects, { ...initial, parents: [disputed] });
  assert.ok(explainChange(repo.objects, resolved).statements.some(row => row.lens === "conflict"));
  // Conflict-only and mode-only deltas have exact source citations even with unchanged readable fields.
  tree.set(path, { ...entry, conflicts: [conflict] });
  const onlyConflict = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, tree), parents: [first] });
  assert.deepEqual(explainChange(repo.objects, onlyConflict).statements.map(row => row.lens), ["conflict"]);
  tree.set(path, { ...entry, mode: "100755" });
  const mode = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, tree), parents: [first] });
  assert.equal(explainChange(repo.objects, mode).statements[0].lens, "file");
  const removed = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, new Map()), parents: [first] });
  const deletion = explainChange(repo.objects, removed, { lenses: TRACKER_LENSES, limit: 100 });
  assert.ok(deletion.statements.some(row => row.lens === "lifecycle" && row.field === "status"));
  assert.ok(deletion.statements.every(row => row.after === undefined && row.before!.commit === first));
  const opaque = new Map(original); opaque.set(path, { ...entry, id: repo.objects.write("blob", Buffer.from("invalid tracker")) });
  const blob = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, opaque), parents: [first] });
  assert.equal(explainChange(repo.objects, blob).statements[0].lens, "opaque");
  opaque.set(path, { ...entry, id: repo.objects.write("record", Buffer.from("invalid JSON")) });
  const malformed = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, opaque), parents: [first] });
  assert.equal(explainChange(repo.objects, malformed).statements[0].lens, "opaque");
  const text = new Map(original); text.set("file.txt", { id: repo.objects.write("blob", Buffer.from("text")), mode: "100644" });
  text.set("empty.json", { id: repo.objects.write("record", encodeRecord({})), mode: "100644" });
  const added = writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, text), parents: [first] });
  const gone = writeCommit(repo.objects, { ...initial, parents: [added] });
  assert.ok(explainChange(repo.objects, gone).statements.some(row => row.lens === "text"));
  assert.ok(explainChange(repo.objects, gone).statements.some(row => row.lens === "file"));
});

test("collection lenses preserve exact entry coordinates duplicate counts and unchanged membership", async () => {
  const { repo, first, path } = await fixture();
  const initial = readCommit(repo.objects, first); const tree = flattenTree(repo.objects, initial.tree); const entry = tree.get(path)!;
  const document = decodeRecord(repo.objects.readTyped(entry.id, "record"));
  const file = { path: "one.ts", scope: "global" }; const other = { path: "two.ts", scope: "project" };
  /** Record canonical arrays without touching working tracker content. */
  const snapshot = (files: readonly RecordDocument[] | undefined, parent: string) => {
    tree.set(path, { ...entry, id: repo.objects.write("record", encodeRecord({ ...document, ...(files === undefined ? {} : { files }) })) });
    return writeCommit(repo.objects, { ...initial, tree: buildTree(repo.objects, tree), parents: [parent] });
  };
  const one = snapshot([file], first); const two = snapshot([file, other], one);
  const added = explainChange(repo.objects, two, { lenses: ["evidence"] }).statements;
  assert.equal(added[0].lens, "evidence"); assert.equal(added[0].entryAfter, 1); assert.equal(added[0].coordinate!.path, "two.ts");
  const removed = snapshot([file], two);
  const deletion = explainChange(repo.objects, removed, { lenses: ["evidence"] }).statements;
  assert.equal(deletion[0].entryBefore, 1); assert.equal(deletion[0].coordinate!.path, "two.ts");
  const empty = snapshot(undefined, removed);
  assert.ok(explainChange(repo.objects, empty, { lenses: ["evidence"] }).statements.some(row => row.entryBefore === 0));
  const reordered = snapshot([other, file], two);
  assert.equal(explainChange(repo.objects, reordered, { lenses: ["evidence"] }).statements[0].lens, "field");
  const duplicate = snapshot([file, file], one);
  assert.equal(explainChange(repo.objects, duplicate, { lenses: ["evidence"] }).statements.filter(row => row.entryAfter !== undefined).length, 1);
});

test("typed refusals explain invalid controls and shallow ancestry instead of inventing lifecycle facts", async () => {
  const { repo, first, client, item, path } = await fixture();
  for (const options of [{ lenses: ["unknown"] }, { lenses: "lifecycle" }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: Infinity }]) {
    assert.throws(() => explainChange(repo.objects, first, options as unknown as ExplainChangeOptions), error => error instanceof VcsError && error.remediation.length > 0);
  }
  await client.update(item.id, { status: "in_progress", author: "fixture" }); repo.stage([path]);
  const next = repo.commit({ message: "shallow", author }, new Date(2000));
  writeFileSync(join(repo.controlDirectory, "partial.json"), JSON.stringify({ remote: "origin", shallow: [next], promised: [] }));
  assert.throws(() => explainChange(repo.objects, next, { lenses: ["lifecycle"] }), error => error instanceof VcsError && error.code === "lens_shallow_boundary" && /Fetch/.test(error.remediation));
});

test("CLI harness accepts default and explicit native revisions and rejects invalid lens pages", async () => {
  const { repo, root, first } = await fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const run = (args: string[], options?: Record<string, unknown>) => harness.runCommand({ command: "vcs explain", args, options, pmRoot: join(root, ".agents/pm") });
  const result = await run([]); assert.equal((result.result as { commit: string }).commit, first);
  await run([first], { lenses: "lifecycle,policy", limit: "1", offset: "0" });
  assert.match((await run([], { lenses: "wrong" })).errorMessage!, /Select lifecycle/);
  assert.match((await run([], { offset: "-1" })).errorMessage!, /nonnegative/);
  assert.match((await run([], { limit: "101" })).errorMessage!, /1\.\.100/);
  assert.equal(repo.resolve("HEAD"), first);
});

test("real CLI loads the built extension and emits bounded JSON and TOON with no Git executable", async () => {
  const { root, first } = await fixture(); const bins = temp();
  // Use the absolute Node executable and an empty PATH, prohibiting all Git subprocess discovery.
  const env = { ...withoutPmContext(process.env), ...discardChildCoverage(), PATH: bins, GIT_CEILING_DIRECTORIES: dirname(root), PM_AUTHOR: "fixture" };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  installPackedExtension(root);
  const before = hashes(root);
  const json = execFileSync(process.execPath, [cli, "vcs", "explain", first, "--lenses", "lifecycle,dependency,evidence,policy", "--limit", "2", "--json"], { cwd: root, env, encoding: "utf8" });
  const result = JSON.parse(json) as { statements: unknown[]; nextOffset: number };
  assert.equal(result.statements.length, 2); assert.equal(result.nextOffset, 2);
  const toon = execFileSync(process.execPath, [cli, "vcs", "explain", "--limit", "1"], { cwd: root, env, encoding: "utf8" });
  assert.match(toon, /statements/); assert.ok(toon.length < 2500);
  // Host caches can refresh on command loading; native content and control bytes must remain exact.
  const after = hashes(root);
  for (const [path, hash] of Object.entries(before).filter(([path]) => path.includes(".pm-vcs") || /tasks.*\.toon$/.test(path))) assert.equal(after[path], hash);
  assert.equal(existsSync(join(root, ".git")), false);
});
