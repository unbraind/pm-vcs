import "./helpers/isolate-session.ts";
/** Real SDK tracker tests for capture isolation, SDK normalization and native publication. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { testEnvironment } from "./helpers/test-environment.ts";
import { installPackedExtension, pmExecutable } from "../scripts/pm-environment.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient, readHistorySnapshot, verifyHistoryEntries, readLocatedItem, locateItem, readSettings, resolveItemTypeRegistry, serializeItemDocument, commitItemMutations, commitWorkspaceTransaction, type ItemDocument, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { TrackerCapture, TrackerAdmissionRefusal, parseTrackerAdmissionRequest } from "../index.ts";
import { trackerAdmissionBoundary } from "../engine/tracker-admission.ts";
import { generateKeyPairSync } from "node:crypto";
import { exportChangeBundle, importChangeBundle, type ChangeBundleAuthorization } from "../engine/change-bundles.ts";
import { publicKeyText } from "../engine/signatures.ts";
import { Repository } from "../engine/repo.ts";
import { readCommit, migratedFileId, decodeRecord, type Signature } from "../engine/model.ts";
import { parseWorkingRecord, renderWorkingRecord } from "../engine/record-format.ts";
import { flattenTree } from "../engine/worktree.ts";
import { exportBundle, importBundle } from "../engine/bundle.ts";
import { cloneFrom, fetchFrom } from "../engine/sync.ts";
import { makeTempDir } from "./helpers/tmp.ts";
process.env.NPM_CONFIG_USERCONFIG = devNull;
const author: Signature = { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const options = { message: "Capture tracker", author, allowEmpty: true };
const scope = { unset: ["parent", "sprint", "release"], author: "fixture" };
const owned: ReturnType<typeof makeTempDir>[] = [];
const defaultBoundary = trackerAdmissionBoundary.visit;
afterEach(() => { trackerAdmissionBoundary.visit = defaultBoundary; for (const dir of owned.splice(0)) dir.cleanup(); });
/** Allocate only disposable, non-git tracker state. */
function temp() { const dir = makeTempDir(process.env.PM_VCS_CRASH_TMPDIR); owned.push(dir); return dir.root; }
/** Initialize real custom or native SDK documents without ambient relationship defaults. */
async function fixture(format: "toon" | "json" = "toon", custom = false) {
  const root = temp(); const pmRoot = join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
  await client.init("admission", { defaults: true, author: "fixture" });
  if (custom) await client.schemaAddType("Experiment", { folder: "research/cards", author: "fixture" });
  const a = (await client.create({ ...scope, type: custom ? "Experiment" : "Task", title: "First" })).item.id;
  const b = (await client.create({ ...scope, type: "Task", title: "Second" })).item.id;
  if (format === "json") {
    const settings = await readSettings(pmRoot); const registry = resolveItemTypeRegistry(settings);
    for (const id of [a, b]) {
      const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder); assert.ok(located);
      const item = await readLocatedItem(located, { schema: settings.schema });
      writeFileSync(located.itemPath, serializeItemDocument(item.document, { format: "json_markdown" }));
      renameSync(located.itemPath, located.itemPath.replace(/\.toon$/, ".md"));
    }
  }
  const repo = Repository.init(root, "main", { recordPaths: [], recordPolicy: {} });
  return { root, pmRoot, client, repo, a, b };
}
/** Canonical state read through SDK resolution, never through a test normalizer. */
async function document(pmRoot: string, id: string): Promise<ItemDocument> {
  const settings = await readSettings(pmRoot); const registry = resolveItemTypeRegistry(settings);
  const found = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
  assert.ok(found); return (await readLocatedItem(found, { schema: settings.schema })).document;
}
/** Materialize one immutable native tree in an independently initialized SDK tracker. */
function materialize(repo: Repository, revision: string, target: string) {
  for (const [path, entry] of flattenTree(repo.objects, readCommit(repo.objects, revision).tree)) {
    const file = join(target, path); mkdirSync(dirname(file), { recursive: true });
    const object = repo.objects.read(entry.id);
    writeFileSync(file, object.type === "record" ? renderWorkingRecord(path, decodeRecord(object.payload)) : object.payload);
  }
}

