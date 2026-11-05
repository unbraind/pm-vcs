import "./helpers/isolate-session.ts";
/** Review regressions exercise real non-git trackers and the same native CLI handlers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient, readSettings, readLocatedItem, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { TrackerCapture } from "../engine/tracker-admission.ts";
import { flattenTree } from "../engine/worktree.ts";
import { readCommit } from "../engine/model.ts";
import { parseWorkingRecord } from "../engine/record-format.ts";
import { Repository } from "../engine/repo.ts";
import { trackerAdmissionDigest } from "./helpers/tracker-admission-digest.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const dir of owned.splice(0)) dir.cleanup(); });

/** Initialize an independently owned SDK tracker without git or ambient relationship defaults. */
async function fixture(rootTracker = false) {
  const dir = makeTempDir(); owned.push(dir);
  const root = dir.root; const pmRoot = rootTracker ? root : join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
  await client.init("review", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Review fixture", unset: ["parent", "sprint", "release"], author: "fixture" })).item;
  return { root, pmRoot, client, item };
}

test("working schema cache reuses resolved roots and invalidates every configured schema source", async () => {
  const f = await fixture(); const other = await fixture();
  const settingsPath = join(f.pmRoot, "settings.json"); const settings = await readSettings(f.pmRoot);
  const statusesPath = join(f.pmRoot, "chosen-statuses.json"); const fieldsPath = join(f.pmRoot, "chosen-fields.json");
  const schema = { ...settings.schema, statuses: [], fields: [], files: { statuses: "chosen-statuses.json", fields: "chosen-fields.json" }, unknown_field_policy: "reject" };
  writeFileSync(settingsPath, JSON.stringify({ ...settings, schema }));
  writeFileSync(statusesPath, JSON.stringify([{ id: "custom_one", aliases: ["active_alias"] }]));
  writeFileSync(fieldsPath, JSON.stringify([{ key: "ticket_code", type: "string" }]));
  // Cache reuse is safe only after every source has aged beyond the filesystem timestamp tick.
  const stableTime = new Date(Date.now() - 10_000);
  for (const path of [settingsPath, statusesPath, fieldsPath]) utimesSync(path, stableTime, stableTime);
  const raw = Buffer.from(encodeToon({ front_matter: { ...f.item, status: "active_alias", ticket_code: "ABC" }, body: "" }));
  const sources = new Set([settingsPath, statusesPath, fieldsPath]); const reads: string[] = [];
  const read = fs.readFileSync;
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === "string" && sources.has(args[0])) reads.push(args[0]);
    return Reflect.apply(read, fs, args);
  }); syncBuiltinESMExports();
  const parse = (pmRoot = f.pmRoot) => parseWorkingRecord("item.toon", raw, pmRoot);
  assert.equal(parse().status, "custom_one"); assert.equal(reads.length, 3);
  for (const root of [f.pmRoot, join(f.pmRoot, "schema", ".."), relative(process.cwd(), f.pmRoot)]) assert.equal(parse(root).status, "custom_one");
  assert.equal(reads.length, 3, "Cache hits must not reread or parse schema files, including equivalent roots.");
  assert.equal(parse(other.pmRoot).status, "active_alias", "Separate tracker roots must not share schemas.");

  // Same size and inode: only the changed mtime distinguishes this rewrite.
  const original = statSync(statusesPath); const second = readFileSync(statusesPath, "utf8").replace("custom_one", "custom_two");
  reads.length = 0; writeFileSync(statusesPath, second); utimesSync(statusesPath, original.atime, new Date(original.mtimeMs + 2000));
  assert.equal(parse().status, "custom_two"); assert.equal(reads.length, 3);
  // Identical size and timestamp: replacement must be detected by inode.
  const replacement = statusesPath + ".replacement"; const current = statSync(statusesPath);
  writeFileSync(replacement, second.replace("custom_two", "custom_six")); utimesSync(replacement, current.atime, current.mtime); renameSync(replacement, statusesPath);
  assert.equal(parse().status, "custom_six");
  // With inode and timestamp retained, a size change still invalidates the cache.
  const sized = statSync(statusesPath); writeFileSync(statusesPath, JSON.stringify([{ id: "custom_longer", aliases: ["active_alias"] }])); utimesSync(statusesPath, sized.atime, sized.mtime);
  assert.equal(parse().status, "custom_longer");

  writeFileSync(fieldsPath, "[]"); assert.equal(parse().status, "active_alias", "A removed strict-schema field must invalidate cached decoding.");
  rmSync(fieldsPath); assert.equal(parse().status, "active_alias");
  writeFileSync(fieldsPath, JSON.stringify([{ key: "ticket_code", type: "string" }])); assert.equal(parse().status, "custom_longer");
  const redirected = join(f.pmRoot, "redirected.json"); writeFileSync(redirected, JSON.stringify([{ id: "redirected", aliases: ["active_alias"] }]));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, schema: { ...schema, files: { ...schema.files, statuses: "redirected.json" } } }));
  assert.equal(parse().status, "redirected");
  writeFileSync(redirected, JSON.stringify([{ id: "new_target", aliases: ["active_alias"] }])); assert.equal(parse().status, "new_target");
  writeFileSync(settingsPath, "invalid JSON"); assert.equal(parse().status, "active_alias");
  writeFileSync(settingsPath, JSON.stringify({ ...settings, schema })); assert.equal(parse().status, "custom_longer");
});

