/** Native large-file staging, working comparisons and physical collection receipts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { traceFile } from "../engine/attribution.ts";
import { STAGING_CDC_PARAMS, blobFileContentId, cdcFragmentedContentId, cdcFragmentedFileContentId, matchesFragmentedFile, readFragmentRange, readFragmented, writeFragmented } from "../engine/fragments.ts";
import { collectGarbage } from "../engine/gc.ts";
import { hashObject } from "../engine/objects.ts";
import { manifestFragments } from "../engine/manifest-pages.ts";
import { type Signature } from "../engine/model.ts";
import { Repository } from "../engine/repo.ts";
import { mergePath } from "../engine/rewrite.ts";
import { RACY_WINDOW_NS, readWorkingStat } from "../engine/worktree.ts";
import { readHints, writeHints } from "../engine/instances.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { installPackedExtension, withoutPmContext } from "../scripts/pm-environment.ts";
import { benchmarkPhase6 } from "../scripts/phase6-benchmark.ts";

const directories: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
afterEach(() => { for (const directory of directories.splice(0)) directory.cleanup(); });

/** Initialize a real PM tracker in a plain directory, never an enclosing Git checkout. */
async function fresh() {
  const directory = makeTempDir(); directories.push(directory);
  const client = new PmClient({ cwd: directory.root, pmRoot: join(directory.root, ".agents/pm"), noExtensions: true });
  await client.init("scale", { defaults: true, author: "fixture" });
  return { repo: Repository.init(directory.root), client };
}

test("native staging streams CDC, retains renamed identities and traces PM items across changes", async () => {
  const { repo, client } = await fresh();
  const item = (await client.create({ type: "Task", title: "Binary provenance", author: "fixture" })).item.id;
  const bytes = randomBytes(2 * 1024 * 1024);
  bytes[400] = 42; // Pin the mutation coordinate so a literal-42 write would be a reproducible no-op.
  const file = join(repo.root, "asset.bin"); writeFileSync(file, bytes);
  const expected = cdcFragmentedContentId(bytes, STAGING_CDC_PARAMS);
  assert.equal(cdcFragmentedFileContentId(file), cdcFragmentedContentId(bytes));
  assert.equal(cdcFragmentedFileContentId(file, STAGING_CDC_PARAMS), expected);
  assert.throws(() => cdcFragmentedFileContentId(file, { minChunkSize: 0, maxChunkSize: 1, mask: 0 }), { code: "invalid_cdc_params" });
  /** Any whole-file reader invocation violates the large-file memory contract. */
  const forbidBuffer = (): never => { throw new Error("whole-file materialization"); };
  assert.deepEqual(repo.stage(["asset.bin"], forbidBuffer), ["asset.bin"]);
  const original = repo.readIndex()[0]; assert.equal(original.id, expected);
  assert.equal(repo.objects.read(original.id).type, "manifest");
  const first = repo.commit({ message: "binary baseline", author, items: [item] }, new Date());
  assert.equal(repo.status(forbidBuffer).clean, false, "untracked tracker remains visible");
  assert.deepEqual(repo.status(forbidBuffer).unstaged, []);
  renameSync(file, join(repo.root, "renamed.bin"));
  const edited = Buffer.from(bytes); edited[100] ^= 255; writeFileSync(join(repo.root, "renamed.bin"), edited);
  repo.stage(["renamed.bin"], forbidBuffer);
  const second = repo.commit({ message: "rename and edit", author, items: [item] }, new Date());
  const current = repo.readIndex()[0]; assert.equal(current.fileId, original.fileId);
  assert.equal(repo.readIndex().length, 1);
  const trace = traceFile(repo.objects, [second, first], original.fileId!);
  assert.deepEqual(trace.map(entry => entry.commit), [second, first]);
  assert.deepEqual(trace.map(entry => entry.kind), ["moved", "added"]);
  assert.ok(trace.every(entry => entry.items.includes(item) && entry.fileId === original.fileId));
  assert.notEqual(trace[0].changeId, trace[1].changeId);
  assert.deepEqual(readFragmentRange(repo.objects, current.id, 90, 115), edited.subarray(90, 115));
  copyFileSync(join(repo.root, "renamed.bin"), join(repo.root, "copy.bin")); repo.stage(["copy.bin"], forbidBuffer);
  const copied = repo.readIndex().find(entry => entry.path === "copy.bin")!;
  assert.notEqual(copied.fileId, original.fileId); assert.equal(copied.copiedFrom, original.fileId);
  assert.equal(copied.id, current.id);
  writeFileSync(join(repo.root, "copy.bin"), Buffer.from("short"));
  assert.deepEqual(repo.status(forbidBuffer).unstaged, [{ path: "copy.bin", kind: "modified" }]);
  const fd = openSync(join(repo.root, "renamed.bin"), "r+");
  try { writeSync(fd, Buffer.from([edited[400] ^ 255]), 0, 1, 400); } finally { closeSync(fd); }
  assert.ok(repo.status(forbidBuffer).unstaged.some(entry => entry.path === "renamed.bin"));
  repo.stage(["renamed.bin"], forbidBuffer);
  assert.notEqual(repo.readIndex().find(entry => entry.path === "renamed.bin")!.id, current.id);
});