test("strict single request schema rejects sparse, oversized and extreme inputs before mutations", () => {
  const valid = { items: ["constructor", "__proto__", "old.id-1"], expectedTip: null };
  assert.deepEqual(parseTrackerAdmissionRequest(valid), valid);
  assert.equal(parseTrackerAdmissionRequest({ items: ["x"], expectedTip: "a".repeat(64) }).expectedTip, "a".repeat(64));
  const invalid: unknown[] = [null, [], 2, {}, { ...valid, extra: 1 }, { ...valid, items: [] }, { ...valid, items: Array(2) }, { ...valid, items: ["x", "x"] }, { ...valid, items: Array.from({ length: 101 }, (_, i) => `x${i}`) }, { ...valid, items: ["../x"] }, { ...valid, items: [" x"] }, { ...valid, items: ["a".repeat(129)] }];
  let seed = 0x53295;
  for (let i = 0; i < 500; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; invalid.push({ ...valid, expectedTip: [Infinity, -Infinity, NaN, -1, Number.MAX_VALUE, {}, [], "g".repeat(64)][seed % 8] }); }
  for (const value of invalid) assert.throws(() => parseTrackerAdmissionRequest(value), error => error instanceof TrackerAdmissionRefusal && error.code === "invalid_tracker_admission" && error.remedy.length > 20);
});

test("admission captures exact SDK-resolved custom folders and formats and consumes the session", async () => {
  for (const format of ["toon", "json"] as const) {
    const f = await fixture(format, true);
    const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null });
    const result = await capture.commit(options, new Date(1)); assert.ok(result.ok); assert.equal(result.checked, 2);
    const paths = [...flattenTree(f.repo.objects, readCommit(f.repo.objects, result.revision).tree).keys()];
    assert.ok(paths.some(path => path.includes("research/cards"))); assert.equal(paths.length, 4);
    assert.equal(f.repo.refs.readHead().target, result.revision);
    await assert.rejects(capture.commit(options, new Date(1)), { code: "tracker_capture_consumed" });
    const target = temp(); mkdirSync(join(target, ".agents/pm"), { recursive: true });
    copyFileSync(join(f.pmRoot, "settings.json"), join(target, ".agents/pm/settings.json"));
    // SDK file-backed custom type registry accompanies the selected documents.
    const schema = join(f.pmRoot, "schema/types.json");
    mkdirSync(join(target, ".agents/pm/schema"), { recursive: true }); copyFileSync(schema, join(target, ".agents/pm/schema/types.json"));
    materialize(f.repo, result.revision, target);
    assert.deepEqual(await document(join(target, ".agents/pm"), f.a), await document(f.pmRoot, f.a));
  }
});

test("every capture boundary yields a coherent historical pair or retry under a competing SDK writer", async () => {
  for (const cut of ["located", "item", "history", "captured"]) {
    const f = await fixture(); let fired = false;
    trackerAdmissionBoundary.visit = async step => { if (step === cut && !fired) { fired = true; await f.client.update(f.a, { ...scope, title: `Peer at ${cut}` }); } };
    const result = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1));
    assert.equal(fired, true);
    if (result.ok) {
      const target = temp(); materialize(f.repo, result.revision, target);
      const history = await readHistorySnapshot(join(target, `.agents/pm/history/${f.a}.jsonl`), f.a);
      const path = [...flattenTree(f.repo.objects, readCommit(f.repo.objects, result.revision).tree).keys()].find(path => path.endsWith(".toon"))!;
      const found = { id: f.a, type: "Task", itemPath: join(target, path), item_format: "toon" as const };
      assert.equal(verifyHistoryEntries(history.entries, (await readLocatedItem(found)).document).ok, true);
    } else { assert.equal(result.code, "tracker_capture_retry"); assert.equal(f.repo.refs.readHead().target, null); }
  }
});