test("working schema cache rereads same-tick same-mtime rewrites of every schema source", async () => {
  for (const source of ["settings.json", "chosen-statuses.json", "chosen-fields.json"]) {
    const f = await fixture(); const settings = await readSettings(f.pmRoot);
    const statuses = [{ id: "custom_one", aliases: ["active_alias"] }];
    const schema = { ...settings.schema, statuses: source === "settings.json" ? statuses : [], fields: [], files: { statuses: "chosen-statuses.json", fields: "chosen-fields.json" }, unknown_field_policy: "reject" };
    const contents = new Map([
      ["settings.json", JSON.stringify({ ...settings, schema })],
      ["chosen-statuses.json", JSON.stringify(source === "settings.json" ? [] : statuses)],
      ["chosen-fields.json", JSON.stringify([{ key: "ticket_code", type: "string" }])],
    ]);
    const tick = Math.floor(Date.now() / 1000) * 1000;
    for (const [name, bytes] of contents) {
      writeFileSync(join(f.pmRoot, name), bytes); utimesSync(join(f.pmRoot, name), (tick - 10_000) / 1000, (tick - 10_000) / 1000);
    }
    const raw = Buffer.from(encodeToon({ front_matter: { ...f.item, status: "active_alias", ticket_code: "ABC" }, body: "" }));
    const parse = () => parseWorkingRecord("item.toon", raw, f.pmRoot).status;
    assert.equal(parse(), "custom_one", "Warm a stable schema before making one source racy.");
    const now = mock.method(Date, "now", () => tick + 100);
    try {
      const path = join(f.pmRoot, source); utimesSync(path, tick / 1000, tick / 1000);
      assert.equal(parse(), "custom_one");
      const before = statSync(path, { bigint: true });
      writeFileSync(path, contents.get(source)!.replace(source === "chosen-fields.json" ? "ticket_code" : "custom_one", source === "chosen-fields.json" ? "absent_code" : "custom_two"));
      utimesSync(path, tick / 1000, tick / 1000);
      const after = statSync(path, { bigint: true });
      assert.deepEqual([after.ino, after.size, after.mtimeNs], [before.ino, before.size, before.mtimeNs], "Force an identical cache signature despite changed bytes.");
      const expected = source === "chosen-fields.json" ? "active_alias" : "custom_two";
      assert.equal(parse(), expected, `${source} must be reread inside the timestamp tick.`);
      now.mock.mockImplementation(() => tick + 3000);
      assert.equal(parse(), expected, "Aged sources can populate the cache with the new schema.");
      assert.equal(parse(), expected);
    } finally { now.mock.restore(); }
  }
});