for (const layout of ["blob", "fixed", "native", "small-fixed"] as const) test(`unchanged staging preserves ${layout} representation and identity`, async () => {
  const { repo } = await fresh();
  const bytes = Buffer.alloc(layout === "small-fixed" ? 64 : 1_048_577, 42);
  const file = join(repo.root, "asset"); writeFileSync(file, bytes);
  repo.stage(["asset"]); const initial = repo.readIndex()[0];
  const id = layout === "blob" ? repo.objects.write("blob", bytes, initial.fileId)
    : layout === "native" ? initial.id : writeFragmented(repo.objects, bytes, 8192, initial.fileId).manifestId;
  repo.writeIndex([{ ...initial, id }]);
  const baseline = repo.commit({ message: "recorded representation", author }, new Date());
  // Force byte comparison rather than a stat-cache no-op.
  repo.writeIndex(repo.readIndex().map(entry => ({ ...entry, stat: undefined })));
  /** Re-adding a large legacy blob must hash bounded reads rather than materialize working bytes. */
  const read = layout === "small-fixed" ? undefined : (): never => { throw new Error("whole-file staging read"); };
  assert.deepEqual(repo.stage(["asset"], read), []);
  assert.equal(repo.readIndex()[0].id, id); assert.equal(repo.readIndex()[0].fileId, initial.fileId);
  assert.deepEqual(repo.status().staged, []); assert.equal(repo.diff(baseline, "HEAD"), "");
  chmodSync(file, 0o755); assert.deepEqual(repo.stage(["asset"], read), ["asset"]);
  assert.equal(repo.readIndex()[0].id, id); assert.equal(repo.readIndex()[0].mode, "100755");
  chmodSync(file, 0o644); repo.stage(["asset"], read);
  repo.createBranch("other", "HEAD", new Date()); repo.switchTo("other", new Date());
  const edited = Buffer.from(bytes); edited[0] ^= 255; writeFileSync(file, edited);
  assert.deepEqual(repo.stage(["asset"], read), ["asset"]);
  assert.notEqual(repo.readIndex()[0].id, id);
  const tip = repo.commit({ message: "concurrent edit", author }, new Date());
  repo.switchTo("main", new Date());
  assert.equal(repo.refs.resolveHead(), baseline);
  assert.deepEqual(repo.stage(["asset"], read), []);
  const merged = repo.merge("other", { message: "unchanged side", author }, new Date());
  assert.equal(merged.clean, true); assert.equal(merged.head, tip);
  assert.deepEqual(readFileSync(file), edited); assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("legacy blob file hashing uses bounded reads and refuses a truncated descriptor", (context) => {
  const directory = makeTempDir(); directories.push(directory); const file = join(directory.root, "asset");
  writeFileSync(file, ""); assert.equal(blobFileContentId(file), hashObject("blob", Buffer.alloc(0)));
  const bytes = randomBytes(131_073); writeFileSync(file, bytes);
  assert.equal(blobFileContentId(file), hashObject("blob", bytes));
  context.mock.method(fs, "readSync", () => 0); syncBuiltinESMExports();
  try { assert.throws(() => blobFileContentId(file), { code: "short_read" }); }
  finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const target of ["identical-target", "absent-target"]) test(`symlink staging preserves target text after a manifest for ${target}`, async () => {
  const { repo } = await fresh(); const file = join(repo.root, "asset"); const bytes = Buffer.alloc(1_048_577, 42);
  writeFileSync(file, bytes); repo.stage(["asset"]);
  const before = repo.readIndex()[0]; assert.equal(repo.objects.read(before.id).type, "manifest");
  repo.commit({ message: "regular manifest", author }, new Date());
  writeFileSync(join(repo.root, "identical-target"), bytes);
  unlinkSync(file); symlinkSync(target, file);
  assert.deepEqual(repo.stage(["asset"]), ["asset"]);
  const entry = repo.readIndex()[0]; assert.notEqual(entry.id, before.id); assert.equal(entry.fileId, before.fileId);
  assert.deepEqual(repo.objects.readTyped(entry.id, "blob"), Buffer.from(target));
  assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("manifest history merge unions both real appended SDK events above one MiB", async () => {
  const { repo, client } = await fresh();
  const item = (await client.create({ type: "Task", title: "Large history", description: "x".repeat(1_048_576), author: "fixture" })).item.id;
  const path = `.agents/pm/history/${item}.jsonl`; const file = join(repo.root, path);
  const itemPath = join(repo.root, ".agents/pm/tasks", `${item}.toon`);
  const originalItem = readFileSync(itemPath); const prefix = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(prefix) > 1_048_576);
  repo.stage([path]); assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  repo.commit({ message: "large history base", author }, new Date()); repo.createBranch("other", "HEAD", new Date());
  await client.update(item, { title: "Agent A appended", author: "agent-a" });
  const ours = readFileSync(file, "utf8").slice(prefix.length);
  assert.equal(ours.trimEnd().split("\n").length, 1);
  repo.stage([path]); assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  repo.commit({ message: "agent a", author }, new Date()); repo.switchTo("other", new Date());
  writeFileSync(itemPath, originalItem);
  await client.update(item, { title: "Agent B appended", author: "agent-b" });
  const theirs = readFileSync(file, "utf8").slice(prefix.length);
  assert.equal(theirs.trimEnd().split("\n").length, 1); assert.notEqual(ours, theirs);
  repo.stage([path]); assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  repo.commit({ message: "agent b", author }, new Date()); repo.switchTo("main", new Date());
  const merged = repo.merge("other", { message: "union both appended events", author }, new Date());
  assert.equal(merged.clean, true); assert.deepEqual(merged.conflicts, []);
  const text = readFileSync(file, "utf8"); assert.ok(text.startsWith(prefix));
  const appended = text.slice(prefix.length).trimEnd().split("\n");
  assert.equal(appended.length, 2); assert.deepEqual(new Set(appended), new Set([ours.trimEnd(), theirs.trimEnd()]));
  assert.equal(repo.readMergeState(), null); assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("manifest text merge diff3 combines independent edits above one MiB", async () => {
  const { repo } = await fresh(); const path = "large.lock"; const file = join(repo.root, path);
  const padding = "p".repeat(1_048_576); const base = `first\n${padding}\nlast\n`;
  writeFileSync(file, base); repo.stage([path]);
  const original = repo.readIndex()[0]; assert.equal(repo.objects.read(original.id).type, "manifest");
  repo.commit({ message: "large text base", author }, new Date()); repo.createBranch("other", "HEAD", new Date());
  writeFileSync(file, `first\n${padding}\nours\n`); repo.stage([path]);
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  repo.commit({ message: "last line", author }, new Date()); repo.switchTo("other", new Date());
  writeFileSync(file, `theirs\n${padding}\nlast\n`); repo.stage([path]);
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  repo.commit({ message: "first line", author }, new Date()); repo.switchTo("main", new Date());
  const merged = repo.merge("other", { message: "diff3 large text", author }, new Date());
  assert.equal(merged.clean, true); assert.deepEqual(merged.conflicts, []);
  assert.equal(readFileSync(file, "utf8"), `theirs\n${padding}\nours\n`);
  assert.equal(repo.readIndex()[0].fileId, original.fileId);
  assert.deepEqual(repo.stage([path]), [], "re-adding the merged blob preserves its recorded address");
  assert.equal(repo.readMergeState(), null); assert.equal(existsSync(join(repo.root, ".git")), false);
});

for (const layout of ["native", "fixed"]) test(`manifest scan streams ${layout} content and corrects hints without losing mode or link changes`, async () => {
  const { repo } = await fresh();
  const bytes = Buffer.alloc(1_048_576, 42); const file = join(repo.root, "asset");
  writeFileSync(file, bytes); chmodSync(file, 0o644); repo.stage(["asset"]);
  if (layout === "fixed") {
    const stored = writeFragmented(repo.objects, bytes, 8192);
    repo.writeIndex([{ ...repo.readIndex()[0], id: stored.manifestId }]);
  }
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  assert.equal(existsSync(join(repo.root, ".git")), false);
  /** Manifest scans must never fall through to a whole-file working reader. */
  const forbidBuffer = (): never => { throw new Error("whole-file scan materialization"); };
  writeHints(repo.controlDirectory, ["asset"]);
  assert.deepEqual(repo.scan(forbidBuffer), { checked: 1, dirty: [], corrections: [{ path: "asset", hinted: true, actual: false }] });
  assert.deepEqual(readHints(repo.controlDirectory), []);
  const edited = Buffer.from(bytes); edited[500_000] ^= 255; writeFileSync(file, edited);
  assert.deepEqual(repo.scan(forbidBuffer), { checked: 1, dirty: ["asset"], corrections: [{ path: "asset", hinted: false, actual: true }] });
  assert.deepEqual(readHints(repo.controlDirectory), ["asset"]);
  writeFileSync(file, bytes); chmodSync(file, 0o755);
  assert.deepEqual(repo.scan(forbidBuffer).dirty, ["asset"], "identical bytes with a changed executable bit stay dirty");
  chmodSync(file, 0o644);
  assert.deepEqual(repo.scan(forbidBuffer).dirty, []);
  renameSync(file, join(repo.root, "saved")); symlinkSync("saved", file);
  assert.deepEqual(repo.scan(forbidBuffer).dirty, ["asset"], "a symlink to identical content is not the staged regular file");
  unlinkSync(file); renameSync(join(repo.root, "saved"), file);
  assert.deepEqual(repo.scan(forbidBuffer).dirty, []);
});

test("manifest diff renders native file bytes through edits additions deletions and blob transitions", async () => {
  const { repo } = await fresh(); const file = join(repo.root, "asset.txt");
  const empty = repo.commit({ message: "empty base", author, allowEmpty: true }, new Date());
  const before = `${"x".repeat(1_048_576)}\nanchor one\nanchor two\nanchor three\nbefore-review-marker\nsuffix\n`;
  writeFileSync(file, before); repo.stage(["asset.txt"]);
  const first = repo.commit({ message: "chunked text", author }, new Date());
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  writeFileSync(file, before.replace("before-review-marker", "after-review-marker")); repo.stage(["asset.txt"]);
  const second = repo.commit({ message: "edit chunked text", author }, new Date());
  const diff = repo.diff(first, second);
  assert.match(diff, /^-before-review-marker$/m); assert.match(diff, /^\+after-review-marker$/m);
  assert.match(diff, /^ anchor three$/m); assert.doesNotMatch(diff, /pm-vcs-manifest/);
  assert.match(repo.diff(empty, first), /^\+before-review-marker$/m);
  assert.match(repo.diff(first, empty), /^-before-review-marker$/m);
  writeFileSync(file, "blob-final\n"); repo.stage(["asset.txt"]);
  const third = repo.commit({ message: "small text", author }, new Date());
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "blob");
  const transition = repo.diff(second, third);
  assert.match(transition, /^-after-review-marker$/m); assert.match(transition, /^\+blob-final$/m);
});

test("range reads skip unrelated blobs and compression never changes content addresses or GC byte accounting", async () => {
  const { repo } = await fresh(); const bytes = randomBytes(1024 * 1024);
  const file = join(repo.root, "asset"); writeFileSync(file, bytes); repo.stage(["asset"]);
  const entry = repo.readIndex()[0]; const fragments = [...manifestFragments(repo.objects, entry.id)];
  const leaf = fragments[0].fragment; const stored = join(repo.controlDirectory, "objects", leaf.id.slice(0, 2), leaf.id.slice(2));
  const frame = inflateSync(readFileSync(stored)); writeFileSync(stored, deflateSync(frame, { level: 9 }));
  assert.deepEqual(repo.objects.readTyped(leaf.id, "blob"), bytes.subarray(0, leaf.length));
  assert.equal(cdcFragmentedFileContentId(file, STAGING_CDC_PARAMS), entry.id);
  const read = repo.objects.read.bind(repo.objects); const touched: string[] = [];
  repo.objects.read = (id) => { touched.push(id); return read(id); };
  assert.deepEqual(readFragmentRange(repo.objects, entry.id, 1, 11), bytes.subarray(1, 11));
  assert.equal(touched.filter(id => fragments.some(part => part.fragment.id === id)).length, 1);
  repo.objects.read = read;
  const garbage = repo.objects.write("blob", randomBytes(100_000));
  const path = join(repo.controlDirectory, "objects", garbage.slice(0, 2), garbage.slice(2));
  const size = statSync(path).size;
  const temporary = `${path}.${process.pid}.abcdef012345.tmp`; copyFileSync(path, temporary);
  const dry = collectGarbage(repo);
  assert.deepEqual(dry.candidates, [garbage]); assert.equal(dry.candidateBytes, size * 2); assert.equal(dry.reclaimedBytes, 0);
  const applied = collectGarbage(repo, true);
  assert.equal(applied.removed, 2); assert.equal(applied.reclaimedBytes, dry.candidateBytes);
  assert.equal(existsSync(path), false); assert.equal(existsSync(temporary), false);
  assert.equal(collectGarbage(repo, true).reclaimedBytes, 0);
  assert.deepEqual(readFragmentRange(repo.objects, entry.id, 1, 11), bytes.subarray(1, 11));
});

test("large configured records and committed link descriptors retain their typed semantics", async () => {
  const { repo } = await fresh();
  const configured = new Repository(repo.root, { recordPaths: ["record.json"], recordPolicy: {} });
  writeFileSync(join(repo.root, "record.json"), JSON.stringify({ value: "x".repeat(1_048_576) }));
  configured.stage(["record.json"]);
  assert.equal(repo.objects.read(configured.readIndex()[0].id).type, "record");
  const id = configured.stageLink("source.link", { version: 1, repository: "a".repeat(32), revision: "b".repeat(64),
    mappings: [{ source: "x".repeat(1_048_576), destination: "output" }] });
  configured.stage(["source.link"]);
  assert.equal(configured.readIndex().find(entry => entry.path === "source.link")!.id, id);
  assert.equal(repo.objects.read(id).type, "link");
  const object = join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
  renameSync(object, `${object}.saved`); mkdirSync(object);
  const snapshot = readFileSync(join(repo.controlDirectory, "index"));
  try {
    assert.throws(() => configured.stage(["source.link"]), "store I/O faults must not stage a deletion");
    assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), snapshot);
  } finally { rmdirSync(object); renameSync(`${object}.saved`, object); }
});

test("manifest working comparisons support fixed layouts and refuse short reads and concurrent source drift", async () => {
  const { repo } = await fresh(); const file = join(repo.root, "asset");
  const bytes = randomBytes(1024 * 1024); writeFileSync(file, bytes);
  const manifest = writeFragmented(repo.objects, bytes, 4096);
  assert.equal(matchesFragmentedFile(repo.objects, manifest.manifestId, file), true);
  const bounded = repo.objects.readBoundedTyped.bind(repo.objects); let metadataReads = 0;
  repo.objects.readBoundedTyped = (id, type, limit) => {
    if (++metadataReads === 2) writeFileSync(file, "");
    return bounded(id, type, limit);
  };
  assert.equal(matchesFragmentedFile(repo.objects, manifest.manifestId, file), false, "truncation after descriptor measurement cannot compare equal");
  repo.objects.readBoundedTyped = bounded;
  writeFileSync(file, Buffer.from("different size")); assert.equal(matchesFragmentedFile(repo.objects, manifest.manifestId, file), false);
  writeFileSync(file, bytes);
  const write = repo.objects.write.bind(repo.objects); let mutated = false;
  repo.objects.write = (type, payload, fileId) => {
    if (!mutated && type === "blob") { mutated = true; writeFileSync(file, Buffer.alloc(bytes.length, 9)); }
    return write(type, payload, fileId);
  };
  assert.throws(() => repo.stage(["asset"]), { code: "source_changed" });
  assert.deepEqual(repo.readIndex(), []); repo.objects.write = write;
  writeFileSync(file, bytes); mutated = false;
  repo.objects.write = (type, payload, fileId) => {
    if (!mutated && type === "blob") { mutated = true; writeFileSync(file, bytes); }
    return write(type, payload, fileId);
  };
  assert.throws(() => repo.stage(["asset"]), { code: "source_changed" }, "even identical rewritten bytes require a new filesystem observation");
  repo.objects.write = write;
  writeFileSync(file, bytes); repo.stage(["asset"]);
  const entry = repo.readIndex()[0];
  const native = readWorkingStat(repo.root, "asset");
  repo.writeIndex([{ ...entry, stat: { ...native.stat, observedAtNs: native.stat.observedAtNs - 3_000_000_000n } }]);
  assert.deepEqual(repo.status().unstaged, []);
  // Prove that a stable streamed comparison can refresh this index before
  // introducing drift; a recent, non-cacheable observation cannot test the guard.
  await delay(Number(RACY_WINDOW_NS / 1_000_000n) + 100);
  const indexPath = join(repo.controlDirectory, "index");
  const uncached = readFileSync(indexPath);
  assert.deepEqual(repo.status().unstaged, []);
  assert.notDeepEqual(readFileSync(indexPath), uncached, "control: a stable aged observation refreshes the stat cache");
  writeFileSync(indexPath, uncached);
  let touched = false;
  repo.objects.readBoundedTyped = (id, type, limit) => {
    const payload = bounded(id, type, limit);
    if (!touched && id === entry.id) { touched = true; writeFileSync(file, bytes); }
    return payload;
  };
  const snapshot = readFileSync(indexPath);
  assert.deepEqual(repo.status().unstaged, []);
  assert.ok(touched, "the streamed comparison must exercise the drift hook");
  assert.deepEqual(readFileSync(indexPath), snapshot, "a drifting streamed observation never populates the stat cache");
  repo.objects.readBoundedTyped = bounded;
  renameSync(file, join(repo.root, "saved")); symlinkSync("saved", file);
  assert.deepEqual(repo.status().unstaged, [{ path: "asset", kind: "modified" }]);
});

test("shipped CLI stages commits and collects in a real tracker with no Git executable", async () => {
  const { repo } = await fresh(); installPackedExtension(repo.root);
  const nodeOnly = join(repo.root, "node-only"); mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, "node"));
  const environment = { ...withoutPmContext(process.env), ...discardChildCoverage(), PATH: nodeOnly, GIT_CEILING_DIRECTORIES: dirname(repo.root),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./helpers/forbid-git.ts", import.meta.url).href}` };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  /** Run the actual installed PM command against the source extension without Git discovery. */
  const invoke = (...args: string[]): Record<string, unknown> => JSON.parse(execFileSync(process.execPath,
    [cli, ...args, "--json"], { cwd: repo.root, encoding: "utf8", env: environment, timeout: 120_000 })) as Record<string, unknown>;
  writeFileSync(join(repo.root, "binary"), randomBytes(1024 * 1024));
  invoke("vcs", "add", "binary"); invoke("vcs", "commit", "--message", "offline binary");
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  invoke("vcs", "branch", "retained.tmp");
  assert.ok(JSON.stringify(invoke("vcs", "branch")).includes("retained.tmp"));
  const status = invoke("vcs", "status"); assert.equal(status.ok, true);
  const retained = repo.objects.write("blob", Buffer.from("reachable only through tmp refs"));
  repo.refs.compareAndSwap("refs/metadata/checkpoint.tmp", null, retained);
  repo.refs.compareAndSwap("refs/remotes/archive.tmp/main", null, retained);
  const garbage = repo.objects.write("blob", Buffer.from("offline unreachable"));
  const dry = invoke("vcs", "gc").gc as { candidateBytes: number; reclaimedBytes: number };
  assert.ok(dry.candidateBytes > 0); assert.equal(dry.reclaimedBytes, 0);
  const applied = invoke("vcs", "gc", "--apply").gc as { reclaimedBytes: number };
  assert.equal(applied.reclaimedBytes, dry.candidateBytes); assert.equal(repo.objects.has(garbage), false);
  assert.ok(repo.objects.has(retained), "Git-free GC must retain valid tmp refs");
  assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("scale benchmark commits a real tracker copy and reports measured chunk reuse and reclaimed bytes", () => {
  const small = benchmarkPhase6(join(packageRoot, ".agents/pm"), 1_048_577);
  assert.ok(small.trackerFiles > 0); assert.ok(small.reusedByteRatio > 0);
  assert.ok(small.gcReclaimedBytes > 0); assert.equal(small.gcCandidateBytes, small.gcReclaimedBytes);
});

test("manifest text classification merges UTF8 split across real fragments", async () => {
  const { repo } = await fresh();
  const text = ["first\né😀 middle\nlast\n", "ours\né😀 middle\nlast\n", "first\né😀 middle\ntheirs\n"];
  const ids = text.map(value => writeFragmented(repo.objects, Buffer.from(value), 1).manifestId);
  const result = mergePath({ store: repo.objects, config: repo.config, committer: author }, "text", ids[0], ids[1]!, ids[2]!);
  assert.equal(result.conflict, undefined);
  assert.equal(repo.objects.readTyped(result.id, "blob").toString("utf8"), "ours\né😀 middle\ntheirs\n");
});

for (const kind of ["truncated-manifest", "nul-manifest", "invalid-blob", "nul-blob"] as const) test(`manifest text classification preserves binary bytes for ${kind}`, async () => {
  const { repo } = await fresh();
  const bytes = kind === "truncated-manifest" ? Buffer.from([0xe2, 0x82]) : kind === "invalid-blob" ? Buffer.from([0xff]) : Buffer.from("binary\0payload");
  const ours = kind.endsWith("manifest") ? writeFragmented(repo.objects, bytes, 1).manifestId : repo.objects.write("blob", bytes);
  const theirs = writeFragmented(repo.objects, Buffer.from("their text\n"), 4).manifestId;
  const base = repo.objects.write("blob", Buffer.from("base\n"));
  const result = mergePath({ store: repo.objects, config: repo.config, committer: author }, "file", base, ours, theirs);
  assert.deepEqual(result, { id: ours, conflict: { path: "file", reason: "content" } });
  assert.deepEqual(kind.endsWith("manifest") ? readFragmented(repo.objects, result.id) : repo.objects.readTyped(result.id, "blob"), bytes);
});