test("a torn pair never publishes; resume resolves only failed records and never replays a frozen target", async () => {
  const f = await fixture(); const file = join(f.pmRoot, `tasks/${f.b}.toon`);
  const bytes = readFileSync(file); writeFileSync(file, bytes.toString().replace("Second", "Torn"));
  const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null });
  const first = await capture.commit(options, new Date(1)); assert.equal(first.ok, false);
  if (first.ok) assert.fail(); assert.deepEqual(first.retry, [{ id: f.b, reason: "history_mismatch" }]);
  assert.equal(f.repo.refs.readHead().target, null); assert.equal(f.repo.readIndex().length, 0);
  writeFileSync(file, bytes); await f.client.update(f.b, { ...scope, title: "Replanned from SDK" });
  // A deleted previously certified source proves resume uses its retained immutable bytes.
  rmSync(join(f.pmRoot, `tasks/${f.a}.toon`));
  const seen: string[] = []; trackerAdmissionBoundary.visit = async (step, id) => { if (step === "located") seen.push(id); };
  const second = await capture.commit(options, new Date(2)); assert.ok(second.ok); assert.equal(second.reused, 1); assert.equal(second.checked, 1); assert.deepEqual(seen, [f.b]);
});

test("native tip CAS refuses two sessions targeting the same parent without overwriting peer success", async () => {
  const f = await fixture(); const request = { items: [f.a], expectedTip: null };
  const peer = new TrackerCapture(f.repo, f.pmRoot, request);
  const first = await new TrackerCapture(f.repo, f.pmRoot, request).commit(options, new Date(1)); assert.ok(first.ok);
  await assert.rejects(peer.commit(options, new Date(2)), { code: "tracker_tip_changed" }); assert.equal(f.repo.refs.readHead().target, first.revision);
});

test("SDK item transaction membership refuses partially committed work at its transaction read boundary", async () => {
  const f = await fixture(); let partial = false;
  await commitItemMutations({ pmRoot: f.pmRoot, transactionId: "capture-tx", author: "fixture", mutations: [
    { op: "update", id: f.a, options: { ...scope, title: "Atomic first" } }, { op: "update", id: f.b, options: { ...scope, title: "Atomic second" } },
  ], onTransition: async ({ transition }) => {
    if (transition === "step_recorded" && !partial) {
      partial = true;
      const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1));
      assert.equal(report.ok, false); if (report.ok) assert.fail(); assert.equal(report.retry[0].reason, "transaction_unverified");
    }
  } });
  assert.equal(partial, true);
  let visited = false; trackerAdmissionBoundary.visit = async step => { if (step === "transaction") visited = true; };
  const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null }).commit(options, new Date(2));
  assert.ok(report.ok); assert.equal(visited, true);
});

test("settings changes during capture invalidate all certificates, including those reused on resume", async () => {
  const f = await fixture(); let changed = false;
  trackerAdmissionBoundary.visit = async step => { if (step === "captured" && !changed) { changed = true; await f.client.config("project", "set", "output.default_format", "json"); } };
  const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null });
  const result = await capture.commit(options, new Date(1)); assert.equal(result.ok, false);
  trackerAdmissionBoundary.visit = async () => {};
  const resumed = await capture.commit(options, new Date(2)); assert.ok(resumed.ok); assert.equal(resumed.checked, 2);
});

test("CLI uses the same strict admission path and exposes a compact retry rather than a torn tip", async () => {
  const f = await fixture(); const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  writeFileSync(join(f.root, "selection.json"), JSON.stringify({ items: [f.a], expectedTip: null }));
  const context = { pmRoot: f.pmRoot, repoRoot: f.root, args: ["Certified tracker"], command: "vcs commit-tracker" };
  const report = await harness.runCommand({ ...context, options: { input: join(f.root, "selection.json") } }); assert.equal(report.errorMessage, undefined); assert.equal((report.result as { ok: boolean }).ok, true);
  assert.match((await harness.runCommand({ ...context, options: { input: join(f.root, "selection.json") } })).errorMessage!, /tracker_tip_changed/);
  for (const options of [{}, { input: "missing.json" }, { input: f.root }]) {
    assert.match((await harness.runCommand({ ...context, options })).errorMessage!, /Tracker admission refused/);
  }
  writeFileSync(join(f.root, "selection.json"), "x".repeat(32769));
  assert.match((await harness.runCommand({ ...context, options: { input: join(f.root, "selection.json") } })).errorMessage!, /Tracker admission refused/);
});

/** Deterministic generator: the seed and sequence count are stable regression evidence. */
function random(seed: number) { let state = seed; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }

test("500 seeded model sequences preserve SDK state across native bundle replay and file sync", { timeout: 600000 }, async () => {
  const f = await fixture(); const next = random(0x53295);
  const configPath = join(f.repo.controlDirectory, "config.json");
  writeFileSync(configPath, JSON.stringify({ recordPaths: ["**/*.toon"], recordPolicy: {} }));
  const recordRepository = Repository.open(f.root);
  const customStatuses: string[] = [];
  for (const role of ["active", "blocked", "draft"]) { const status = `custom-${next() % 100000}`; customStatuses.push(status); await f.client.schemaAddStatus(status, { role: [role], author: "fixture" }); }
  await f.client.update(f.a, { ...scope, comment: ["text=Seed comment"], note: ["text=Seed note"], learning: ["text=Seed learning"], file: ["path=README.md"], doc: ["path=README.md,scope=project,note=Guide"], acceptanceCriteria: "Read all native fields" });
  const target = temp(); const receiver = Repository.init(target); const snapshots: { revision: string; bytes: Buffer; signed: Buffer; model: ItemDocument }[] = [];
  const keys = generateKeyPairSync("ed25519");
  const branch = "refs/heads/replay";
  const policy: ChangeBundleAuthorization = { scope: { paths: [`.agents/pm/history/${f.a}.jsonl`, `.agents/pm/tasks/${f.a}.toon`], refs: [branch] }, trust: { version: 1, keys: [{ identity: author.email, publicKey: publicKeyText(keys.publicKey) }], revocations: [] } };
  receiver.remotes.add("origin", f.root);
  // Model values come from SDK read-back after actual native mutations, not duplicated normalization.
  const model = new Map<string, ItemDocument>();
  for (let sequence = 0; sequence < 15; sequence++) {
    const choice = next() % 5;
    const value = `value ${next() % 19}${sequence % 2 === 0 ? "\r\n  body \r\n" : "\n body \n"}`;
    const mutation: PmClientFullMutationOptions = choice === 0 ? { title: `Title ${next() % 17}` }
      : choice === 1 ? { description: value, body: value }
      : choice === 2 ? { parent: f.b, dep: [`id=${f.b},kind=related`], unset: ["sprint", "release"] }
      : choice === 3 ? { tags: `tag-${next() % 5}`, priority: next() % 5 }
      : { risk: ["low", "medium", "high"][next() % 3], acceptanceCriteria: value, unset: ["parent", "sprint", "release"] };
    await f.client.focus(f.b);
    await f.client.update(f.a, { ...scope, ...mutation, status: customStatuses[next() % customStatuses.length] });
    model.set(f.a, await document(f.pmRoot, f.a));
    const parent = recordRepository.refs.readHead().target;
    const report = await new TrackerCapture(recordRepository, f.pmRoot, { items: [f.a], expectedTip: parent }).commit(options, new Date(sequence + 1)); assert.ok(report.ok);
    const bytes = exportBundle(f.repo.objects, f.repo.refs, ["refs/heads/main"]);
    const signed = exportChangeBundle(f.repo.objects, { [branch]: report.revision }, policy.scope, author.email, keys.privateKey);
    const state = { revision: report.revision, bytes, signed, model: structuredClone(model.get(f.a)!) }; snapshots.push(state);
  }
  // Each sequence applies a newer or older input, an idempotent replay and a formatting variant.
  for (let sequence = 0; sequence < 500; sequence++) {
    let selected = snapshots[next() % snapshots.length];
    if (sequence % 3 === 0) {
      importBundle(receiver.objects, receiver.refs, selected.bytes);
      assert.equal(receiver.refs.read("refs/heads/main"), selected.revision);
      const replay = importBundle(receiver.objects, receiver.refs, selected.bytes); assert.equal(replay.added.length, 0);
    } else if (sequence % 3 === 1) {
      importChangeBundle(receiver, selected.signed, policy, { [branch]: receiver.refs.read(branch) });
      importChangeBundle(receiver, selected.signed, policy, { [branch]: selected.revision });
      assert.equal(receiver.refs.read(branch), selected.revision);
    } else {
      await fetchFrom(receiver, "origin", new Date(1001));
      selected = snapshots[snapshots.length - 1];
      assert.equal(receiver.refs.read("refs/remotes/origin/main"), selected.revision);
    }
    materialize(receiver, selected.revision, target);
    copyFileSync(join(f.pmRoot, "settings.json"), join(target, ".agents/pm/settings.json"));
    mkdirSync(join(target, ".agents/pm/schema"), { recursive: true });
    copyFileSync(join(f.pmRoot, "schema/statuses.json"), join(target, ".agents/pm/schema/statuses.json"));
    const itemPath = join(target, `.agents/pm/tasks/${f.a}.toon`);
    const variant = serializeItemDocument(selected.model, { format: "toon" });
    writeFileSync(itemPath, sequence % 2 === 0 ? variant.replaceAll("\n", "\r\n") : variant + "\n");
    assert.deepEqual(await document(join(target, ".agents/pm"), f.a), selected.model, `seed 0x53295 sequence ${sequence}`);
    if (sequence % 100 === 99) console.log(`tracker admission model sequences: ${sequence + 1}`);
  }
  const cloned = await cloneFrom(f.root, join(temp(), "clone"), new Date(1000));
  const clone = Repository.open(cloned.root); await fetchFrom(clone, "origin", new Date(1001));
  const pmRoot = join(cloned.root, ".agents/pm"); copyFileSync(join(f.pmRoot, "settings.json"), join(pmRoot, "settings.json"));
  mkdirSync(join(pmRoot, "schema"), { recursive: true }); copyFileSync(join(f.pmRoot, "schema/statuses.json"), join(pmRoot, "schema/statuses.json"));
  assert.deepEqual(await document(pmRoot, f.a), model.get(f.a));
});