test("tracker byte validation includes configured item folders inside root runtime directories", async () => {
  const f = await fixture();
  for (const [index, folder] of ["search", "runtime/cards", "locks", "extensions"].entries()) {
    const type = `Experiment${index}`;
    await f.client.schemaAddType(type, { folder, author: "fixture" });
    const item = (await f.client.create({ type, title: "Custom source", unset: ["parent", "sprint", "release"], author: "fixture" })).item;
    const path = join(f.pmRoot, folder, `${item.id}.toon`); const bytes = readFileSync(path);
    const before = await trackerAdmissionDigest(f.pmRoot);
    writeFileSync(path, bytes.toString().replace("Custom source", "Edited source"));
    assert.notEqual(await trackerAdmissionDigest(f.pmRoot), before, `${folder} item bytes must be included.`);
    writeFileSync(path, bytes); assert.equal(await trackerAdmissionDigest(f.pmRoot), before);
    renameSync(path, path.replace(/\.toon$/, ".md"));
    assert.notEqual(await trackerAdmissionDigest(f.pmRoot), before, "Both native document formats and renames must be visible.");
    const markdown = await trackerAdmissionDigest(f.pmRoot);
    writeFileSync(join(f.pmRoot, folder, "derived-cache"), "derived");
    assert.equal(await trackerAdmissionDigest(f.pmRoot), markdown, "Derived files must stay excluded beside custom item documents.");
  }
});

test("tracker byte validation separates entry types and filename-content boundaries", async () => {
  const f = await fixture(); const file = join(f.pmRoot, "probe-a"); const renamed = `${file}b`;
  writeFileSync(file, "bc"); const before = await trackerAdmissionDigest(f.pmRoot);
  renameSync(file, renamed); writeFileSync(renamed, "c");
  assert.notEqual(await trackerAdmissionDigest(f.pmRoot), before, "a + bc and ab + c must have distinct framed input.");
  rmSync(renamed); mkdirSync(file); const directory = await trackerAdmissionDigest(f.pmRoot);
  rmSync(file, { recursive: true }); writeFileSync(file, createHash("sha256").digest());
  assert.notEqual(await trackerAdmissionDigest(f.pmRoot), directory, "A file containing a directory digest is still a different entry type.");
});

test("tracker byte validation includes nested custom folders named like root runtime directories", async () => {
  const f = await fixture();
  await f.client.schemaAddType("Experiment", { folder: "research/search", author: "fixture" });
  const item = (await f.client.create({ type: "Experiment", title: "Nested source", unset: ["parent", "sprint", "release"], author: "fixture" })).item;
  const before = await trackerAdmissionDigest(f.pmRoot);
  for (const name of ["runtime", "search", "locks", "extensions"]) {
    mkdirSync(join(f.pmRoot, name), { recursive: true }); writeFileSync(join(f.pmRoot, name, "cache"), "derived");
    assert.equal(await trackerAdmissionDigest(f.pmRoot), before);
    const nested = join(f.pmRoot, "research", name); mkdirSync(nested, { recursive: true });
    const file = join(nested, "probe"); writeFileSync(file, "tracked");
    assert.notEqual(await trackerAdmissionDigest(f.pmRoot), before); rmSync(file);
    // Remove only directories this test added, preserving the SDK's custom item folder.
    if (name !== "search") rmSync(nested, { recursive: true });
  }
  assert.equal(await trackerAdmissionDigest(f.pmRoot), before);
  const path = join(f.pmRoot, `research/search/${item.id}.toon`); const bytes = readFileSync(path);
  writeFileSync(path, bytes.toString().replace("Nested source", "Changed source"));
  assert.notEqual(await trackerAdmissionDigest(f.pmRoot), before, "Custom item byte changes must fail the validator's immutability assertion.");
  writeFileSync(path, bytes); assert.equal(await trackerAdmissionDigest(f.pmRoot), before);
});

test("commit-tracker stores exactly the same terminated message as the vcs commit handler", async () => {
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  for (const message of ["Review message", "  Multiple lines\n\nwith detail\n\n  "]) {
    const f = await fixture(); const repo = Repository.init(f.root);
    const ordinary = await harness.runCommand({ command: "vcs commit", pmRoot: f.pmRoot, options: { message, allowEmpty: true } });
    assert.equal(ordinary.errorMessage, undefined);
    const baseline = readCommit(repo.objects, (ordinary.result as { commit: string }).commit).message;
    writeFileSync(join(f.root, "selection.json"), JSON.stringify({ items: [f.item.id], expectedTip: repo.refs.readHead().target }));
    const captured = await harness.runCommand({ command: "vcs commit-tracker", pmRoot: f.pmRoot, args: [message], options: { input: join(f.root, "selection.json") } });
    assert.equal(captured.errorMessage, undefined);
    const actual = readCommit(repo.objects, (captured.result as { revision: string }).revision).message;
    assert.equal(actual, baseline); assert.equal(actual, `${message.trim()}\n`);
  }
});


