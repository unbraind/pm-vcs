import "./helpers/isolate-session.ts";
/** Review regressions exercise real non-git trackers and the same native CLI handlers. */
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { afterEach, mock, test } from "node:test";
import { PmClient, readSettings } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { readCommit } from "../engine/model.ts";
import { parseWorkingRecord } from "../engine/record-format.ts";
import { Repository } from "../engine/repo.ts";
import { trackerAdmissionDigest } from "./helpers/tracker-admission-digest.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const dir of owned.splice(0)) dir.cleanup(); });

/** Initialize an independently owned SDK tracker without git or ambient relationship defaults. */
async function fixture() {
  const dir = makeTempDir(); owned.push(dir);
  const root = dir.root; const pmRoot = join(root, ".agents/pm");
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

test("tracker byte validation includes nested custom folders named like root runtime directories", async () => {
  const f = await fixture();
  await f.client.schemaAddType("Experiment", { folder: "research/search", author: "fixture" });
  const item = (await f.client.create({ type: "Experiment", title: "Nested source", unset: ["parent", "sprint", "release"], author: "fixture" })).item;
  const before = trackerAdmissionDigest(f.pmRoot);
  for (const name of ["runtime", "search", "locks", "extensions"]) {
    mkdirSync(join(f.pmRoot, name), { recursive: true }); writeFileSync(join(f.pmRoot, name, "cache"), "derived");
    assert.equal(trackerAdmissionDigest(f.pmRoot), before);
    const nested = join(f.pmRoot, "research", name); mkdirSync(nested, { recursive: true });
    const file = join(nested, "probe"); writeFileSync(file, "tracked");
    assert.notEqual(trackerAdmissionDigest(f.pmRoot), before); rmSync(file);
    // Remove only directories this test added, preserving the SDK's custom item folder.
    if (name !== "search") rmSync(nested, { recursive: true });
  }
  assert.equal(trackerAdmissionDigest(f.pmRoot), before);
  const path = join(f.pmRoot, `research/search/${item.id}.toon`); const bytes = readFileSync(path);
  writeFileSync(path, bytes.toString().replace("Nested source", "Changed source"));
  assert.notEqual(trackerAdmissionDigest(f.pmRoot), before, "Custom item byte changes must fail the validator's immutability assertion.");
  writeFileSync(path, bytes); assert.equal(trackerAdmissionDigest(f.pmRoot), before);
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