test("unavailable, legacy alias, empty and malformed histories fail alone with bounded retry receipts", async () => {
  const f = await fixture();
  for (const raw of ["missing", f.a.replace("admission-", "")]) {
    const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [raw, f.b], expectedTip: null }).commit(options, new Date(1));
    assert.equal(report.ok, false); if (report.ok) assert.fail(); assert.equal(report.retry.length, 1); assert.equal(report.checked, 2);
    assert.ok(JSON.stringify(report).length < 1000); assert.ok(Number.isSafeInteger(report.checked)); assert.ok(report.checked <= 100);
  }
  const historyPath = join(f.pmRoot, `history/${f.a}.jsonl`); const bytes = readFileSync(historyPath);
  for (const content of [null, "", "invalid history\n"]) {
    if (content === null) rmSync(historyPath); else writeFileSync(historyPath, content);
    const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.equal(report.ok, false);
    assert.equal(f.repo.refs.readHead().target, null);
  }
  writeFileSync(historyPath, bytes);
  const external = Repository.init(temp());
  const report = await new TrackerCapture(external, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.equal(report.ok, false);
  if (report.ok) assert.fail(); assert.equal(report.retry[0].reason, "outside_workspace"); assert.match(report.remedy, /workspace containing/);
});

test("foreign transaction outcomes and malformed markers are retry witnesses, never exceptions or native tips", async () => {
  const f = await fixture();
  const outcomes = [undefined, null, "foreign", [], { id: "foreign" }];
  for (let index = 0; index < outcomes.length; index++) {
    const transactionId = `foreign-${index}`;
    const target = (await f.client.create({ ...scope, type: "Task", title: `Foreign target ${index}` })).item.id;
    await commitWorkspaceTransaction({ pmRoot: f.pmRoot, transactionId, author: "fixture", steps: [{ id: "s", async inspect() { return { state: "pending" }; }, async apply() { return outcomes[index]; }, async compensate() {} }] });
    await f.client.update(target, { ...scope, title: `Foreign ${index}`, message: `bulk-item-transaction ${transactionId} s apply` });
    const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [target], expectedTip: null }).commit(options, new Date(1)); assert.equal(report.ok, false);
  }
  for (const marker of ["bulk-item-transaction missing s apply", "bulk-item-transaction malformed"]) {
    // A fresh record isolates this refusal from earlier foreign events.
    const id = (await f.client.create({ ...scope, type: "Task", title: "Marker", message: marker })).item.id;
    const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [id], expectedTip: null }).commit(options, new Date(1));
    assert.equal(report.ok, false); if (report.ok) assert.fail(); assert.equal(report.retry[0].reason, "transaction_unverified");
  }
});