test("capture classifies moved items by exact SDK type folders in root and nested trackers", async () => {
  for (const rootTracker of [true, false]) for (const extension of ["toon", "md"]) {
    const f = await fixture(rootTracker);
    await f.client.schemaAddType("Experiment", { folder: "research/cards", author: "fixture" });
    const oldFile = join(f.pmRoot, `tasks/${f.item.id}.toon`);
    if (extension === "md") {
      const located = { id: f.item.id, type: "Task", item_format: "toon" as const, itemPath: oldFile };
      const document = (await readLocatedItem(located, { schema: (await readSettings(f.pmRoot)).schema })).document;
      writeFileSync(oldFile, serializeItemDocument(document, { format: "json_markdown" }));
      renameSync(oldFile, oldFile.replace(/\.toon$/, ".md"));
    }
    const repo = Repository.init(f.root);
    const prefix = rootTracker ? "" : ".agents/pm/";
    const unrelated = [`docs/${f.item.id}.md`, `notes/${f.item.id}.toon`, `${prefix}tasks/archive/${f.item.id}.md`, `${prefix}research/cards/notes/${f.item.id}.toon`];
    for (const path of unrelated) {
      mkdirSync(join(f.root, path, ".."), { recursive: true }); writeFileSync(join(f.root, path), "Unrelated reference");
    }
    repo.stage(unrelated);
    const options = { message: "Root tracker paths\n", author: { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 }, allowEmpty: true };
    const baseline = await new TrackerCapture(repo, f.pmRoot, { items: [f.item.id], expectedTip: null }).commit(options, new Date(1));
    assert.ok(baseline.ok, JSON.stringify(baseline));
    const tree = flattenTree(repo.objects, readCommit(repo.objects, baseline.revision).tree);
    for (const path of unrelated) assert.equal(repo.objects.read(tree.get(path)!.id).payload.toString(), "Unrelated reference");
    const previous = `${prefix}tasks/${f.item.id}.${extension}`;
    const next = `${prefix}research/cards/${f.item.id}.${extension}`;
    renameSync(join(f.root, previous), join(f.root, next));
    const index = readFileSync(join(repo.controlDirectory, "index")); const inventory = repo.objects.inventory().map(row => row.id).sort();
    await assert.rejects(new TrackerCapture(repo, f.pmRoot, { items: [f.item.id], expectedTip: baseline.revision }).commit(options, new Date(2)), { code: "tracker_path_changed" });
    assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), index);
    assert.deepEqual(repo.objects.inventory().map(row => row.id).sort(), inventory);
    assert.equal(repo.refs.readHead().target, baseline.revision);
    repo.stage([previous]);
    const result = await new TrackerCapture(repo, f.pmRoot, { items: [f.item.id], expectedTip: baseline.revision }).commit(options, new Date(3));
    assert.ok(result.ok, JSON.stringify(result));
    const paths = [...flattenTree(repo.objects, readCommit(repo.objects, result.revision).tree).keys()];
    assert.ok(paths.includes(next)); assert.ok(!paths.includes(previous));
  }
});

test("tracker byte validation hashes the managed extension manifest and excludes only derived extension files", async () => {
  const f = await fixture(); const extensions = join(f.pmRoot, "extensions");
  mkdirSync(extensions, { recursive: true });
  const manifest = join(extensions, ".managed-extensions.json");
  rmSync(manifest, { force: true }); const absent = await trackerAdmissionDigest(f.pmRoot);
  writeFileSync(manifest, '{"extensions":[]}'); const initial = await trackerAdmissionDigest(f.pmRoot);
  assert.notEqual(initial, absent, "Adding a tracked manifest must change the source digest.");
  mkdirSync(join(extensions, "derived")); writeFileSync(join(extensions, "derived/cache"), "derived");
  writeFileSync(join(extensions, "cache"), "first"); assert.equal(await trackerAdmissionDigest(f.pmRoot), initial);
  writeFileSync(join(extensions, "cache"), "changed"); assert.equal(await trackerAdmissionDigest(f.pmRoot), initial);
  writeFileSync(manifest, '{"extensions":["changed"]}'); assert.notEqual(await trackerAdmissionDigest(f.pmRoot), initial);
  writeFileSync(manifest, '{"extensions":[]}'); assert.equal(await trackerAdmissionDigest(f.pmRoot), initial);
  rmSync(manifest); assert.equal(await trackerAdmissionDigest(f.pmRoot), absent, "Deleting the manifest must also change the digest.");
});