test("changing settings between retries revalidates all targets and a native peer at each boundary wins truthfully", async () => {
  const f = await fixture(); const history = join(f.pmRoot, `history/${f.b}.jsonl`); const bytes = readFileSync(history); rmSync(history);
  const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null });
  assert.equal((await capture.commit(options, new Date(1))).ok, false);
  await f.client.config("project", "set", "output.default_format", "json"); writeFileSync(history, bytes);
  const result = await capture.commit(options, new Date(2)); assert.ok(result.ok); assert.equal(result.reused, 0); assert.equal(result.checked, 2);
  for (const cut of ["located", "item", "history", "captured"]) {
    const expectedTip = f.repo.refs.readHead().target; let peer: string | undefined;
    trackerAdmissionBoundary.visit = async step => { if (step === cut && peer === undefined) peer = f.repo.commit({ ...options, message: "Peer" }, new Date(3)); };
    await assert.rejects(new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip }).commit(options, new Date(4)), { code: "tracker_tip_changed" });
    assert.equal(f.repo.refs.readHead().target, peer);
  }
});

test("native capture bypasses stale stat cache, preserves file identity and rejects protected selections", async () => {
  const f = await fixture();
  const selected = { items: [f.a], expectedTip: null };
  const result = await new TrackerCapture(f.repo, f.pmRoot, selected).commit(options, new Date(1)); assert.ok(result.ok);
  const path = `.agents/pm/tasks/${f.a}.toon`; const original = f.repo.readIndex().find(row => row.path === path)!;
  await f.client.update(f.a, { ...scope, title: "Next" });
  const next = await new TrackerCapture(f.repo, f.pmRoot, { ...selected, expectedTip: result.revision }).commit(options, new Date(2)); assert.ok(next.ok);
  assert.equal(f.repo.readIndex().find(row => row.path === path)!.fileId, original.fileId);
  for (const denied of [".pmvcs/config.json", "../external"]) {
    assert.throws(() => f.repo.commitCaptured(options, [{ path: denied, content: Buffer.from("bad") }], next.revision, new Date(3)));
    assert.equal(f.repo.refs.readHead().target, next.revision);
  }
  writeFileSync(join(f.root, ".pmvcsignore"), ".agents/pm/tasks/**\n");
  await assert.rejects(new TrackerCapture(f.repo, f.pmRoot, { ...selected, expectedTip: next.revision }).commit(options, new Date(3)), { code: "path_ignored" });
});

test("one capture session refuses overlapping attempts and releases its local guard after failure", async () => {
  const f = await fixture();
  const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null });
  let release: () => void = () => {}; const paused = new Promise<void>(resolve => { release = resolve; });
  let signal: () => void = () => {}; const entered = new Promise<void>(resolve => { signal = resolve; });
  trackerAdmissionBoundary.visit = async step => { if (step === "item") { signal(); await paused; } };
  const active = capture.commit(options, new Date(1)); await entered;
  const overlapping = capture.commit(options, new Date(1));
  release(); await assert.rejects(overlapping, { code: "tracker_capture_busy" });
  assert.ok((await active).ok);
});

test("structured native capture preserves SDK fields and refuses sparse/conflicted/private paths", async () => {
  const f = await fixture();
  // Configure native record storage without modifying the tracker or resolving codecs ourselves.
  const configPath = join(f.repo.controlDirectory, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { recordPaths: string[] };
  writeFileSync(configPath, JSON.stringify({ ...config, recordPaths: ["**/*.toon"] }));
  const repo = Repository.open(f.root);
  const report = await new TrackerCapture(repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.ok(report.ok);
  const path = `.agents/pm/tasks/${f.a}.toon`;
  assert.equal(repo.objects.read(repo.readIndex().find(row => row.path === path)!.id).type, "record");
  const original = repo.readIndex();
  for (const entry of [{ ...original[0], sparse: true }, { ...original[0], conflicts: [original[0].id] }]) {
    repo.writeIndex([entry, ...original.slice(1)]);
    assert.throws(() => repo.commitCaptured(options, [{ path: entry.path, content: Buffer.from("bad") }], report.revision, new Date(2)), { code: "path_ignored" });
  }
  repo.writeIndex(original);
  repo.addLayer("private-tracker", new Map([[path, { content: readFileSync(join(f.root, path)), executable: false }]]));
  assert.throws(() => repo.commitCaptured(options, [{ path, content: Buffer.from("bad") }], report.revision, new Date(2)), { code: "path_ignored" });
});

test("a transaction between selected pairs invalidates only its previously captured selected members", async () => {
  for (const cut of ["history", "transaction"]) {
  const f = await fixture(); let fired = false;
  if (cut === "transaction") await commitItemMutations({ pmRoot: f.pmRoot, transactionId: "baseline", author: "fixture", mutations: [
    { op: "update", id: f.a, options: { ...scope, title: "Baseline A" } }, { op: "update", id: f.b, options: { ...scope, title: "Baseline B" } },
  ] });
  trackerAdmissionBoundary.visit = async (step, id) => {
    if (step === cut && id === f.a && !fired) {
      fired = true;
      await commitItemMutations({ pmRoot: f.pmRoot, transactionId: "between-pairs", author: "fixture", mutations: [
        { op: "update", id: f.a, options: { ...scope, title: "Coherent A" } }, { op: "update", id: f.b, options: { ...scope, title: "Coherent B" } },
      ] });
    }
  };
  const capture = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a, f.b], expectedTip: null });
  const retry = await capture.commit(options, new Date(1)); assert.equal(retry.ok, false); if (retry.ok) assert.fail();
  assert.deepEqual(retry.retry, [{ id: f.a, reason: "transaction_unverified" }]); assert.equal(f.repo.refs.readHead().target, null);
  const seen: string[] = []; trackerAdmissionBoundary.visit = async (step, id) => { if (step === "located") seen.push(id); };
  const result = await capture.commit(options, new Date(2)); assert.ok(result.ok); assert.equal(result.reused, 1); assert.deepEqual(seen, [f.a]);
  }
});

test("packed CLI admits JSON and TOON without a git executable and returns compact typed retry", async () => {
  const f = await fixture(); installPackedExtension(f.root);
  const input = join(f.root, "selection.json"); writeFileSync(input, JSON.stringify({ items: [f.a], expectedTip: null }));
  const environment = testEnvironment({ PATH: temp(), GIT_CEILING_DIRECTORIES: dirname(f.root), PM_AUTHOR: "fixture" });
  const run = (args: string[]) => execFileSync(process.execPath, [pmExecutable, "vcs", "commit-tracker", "Certified tracker", "--input", input, ...args], { cwd: f.root, env: environment, encoding: "utf8", timeout: 60000 });
  const json = run(["--json"]); const receipt = JSON.parse(json) as { ok: boolean; revision: string }; assert.equal(receipt.ok, true);
  writeFileSync(input, JSON.stringify({ items: [f.a], expectedTip: receipt.revision }));
  await f.client.update(f.a, { ...scope, title: "Next" });
  const toon = run([]); assert.match(toon, /ok: true/);
  const itemPath = join(f.pmRoot, `tasks/${f.a}.toon`); writeFileSync(itemPath, readFileSync(itemPath, "utf8").replace("Next", "Torn"));
  const retry = run(["--json"]); assert.equal((JSON.parse(retry) as { code: string }).code, "tracker_capture_retry");
  assert.ok(Buffer.byteLength(json) < 1000 && Buffer.byteLength(toon) < 1000 && Buffer.byteLength(retry) < 1000);
  assert.equal(existsSync(join(f.root, ".git")), false);
});

test("SDK membership ignores foreign result payloads and checks only selected transaction members", async () => {
  const f = await fixture();
  await commitWorkspaceTransaction({ pmRoot: f.pmRoot, transactionId: "foreign-extra", author: "fixture", steps: [
    { id: "owned", async inspect() { return { state: "pending" }; }, async apply() { return { id: f.a }; }, async compensate() {} },
    { id: "foreign", async inspect() { return { state: "pending" }; }, async apply() { return null; }, async compensate() {} },
  ] });
  await f.client.update(f.a, { ...scope, title: "SDK certificate", message: "bulk-item-transaction foreign-extra owned apply" });
  const report = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.ok(report.ok);
});

test("captured pairs retain legacy FileId migration, executable modes and copied provenance", async () => {
  const f = await fixture();
  const initial = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.ok(initial.ok);
  const entries = f.repo.readIndex(); const target = entries.find(row => row.path.endsWith(".toon"))!;
  const legacy = { ...target, fileId: undefined };
  f.repo.writeIndex(entries.map(row => row === target ? legacy : row));
  const migrated = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: initial.revision }).commit(options, new Date(2)); assert.ok(migrated.ok);
  const current = f.repo.readIndex(); const native = current.find(row => row.path === target.path)!;
  assert.equal(native.fileId, migratedFileId(legacy));
  const copiedFrom = "a".repeat(32);
  f.repo.writeIndex(current.map(row => row === native ? { ...row, mode: "100755", copiedFrom } : row));
  const next = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: migrated.revision }).commit(options, new Date(3)); assert.ok(next.ok);
  const after = f.repo.readIndex().find(row => row.path === target.path)!;
  assert.equal(after.mode, "100755"); assert.equal(after.copiedFrom, copiedFrom); assert.equal(after.fileId, native.fileId);
});

test("capture binds branch identity even when a peer switches HEAD to the same revision", async () => {
  const f = await fixture();
  const baseline = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.ok(baseline.ok);
  const main = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: baseline.revision });
  f.repo.createBranch("peer", "HEAD", new Date(2)); f.repo.switchTo("peer", new Date(2));
  await assert.rejects(main.commit(options, new Date(3)), { code: "tracker_tip_changed" });
  const branch = new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: baseline.revision });
  f.repo.switchTo(baseline.revision, new Date(3));
  await assert.rejects(branch.commit(options, new Date(4)), { code: "tracker_tip_changed" });
  const detached = await new TrackerCapture(f.repo, f.pmRoot, { items: [f.a], expectedTip: baseline.revision }).commit(options, new Date(5)); assert.ok(detached.ok);
  assert.equal(f.repo.refs.read("refs/heads/main"), baseline.revision); assert.equal(f.repo.refs.read("refs/heads/peer"), baseline.revision);
});

test("record codecs refuse malformed shapes and preserve SDK custom-status documents and aliases", async () => {
  for (const value of [null, true, 1, [], { title: "Missing status" }, { front_matter: null }, { front_matter: 1 }, { front_matter: [] }, { front_matter: { status: 1 } }]) {
    assert.throws(() => parseWorkingRecord("invalid.toon", Buffer.from(encodeToon(value))));
  }
  const f = await fixture(); await f.client.schemaAddStatus("custom-running", { role: ["active"], alias: ["active-alias"], author: "fixture" });
  await f.client.update(f.a, { ...scope, status: "custom-running", parent: f.b, unset: ["sprint", "release"], dep: [`id=${f.b},kind=related`], body: "  body\r\nwith whitespace  \r\n" });
  const expected = await document(f.pmRoot, f.a); const itemPath = join(f.pmRoot, `tasks/${f.a}.toon`);
  writeFileSync(itemPath, encodeToon({ front_matter: { ...expected.metadata, status: "active-alias" }, body: expected.body }));
  const legacy = parseWorkingRecord("legacy.toon", Buffer.from(encodeToon({ front_matter: expected.metadata, body: expected.body })));
  assert.equal(legacy.status, expected.metadata.status);
  writeFileSync(join(f.repo.controlDirectory, "config.json"), JSON.stringify({ recordPaths: ["**/*.toon"], recordPolicy: {} }));
  const repo = Repository.open(f.root);
  const report = await new TrackerCapture(repo, f.pmRoot, { items: [f.a], expectedTip: null }).commit(options, new Date(1)); assert.ok(report.ok);
  const target = temp(); materialize(repo, report.revision, target);
  const found = { id: f.a, type: "Task", item_format: "toon" as const, itemPath: join(target, `.agents/pm/tasks/${f.a}.toon`) };
  const settings = await readSettings(f.pmRoot);
  const actual = (await readLocatedItem(found, { schema: settings.schema })).document;
  assert.deepEqual(actual, expected);
  const history = await readHistorySnapshot(join(target, `.agents/pm/history/${f.a}.jsonl`), f.a);
  assert.equal(verifyHistoryEntries(history.entries, actual).ok, true);
});
