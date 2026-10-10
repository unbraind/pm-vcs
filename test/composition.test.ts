/** End-to-end composition and permanent-erasure tests over real SDK trackers and storage. */
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { scryptSync, createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { inflateSync, deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { openRepository } from "../vcs-commands.ts";
import { eraseFile } from "../engine/erasure.ts";
import { Repository } from "../engine/repo.ts";
import { configureAuthority, authorize, decodeLink, encodeLink, readLayers, assertSafeFilePath, assertCompositionPath, writePrivateJson, syncDirectory, type RepositoryLink } from "../engine/composition.ts";
import { inspectRepresentations } from "../engine/representations.ts";
import { inspectClosure } from "../engine/closure.ts";
import { encodeTombstone, validateDenials, assertArrivalsAllowed } from "../engine/lifecycle.ts";
import { BUNDLE_FORMAT, exportBundle, importBundle, importBundleObjects, parseBundle, serializeBundle } from "../engine/bundle.ts";
import { hashObject, frameObject, ObjectStore, ObjectStoreError, type ObjectId } from "../engine/objects.ts";
import { type Signature, type TreeEntry, readCommit, encodeTree, writeTree, writeCommit, encodeSeries, encodeManifest, encodeCommit, encodeRecord, decodeRecord } from "../engine/model.ts";
import { readFragmented, writeFragmented } from "../engine/fragments.ts";
import { mergePath, mergeTrees } from "../engine/rewrite.ts";
import { flattenTree } from "../engine/worktree.ts";
import { registerInstance } from "../engine/instances.ts";
import { FileTransport } from "../engine/transport.ts";
import { cloneFrom, fetchFrom } from "../engine/sync.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { installPackedExtension, pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";

const signature: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
const temps: ReturnType<typeof makeTempDir>[] = [];
/** Remove only each scenario's disposable directories. */
afterEach(() => { for (const temp of temps.splice(0)) temp.cleanup(); });

/** Initialize a real SDK tracker and repository under one disposable scenario root. */
async function fixture(): Promise<{ root: string; repo: Repository; parent: string; client: PmClient }> {
  const temp = makeTempDir(); temps.push(temp);
  const root = join(temp.root, "repo"); mkdirSync(root);
  const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents", "pm"), noExtensions: true });
  await client.init("composition", { defaults: true, author: "fixture" });
  const repo = Repository.init(root);
  repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  repo.identity();
  repo.stage([]); repo.commit({ message: "real tracker baseline", author: signature }, new Date(0));
  return { root, repo, parent: temp.root, client };
}

/** Commit real arbitrary bytes with stable identity and return the new revision. */
function commit(repo: Repository, path: string, content: Buffer = Buffer.from("base content\n")): ObjectId {
  mkdirSync(dirname(join(repo.root, path)), { recursive: true });
  writeFileSync(join(repo.root, path), content); repo.stage([path]);
  return repo.commit({ message: "fixture", author: signature }, new Date(1000));
}

/** Compute the physical path of one loose object for corruption and temporary-copy fixtures. */
function objectPath(repo: Repository, id: string): string {
  return join(repo.instanceLink?.controlDirectory ?? repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
}

/** Assert one stable typed refusal rather than matching incidental filesystem diagnostics. */
function refuses(action: () => unknown, code: string): void {
  assert.throws(action, /** Check the observable machine-readable refusal. */ (error: unknown) => error instanceof ObjectStoreError && error.code === code);
}

/** Recursively inspect raw, zlib, base64 JSON fields and bundle representations for the unique marker. */
function scanBytes(root: string, marker: Buffer): number {
  let matches = 0;
  /** Inspect nested encodings without swallowing a detected marker. */
  function inspect(bytes: Buffer, depth: number): void {
    if (bytes.includes(marker) || bytes.includes(Buffer.from(marker.toString("base64")))) matches += 1;
    if (depth === 0) return;
    try { inspect(inflateSync(bytes), depth - 1); } catch { /* Not compressed. */ }
    const text = bytes.toString("utf8");
    for (const encoded of text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []) inspect(Buffer.from(encoded, "base64"), depth - 1);
  }
  /** Walk scenario-owned storage only, including private metadata and working copies. */
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) inspect(readFileSync(path), 6);
    }
  }
  walk(root); return matches;
}

/** Construct an exact canonical link from a contacted target's immutable identity. */
function linkTo(target: Repository, revision: string): RepositoryLink {
  return { version: 1, repository: target.identity(), revision, mappings: [{ source: "asset.bin", destination: "vendor/asset.bin" }] };
}

test("committed links retain exact identity and pin after branch movement, without copying payloads or credentials", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  const target = Repository.init(join(parent, "target")); target.setAuthority("target", "target-read", "target-erase");
  const binary = Buffer.from([0, 255, 128, 13, 42, 99]);
  const pinned = commit(target, "asset.bin", binary);
  const descriptor = linkTo(target, pinned);
  const id = repo.stageLink("dependency.link", descriptor);
  assert.equal(repo.objects.read(id).type, "link");
  repo.commit({ message: "link", author: signature }, new Date(1000));
  assert.equal(repo.status().clean, true);
  commit(target, "asset.bin", Buffer.from("new branch content"));
  refuses(() => repo.resolveLink("dependency.link", target, "read-fixture", "wrong-grant"), "unauthorized");
  const wrong = Repository.init(join(parent, "wrong")); wrong.setAuthority("wrong", "target-read", "wrong-erase");
  commit(wrong, "asset.bin", binary);
  refuses(() => repo.resolveLink("dependency.link", wrong, "target-read", "wrong-identity"), "link_identity_mismatch");
  repo.resolveLink("dependency.link", target, "target-read", "resolved");
  assert.deepEqual(readFileSync(join(repo.root, "vendor", "asset.bin")), binary);
  const bundle = exportBundle(repo.objects, repo.refs, []);
  assert.equal(bundle.includes(Buffer.from("target-read")), false);
  assert.equal(bundle.includes(Buffer.from(binary.toString("base64"))), false);
  const cloneRoot = join(parent, "clone"); await cloneFrom(repo.root, cloneRoot, new Date(1000));
  const cloned = Repository.open(cloneRoot);
  assert.equal(cloned.identity(), repo.identity());
  assert.deepEqual(cloned.links(), [{ path: "dependency.link", id, link: descriptor }]);
  assert.deepEqual(cloned.layers(), []);
  assert.equal(existsSync(join(cloneRoot, "vendor")), false);
  assert.equal(existsSync(join(cloned.controlDirectory, "authority.json")), false);
  cloned.resolveLink("dependency.link", target, "target-read", "resolved");
  assert.deepEqual(readFileSync(join(cloneRoot, "vendor", "asset.bin")), binary);
});

test("private tracked and new overlays preserve edited bytes across checkout, never stage or change trees", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  const base = commit(repo, "tracked.txt");
  repo.linkInstance("other", join(parent, "other"));
  repo.addLayer("local", new Map([
    ["tracked.txt", { content: Buffer.from("private snapshot"), executable: true }],
    ["new.txt", { content: Buffer.from("local-only"), executable: false }],
  ]));
  assert.deepEqual(repo.status().excludedLayers, [{ name: "local", paths: ["new.txt", "tracked.txt"] }]);
  assert.equal(repo.status().clean, true);
  assert.deepEqual(repo.scan().dirty, []);
  const before = repo.readIndex().map(({ stat: _stat, ...entry }) => entry);
  refuses(() => repo.stage(["tracked.txt"]), "layer_excluded");
  refuses(() => repo.stage(["new.txt"]), "layer_excluded");
  assert.deepEqual(repo.stage([]), []);
  assert.deepEqual(repo.readIndex().map(({ stat: _stat, ...entry }) => entry), before);
  const empty = repo.commit({ message: "same tree", author: signature, allowEmpty: true }, new Date(2000));
  assert.equal(readCommit(repo.objects, empty).tree, readCommit(repo.objects, base).tree);
  writeFileSync(join(repo.root, "tracked.txt"), "edited private bytes");
  repo.switchTo(base, new Date(3000));
  assert.equal(readFileSync(join(repo.root, "tracked.txt"), "utf8"), "edited private bytes");
  assert.equal(readFileSync(join(parent, "other", "tracked.txt"), "utf8"), "base content\n");
  refuses(() => repo.removeLayer("local"), "layer_edited");
  refuses(() => repo.setView(["tracked.txt"]), "layer_view_conflict");
  refuses(() => repo.restore(["tracked.txt"], base), "layer_restore_conflict");
  repo.removeLayer("local", true);
  assert.equal(readFileSync(join(repo.root, "tracked.txt"), "utf8"), "base content\n");
  assert.equal(existsSync(join(repo.root, "new.txt")), false);
  assert.equal(repo.status().clean, true);
  refuses(() => repo.removeLayer("absent"), "unknown_layer");
});

test("authorized erasure scrubs historical, renamed, unreachable, indexed, fragmented and temporary bytes", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  const marker = Buffer.from("unique-erasure-marker-\u0000\u00ff-927604-binary", "latin1");
  const first = commit(repo, "secret.bin", Buffer.concat([marker, Buffer.alloc(32, 151)]));
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")?.fileId; assert.ok(fileId);
  const keep = Buffer.from("independently owned retained bytes"); commit(repo, "keep.bin", keep);
  renameSync(join(repo.root, "secret.bin"), join(repo.root, "renamed.bin")); repo.stage([]);
  const renamed = repo.commit({ message: "rename", author: signature }, new Date(2000));
  const unreferenced = commit(repo, "renamed.bin", Buffer.concat([marker, Buffer.from("unreachable revision")]));
  repo.reset(renamed, "hard", new Date(3000));
  assert.notEqual(repo.refs.resolveHead(), unreferenced);
  const fragmented = writeFragmented(repo.objects, Buffer.concat([marker, Buffer.alloc(160, 173)]), 64);
  repo.writeIndex(repo.readIndex().map(entry => entry.fileId === fileId ? { ...entry, id: fragmented.manifestId, stat: undefined } : entry));
  const fragment = fragmented.manifest.fragments[0].id;
  writeFileSync(`${objectPath(repo, fragment)}.123.abcdef123456.tmp`, readFileSync(objectPath(repo, fragment)));
  repo.linkInstance("shared", join(parent, "shared"));
  const shared = Repository.open(join(parent, "shared"));
  const stale = exportBundle(repo.objects, repo.refs, []);
  const refsBefore = repo.refs.list("refs/heads/");
  assert.ok(scanBytes(repo.root, marker) > 0);
  assert.ok(scanBytes(shared.root, marker) > 0);
  refuses(() => repo.obliterate(fileId, "read-fixture", "incident", new Date()), "unauthorized");
  assert.ok(scanBytes(repo.root, marker) > 0);
  const receipt = repo.obliterate(fileId, "erase-fixture", "incident", new Date(4000));
  assert.equal(receipt.fileId, fileId);
  assert.equal(scanBytes(repo.root, marker), 0);
  assert.equal(scanBytes(shared.root, marker), 0);
  assert.deepEqual(readFileSync(join(repo.root, "keep.bin")), keep);
  assert.deepEqual(repo.refs.list("refs/heads/"), refsBefore);
  assert.equal(repo.readFileState(first, "secret.bin").kind, "obliterated");
  assert.equal(shared.readFileState(first, "secret.bin").kind, "obliterated");
  assert.equal(repo.readFileState(first, "absent").kind, "missing");
  assert.throws(() => repo.objects.read(fragment), /permanently obliterated/);
  const verify = repo.verify(); assert.ok(verify.obliterated.length > 0); assert.deepEqual(verify.corrupt, []); assert.deepEqual(verify.missing, []);
  repo.reset(first, "hard", new Date(5000));
  assert.equal(existsSync(join(repo.root, "secret.bin")), false);
  assert.equal(repo.status().clean, true);
  assert.equal(repo.status().obliterated?.[0].tombstone, receipt.tombstone);
  const beforeInventory = repo.objects.inventory().map(entry => entry.id).sort();
  refuses(() => importBundle(repo.objects, repo.refs, stale), "object_obliterated");
  assert.deepEqual(repo.objects.inventory().map(entry => entry.id).sort(), beforeInventory);
  refuses(() => repo.objects.write("blob", marker), "unattributed_arrival");
  refuses(() => repo.objects.write("blob", Buffer.from("novel bytes"), fileId), "file_obliterated");
  const cloneRoot = join(parent, "erased-clone"); await cloneFrom(repo.root, cloneRoot, new Date(6000));
  const clone = Repository.open(cloneRoot);
  assert.equal(clone.readFileState(first, "secret.bin").kind, "obliterated");
  assert.equal(existsSync(join(cloneRoot, "secret.bin")), false);
  assert.deepEqual(clone.objects.denials(), repo.objects.denials());
  assert.equal(scanBytes(cloneRoot, marker), 0);
});

test("denial refuses stale fetch and novel FileId payload batches before bytes or refs move", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  const base = commit(repo, "secret.bin", Buffer.from("unique old secret payload"));
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")?.fileId as string;
  await cloneFrom(repo.root, join(parent, "stale"), new Date(1000));
  const stale = Repository.open(join(parent, "stale"));
  commit(stale, "secret.bin", Buffer.from("novel payload under denied identity"));
  repo.obliterate(fileId, "erase-fixture", "incident", new Date(2000));
  repo.remotes.add("stale", stale.root);
  const before = repo.objects.inventory().map(entry => entry.id).sort();
  await assert.rejects(fetchFrom(repo, "stale", new Date()), error => error instanceof ObjectStoreError && error.code === "file_obliterated");
  assert.equal(repo.refs.read("refs/remotes/stale/main"), null);
  assert.equal(repo.refs.resolveHead(), base);
  assert.deepEqual(repo.objects.inventory().map(entry => entry.id).sort(), before);
  const wire = new FileTransport(repo.root, repo.root);
  const payload = Buffer.from("new arbitrary upload");
  await assert.rejects(wire.uploadObjects([{ type: "blob", payload, id: hashObject("blob", payload) }]), /provenance/);
  assert.equal(repo.objects.has(hashObject("blob", payload)), false);
  const newId = hashObject("blob", Buffer.from("new secret"));
  const tree = encodeTree([{ name: "secret.bin", mode: "100644", fileId, id: newId }]);
  refuses(() => repo.objects.write("tree", tree), "file_obliterated");
  const unrelated = commit(repo, "unrelated.txt", Buffer.from("new independently attributed bytes"));
  assert.notEqual(unrelated, base);
});

test("remote tombstones never silently authorize deleting locally held content", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  commit(repo, "secret.bin", Buffer.from("held remote payload"));
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")?.fileId as string;
  await cloneFrom(repo.root, join(parent, "remote"), new Date());
  const remote = Repository.open(join(parent, "remote")); remote.setAuthority("remote", "remote-read", "remote-erase");
  remote.obliterate(fileId, "remote-erase", "incident", new Date());
  const before = repo.objects.inventory().length;
  refuses(() => importBundleObjects(repo.objects, exportBundle(remote.objects, remote.refs, [])), "remote_erasure_requires_authority");
  assert.equal(repo.objects.inventory().length, before);
  assert.deepEqual(repo.objects.denials(), []);
  assert.equal(readFileSync(join(repo.root, "secret.bin"), "utf8"), "held remote payload");
});

test("deduplicated FileIds and shared fragments refuse erasure before durable denial", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture();
  commit(repo, "secret.bin", Buffer.from("shared immutable payload"));
  commit(repo, "copy.bin", Buffer.from("shared immutable payload"));
  const id = repo.readIndex().find(entry => entry.path === "secret.bin")?.fileId as string;
  refuses(() => repo.obliterate(id, "erase-fixture", "incident", new Date()), "erasure_dedup_conflict");
  assert.deepEqual(repo.objects.denials(), []);
  assert.equal(readFileSync(join(repo.root, "copy.bin"), "utf8"), "shared immutable payload");
});

test("affected layers and untracked copies refuse erasure and preserve independent bytes", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture();
  const bytes = Buffer.from("unique layer erasure fixture"); commit(repo, "secret.bin", bytes);
  const id = repo.readIndex().find(entry => entry.path === "secret.bin")?.fileId as string;
  repo.addLayer("private", new Map([["secret.bin", { content: Buffer.from("private override"), executable: false }]]));
  refuses(() => repo.obliterate(id, "erase-fixture", "incident", new Date()), "erasure_layer_conflict");
  repo.removeLayer("private");
  writeFileSync(join(repo.root, "copy.bin"), bytes);
  refuses(() => repo.obliterate(id, "erase-fixture", "incident", new Date()), "erasure_worktree_conflict");
  rmSync(join(repo.root, "copy.bin"));
  repo.obliterate(id, "erase-fixture", "incident", new Date());
});

test("unknown pack/cache storage and corrupt or incomplete inventory fail before erasure", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); commit(repo, "secret.bin");
  const entry = repo.readIndex().find(entry => entry.path === "secret.bin")!;
  mkdirSync(join(repo.controlDirectory, "packs")); writeFileSync(join(repo.controlDirectory, "packs", "old.pack"), Buffer.from("opaque pack"));
  refuses(() => repo.obliterate(entry.fileId as string, "erase-fixture", "incident", new Date()), "unsupported_erasure_storage");
  rmSync(join(repo.controlDirectory, "packs"), { recursive: true });
  const original = readFileSync(objectPath(repo, entry.id)); rmSync(objectPath(repo, entry.id));
  refuses(() => repo.obliterate(entry.fileId as string, "erase-fixture", "incident", new Date()), "incomplete_erasure_inventory");
  writeFileSync(objectPath(repo, entry.id), original);
  writeFileSync(join(repo.controlDirectory, "objects", "unknown.pack"), "opaque pack");
  refuses(() => repo.obliterate(entry.fileId as string, "erase-fixture", "incident", new Date()), "unsupported_erasure_storage");
  rmSync(join(repo.controlDirectory, "objects", "unknown.pack"));
  writeFileSync(`${objectPath(repo, entry.id)}.tmp`, "unindexed temp copy");
  refuses(() => repo.obliterate(entry.fileId as string, "erase-fixture", "incident", new Date()), "unsupported_erasure_storage");
  rmSync(`${objectPath(repo, entry.id)}.tmp`);
  assert.deepEqual(repo.objects.denials(), []);
  repo.obliterate(entry.fileId as string, "erase-fixture", "incident", new Date());
});

test("typed reads and verification distinguish missing and corrupt from obliterated content", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); const rev = commit(repo, "secret.bin"); const id = repo.readIndex().find(entry => entry.path === "secret.bin")!.id;
  const bytes = readFileSync(objectPath(repo, id)); rmSync(objectPath(repo, id));
  assert.equal(repo.readFileState(rev, "secret.bin").kind, "missing"); assert.equal(repo.verify().missing.length, 1);
  writeFileSync(objectPath(repo, id), Buffer.from("damaged"));
  assert.equal(repo.readFileState(rev, "secret.bin").kind, "corrupt"); assert.equal(repo.verify().corrupt.length, 1);
  writeFileSync(objectPath(repo, id), bytes);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.readFileState(rev, "secret.bin").kind, "obliterated");
});

test("the real extension harness runs link, layer, authority and erasure operations with a real tracker", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent, client } = await fixture();
  const item = await client.create({ type: "Task", title: "Composition fixture", author: "fixture" }); assert.ok(item.item.id);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const pmRoot = repo.root;
  const readToken = join(parent, "read-token"); const eraseToken = join(parent, "erase-token");
  writeFileSync(readToken, "read-fixture"); writeFileSync(eraseToken, "erase-fixture");
  const auth = await harness.runCommand({ command: "vcs authority", pmRoot, options: { principal: "fixture", readTokenFile: readToken, eraseTokenFile: eraseToken, currentEraseTokenFile: eraseToken } });
  assert.equal(auth.errorMessage, undefined);
  const revision = commit(repo, "asset.bin", Buffer.from("cli-fixture"));
  const descriptor = linkTo(repo, revision); const spec = join(parent, "link.json"); writeFileSync(spec, encodeLink(descriptor));
  const linked = await harness.runCommand({ command: "vcs link", pmRoot, args: ["dependency.link"], options: { spec } }); assert.equal(linked.errorMessage, undefined);
  const listed = await harness.runCommand({ command: "vcs link", pmRoot, options: { list: true } }); assert.ok(listed.result);
  const resolved = await harness.runCommand({ command: "vcs link resolve", pmRoot, args: ["dependency.link"], options: { target: repo.root, layer: "resolved", readTokenFile: readToken } }); assert.equal(resolved.errorMessage, undefined);
  const removed = await harness.runCommand({ command: "vcs layer", pmRoot, args: ["resolved"], options: { remove: true } }); assert.equal(removed.errorMessage, undefined);
  const created = await harness.runCommand({ command: "vcs layer", pmRoot, args: ["overlay", "local.txt", readToken], options: { executable: true } }); assert.equal(created.errorMessage, undefined);
  const layers = await harness.runCommand({ command: "vcs layer", pmRoot, options: { list: true } }); assert.ok(layers.result);
  await harness.runCommand({ command: "vcs layer", pmRoot, args: ["overlay"], options: { remove: true } });
  const erased = await harness.runCommand({ command: "vcs obliterate", pmRoot, args: ["asset.bin"], options: { reason: "incident", eraseTokenFile: eraseToken } }); assert.equal(erased.errorMessage, undefined, String(erased.errorMessage));
  const verified = await harness.runCommand({ command: "vcs verify", pmRoot }); assert.equal(verified.errorMessage, undefined);
});

test("canonical link and local metadata validators reject ambiguous, unsafe and credential-bearing shapes", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); const revision = commit(repo, "asset.bin"); const valid = linkTo(repo, revision);
  const reversed = { version: 1 as const, revision, repository: repo.identity(), mappings: [{ destination: "vendor/asset.bin", source: "asset.bin" }] };
  assert.deepEqual(encodeLink(reversed), encodeLink(valid));
  for (const value of [null, [], { ...valid, version: 2 }, { ...valid, mappings: [] }, { ...valid, credential: "secret" },
    { ...valid, mappings: [null] }, { ...valid, mappings: [{ source: 2, destination: "safe" }] },
    { ...valid, mappings: [...valid.mappings, valid.mappings[0]] },
    { ...valid, mappings: [...valid.mappings, { source: "another", destination: "vendor/asset.bin/nested" }] }]) {
    refuses(() => decodeLink(Buffer.from(JSON.stringify(value))), "bad_link");
  }
  refuses(() => decodeLink(Buffer.from("not JSON")), "bad_link");
  refuses(() => decodeLink(Buffer.from(` ${encodeLink(valid).toString()}`)), "bad_link");
  for (const path of ["", "..", "a/../b", "/absolute", "a\\b", "C:drive", ".pmvcs/layers.json", ".git/config", ".agents/pm/runtime/x", ".agents/pm/search/cache", ".agents/pm/locks/x", ".agents/pm/transactions/x", ".agents/pm/checkpoints/x"]) refuses(() => assertCompositionPath(path, repo.ignoreRules()), "unsafe_composition_path");
  refuses(() => assertCompositionPath("custom/cache", { patterns: [], negations: [], runtime: [{ patterns: ["custom/**"], negations: [] }] }), "unsafe_composition_path");
  assertSafeFilePath(repo.root, "missing/deep.txt");
  mkdirSync(join(repo.root, "dir")); refuses(() => assertSafeFilePath(repo.root, "dir"), "unsafe_composition_path");
  writeFileSync(join(repo.root, "file"), "occupied"); refuses(() => assertSafeFilePath(repo.root, "file/nested"), "unsafe_composition_path");
  symlinkSync("file", join(repo.root, "alias")); refuses(() => assertSafeFilePath(repo.root, "alias"), "unsafe_composition_path");
  chmodSync(join(repo.root, "dir"), 0o000);
  try { assert.throws(() => assertSafeFilePath(repo.root, "dir/child"), error => (error as NodeJS.ErrnoException).code === "EACCES"); }
  finally { chmodSync(join(repo.root, "dir"), 0o755); }
  for (const value of [{}, [null], [{ name: "local", files: [] }], [{ name: "x", files: [{ path: "safe", content: "*", executable: false }] }]]) {
    writePrivateJson(join(repo.controlDirectory, "layers.json"), value); refuses(() => readLayers(repo.controlDirectory), "bad_layers");
  }
  const layer = { name: "local", files: [{ path: "safe", content: "", executable: false }] };
  for (const values of [[layer, layer], [layer, { ...layer, name: "other" }]]) {
    writePrivateJson(join(repo.controlDirectory, "layers.json"), values); refuses(() => readLayers(repo.controlDirectory), "bad_layers");
  }
  rmSync(join(repo.controlDirectory, "layers.json"));
  for (const principal of ["", "invalid principal"]) refuses(() => configureAuthority(repo.controlDirectory, principal, "a", "b"), "bad_authority");
  refuses(() => configureAuthority(repo.controlDirectory, "fixture", "", "b"), "bad_authority");
  refuses(() => configureAuthority(repo.controlDirectory, "fixture", "a", "a"), "bad_authority");
  rmSync(join(repo.controlDirectory, "authority.json")); refuses(() => authorize(repo.controlDirectory, "read", "a"), "unauthorized");
  writePrivateJson(join(repo.controlDirectory, "authority.json"), {}); refuses(() => authorize(repo.controlDirectory, "read", "a"), "unauthorized");
  refuses(() => repo.setAuthority("fixture", "read-fixture", "erase-fixture"), "bad_authority");
});

test("layer and link ownership refuses dirty, untracked, overlapping and unsafe destinations", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); const revision = commit(repo, "asset.bin");
  refuses(() => repo.addLayer("empty", new Map()), "bad_layers");
  writeFileSync(join(repo.root, "asset.bin"), "dirty");
  refuses(() => repo.addLayer("dirty", new Map([["asset.bin", { content: Buffer.from("private"), executable: false }]])), "layer_collision");
  repo.restore(["asset.bin"], revision);
  writeFileSync(join(repo.root, "untracked"), "occupied");
  refuses(() => repo.addLayer("untracked", new Map([["untracked", { content: Buffer.from("private"), executable: false }]])), "layer_collision");
  repo.addLayer("owned", new Map([["new/path", { content: Buffer.from("private"), executable: false }]]));
  refuses(() => repo.addLayer("owned", new Map([["another", { content: Buffer.alloc(0), executable: false }]])), "bad_layers");
  refuses(() => repo.addLayer("overlap", new Map([["new/path", { content: Buffer.alloc(0), executable: false }]])), "layer_collision");
  refuses(() => repo.stageLink("new/path", linkTo(repo, revision)), "layer_excluded");
  const blob = repo.objects.write("blob", Buffer.from("directory collision"));
  const tree = writeTree(repo.objects, [{ name: "new", id: blob, mode: "100644", fileId: "e".repeat(32) }]);
  refuses(() => repo.materialize(tree), "layer_checkout_conflict");
  rmSync(join(repo.root, "new", "path")); refuses(() => repo.removeLayer("owned"), "layer_edited"); repo.removeLayer("owned", true);
  refuses(() => repo.stageLink("untracked", linkTo(repo, revision)), "link_collision");
  repo.stageLink("dependency.link", linkTo(repo, revision)); writeFileSync(join(repo.root, "dependency.link"), "edited");
  refuses(() => repo.stageLink("dependency.link", linkTo(repo, revision)), "link_collision");
  repo.restore(["dependency.link"], revision);
  repo.stageLink("dependency.link", linkTo(repo, revision));
  repo.stage(["dependency.link"]);
  refuses(() => repo.resolveLink("absent", repo, "read-fixture", "absent"), "unknown_link");
  const missing = { ...linkTo(repo, revision), revision: "e".repeat(64) }; repo.stageLink("missing.link", missing);
  refuses(() => repo.resolveLink("missing.link", repo, "read-fixture", "missing"), "object_not_found");
  repo.stageLink("subset.link", { ...linkTo(repo, revision), mappings: [{ source: "absent", destination: "safe" }] });
  refuses(() => repo.resolveLink("subset.link", repo, "read-fixture", "subset"), "link_subset_missing");
  repo.stageLink("nested.link", linkTo(repo, revision)); const nestedRevision = repo.commit({ message: "nested", author: signature }, new Date());
  repo.stageLink("recursive.link", { ...linkTo(repo, nestedRevision), mappings: [{ source: "nested.link", destination: "safe" }] });
  refuses(() => repo.resolveLink("recursive.link", repo, "read-fixture", "recursive"), "nested_link");
  const alias = join(parent, "alias-root"); symlinkSync(repo.root, alias);
  refuses(() => assertSafeFilePath(alias, "asset.bin"), "unsafe_composition_path");
});

test("erasure detects ignored, compressed and base64 copies and handles shared fragment conflicts", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); const bytes = Buffer.from("unique compressed and encoded retained payload"); commit(repo, "secret.bin", bytes);
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")!.fileId as string;
  writeFileSync(join(repo.root, ".pmvcsignore"), "ignored.cache\n");
  writeFileSync(join(repo.root, "ignored.cache"), deflateSync(bytes));
  refuses(() => repo.obliterate(fileId, "erase-fixture", "incident", new Date()), "erasure_worktree_conflict");
  writeFileSync(join(repo.root, "ignored.cache"), bytes.toString("base64"));
  refuses(() => repo.obliterate(fileId, "erase-fixture", "incident", new Date()), "erasure_worktree_conflict");
  rmSync(join(repo.root, "ignored.cache")); rmSync(join(repo.root, ".pmvcsignore"));
  const fragmented = writeFragmented(repo.objects, bytes, 16);
  repo.writeIndex(repo.readIndex().map(entry => entry.fileId === fileId ? { ...entry, id: fragmented.manifestId, stat: undefined } : entry));
  writeFragmented(repo.objects, Buffer.concat([bytes, Buffer.from("independent tail")]), 16);
  refuses(() => repo.obliterate(fileId, "erase-fixture", "incident", new Date()), "erasure_dedup_conflict");
});

test("pending physical cleanup blocks writes and exports and completes under authorized retry", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); commit(repo, "secret.bin", Buffer.from("interrupted unique payload"));
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")!.fileId as string;
  const index = repo.readIndex(); const path = objectPath(repo, index.find(entry => entry.fileId === fileId)!.id);
  const original = readFileSync(path);
  const receipt = repo.obliterate(fileId, "erase-fixture", "incident", new Date());
  const denial = repo.objects.denials()[0];
  repo.objects.recordDenials([{ ...denial, pending: true }]);
  // Recreate the interrupted cleanup's retained canonical bytes directly on
  // disposable storage; the application denial remains durable and authoritative.
  writeFileSync(path, original); writeFileSync(join(repo.root, "secret.bin"), "retained worktree bytes");
  assert.equal(repo.objects.state(index.find(entry => entry.fileId === fileId)!.id).kind, "obliterated");
  refuses(() => repo.objects.write("blob", Buffer.from("attempt"), "a".repeat(32)), "erasure_incomplete");
  refuses(() => exportBundle(repo.objects, repo.refs, []), "erasure_incomplete");
  assert.ok(repo.verify().corrupt.includes("erasure_incomplete"));
  const resumed = repo.obliterate(fileId, "erase-fixture", "incident", new Date()); assert.equal(resumed.tombstone, receipt.tombstone);
  assert.equal(existsSync(path), false); assert.equal(existsSync(join(repo.root, "secret.bin")), false);
  assert.equal(repo.objects.denials()[0].pending, false);
  repo.obliterate(fileId, "erase-fixture", "incident", new Date());
  refuses(() => repo.stage(["secret.bin"]), "file_obliterated");
  refuses(() => repo.addLayer("denied", new Map([["secret.bin", { content: Buffer.from("private"), executable: false }]])), "layer_collision");
  refuses(() => repo.objects.write("record", Buffer.from("interrupted unique payload"), "a".repeat(32)), "object_obliterated");
  assert.equal(repo.links().length, 0);
  refuses(() => validateDenials({}), "bad_tombstone");
  refuses(() => validateDenials([{ ...denial, id: "f".repeat(64) }]), "bad_tombstone");
  refuses(() => validateDenials([denial, denial]), "bad_tombstone");
  refuses(() => encodeTombstone({ ...denial.tombstone, reason: "arbitrary payload text" }), "bad_tombstone");
  const manifest = Buffer.from(JSON.stringify({}));
  assert.throws(() => assertArrivalsAllowed([{ ...denial, pending: false }], [{ id: hashObject("manifest", manifest), type: "manifest", payload: manifest }], true));
});

test("fragment reads and verification include fragment missing, corrupt and terminal states", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from(Array.from({ length: 1536 }, (_, index) => (index * 131 + 79) % 256)));
  const result = writeFragmented(repo.objects, Buffer.from(Array.from({ length: 1536 }, (_, index) => (index * 131 + 79) % 256)), 512);
  const fileId = repo.readIndex().find(entry => entry.path === "secret.bin")!.fileId;
  repo.writeIndex(repo.readIndex().map(entry => entry.fileId === fileId ? { ...entry, id: result.manifestId, stat: undefined } : entry));
  const revision = repo.commit({ message: "fragments", author: signature }, new Date());
  assert.equal(repo.readFileState(revision, "secret.bin").kind, "present");
  const receiver = Repository.init(join(parent, "live-fragment-clone")); importBundle(receiver.objects, receiver.refs, exportBundle(repo.objects, repo.refs, [])); assert.deepEqual(receiver.readFileState(revision, "secret.bin"), repo.readFileState(revision, "secret.bin")); receiver.switchTo(revision, new Date()); assert.deepEqual(readFileSync(join(receiver.root, "secret.bin")), Buffer.from(Array.from({ length: 1536 }, (_, index) => (index * 131 + 79) % 256)));
  const path = objectPath(repo, result.manifest.fragments[0].id); const bytes = readFileSync(path); rmSync(path);
  assert.equal(repo.readFileState(revision, "secret.bin").kind, "missing"); assert.ok(repo.verify().missing.length > 0);
  writeFileSync(path, "corrupt"); assert.equal(repo.readFileState(revision, "secret.bin").kind, "corrupt"); writeFileSync(path, bytes);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.readFileState(revision, "secret.bin").kind, "obliterated");
});

/** Build an untrusted archive without using the trusted exporter to validate its claims. */
function archive(refs: Record<string, string>, denials: ReturnType<Repository["objects"]["denials"]>, objects: { id: string; type: string; payload: Buffer }[] = []): Buffer {
  return Buffer.from(["pmvcs-bundle-1", JSON.stringify({ refs, prerequisites: [], objects: objects.map(/** Declare the exact carried inventory. */ (object) => object.id), denials }), ...objects.map(/** Preserve valid addresses while forging structural relationships. */ (object) => `${object.type} ${object.id} ${object.payload.toString("base64")}`), ""].join("\n"));
}

test("tombstones cannot launder absent commit refs, parents, trees or unrelated FileId leaves", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture();
  const absent = "d".repeat(64);
  const tombstone = { version: 1 as const, fileId: "a".repeat(32), roots: [absent], objects: [absent], payloads: [], principal: "fixture", timestamp: new Date(1).toISOString(), reason: "incident" };
  const denial = { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false };
  const receiver = Repository.init(join(parent, "receiver"));
  const initial = receiver.objects.inventory().length;
  refuses(() => importBundle(receiver.objects, receiver.refs, archive({ "refs/heads/forged": absent }, [denial])), "incomplete_bundle");
  assert.equal(receiver.refs.read("refs/heads/forged"), null); assert.equal(receiver.objects.inventory().length, initial);
  const emptyTree = writeTree(repo.objects, []);
  for (const options of [{ tree: emptyTree, parents: [absent] }, { tree: absent, parents: [] }]) {
    const revision = writeCommit(repo.objects, { ...options, author: signature, committer: signature, message: "forged", changeId: "b".repeat(32) });
    const object = repo.objects.read(revision);
    const tree = repo.objects.read(emptyTree);
    refuses(() => importBundle(receiver.objects, receiver.refs, archive({ "refs/heads/forged": revision }, [denial], [{ id: revision, ...object }, { id: emptyTree, ...tree }])), "incomplete_bundle");
    assert.equal(receiver.refs.read("refs/heads/forged"), null); assert.equal(receiver.objects.inventory().length, initial);
    refuses(() => importBundleObjects(receiver.objects, archive({}, [denial], [{ id: revision, ...object }, { id: emptyTree, ...tree }])), "incomplete_bundle"); assert.equal(receiver.objects.inventory().length, initial);
  }
  for (const entry of [{ name: "leaf", mode: "100644" as const, id: absent, fileId: "b".repeat(32) }, { name: "dir", mode: "40000" as const, id: absent }]) {
    const payload = encodeTree([entry]); const id = hashObject("tree", payload);
    refuses(() => importBundleObjects(receiver.objects, archive({}, [denial], [{ id, type: "tree", payload }])), "invalid_erasure_role");
  }
  const directory = encodeTree([{ name: "dir", mode: "40000", id: absent }]); const directoryId = hashObject("tree", directory);
  refuses(() => importBundleObjects(receiver.objects, archive({}, [], [{ id: directoryId, type: "tree", payload: directory }])), "incomplete_bundle"); assert.equal(receiver.objects.has(directoryId), false);
  receiver.objects.recordDenials([denial]); receiver.refs.compareAndSwap("refs/heads/forged", null, absent);
  const verified = receiver.verify(); assert.deepEqual(verified.obliterated, []); assert.ok(verified.corrupt.some(value => value.includes("invalid_erasure_role")));
  const blob = repo.objects.write("blob", Buffer.from("wrong ref kind"));
  refuses(() => importBundle(receiver.objects, receiver.refs, archive({ "refs/heads/wrong": blob }, [], [{ id: blob, ...repo.objects.read(blob) }])), "incomplete_bundle");
  assert.equal(receiver.refs.read("refs/heads/wrong"), null);
});

test("series and standalone object arrivals preserve structural boundaries and fresh typed audits", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); const revision = commit(repo, "secret.bin", Buffer.from("audit independent unique payload"));
  const receipt = repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  const receiver = Repository.init(join(parent, "receiver")); importBundle(receiver.objects, receiver.refs, exportBundle(repo.objects, repo.refs, []));
  assert.equal(receiver.objects.read(receipt.tombstone).type, "tombstone"); assert.equal(receiver.verify().corrupt.length, 0); assert.equal(receiver.verify().missing.length, 0);
  const auditPath = objectPath(receiver, receipt.tombstone); const audit = readFileSync(auditPath); rmSync(auditPath);
  assert.ok(receiver.verify().missing.some(value => value.startsWith(receipt.tombstone))); writeFileSync(auditPath, "broken");
  assert.ok(receiver.verify().corrupt.some(value => value.startsWith(receipt.tombstone))); writeFileSync(auditPath, audit);
  const absent = "d".repeat(64); const original = repo.objects.denials()[0];
  const tombstone = { ...original.tombstone, roots: [absent], objects: [absent], payloads: [] };
  const denial = { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false };
  const series = encodeSeries({ base: absent, patches: [{ commit: revision }], description: "fixture", author: signature });
  const id = hashObject("series", series); const blank = Repository.init(join(parent, "blank"));
  refuses(() => importBundleObjects(blank.objects, archive({}, [denial], [{ id, type: "series", payload: series }])), "incomplete_bundle");
  assert.equal(blank.objects.has(id), false); assert.equal(blank.objects.denials().length, 0);
  const standalone = await new FileTransport(repo.root, repo.root).fetchObjects([original.tombstone.roots[0]]);
  const parsed = parseBundle(standalone); assert.equal(parsed.lines.length, 0); assert.equal(parsed.header.denials?.[0].id, receipt.tombstone);
  const typed = inspectClosure(receiver.objects, [revision]); assert.ok(typed.obliterated.length > 0);
});

test("concurrent explicit identity creation and empty clones keep one immutable repository identity", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); const empty = Repository.init(join(parent, "empty"));
  rmSync(join(empty.controlDirectory, "identity"), { force: true });
  const run = promisify(execFile);
  const moduleUrl = pathToFileURL(join(process.cwd(), "engine", "repo.ts")).href;
  const source = `import { Repository } from ${JSON.stringify(moduleUrl)}; process.stdout.write(Repository.open(process.argv[1]).identity());`;
  const children = await Promise.all(Array.from({ length: 4 }, /** Real independent processes race the identity creation lease. */ () => run(process.execPath, ["--input-type=module", "-e", source, empty.root])));
  const identities = children.map(/** Capture only the returned immutable identity. */ (child) => child.stdout);
  assert.equal(new Set(identities).size, 1); assert.equal(empty.identity(), identities[0]);
  const clone = await cloneFrom(empty.root, join(parent, "clone"), new Date()); assert.equal(Repository.open(clone.root).identity(), empty.identity());
  const established = empty.identity(); empty.objects.adoptIdentity(repo.identity()); assert.equal(empty.identity(), established);
  assert.notEqual(repo.identity(), empty.identity());
});


test("strict erasure refuses structural payload ownership, merge state, metadata copies and private payload copies", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); const payload = Buffer.from("bounded-unique-control-marker-932657"); commit(repo, "secret.bin", payload);
  const index = repo.readIndex(); const selected = index.find(entry => entry.path === "secret.bin")!;
  const tree = writeTree(repo.objects, []);
  repo.writeIndex(index.map(/** A corrupt index cannot authorize structural-object deletion. */ (entry) => entry.path === selected.path ? { ...entry, id: tree } : entry));
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "incomplete_erasure_inventory"); repo.writeIndex(index);
  writeFileSync(join(repo.controlDirectory, "MERGE_STATE"), "{}"); refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "erasure_merge_in_progress"); rmSync(join(repo.controlDirectory, "MERGE_STATE"));
  writeFileSync(join(repo.controlDirectory, "credentials.json"), payload.toString("base64")); refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unsupported_erasure_storage"); rmSync(join(repo.controlDirectory, "credentials.json"));
  repo.addLayer("copied", new Map([["private.bin", { content: payload, executable: false }]])); refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "erasure_layer_conflict"); repo.removeLayer("copied");
  refuses(() => repo.obliterate("missing", "erase-fixture", "incident", new Date()), "unknown_file");
  writeFileSync(join(repo.root, "nested-encoding"), Buffer.from(Buffer.from(Buffer.from("unrelated").toString("base64")).toString("base64")).toString("base64"));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  const denial = repo.objects.denials()[0];
  const manifest = encodeManifest({ totalLength: 7, fragments: [{ id: selected.id, length: 7 }] });
  refuses(() => assertArrivalsAllowed([denial], [{ id: hashObject("manifest", manifest), type: "manifest", payload: manifest }], true), "object_obliterated");
  for (const encoded of [deflateSync(payload), Buffer.from(payload.toString("base64")), Buffer.from(Buffer.from(payload.toString("base64")).toString("base64"))]) refuses(() => repo.objects.write("blob", encoded, "b".repeat(32)), "object_obliterated");
  repo.objects.write("blob", Buffer.from(Buffer.from(Buffer.from("unrelated").toString("base64")).toString("base64")), "b".repeat(32));
  syncDirectory(repo.controlDirectory, false, "win32"); refuses(() => syncDirectory(repo.controlDirectory, true, "win32"), "unsupported_durability");
  const alias = join(parent, "metadata-alias"); symlinkSync(repo.controlDirectory, alias); refuses(() => writePrivateJson(join(alias, "new.json"), {}), "unsafe_composition_path");
});

test("history inspection propagates real I/O faults and refuses a denied fragment without its denied root", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo } = await fixture(); const revision = commit(repo, "asset.bin");
  const path = objectPath(repo, revision); chmodSync(path, 0o000);
  try { assert.throws(() => repo.verify(), /** Actual OS read failure remains distinct from missing and corrupt. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES"); } finally { chmodSync(path, 0o644); }
  const fragmented = writeFragmented(repo.objects, Buffer.from("unique-fragment-closure-material"), 16);
  const root = "a".repeat(64); const fragment = fragmented.manifest.fragments[0].id;
  const tombstone = { version: 1 as const, fileId: "b".repeat(32), roots: [root], objects: [root, fragment], payloads: [], principal: "fixture", timestamp: new Date(0).toISOString(), reason: "incident" };
  const denial = { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false };
  const tree = writeTree(repo.objects, [{ name: "file", mode: "100644", id: fragmented.manifestId, fileId: tombstone.fileId }]);
  const commitId = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "fixture" });
  const report = inspectClosure(repo.objects, [commitId], [], [denial]); assert.deepEqual(report.obliterated, []); assert.ok(report.corrupt.some(value => value.startsWith(fragment)));
});

test("native CLI requires explicit composition options and can explicitly recover an absent writer lock", /** Exercise the scenario using a real tracker and disposable storage. */ async () => {
  const { repo, parent } = await fixture(); const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const token = join(parent, "erase-token"); writeFileSync(token, "erase-fixture");
  for (const request of [
    { command: "vcs authority", options: {} },
    { command: "vcs authority", options: { principal: "fixture" } },
    { command: "vcs link", args: ["descriptor"] },
    { command: "vcs link resolve", args: ["descriptor"], options: { target: repo.root } },
    { command: "vcs link resolve", args: ["descriptor"], options: { layer: "private" } },
    { command: "vcs obliterate", args: ["asset.bin"], options: { eraseTokenFile: token } },
  ]) {
    const result = await harness.runCommand({ ...request, pmRoot: repo.root }); assert.ok(result.errorMessage);
  }
  commit(repo, "asset.bin", Buffer.from("cli recovery selected content"));
  const result = await harness.runCommand({ command: "vcs obliterate", args: ["asset.bin"], pmRoot: repo.root, options: { reason: "incident", eraseTokenFile: token, recoverLock: true } }); assert.equal(result.errorMessage, undefined);
});


test("erasure from shared instances preserves unrelated layers and other completed denials", /** Exercise independently owned bytes sharing one object store. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "first.bin", Buffer.from("first independently unique terminal bytes")); commit(repo, "second.bin", Buffer.from("second independently unique terminal bytes"));
  refuses(() => repo.obliterate("f".repeat(32), "erase-fixture", "incident", new Date()), "unknown_file");
  repo.obliterate("first.bin", "erase-fixture", "incident", new Date());
  repo.addLayer("unrelated", new Map([["private.txt", { content: Buffer.from("unrelated overlay preserved"), executable: false }]]));
  repo.linkInstance("shared", join(parent, "shared")); const shared = Repository.open(join(parent, "shared"));
  shared.obliterate("second.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.objects.denials().length, 2); assert.equal(readFileSync(join(repo.root, "private.txt"), "utf8"), "unrelated overlay preserved"); assert.equal(repo.verify().corrupt.length, 0);
});

test("unchanged refs still exchange erasure metadata and empty clones retain terminal identities", /** Exercise metadata-only exchange with real repository transports. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from("unchanged-ref erasure payload"));
  const report = await cloneFrom(repo.root, join(parent, "stale"), new Date()); const stale = Repository.open(report.root);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  await assert.rejects(() => fetchFrom(stale, "origin", new Date()), /** Remote metadata never grants deletion authority over held bytes. */ (error: unknown) => error instanceof ObjectStoreError && error.code === "remote_erasure_requires_authority");
  assert.equal(readFileSync(join(stale.root, "secret.bin"), "utf8"), "unchanged-ref erasure payload");
  const empty = Repository.init(join(parent, "empty")); empty.identity(); empty.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(empty.root, "staged.bin"), "uncommitted terminal payload"); empty.stage(["staged.bin"]); const receipt = empty.obliterate("staged.bin", "erase-fixture", "incident", new Date());
  const fresh = Repository.open((await cloneFrom(empty.root, join(parent, "empty-clone"), new Date())).root);
  assert.equal(fresh.identity(), empty.identity()); assert.equal(fresh.objects.denials()[0].id, receipt.tombstone); assert.equal(fresh.objects.read(receipt.tombstone).type, "tombstone");
});


test("recoverable loose-frame wrappers refuse erasure before mutation and refuse every later arrival", /** Inspect actual physical object bytes rather than only semantic references. */ async () => {
  const { repo } = await fixture(); const marker = Buffer.from("wrapped-loose-unique-marker-\u0000\u00ff-637825", "latin1");
  commit(repo, "secret.bin", marker); commit(repo, "keep.bin", Buffer.from("unrelated preserved object bytes"));
  const selected = repo.readIndex().find(/** Capture the old immutable payload address. */ (entry) => entry.path === "secret.bin")!;
  const compressed = readFileSync(objectPath(repo, selected.id)); const framed = inflateSync(compressed);
  const representations = [framed, compressed, Buffer.from(framed.toString("base64")), Buffer.from(compressed.toString("base64"))];
  for (const representation of representations) {
    const wrapper = repo.objects.write("blob", representation); const path = objectPath(repo, wrapper); const physical = readFileSync(path);
    assert.ok(scanBytes(repo.root, marker) > 0);
    refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "erasure_retained_copy");
    assert.deepEqual(repo.objects.denials(), []); assert.deepEqual(readFileSync(path), physical); assert.deepEqual(repo.objects.read(wrapper).payload, representation);
    assert.deepEqual(repo.objects.read(selected.id).payload, marker); rmSync(path);
  }
  let nested = framed;
  for (let depth = 0; depth < 8; depth += 1) nested = Buffer.from(nested.toString("base64"));
  const nestedId = repo.objects.write("blob", nested);
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "uninspectable_payload"); assert.deepEqual(repo.objects.denials(), []); rmSync(objectPath(repo, nestedId));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); assert.equal(scanBytes(repo.root, marker), 0);
  refuses(() => repo.objects.write("blob", nested, "a".repeat(32)), "uninspectable_payload");
  assert.equal(readFileSync(join(repo.root, "keep.bin"), "utf8"), "unrelated preserved object bytes");
  const revision = repo.refs.resolveHead()!;
  refuses(() => repo.stageLink("secret.bin", linkTo(repo, revision)), "file_obliterated");
  const before = repo.objects.inventory().map(/** No denied arrival may publish even an unrelated carried object. */ (entry) => entry.id).sort();
  for (const payload of representations) {
    const id = hashObject("blob", payload);
    refuses(() => repo.objects.write("blob", payload, "a".repeat(32)), "object_obliterated");
    refuses(() => repo.objects.accept([{ id, type: "blob", payload }], true), "object_obliterated");
    const tree = encodeTree([{ name: "new.bin", mode: "100644", id, fileId: "a".repeat(32) }]); const treeId = hashObject("tree", tree);
    const revision = encodeCommit({ tree: treeId, parents: [], author: signature, committer: signature, message: "wrapper resurrection" }); const revisionId = hashObject("commit", revision);
    refuses(() => importBundle(repo.objects, repo.refs, archive({ "refs/heads/resurrected": revisionId }, [], [{ id, type: "blob", payload }, { id: treeId, type: "tree", payload: tree }, { id: revisionId, type: "commit", payload: revision }])), "object_obliterated");
    assert.equal(repo.refs.read("refs/heads/resurrected"), null); assert.equal(repo.objects.has(id), false); assert.deepEqual(repo.objects.inventory().map(/** Compare the complete physical object inventory after refusal. */ (entry) => entry.id).sort(), before);
  }
});

test("supported representation inspection fails closed at nesting, decompression and framing bounds", /** Bounded recognizable encodings cannot be silently certified clean. */ () => {
  /** This predicate deliberately finds no secret so the inspector must complete every supported decode. */
  const clean = (): boolean => false;
  const bytes = Buffer.from([0, 255, 17]); assert.equal(inspectRepresentations(bytes, clean), false);
  const base64 = Buffer.from(bytes.toString("base64")); refuses(() => inspectRepresentations(base64, clean, 0), "uninspectable_payload");
  refuses(() => inspectRepresentations(Buffer.from("blob 999\0missing"), clean), "uninspectable_payload");
  refuses(() => inspectRepresentations(Buffer.from([0x78, 0x9c, 0xff]), clean), "uninspectable_payload");
  refuses(() => inspectRepresentations(deflateSync(Buffer.alloc(1024, 0)), clean, 6, 64), "uninspectable_payload");
  assert.equal(inspectRepresentations(Buffer.alloc(65), clean, 6, 64), false);
  assert.equal(inspectRepresentations(Buffer.from("AA== ".repeat(4100)), clean), false);
  assert.equal(inspectRepresentations(Buffer.from("noncanonical base64 A=== abcde"), clean), false);
});


test("registration at the erasure lease boundary enters the complete cleanup scope", /** Reproduce a supported registration immediately before transaction acquisition. */ async () => {
  const { repo, parent } = await fixture(); const marker = Buffer.from("registration-boundary-unique-marker-738492"); commit(repo, "secret.bin", marker);
  const original = repo.objects.withWriteLock.bind(repo.objects); const root = join(parent, "late-instance");
  /** Schedule a real native operation at the boundary, then restore the real lease implementation. */
  repo.objects.withWriteLock = <T,>(action: () => T): T => { repo.objects.withWriteLock = original; repo.linkInstance("late", root); return original(action); };
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.listInstances().length, 1); assert.equal(existsSync(join(root, "secret.bin")), false); assert.equal(scanBytes(root, marker), 0); assert.equal(scanBytes(repo.root, marker), 0);
  const nested = new ObjectStore(join(repo.controlDirectory, "objects")); repo.identity();
  repo.objects.withWriteLock(/** Distinct handles share a synchronous lease rather than attempting a second filesystem lock. */ () => nested.withWriteLock(/** Real nested reads occur under the same physical lease. */ () => assert.equal(nested.recordedIdentity(), repo.identity())));
});

test("a contending real process cannot begin shared-instance materialization before obtaining its lease", /** Observe normal native linking under cross-process contention. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from("cross-process-registration-marker-238694"));
  const url = pathToFileURL(join(process.cwd(), "engine", "repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; let materializeReached=false; const original=Repository.prototype.materialize; Repository.prototype.materialize=function(tree){materializeReached=true;return original.call(this,tree)}; let refusal=""; try{Repository.open(process.argv[1]).linkInstance("child",process.argv[2])}catch(error){refusal=error.code} process.stdout.write(JSON.stringify({refusal,materializeReached}));`;
  const root = join(parent, "child");
  repo.objects.withWriteLock(/** A real child must refuse before copying or registering any payload. */ () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, repo.root, root], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { refusal: "store_locked", materializeReached: false }); assert.equal(existsSync(root), false); assert.deepEqual(repo.listInstances(), []);
  });
  repo.linkInstance("child", root); repo.unlinkInstance("child");
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); assert.equal(existsSync(join(root, "secret.bin")), false);
});

test("native merge and replay after erasure retain FileId provenance for blobs, records and PM histories", /** Merge independent changes while preserving terminal absence and audit metadata. */ async () => {
  for (const operation of ["merge", "cherryPick"] as const) {
    const { repo: original } = await fixture(); const repo = new Repository(original.root, { ...original.config, recordPaths: [...original.config.recordPaths, "data.json"] });
    const marker = Buffer.from("merge-provenance-unique-erasure-marker-637294"); const history = ".agents/pm/history/fixture.jsonl";
    const baseEvent = '{"ts":"2026-01-01","event":"base"}\n'; const mainEvent = '{"ts":"2026-01-02","event":"main"}\n'; const featureEvent = '{"ts":"2026-01-03","event":"feature"}\n';
    commit(repo, "secret.bin", marker); commit(repo, "keep.txt", Buffer.from("a\nb\nc\nd\n")); commit(repo, "data.json", Buffer.from('{"left":"a","right":"b"}')); const base = commit(repo, history, Buffer.from(baseEvent));
    const identities = new Map(repo.readIndex().map(/** Preserve the native identities selected before erasure. */ (entry) => [entry.path, entry.fileId]));
    repo.createBranch("feature", base, new Date()); repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); const audits = repo.objects.denials();
    writeFileSync(join(repo.root, "keep.txt"), "A\nb\nc\nd\n"); writeFileSync(join(repo.root, "data.json"), '{"left":"A","right":"b"}'); writeFileSync(join(repo.root, history), baseEvent + mainEvent); repo.stage([]); const main = repo.commit({ message: "main", author: signature }, new Date());
    repo.switchTo("feature", new Date()); writeFileSync(join(repo.root, "keep.txt"), "a\nb\nc\nD\n"); writeFileSync(join(repo.root, "data.json"), '{"left":"a","right":"B"}'); writeFileSync(join(repo.root, history), baseEvent + featureEvent); repo.stage([]); repo.commit({ message: "feature", author: signature }, new Date());
    if (operation === "merge") { const merged = repo.merge("main", { message: "merge", author: signature }, new Date()); assert.equal(merged.kind, "merged"); assert.equal(merged.clean, true); }
    else repo.cherryPick(main, signature, new Date());
    assert.equal(readFileSync(join(repo.root, "keep.txt"), "utf8"), "A\nb\nc\nD\n"); assert.deepEqual(JSON.parse(readFileSync(join(repo.root, "data.json"), "utf8")), { left: "A", right: "B" }); assert.equal(readFileSync(join(repo.root, history), "utf8"), baseEvent + mainEvent + featureEvent);
    for (const path of ["keep.txt", "data.json", history]) assert.equal(repo.readIndex().find(/** Match output ownership to the pre-erasure identity. */ (entry) => entry.path === path)!.fileId, identities.get(path));
    assert.deepEqual(repo.objects.denials(), audits); assert.equal(scanBytes(repo.root, marker), 0); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("one-sided typed link changes merge and competing pins refuse without ref, index or layer mutation", /** Pin reconciliation is explicit and never a text merge of descriptors. */ async () => {
  const { repo, parent } = await fixture(); const target = Repository.init(join(parent, "target")); target.setAuthority("target", "target-read", "target-erase");
  const first = commit(target, "asset.bin", Buffer.from("first pin")); const second = commit(target, "asset.bin", Buffer.from("second pin")); const third = commit(target, "asset.bin", Buffer.from("third pin"));
  repo.stageLink("dependency.link", linkTo(target, first)); repo.commit({ message: "base", author: signature }, new Date()); repo.createBranch("feature", "main", new Date());
  repo.stageLink("dependency.link", linkTo(target, second)); repo.commit({ message: "main pin", author: signature }, new Date()); repo.switchTo("feature", new Date()); commit(repo, "unrelated.txt");
  const oneSided = repo.merge("main", { message: "one side", author: signature }, new Date()); assert.equal(oneSided.clean, true); assert.equal(repo.links()[0].link.revision, second); assert.equal(repo.objects.read(repo.links()[0].id).type, "link");
  repo.createBranch("competing", "HEAD", new Date()); repo.stageLink("dependency.link", linkTo(target, third)); repo.commit({ message: "third pin", author: signature }, new Date()); const ours = repo.refs.resolveHead();
  repo.switchTo("competing", new Date()); repo.stageLink("dependency.link", linkTo(target, first)); repo.commit({ message: "first pin", author: signature }, new Date()); repo.switchTo("feature", new Date());
  repo.resolveLink("dependency.link", target, "target-read", "private"); const index = repo.readIndex(); const layers = repo.layers(); const bytes = readFileSync(join(repo.root, "vendor/asset.bin")); const refs = repo.refs.list("refs/heads/");
  refuses(() => repo.merge("competing", { message: "conflict", author: signature }, new Date()), "link_merge_conflict"); assert.equal(repo.refs.resolveHead(), ours); assert.deepEqual(repo.refs.list("refs/heads/"), refs); assert.deepEqual(repo.readIndex(), index); assert.deepEqual(repo.layers(), layers); assert.deepEqual(readFileSync(join(repo.root, "vendor/asset.bin")), bytes); assert.equal(repo.readMergeState(), null);
  repo.stageLink("dependency.link", linkTo(target, first)); repo.commit({ message: "explicit selected pin", author: signature }, new Date()); const resolved = repo.merge("competing", { message: "agreed pins", author: signature }, new Date()); assert.equal(resolved.clean, true); assert.equal(repo.links()[0].link.revision, first); assert.deepEqual(readFileSync(join(repo.root, "vendor/asset.bin")), bytes);
  repo.removeLayer("private"); repo.createBranch("plain", "HEAD", new Date()); repo.switchTo("plain", new Date()); rmSync(join(repo.root, "dependency.link")); repo.stage(["dependency.link"]); repo.commit({ message: "explicit removal", author: signature }, new Date()); commit(repo, "dependency.link", Buffer.from("ordinary replacement"));
  repo.switchTo("feature", new Date()); repo.stageLink("dependency.link", linkTo(target, third)); repo.commit({ message: "new typed pin", author: signature }, new Date()); repo.switchTo("plain", new Date());
  refuses(() => repo.merge("feature", { message: "mixed kinds", author: signature }, new Date()), "link_merge_conflict");
});

test("restore, sparse materialization and merge markers cannot publish cached bytes across a concurrent erasure", /** Supported worktree writers share the publication lease from reads through writes. */ async () => {
  for (const operation of ["restore", "view", "merge"] as const) {
    const { repo } = await fixture(); const marker = Buffer.from(`native-writer-${operation}-unique-marker-938274`); const base = commit(repo, "secret.bin", marker);
    const selected = repo.readIndex().find(/** Observe the exact payload whose cached read could otherwise escape erasure. */ (entry) => entry.path === "secret.bin")!.id;
    if (operation === "restore") writeFileSync(join(repo.root, "secret.bin"), "edited");
    else if (operation === "view") repo.setView(["unrelated/**"]);
    else {
      repo.createBranch("other", base, new Date()); commit(repo, "secret.bin", Buffer.from("our conflicting value\n")); repo.switchTo("other", new Date()); commit(repo, "secret.bin", Buffer.from("their conflicting value\n")); repo.switchTo("main", new Date());
    }
    const moduleUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
    const childProgram = `import { Repository } from ${JSON.stringify(moduleUrl)}; let refusal=""; try{Repository.open(process.argv[1]).obliterate("secret.bin","erase-fixture","incident",new Date())}catch(error){refusal=error.code} process.stdout.write(JSON.stringify({refusal}));`;
    const original = repo.objects.read.bind(repo.objects); let observed = false;
    /** A real second process attempts erasure after a supported writer has loaded the original bytes. */
    repo.objects.read = (id: string) => {
      const object = original(id);
      if (id === selected && !observed) {
        observed = true;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", childProgram, repo.root], { encoding: "utf8", timeout: 10_000 });
        assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { refusal: "store_locked" }); assert.deepEqual(repo.objects.denials(), []);
      }
      return object;
    };
    if (operation === "restore") repo.restore(["secret.bin"], base);
    else if (operation === "view") repo.setView(null);
    else { const merged = repo.merge("other", { message: "conflicting native mutation", author: signature }, new Date()); assert.equal(merged.clean, false); repo.mergeAbort(new Date()); }
    repo.objects.read = original; assert.equal(observed, true);
    repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); assert.equal(scanBytes(repo.root, marker), 0); assert.equal(existsSync(join(repo.root, "secret.bin")), false);
  }
});

test("restored native entries retain both stable identity and copy provenance", /** Restoration never converts attributed leaves into anonymous index entries. */ async () => {
  const { repo } = await fixture(); commit(repo, "original.txt", Buffer.from("restore provenance bytes"));
  writeFileSync(join(repo.root, "copy.txt"), "restore provenance bytes"); repo.stage(["copy.txt"]); const revision = repo.commit({ message: "copy", author: signature }, new Date());
  const before = repo.readIndex().find(/** Capture the copied leaf's native ownership before editing. */ (entry) => entry.path === "copy.txt")!; assert.ok(before.fileId); assert.ok(before.copiedFrom);
  writeFileSync(join(repo.root, "copy.txt"), "edited copied leaf"); repo.restore(["copy.txt"], revision);
  const after = repo.readIndex().find(/** Check restored provenance rather than only restored bytes. */ (entry) => entry.path === "copy.txt")!;
  assert.equal(after.fileId, before.fileId); assert.equal(after.copiedFrom, before.copiedFrom); assert.equal(readFileSync(join(repo.root, "copy.txt"), "utf8"), "restore provenance bytes");
  chmodSync(join(repo.root, "copy.txt"), 0o755); repo.stage(["copy.txt"]); repo.commit({ message: "executable copy", author: signature }, new Date()); repo.addLayer("mode", new Map([["copy.txt", { content: Buffer.from("private executable override"), executable: false }]])); repo.removeLayer("mode"); assert.equal(repo.readIndex().find(/** Underlying executable mode is restored along with identity and bytes. */ (entry) => entry.path === "copy.txt")!.mode, "100755");
});

test("immutable identity, inventory and recovery fail closed on real invalid storage", /** Verify administrative boundaries using physical faults and real process identities. */ async () => {
  const { repo, parent } = await fixture(); const revision = commit(repo, "secret.bin", Buffer.from("inventory complete unique marker 638752"));
  const identityPath = join(repo.controlDirectory, "identity"); const identity = repo.identity();
  for (const value of [1, "invalid"]) { writeFileSync(identityPath, JSON.stringify(value)); refuses(() => repo.identity(), "bad_identity"); }
  rmSync(identityPath); const identityCopy = join(parent, "identity-copy"); writeFileSync(identityCopy, JSON.stringify(identity)); symlinkSync(identityCopy, identityPath); refuses(() => repo.identity(), "bad_identity"); rmSync(identityPath);
  writeFileSync(identityPath, JSON.stringify(identity)); refuses(() => repo.objects.adoptIdentity("invalid"), "bad_identity");
  assert.deepEqual(new ObjectStore(join(parent, "absent", "objects")).inventory(), []);
  const alias = join(parent, "object-alias"); symlinkSync(join(repo.controlDirectory, "objects"), alias); refuses(() => new ObjectStore(alias).inventory(), "unsupported_erasure_storage");
  const path = objectPath(repo, revision); const physical = readFileSync(path); writeFileSync(path, deflateSync(frameObject("blob", Buffer.from("different valid object"))));
  refuses(() => repo.objects.inventory(), "corrupt_object"); writeFileSync(path, physical);
  chmodSync(path, 0o000); try { assert.throws(() => repo.objects.state(revision), /** I/O failure never turns into an intentional or missing state. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES"); } finally { chmodSync(path, 0o644); }
  const retired = join(repo.controlDirectory, "unlinked-instances.json");
  for (const value of [{}, [1]]) { writeFileSync(retired, JSON.stringify(value)); refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "bad_instances"); assert.deepEqual(repo.objects.denials(), []); }
  rmSync(retired); repo.linkInstance("retained", join(parent, "retained")); writeFileSync(retired, "{}"); refuses(() => repo.unlinkInstance("retained"), "bad_instances"); assert.equal(repo.listInstances().length, 1); rmSync(retired);
  const lock = join(repo.controlDirectory, "objects.lock"); mkdirSync(lock); assert.throws(() => repo.objects.recoverWriterLock(), /** Actual directory read errors remain operational I/O errors. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR"); rmSync(lock, { recursive: true });
  for (const value of ["unknown", "-1", "9007199254740992", String(process.pid)]) { writeFileSync(lock, value); refuses(() => repo.objects.recoverWriterLock(), "store_locked"); rmSync(lock); }
  writeFileSync(lock, "999999999999"); assert.throws(() => repo.objects.recoverWriterLock(), /** Invalid native PID ranges cannot be mistaken for dead writers. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_TYPE"); rmSync(lock);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); assert.equal(child.status, 0); writeFileSync(lock, child.stdout); repo.objects.recoverWriterLock(); assert.equal(existsSync(lock), false);
});

test("unreachable missing history and malformed import metadata refuse before erasure or publication", /** Complete history and immutable audits remain necessary even without advertised refs. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from("historical-structure-unique-marker-572839"));
  const absent = "e".repeat(64); const broken = writeCommit(repo.objects, { tree: absent, parents: [], author: signature, committer: signature, message: "unreachable incomplete structure" });
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "incomplete_erasure_inventory"); assert.deepEqual(repo.objects.denials(), []); rmSync(objectPath(repo, broken));
  const receipt = repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); const denial = repo.objects.denials()[0];
  const receiver = Repository.init(join(parent, "receiver"));
  refuses(() => importBundleObjects(receiver.objects, archive({}, [{ ...denial, pending: true }])), "erasure_incomplete"); assert.deepEqual(receiver.objects.denials(), []);
  importBundleObjects(receiver.objects, archive({}, [denial])); importBundleObjects(receiver.objects, archive({}, [denial]));
  const tombstone = { ...denial.tombstone, reason: "different" }; const different = { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false };
  refuses(() => importBundleObjects(receiver.objects, archive({}, [different])), "tombstone_conflict"); assert.equal(receiver.objects.denials()[0].id, receipt.tombstone);
  for (const identity of [1, "invalid"]) refuses(() => parseBundle(Buffer.from(`pmvcs-bundle-1\n${JSON.stringify({ refs: {}, objects: [], prerequisites: [], identity })}\n`)), "bad_bundle");
});

test("self-targeted pin resolution keeps cached target reads under the same erasure lease", /** A supported link resolver cannot publish an erased payload after its read lease ends. */ async () => {
  const { repo } = await fixture(); const marker = Buffer.from("self-target-native-lease-unique-marker-928374"); const pin = commit(repo, "asset.bin", marker); const selected = repo.readIndex().find(/** Observe the original pinned payload. */ (entry) => entry.path === "asset.bin")!.id;
  repo.stageLink("local.link", linkTo(repo, pin)); repo.commit({ message: "self pin", author: signature }, new Date());
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href; const program = `import { Repository } from ${JSON.stringify(url)}; let refusal=""; try{Repository.open(process.argv[1]).obliterate("asset.bin","erase-fixture","incident",new Date())}catch(error){refusal=error.code} process.stdout.write(JSON.stringify({refusal}));`;
  const original = repo.objects.read.bind(repo.objects); let observed = false;
  /** Attempt real erasure after target bytes enter the resolver, before its layer publishes. */
  repo.objects.read = (id: string) => { const object = original(id); if (id === selected && !observed) { observed = true; const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 }); assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { refusal: "store_locked" }); } return object; };
  repo.resolveLink("local.link", repo, "read-fixture", "resolved"); repo.objects.read = original; assert.equal(observed, true);
  refuses(() => repo.obliterate("asset.bin", "erase-fixture", "incident", new Date()), "erasure_layer_conflict"); repo.removeLayer("resolved"); repo.obliterate("asset.bin", "erase-fixture", "incident", new Date()); assert.equal(scanBytes(repo.root, marker), 0);
});

test("proposed audit metadata never reintroduces erased payload bytes", /** Short audit-compatible payloads must refuse before any denial or object mutation. */ async () => {
  for (const scenario of ["reason", "timestamp"] as const) {
    const { repo } = await fixture(); const marker = Buffer.from(scenario === "reason" ? "incident" : "2044-12-30"); const revision = commit(repo, "secret.bin", marker); const selected = repo.readIndex().find(/** Capture exact old physical payload ownership. */ (entry) => entry.path === "secret.bin")!;
    const physical = readFileSync(objectPath(repo, selected.id)); const inventory = repo.objects.inventory().map(/** Audit refusal must leave the full object inventory unchanged. */ (entry) => entry.id).sort(); const operations = repo.operations.read(); assert.ok(scanBytes(repo.root, marker) > 0);
    refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date("2044-12-30T12:00:00.000Z")), "erasure_audit_conflict");
    assert.deepEqual(repo.objects.denials(), []); assert.deepEqual(repo.operations.read(), operations); assert.deepEqual(repo.objects.inventory().map(/** Compare physical inventory before retry. */ (entry) => entry.id).sort(), inventory); assert.deepEqual(readFileSync(objectPath(repo, selected.id)), physical); assert.deepEqual(readFileSync(join(repo.root, "secret.bin")), marker);
    repo.obliterate("secret.bin", "erase-fixture", "policy", new Date("2050-01-02T12:00:00.000Z")); assert.equal(scanBytes(repo.root, marker), 0); assert.equal(repo.readFileState(revision, "secret.bin").kind, "obliterated"); assert.deepEqual(repo.verify().corrupt, []);
    const before = repo.operations.read(); assert.throws(() => repo.operations.append("fixture", "unsafe receipt", [], new Date(), undefined, /** A receipt validator runs under the actual log lock before the first byte append. */ (receipt) => { assert.equal(receipt.sequence, before.length + 1); throw new ObjectStoreError("erasure_audit_conflict", "Refused synthetic receipt."); }), /** Preserve the typed refusal and old audit entries. */ (error: unknown) => error instanceof ObjectStoreError && error.code === "erasure_audit_conflict"); assert.deepEqual(repo.operations.read(), before);
  }
});

test("shared verification agrees on missing, corrupt and intentionally absent payload states", /** Real hub and linked stores retain the same classifications despite different read error codes. */ async () => {
  const { repo, parent } = await fixture(); const revision = commit(repo, "asset.bin", Buffer.from("shared-classification-unique-marker-837492")); repo.linkInstance("shared", join(parent, "shared")); const shared = Repository.open(join(parent, "shared"));
  for (const current of [repo, shared]) {
    assert.deepEqual(current.readFileState(revision, "absent.bin"), { kind: "missing", code: "path_not_found" });
    const present = current.readFileState(revision, "asset.bin"); assert.equal(present.kind, "present");
    if (present.kind === "present") { assert.equal(present.object.type, "blob"); assert.deepEqual(present.object.payload, Buffer.from("shared-classification-unique-marker-837492")); }
  }
  const selected = repo.readIndex().find(/** Address one actual shared loose payload. */ (entry) => entry.path === "asset.bin")!; const path = objectPath(repo, selected.id); const physical = readFileSync(path); rmSync(path);
  for (const current of [repo, shared]) { const report = current.verify(); assert.equal(report.missing.length, 1); assert.deepEqual(report.corrupt, []); assert.deepEqual(report.obliterated, []); assert.equal(current.readFileState(revision, "asset.bin").kind, "missing"); }
  writeFileSync(path, "corrupt physical bytes"); for (const current of [repo, shared]) { const report = current.verify(); assert.equal(report.corrupt.length, 1); assert.deepEqual(report.missing, []); assert.deepEqual(report.obliterated, []); assert.equal(current.readFileState(revision, "asset.bin").kind, "corrupt"); }
  writeFileSync(path, physical); repo.obliterate("asset.bin", "erase-fixture", "incident", new Date());
  for (const current of [repo, shared]) { const report = current.verify(); assert.deepEqual(report.missing, []); assert.deepEqual(report.corrupt, []); assert.equal(report.obliterated.length, 1); assert.equal(current.readFileState(revision, "asset.bin").kind, "obliterated"); }
});

test("incoming tombstones reject nonstring audit fields before any store mutation", /** Real bundle arrival must validate types without coercing untrusted JSON values. */ async () => {
  const { repo } = await fixture();
  const inventory = repo.objects.inventory().map(/** Observe immutable inventory before malformed arrivals. */ (entry) => entry.id).sort();
  const refs = repo.refs.list("refs/heads/");
  for (const [field, value] of [
    ["principal", null], ["principal", true], ["principal", ["Fixture"]],
    ["reason", null], ["reason", true], ["reason", ["incident"]],
    ["fileId", null], ["fileId", ["a".repeat(32)]],
  ] as const) {
      const tombstone = { version: 1, fileId: "a".repeat(32), roots: ["b".repeat(64)], objects: ["b".repeat(64)], payloads: [], principal: "Fixture", timestamp: "2050-01-02T12:00:00.000Z", reason: "incident", [field]: value };
      const denial = { id: hashObject("tombstone", Buffer.from(JSON.stringify(tombstone))), tombstone, pending: false };
      const bytes = Buffer.from(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: {}, prerequisites: [], objects: [], denials: [denial] })}\n`);
      refuses(() => importBundle(repo.objects, repo.refs, bytes), "bad_tombstone");
      assert.deepEqual(repo.objects.denials(), []);
      assert.deepEqual(repo.objects.inventory().map(/** Check that rejected JSON publishes no typed audit object. */ (entry) => entry.id).sort(), inventory);
      assert.deepEqual(repo.refs.list("refs/heads/"), refs);
  }
});

test("committed link identities reject JSON arrays before descriptor publication", /** Real staging must refuse coercible repository and revision fields without changing the index or store. */ async () => {
  const { repo } = await fixture();
  const descriptor = linkTo(repo, repo.refs.resolveHead()!);
  const index = repo.readIndex();
  const inventory = repo.objects.inventory().map(/** Capture the physical store before malformed descriptor arrival. */ (entry) => entry.id).sort();
  for (const field of ["repository", "revision"] as const) {
    const raw = Buffer.from(JSON.stringify({ ...descriptor, [field]: [descriptor[field]] }));
    refuses(() => repo.stageLink("unsafe.link", decodeLink(raw)), "bad_link");
    assert.deepEqual(repo.readIndex(), index);
    assert.deepEqual(repo.objects.inventory().map(/** Verify no invalid typed link object was published. */ (entry) => entry.id).sort(), inventory);
    assert.equal(existsSync(join(repo.root, "unsafe.link")), false);
  }
});

test("erasing an empty file preserves healthy empty trees while refusing its payload identity", /** Zero-byte structural representations cannot be mistaken for a denied blob's type-independent content. */ async () => {
  const { repo } = await fixture();
  const tree = writeTree(repo.objects, []);
  const empty = writeCommit(repo.objects, { tree, parents: [repo.refs.resolveHead()!], author: signature, committer: signature, message: "empty tree" });
  commit(repo, "empty.bin", Buffer.alloc(0));
  const selected = repo.readIndex().find(/** Capture the exact terminal payload and FileId. */ (entry) => entry.path === "empty.bin")!;
  repo.obliterate("empty.bin", "erase-fixture", "incident", new Date(4000));
  repo.reset(empty, "mixed", new Date(5000));
  assert.doesNotThrow(() => repo.commit({ message: "still empty", author: signature, allowEmpty: true }, new Date(6000)));
  assert.equal(readCommit(repo.objects, repo.refs.resolveHead()!).tree, tree);
  assert.deepEqual(repo.verify().corrupt, []);
  assert.equal(repo.objects.state(selected.id).kind, "obliterated");
  refuses(() => repo.objects.write("blob", Buffer.alloc(0), selected.fileId), "object_obliterated");
  refuses(() => repo.objects.write("blob", Buffer.from("replacement"), selected.fileId), "file_obliterated");
});

test("atomic payload merge handles added records and reports incompatible base kinds", /** Use real stored typed inputs, including a link base replaced differently on both sides. */ async () => {
  const { repo } = await fixture(); const context = { store: repo.objects, config: repo.config, committer: signature };
  const ourRecord = repo.objects.write("record", encodeRecord({ left: "a" })); const theirRecord = repo.objects.write("record", encodeRecord({ right: "b" })); const merged = mergePath(context, "record.json", null, ourRecord, theirRecord);
  assert.deepEqual(decodeRecord(repo.objects.read(merged.id).payload), { left: "a", right: "b" }); assert.equal(merged.conflict, undefined);
  const ourBlob = repo.objects.write("blob", Buffer.from("ours\n")); const theirBlob = repo.objects.write("blob", Buffer.from("theirs\n"));
  assert.deepEqual(mergePath(context, "plain.txt", ourRecord, ourBlob, theirBlob), { id: ourBlob, conflict: { path: "plain.txt", reason: "content" } });
  assert.deepEqual(mergePath(context, "record.json", ourBlob, ourRecord, theirRecord), { id: ourRecord, conflict: { path: "record.json", reason: "content" } });
  const link = repo.objects.write("link", encodeLink(linkTo(repo, repo.refs.resolveHead()!)));
  refuses(() => mergePath(context, "descriptor.link", link, ourBlob, theirBlob), "link_merge_conflict");
});

test("an indexed uncommitted payload missing from loose storage refuses erasure before denial", /** Inventory includes staged identities absent from every commit closure. */ async () => {
  const { repo } = await fixture(); const marker = Buffer.from("indexed-only-missing-unique-marker-839275"); writeFileSync(join(repo.root, "staged.bin"), marker); repo.stage(["staged.bin"]);
  const selected = repo.readIndex().find(/** Resolve a stable uncommitted identity through the native index. */ (entry) => entry.path === "staged.bin")!; const path = objectPath(repo, selected.id); const physical = readFileSync(path); rmSync(path);
  refuses(() => repo.obliterate("staged.bin", "erase-fixture", "incident", new Date()), "incomplete_erasure_inventory"); assert.deepEqual(repo.objects.denials(), []); assert.deepEqual(readFileSync(join(repo.root, "staged.bin")), marker);
  writeFileSync(path, physical); repo.obliterate("staged.bin", "erase-fixture", "incident", new Date()); assert.equal(scanBytes(repo.root, marker), 0);
});

test("a future tree cannot replace an edited private layer parent with a tracked file", /** Check ancestor collisions before fast-forward ref and worktree publication. */ async () => {
  const { repo } = await fixture(); repo.createBranch("other", "HEAD", new Date()); repo.switchTo("other", new Date()); commit(repo, "vendor", Buffer.from("incoming ancestor file")); repo.switchTo("main", new Date());
  repo.addLayer("private", new Map([["vendor/private.bin", { content: Buffer.from("original private snapshot"), executable: false }]])); writeFileSync(join(repo.root, "vendor/private.bin"), "edited private bytes");
  const head = repo.refs.resolveHead(); const index = repo.readIndex(); const layers = repo.layers();
  refuses(() => repo.merge("other", { message: "colliding incoming tree", author: signature }, new Date()), "layer_checkout_conflict"); assert.equal(repo.refs.resolveHead(), head); assert.deepEqual(repo.readIndex(), index); assert.deepEqual(repo.layers(), layers); assert.equal(readFileSync(join(repo.root, "vendor/private.bin"), "utf8"), "edited private bytes");
});

test("real index and registry I/O faults remain distinct from lease contention", /** Fail real filesystem writes after the common lease has already been obtained. */ async () => {
  const { repo } = await fixture();
  repo.objects.withWriteLock(/** Hold the real store lease while injecting a recoverable directory-permission fault. */ () => {
    chmodSync(repo.controlDirectory, 0o500);
    try {
      assert.throws(() => repo.writeIndex([]), /** A denied index lock is an I/O error rather than another active writer. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
      assert.throws(() => registerInstance(repo.controlDirectory, { name: "fault", path: "fault" }), /** The registry preserves the same operational distinction. */ (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
    } finally { chmodSync(repo.controlDirectory, 0o700); }
  });
  assert.equal(repo.status().clean, true); assert.deepEqual(repo.listInstances(), []);
});

test("restore supports legacy unattributed tree entries and preserves executable bytes", /** Backward-compatible history can be restored before explicit identity migration. */ async () => {
  const { repo } = await fixture(); const id = repo.objects.write("blob", Buffer.from("legacy native tree payload")); const tree = writeTree(repo.objects, [{ name: "legacy.txt", mode: "100755", id }]); const revision = writeCommit(repo.objects, { tree, parents: [repo.refs.resolveHead()!], author: signature, committer: signature, message: "legacy" });
  repo.restore(["legacy.txt"], revision); const restored = repo.readIndex().find(/** A legacy leaf does not invent provenance during restoration. */ (entry) => entry.path === "legacy.txt")!; assert.equal(restored.fileId, undefined); assert.equal(restored.mode, "100755"); assert.equal(readFileSync(join(repo.root, "legacy.txt"), "utf8"), "legacy native tree payload");
  repo.stage(["legacy.txt"]); assert.ok(repo.readIndex().find(/** Normal native staging migrates the restored entry into stable identity. */ (entry) => entry.path === "legacy.txt")!.fileId);
});


test("composition rejects every control-name spelling at any depth", /** Link descriptors, private layers and owned erasure paths share the control-path fence. */ async () => {
  const { repo } = await fixture();
  for (const path of [".PMVCS", "nested/.PmVcS/file.txt", "nested/.pmvcs"]) {
    refuses(() => assertCompositionPath(path), "unsafe_composition_path");
    refuses(() => repo.addLayer("unsafe", new Map([[path, { content: Buffer.from("private bytes"), executable: false }]])), "unsafe_composition_path");
    refuses(() => repo.stageLink(path, { version: 1, repository: repo.identity(), revision: repo.refs.resolveHead()!,
      mappings: [{ source: "source.txt", destination: "vendor/file.txt" }] }), "unsafe_composition_path");
    refuses(() => encodeLink({ version: 1, repository: repo.identity(), revision: repo.refs.resolveHead()!,
      mappings: [{ source: path, destination: "vendor/file.txt" }] }), "unsafe_composition_path");
  }
});


test("obliteration refuses forged ownership inside a nested control directory", /** A legacy or injected index never authorizes removal of protected control bytes. */ async () => {
  const { repo } = await fixture();
  commit(repo, "secret.bin", Buffer.from("unique payload chosen for control-path erasure regression"));
  const selected = repo.readIndex().find(/** Preserve the selected real FileId while forging only its checkout path. */ (entry) => entry.path === "secret.bin")!;
  const path = "nested/.PMVCS/sentinel";
  mkdirSync(dirname(join(repo.root, path)), { recursive: true });
  writeFileSync(join(repo.root, path), "control sentinel");
  repo.writeIndex(repo.readIndex().map(/** Test the terminal ownership check against an untrusted legacy index. */ (entry) => entry.path === "secret.bin" ? { ...entry, path } : entry));
  rmSync(join(repo.root, "secret.bin"));
  refuses(() => repo.obliterate(selected.fileId!, "erase-fixture", "incident", new Date()), "unsafe_composition_path");
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "control sentinel");
  assert.deepEqual(repo.objects.denials(), []);
});

test("sparse-view CLI preserves operational errors from control metadata publication", /** A working-tree mutation refusal and a metadata I/O fault retain their separate error contracts. */ async () => {
  const { repo } = await fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  mkdirSync(join(repo.controlDirectory, "view.json"));
  const index = repo.readIndex();
  const result = await harness.runCommand({ command: "vcs view", args: ["**"], pmRoot: repo.root });
  assert.match(String(result.errorMessage), /EISDIR|ENOTDIR|EEXIST/);
  assert.deepEqual(repo.readIndex(), index);
  assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
});

test("review credentials use versioned scrypt and reject malformed or legacy grants before mutation", /** Real authority files enforce independent read and destructive grants. */ async () => {
  const { repo } = await fixture(); const path = join(repo.controlDirectory, "authority.json");
  const authority = JSON.parse(readFileSync(path, "utf8")) as { version: number; principal: string; salt: string; read: string; erase: string };
  assert.equal(authority.version, 2);
  assert.equal(authority.erase, scryptSync("erase-fixture", authority.salt, 32).toString("hex"));
  assert.equal(authorize(repo.controlDirectory, "read", "read-fixture"), "fixture");
  assert.equal(authorize(repo.controlDirectory, "erase", "erase-fixture"), "fixture");
  for (const value of ["read-fixture", "wrong", "", "erase-fixturf"]) refuses(() => authorize(repo.controlDirectory, "erase", value), "unauthorized");
  const revision = commit(repo, "credential-secret.bin", Buffer.from("credential-boundary-selected-marker-293874"));
  for (const change of [{ erase: "00" }, { erase: "g".repeat(64) }, { erase: "0".repeat(65) }, { salt: [] }, { salt: "bad" }, { principal: 1 }, { principal: "" }, { erase: 1 }, { version: 3 }, { version: 1 }, { version: undefined }]) {
    writePrivateJson(path, { ...authority, ...change });
    refuses(() => repo.obliterate("credential-secret.bin", "erase-fixture", "incident", new Date()), "unauthorized");
    assert.equal(repo.refs.resolveHead(), revision); assert.deepEqual(repo.objects.denials(), []); assert.equal(existsSync(join(repo.root, "credential-secret.bin")), true);
  }
  writePrivateJson(path, { principal: "fixture", salt: authority.salt, read: createHash("sha256").update(`${authority.salt}\0read-fixture`).digest("hex"), erase: createHash("sha256").update(`${authority.salt}\0erase-fixture`).digest("hex") });
  refuses(() => authorize(repo.controlDirectory, "erase", "erase-fixture"), "unauthorized");
  repo.setAuthority("fixture", "read-fixture", "erase-fixture", { regenerateLegacy: true }); repo.obliterate("credential-secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(existsSync(join(repo.root, "credential-secret.bin")), false);
});

test("review ordinary large and long-text files remain usable before and after erasure", /** Preserve availability without skipping recoverable-copy inspection. */ async () => {
  const { repo } = await fixture(); const marker = Buffer.from("large-control-selected-marker-946283");
  commit(repo, "secret.bin", marker);
  const controls = [Buffer.alloc(17 * 1024 * 1024, 0xff), Buffer.from("ordinary text word ".repeat(5000)), Buffer.from("blob ordinary document"), deflateSync(Buffer.from("independent valid compressed document"))];
  for (let i = 0; i < controls.length; i += 1) writeFileSync(join(repo.root, `ordinary-${i}.bin`), controls[i]);
  assert.doesNotThrow(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()));
  for (let i = 0; i < controls.length; i += 1) assert.doesNotThrow(() => commit(repo, `ordinary-${i}.bin`, controls[i]));
  assert.deepEqual(repo.verify().corrupt, []);
  for (let i = 0; i < controls.length; i += 1) assert.deepEqual(readFileSync(join(repo.root, `ordinary-${i}.bin`)), controls[i]);
  const stale = frameObject("blob", marker);
  for (const payload of [marker, stale, frameObject("record", marker), deflateSync(stale), Buffer.from(stale.toString("base64")), Buffer.from(`${"word ".repeat(5000)}${stale.toString("base64")}`)]) {
    refuses(() => repo.objects.write("blob", payload, "a".repeat(32)), "object_obliterated");
  }
});

test("review denials reuse validated reads and refresh across real replacement and pending cleanup", /** Trace filesystem reads and retain fail-closed invalidation across store handles. */ async () => {
  const { repo } = await fixture(); commit(repo, "secret.bin", Buffer.from("cache-denial-unique-selected-marker-397162"));
  const keep = repo.objects.write("blob", Buffer.from("independent readable control"));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  const denial = repo.objects.denials()[0]; const path = join(repo.controlDirectory, "denials.json");
  const moduleUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(moduleUrl)}; const r=Repository.open(process.argv[1]); for(let i=0;i<40;i++){r.objects.read(process.argv[2]); if(!r.objects.denial(process.argv[3]))throw Error("missing denial")} process.stdout.write("40 verified reads");`;
  const child = spawnSync("strace", ["-e", "trace=openat", "-P", path, process.execPath, "--input-type=module", "-e", program, repo.root, keep, denial.tombstone.roots[0]], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, "40 verified reads");
  assert.equal(child.stderr.split("\n").filter(line => line.includes("openat(") && line.includes("denials.json")).length, 1);
  const second = new ObjectStore(join(repo.controlDirectory, "objects"));
  assert.equal(second.denial(denial.tombstone.roots[0])?.id, denial.id);
  second.recordDenials([{ ...denial, pending: true }]);
  refuses(() => repo.objects.write("blob", Buffer.from("fresh control"), "b".repeat(32)), "erasure_incomplete");
  second.recordDenials([denial]);
  assert.equal(repo.objects.denials()[0].pending, false);
  writeFileSync(path, "{}"); refuses(() => repo.objects.read(keep), "bad_tombstone");
  writePrivateJson(path, [denial]); assert.equal(repo.objects.denial(denial.tombstone.roots[0])?.id, denial.id);
  const exposed = repo.objects.denials();
  assert.throws(() => { (exposed[0].tombstone.objects as string[]).length = 0; }, TypeError);
  exposed.length = 0;
  assert.equal(repo.objects.denials().length, 1);
});

test("review identity advertisement and export stay read-only under a live writer lease", /** A real child can advertise and export without source mutation or lock contention. */ async () => {
  const { repo, parent } = await fixture(); const identity = repo.identity();
  const repoUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const transportUrl = pathToFileURL(join(process.cwd(), "engine/transport.ts")).href;
  const bundleUrl = pathToFileURL(join(process.cwd(), "engine/bundle.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(repoUrl)}; import { FileTransport } from ${JSON.stringify(transportUrl)}; import { exportBundle } from ${JSON.stringify(bundleUrl)}; const r=Repository.open(process.argv[1]); const a=await new FileTransport(r.root, r.root).advertise(); const b=exportBundle(r.objects,r.refs,[]); process.stdout.write(JSON.stringify({identity:a.repositoryId,bytes:b.length}));`;
  repo.objects.withWriteLock(/** Hold the actual lease while an independent reader accesses immutable metadata. */ () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr); const output = JSON.parse(child.stdout) as { identity: string; bytes: number };
    assert.equal(output.identity, identity); assert.ok(output.bytes > 0);
  });
  chmodSync(repo.controlDirectory, 0o555);
  try { assert.equal(repo.objects.recordedIdentity(), identity); assert.equal((await new FileTransport(repo.root, repo.root).advertise()).repositoryId, identity); } finally { chmodSync(repo.controlDirectory, 0o755); }
  const legacy = Repository.init(join(parent, "legacy"));
  assert.equal((await new FileTransport(legacy.root, legacy.root).advertise()).repositoryId, undefined);
  assert.equal(existsSync(join(legacy.controlDirectory, "identity")), false);
});

test("review identity adoption ignores occupied storage and inventory decompression faults are typed", /** Nonempty stores never need decompression to reject clone identity adoption. */ async () => {
  const { repo, parent } = await fixture(); const identity = repo.identity();
  const stray = join(repo.controlDirectory, "objects", ".DS_Store"); writeFileSync(stray, "unindexed control");
  assert.doesNotThrow(() => repo.objects.adoptIdentity("a".repeat(32))); assert.equal(repo.identity(), identity);
  const legacy = Repository.init(join(parent, "legacy")); mkdirSync(join(legacy.controlDirectory, "objects", "aa"));
  writeFileSync(join(legacy.controlDirectory, "objects", "aa", `${"b".repeat(62)}.123.123456789abc.tmp`), "truncated");
  assert.doesNotThrow(() => legacy.objects.adoptIdentity(identity)); assert.equal(legacy.objects.recordedIdentity(), undefined);
  refuses(() => legacy.objects.inventory(), "corrupt_object");
});

test("review ordinary crashed writers recover without erase authority and empty legacy locks have a grace period", /** Kill an actual lease holder, then recover through the installed command surface. */ async () => {
  const { repo } = await fixture(); rmSync(join(repo.controlDirectory, "authority.json"));
  const repoUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const marker = join(repo.controlDirectory, "writer-ready");
  const program = `import { Repository } from ${JSON.stringify(repoUrl)}; import { writeFileSync } from "node:fs"; Repository.open(process.argv[1]).objects.withWriteLock(()=>{writeFileSync(process.argv[2],String(process.pid)); process.kill(process.pid,"SIGKILL")});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, repo.root, marker], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL"); assert.equal(existsSync(marker), true); rmSync(marker);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  let recovered: Awaited<ReturnType<typeof harness.runCommand>> | undefined;
  await assert.doesNotReject(async () => { recovered = await harness.runCommand({ command: "vcs recover-lock", pmRoot: repo.root }); });
  assert.ok(recovered);
  assert.equal(recovered.errorMessage, undefined); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
  commit(repo, "after-crash.txt", Buffer.from("ordinary writer recovery"));
  const lock = join(repo.controlDirectory, "objects.lock"); writeFileSync(lock, "");
  refuses(() => repo.objects.recoverWriterLock(), "store_locked");
  utimesSync(lock, new Date(0), new Date(0)); repo.objects.recoverWriterLock(); assert.equal(existsSync(lock), false);
  writeFileSync(lock, String(process.pid)); utimesSync(lock, new Date(0), new Date(0)); refuses(() => repo.objects.recoverWriterLock(), "store_locked"); rmSync(lock);
});

test("review writer lease publishes complete owner metadata atomically", /** Trace the real native publication syscall rather than mocking filesystem writes. */ async () => {
  const { repo } = await fixture();
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; Repository.open(process.argv[1]).objects.withWriteLock(()=>process.stdout.write("held"));`;
  const child = spawnSync("strace", ["-y", "-e", "trace=openat,write,link", process.execPath, "--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, "held");
  const lines = child.stderr.split("\n");
  const publish = lines.findIndex(line => line.startsWith("link(") && line.includes('objects.lock"'));
  assert.ok(publish >= 0, "lease must be published with an atomic hard link");
  assert.ok(lines.slice(0, publish).some(line => line.startsWith("write(") && line.includes("objects.lock.") && line.includes(".tmp>")), "complete owner bytes precede publication");
  assert.equal(readdirSync(repo.controlDirectory).some(name => name.startsWith("objects.lock")), false);
});

test("review null identity and denial control files are corrupt rather than absent", /** Existing JSON null cannot reset immutable identity or reopen terminal payloads. */ async () => {
  const { repo } = await fixture(); commit(repo, "secret.bin", Buffer.from("null-control-denied-selected-marker-837264"));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  const selected = repo.objects.denials()[0].tombstone.roots[0];
  writeFileSync(join(repo.controlDirectory, "identity"), "null");
  refuses(() => repo.objects.recordedIdentity(), "bad_identity");
  refuses(() => repo.objects.adoptIdentity("a".repeat(32)), "bad_identity");
  assert.equal(readFileSync(join(repo.controlDirectory, "identity"), "utf8"), "null");
  writeFileSync(join(repo.controlDirectory, "denials.json"), "null");
  refuses(() => repo.objects.denial(selected), "bad_tombstone");
});

/** Pause actual native syscalls to coordinate real filesystem races without changing returned data or errno. */
async function nativeRace(root: string, program: string, syscall: string, boundary: string, mutate: () => void, filter?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("strace", ["-y", "-e", `trace=${syscall}`, `--inject=${syscall}:delay_exit=1s`, ...(filter === undefined ? [] : ["-P", filter]), process.execPath, "--input-type=module", "-e", program, root]);
    let stdout = ""; let stderr = ""; let changed = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Native race did not finish")); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!changed && stderr.includes(boundary)) {
        changed = true;
        try { mutate(); } catch (error) { child.kill("SIGKILL"); reject(error); }
      }
    });
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timeout); if (!changed) reject(new Error(`Native boundary was not reached: ${stderr}`)); else resolve({ code, stdout, stderr }); });
  });
}

test("review recovery preserves replaced owners and tolerates disappearing dead leases", /** Real processes change lease metadata while the dead-owner syscall is paused. */ async () => {
  const { repo } = await fixture(); const lock = join(repo.controlDirectory, "objects.lock");
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; try { Repository.open(process.argv[1]).objects.recoverWriterLock(); process.stdout.write("recovered"); } catch (error) { process.stdout.write(error.code); }`;
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); assert.equal(dead.status, 0);
  for (const replacement of ["missing", "new-owner", "changed-owner"] as const) {
    writeFileSync(lock, dead.stdout);
    const child = await nativeRace(repo.root, program, "kill", "kill(", () => {
      if (replacement !== "changed-owner") rmSync(lock);
      if (replacement !== "missing") writeFileSync(lock, String(process.pid));
    });
    assert.equal(child.code, 0, child.stderr); assert.equal(child.stdout, replacement === "missing" ? "recovered" : "store_locked");
    if (replacement !== "missing") { assert.equal(readFileSync(lock, "utf8"), String(process.pid)); rmSync(lock); }
  }
  writeFileSync(lock, dead.stdout);
  const disappeared = await nativeRace(repo.root, program, "statx", "(DELAYED)", () => rmSync(lock), lock);
  assert.equal(disappeared.code, 0, disappeared.stderr); assert.match(disappeared.stderr, /statx[^\n]*= 0[^\n]*\(DELAYED\)/); assert.equal(disappeared.stdout, "recovered");
  const alias = join(repo.root, "lock-owner.txt"); writeFileSync(alias, dead.stdout); symlinkSync(alias, lock);
  refuses(() => repo.objects.recoverWriterLock(), "store_locked"); assert.equal(readFileSync(alias, "utf8"), dead.stdout); rmSync(lock);
});

test("review atomic publication preserves native permission failures and known orphan owner metadata", /** Change real directory permissions after fsynced owner creation, before publication. */ async () => {
  const { repo, parent } = await fixture(); const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; try { Repository.open(process.argv[1]).objects.withWriteLock(()=>process.stdout.write("held")); } catch (error) { process.stdout.write(error.code); }`;
  try {
    const child = await nativeRace(repo.root, program, "write", ".tmp>", () => chmodSync(repo.controlDirectory, 0o555));
    assert.equal(child.code, 0, child.stderr); assert.equal(child.stdout, "EACCES"); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
  } finally { chmodSync(repo.controlDirectory, 0o755); }
  const owners = readdirSync(repo.controlDirectory).filter(name => /^objects\.lock\.[0-9]+\.[0-9a-f]{12}\.tmp$/.test(name));
  assert.equal(owners.length, 1);
  commit(repo, "secret.bin", Buffer.from("orphan-owner-independent-erasure-marker-647382"));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); assert.equal(existsSync(join(repo.root, "secret.bin")), false);
  const orphan = join(repo.controlDirectory, owners[0]); writeFileSync(orphan, "orphan-owner-second-selected-marker-293871");
  commit(repo, "second.bin", Buffer.from("orphan-owner-second-selected-marker-293871"));
  refuses(() => repo.obliterate("second.bin", "erase-fixture", "incident", new Date()), "unsupported_erasure_storage");
  const fresh = new ObjectStore(join(parent, "new-control", "objects")); const id = fresh.write("blob", Buffer.from("first ordinary publication"));
  assert.equal(fresh.read(id).payload.toString(), "first ordinary publication");
});

test("review decoded expansion refuses exhaustion without rejecting ordinary raw size", /** A compressed document consumes both expansion and nested-token accounting. */ () => {
  refuses(() => inspectRepresentations(deflateSync(Buffer.from("word ".repeat(200))), () => false, 6, 1024), "uninspectable_payload");
});

test("review ordinary recovery retains pending erasure and first denial attribution", /** Administrative lease recovery cannot reopen a denied payload or change attribution precedence. */ async () => {
  const { repo } = await fixture(); commit(repo, "secret.bin", Buffer.from("pending-recovery-synthetic-marker-824736"));
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()); const denial = repo.objects.denials()[0];
  const tombstone = { ...denial.tombstone, fileId: "a".repeat(32) };
  repo.objects.recordDenials([{ ...denial, pending: true }, { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false }]);
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); assert.equal(dead.status, 0);
  writeFileSync(join(repo.controlDirectory, "objects.lock"), dead.stdout); rmSync(join(repo.controlDirectory, "authority.json"));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs recover-lock", pmRoot: repo.root }); assert.equal(result.errorMessage, undefined);
  assert.equal(repo.objects.denials()[0].pending, true); assert.equal(repo.objects.denial(denial.tombstone.roots[0])?.id, denial.id);
  refuses(() => repo.objects.write("blob", Buffer.from("new publication"), "b".repeat(32)), "erasure_incomplete");
});

test("review short owner writes cannot publish a lease", /** A real per-process file-size limit makes the kernel return a partial metadata write. */ async () => {
  const { repo } = await fixture(); const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; import { existsSync } from "node:fs"; import { join } from "node:path"; const r=Repository.open(process.argv[1]); let ran=false,error=""; try{r.objects.withWriteLock(()=>{ran=true})}catch(e){error=e.code} process.stdout.write(JSON.stringify({ran,error,lock:existsSync(join(r.controlDirectory,"objects.lock"))}));`;
  const limit = 'import os,resource,signal,sys; signal.signal(signal.SIGXFSZ,signal.SIG_IGN); bound=len(str(os.getpid()))-1; resource.setrlimit(resource.RLIMIT_FSIZE,(bound,bound)); os.execv(sys.argv[1],sys.argv[1:])';
  const child = spawnSync("python3", ["-c", limit, process.execPath, "--input-type=module", "-e", program, repo.root], { env: { ...process.env, NODE_V8_COVERAGE: "", NODE_COMPILE_CACHE: "" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { ran: false, error: "EFBIG", lock: false });
  assert.equal(readdirSync(repo.controlDirectory).some(name => name.startsWith("objects.lock")), false);
});


for (const deniedSide of ["base", "ours", "theirs"] as const) {
  for (const basePresent of deniedSide === "base" ? [true] : [false, true]) {
    test(`denied merge preserves our complete entry with denied ${deniedSide} and base ${basePresent}`, /** Intentional absence is produced by authorized erasure, never by reopening a terminal identity. */ async () => {
      const { repo } = await fixture();
      commit(repo, "p", Buffer.from("terminal selected payload 763952\n"));
      const terminal = repo.readIndex().find(entry => entry.path === "p")!;
      repo.obliterate("p", "erase-fixture", "incident", new Date());
      const denial = readFileSync(join(repo.controlDirectory, "denials.json"));
      const ourId = deniedSide === "ours" ? terminal.id : repo.objects.write("blob", Buffer.from("our surviving bytes\n"), "e".repeat(32));
      const theirId = deniedSide === "theirs" ? terminal.id : repo.objects.write("blob", Buffer.from("their surviving bytes\n"), "b".repeat(32));
      const baseId = !basePresent ? null : deniedSide === "base" ? terminal.id : repo.objects.write("blob", Buffer.from("unrelated live base\n"), "f".repeat(32));
      const context = { store: repo.objects, config: repo.config, committer: signature };
      let resolution: ReturnType<typeof mergePath> | undefined;
      assert.doesNotThrow(() => { resolution = mergePath(context, "p", baseId, ourId, theirId); });
      assert.deepEqual(resolution, { id: ourId, conflict: { path: "p", reason: "content" } });
      const ours = deniedSide === "ours" ? terminal : { id: ourId, mode: "100644" as const, fileId: "e".repeat(32), copiedFrom: "a".repeat(32) };
      const theirs = deniedSide === "theirs" ? terminal : { id: theirId, mode: "100644" as const, fileId: "b".repeat(32), copiedFrom: "d".repeat(32) };
      const tree = (entry: { id: ObjectId; mode: "100644" | "100755"; fileId?: string; copiedFrom?: string }): ObjectId => writeTree(repo.objects, [{ name: "p", ...entry }]);
      const merged = mergeTrees(context, baseId === null ? null : tree({ id: baseId, mode: "100644", fileId: baseId === terminal.id ? terminal.fileId : "f".repeat(32) }), tree(ours), tree(theirs));
      assert.ok(merged.conflicts.some(conflict => conflict.path === "p" && conflict.reason === "content"));
      assert.deepEqual(merged.merged, []);
      const retained = flattenTree(repo.objects, merged.tree).get("p")!;
      assert.equal(retained.id, ours.id); assert.equal(retained.mode, ours.mode); assert.equal(retained.fileId, ours.fileId); assert.equal(retained.copiedFrom, ours.copiedFrom);
      repo.materialize(merged.tree);
      if (deniedSide === "ours") assert.equal(existsSync(join(repo.root, "p")), false);
      else assert.equal(readFileSync(join(repo.root, "p"), "utf8"), "our surviving bytes\n");
      assert.deepEqual(readFileSync(join(repo.controlDirectory, "denials.json")), denial);
      refuses(() => repo.objects.read(terminal.id), "object_obliterated");
    });
  }
}

test("denied merge validates every surviving object before returning a conflict", /** Damage real compressed store bytes and require typed refusal without collateral state changes. */ async () => {
  const { repo } = await fixture(); commit(repo, "p", Buffer.from("denied integrity marker 984372\n"));
  const fragmented = writeFragmented(repo.objects, Buffer.from("surviving fragmented bytes\n".repeat(10)), 32);
  const terminal = repo.readIndex().find(entry => entry.path === "p")!; repo.obliterate("p", "erase-fixture", "incident", new Date());
  const context = { store: repo.objects, config: repo.config, committer: signature };
  const survivor = repo.objects.write("blob", Buffer.from("surviving integrity bytes\n"), "e".repeat(32));
  const original = readFileSync(objectPath(repo, survivor));
  const before = { head: repo.refs.readHead(), refs: repo.refs.list("refs/heads/"), index: repo.readIndex(), denials: readFileSync(join(repo.controlDirectory, "denials.json")) };
  for (const ids of [[terminal.id, survivor, terminal.id], [terminal.id, terminal.id, survivor], [survivor, terminal.id, terminal.id]] as const) {
    writeFileSync(objectPath(repo, survivor), deflateSync(frameObject("blob", Buffer.from("wrong hash bytes\n"))));
    refuses(() => mergePath(context, "p", ids[0], ids[1], ids[2]), "corrupt_object");
    rmSync(objectPath(repo, survivor)); refuses(() => mergePath(context, "p", ids[0], ids[1], ids[2]), "object_not_found");
    writeFileSync(objectPath(repo, survivor), original);
  }
  const structural = readCommit(repo.objects, repo.refs.resolveHead()!).tree;
  refuses(() => mergePath(context, "p", terminal.id, survivor, structural), "object_type_mismatch");
  const fragment = fragmented.manifest.fragments[0].id; const fragmentBytes = readFileSync(objectPath(repo, fragment));
  writeFileSync(objectPath(repo, fragment), deflateSync(frameObject("blob", Buffer.from("corrupt surviving fragment\n"))));
  refuses(() => mergePath(context, "p", terminal.id, survivor, fragmented.manifestId), "corrupt_object");
  writeFileSync(objectPath(repo, fragment), fragmentBytes);
  assert.deepEqual(mergePath(context, "p", terminal.id, fragmented.manifestId, survivor), { id: fragmented.manifestId, conflict: { path: "p", reason: "content" } });
  const target = Repository.init(join(repo.root, "..", "target")); const pin = commit(target, "asset", Buffer.from("linked bytes\n"));
  const link = repo.objects.write("link", encodeLink({ version: 1, repository: target.identity(), revision: pin, mappings: [{ source: "asset", destination: "asset" }] }), "b".repeat(32));
  refuses(() => mergePath(context, "p", terminal.id, survivor, link), "link_merge_conflict");
  assert.deepEqual({ head: repo.refs.readHead(), refs: repo.refs.list("refs/heads/"), index: repo.readIndex(), denials: readFileSync(join(repo.controlDirectory, "denials.json")) }, before);
});

for (const scenario of ["base", "ours", "theirs"] as const) {
  test(`denied merge real branch merge preserves ours with denied ${scenario}`, /** Explicitly replace terminal index identities through the supported API before staging unrelated replacement bytes. */ async () => {
    const { repo } = await fixture();
    if (scenario === "base") commit(repo, "p", Buffer.from("terminal branch base 638925\n"));
    const base = repo.refs.resolveHead()!;
    repo.createBranch("left", base, new Date()); repo.createBranch("right", base, new Date());
    if (scenario !== "base") { repo.switchTo(scenario === "ours" ? "left" : "right", new Date()); commit(repo, "p", Buffer.from("terminal branch side 638925\n")); }
    const terminal = repo.readIndex().find(entry => entry.path === "p")!; repo.obliterate("p", "erase-fixture", "incident", new Date());
    const denials = readFileSync(join(repo.controlDirectory, "denials.json"));
    for (const branch of ["left", "right"]) {
      if (scenario === "ours" && branch === "left" || scenario === "theirs" && branch === "right") continue;
      repo.switchTo(branch, new Date());
      if (scenario === "base") {
        writeFileSync(join(repo.root, "p"), "replacement refused on terminal identity\n");
        refuses(() => repo.stage(["p"]), "file_obliterated"); rmSync(join(repo.root, "p"));
        repo.writeIndex([...repo.readIndex().values()].filter(entry => entry.path !== "p"));
      }
      commit(repo, "p", Buffer.from(`unrelated ${branch} bytes\n`));
      assert.notEqual(repo.readIndex().find(entry => entry.path === "p")!.fileId, terminal.fileId);
    }
    repo.switchTo("left", new Date());
    const ours = repo.readIndex().find(entry => entry.path === "p")!; const refs = repo.refs.list("refs/heads/"); const head = repo.refs.readHead(); const index = repo.readIndex();
    if (scenario === "base") {
      const theirs = flattenTree(repo.objects, readCommit(repo.objects, repo.resolve("right")).tree).get("p")!;
      const original = readFileSync(objectPath(repo, theirs.id));
      writeFileSync(objectPath(repo, theirs.id), deflateSync(frameObject("blob", Buffer.from("corrupt branch survivor\n"))));
      refuses(() => repo.merge("right", { message: "refuse corruption", author: signature }, new Date()), "corrupt_object");
      assert.deepEqual(repo.refs.list("refs/heads/"), refs); assert.deepEqual(repo.refs.readHead(), head); assert.deepEqual(repo.readIndex(), index); assert.equal(repo.readMergeState(), null);
      assert.equal(readFileSync(join(repo.root, "p"), "utf8"), "unrelated left bytes\n");
      writeFileSync(objectPath(repo, theirs.id), original);
    }
    let result: ReturnType<Repository["merge"]> | undefined;
    assert.doesNotThrow(() => { result = repo.merge("right", { message: "intentional absence conflict", author: signature }, new Date()); });
    assert.equal(result?.clean, false); assert.ok(result?.conflicts.some(conflict => conflict.path === "p" && conflict.reason === "content"));
    const retained = repo.readIndex().find(entry => entry.path === "p")!;
    assert.equal(retained.id, ours.id); assert.equal(retained.fileId, ours.fileId); assert.equal(retained.copiedFrom, ours.copiedFrom); assert.equal(retained.mode, ours.mode);
    if (scenario === "ours") assert.equal(existsSync(join(repo.root, "p")), false);
    else assert.equal(readFileSync(join(repo.root, "p"), "utf8"), "unrelated left bytes\n");
    assert.deepEqual(readFileSync(join(repo.controlDirectory, "denials.json")), denials); refuses(() => repo.objects.read(terminal.id), "object_obliterated");
  });
}

for (const kinds of [
  ["manifest", "manifest", "manifest"], ["blob", "manifest", "manifest"],
  [null, "manifest", "blob"], ["manifest", "blob", "blob"],
  ["record", "record", "blob"], ["blob", "record", "record"], [null, "blob", "record"],
] as const) {
  test(`renewed merge preserves file objects across ${kinds.join("/")} conflicts`, /** Real tree merges must never merge manifest metadata or throw for file-kind disagreement. */ async () => {
    const { repo } = await fixture();
    const fileId = "c".repeat(32);
    const ids = kinds.map((kind, i) => kind === null ? null : kind === "manifest"
      ? writeFragmented(repo.objects, Buffer.from(`fragmented side ${i}\n`.repeat(10)), 32).manifestId
      : repo.objects.write(kind, kind === "record" ? encodeRecord({ side: i }) : Buffer.from(`blob side ${i}\n`), fileId));
    const tree = (id: string | null): string | null => id === null ? null : writeTree(repo.objects, [{ name: "file", mode: "100644", id, fileId }]);
    let result: ReturnType<typeof mergeTrees> | undefined;
    assert.doesNotThrow(() => { result = mergeTrees({ store: repo.objects, config: repo.config, committer: signature }, tree(ids[0]), tree(ids[1])!, tree(ids[2])); });
    assert.ok(result);
    assert.deepEqual(result.conflicts, [{ path: "file", reason: "content" }]);
    const entry = flattenTree(repo.objects, result.tree).get("file")!;
    assert.equal(entry.id, ids[1]); assert.equal(entry.fileId, fileId);
    repo.materialize(result.tree);
    const object = repo.objects.read(entry.id);
    if (object.type === "manifest") assert.deepEqual(readFileSync(join(repo.root, "file")), readFragmented(repo.objects, entry.id));
    else if (object.type === "blob") assert.deepEqual(readFileSync(join(repo.root, "file")), object.payload);
    else assert.deepEqual(JSON.parse(readFileSync(join(repo.root, "file"), "utf8")), decodeRecord(object.payload));
  });
}

for (const operation of ["switch", "reset", "undo-ref", "undo-head", "rewrite", "rewrite-detached"] as const) {
  test(`renewed private layer refuses ${operation} before ref HEAD index or oplog mutation`, /** Colliding parent and descendant paths cannot leave HEAD ahead of the checkout. */ async () => {
    const { repo } = await fixture();
    const baseline = repo.refs.resolveHead()!;
    const target = commit(repo, "vendor", Buffer.from("tracked parent file"));
    rmSync(join(repo.root, "vendor")); repo.stage([]);
    let current = repo.commit({ message: "remove parent", author: signature }, new Date(2000));
    if (operation.startsWith("rewrite")) { repo.reset(baseline, "hard", new Date(2500)); current = commit(repo, "safe.txt"); }
    if (operation === "undo-head") { repo.switchTo(target, new Date(3000)); repo.switchTo(current, new Date(4000)); }
    if (operation === "rewrite-detached") repo.switchTo(current, new Date(3000));
    repo.addLayer("private", new Map([["vendor/asset.bin", { content: Buffer.from("private preserved bytes"), executable: false }]]));
    const snapshot = { head: repo.refs.rawHead(), refs: repo.refs.list("refs/"), index: readFileSync(join(repo.controlDirectory, "index")), log: readFileSync(join(repo.controlDirectory, "oplog.jsonl")) };
    const action = operation === "switch" ? () => repo.switchTo(target, new Date(5000))
      : operation === "reset" ? () => repo.reset(target, "hard", new Date(5000))
      : operation.startsWith("undo") ? () => repo.undo(null, new Date(5000))
      : () => repo.rebase(current, target, signature, new Date(5000));
    refuses(action, "layer_checkout_conflict");
    assert.deepEqual({ head: repo.refs.rawHead(), refs: repo.refs.list("refs/"), index: readFileSync(join(repo.controlDirectory, "index")), log: readFileSync(join(repo.controlDirectory, "oplog.jsonl")) }, snapshot);
    assert.equal(readFileSync(join(repo.root, "vendor/asset.bin"), "utf8"), "private preserved bytes");
  });
}

test("renewed retired-instance binding rejects foreign cleanup before denial", /** Reusing a retired path for another repository must not delete its independently owned bytes. */ async () => {
  const { repo, parent } = await fixture();
  commit(repo, "secret.bin", Buffer.from("retired-binding-selected-marker-532794"));
  const retiredRoot = join(parent, "retired"); repo.linkInstance("retired", retiredRoot); repo.unlinkInstance("retired");
  rmSync(retiredRoot, { recursive: true }); mkdirSync(retiredRoot);
  await cloneFrom(repo.root, retiredRoot, new Date());
  const foreign = Repository.open(retiredRoot);
  assert.equal(foreign.identity(), repo.identity());
  const index = readFileSync(join(foreign.controlDirectory, "index"));
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unbound_instance");
  assert.deepEqual(repo.objects.denials(), []);
  assert.deepEqual(readFileSync(join(foreign.controlDirectory, "index")), index);
  assert.equal(readFileSync(join(foreign.root, "secret.bin"), "utf8"), "retired-binding-selected-marker-532794");
});

test("renewed base64 zlib refusal cannot certify an uninspected decoded denial", /** Decode-budget failures are recoverable encoded copies, not malformed-token permission to bypass denial. */ async () => {
  const marker = Buffer.from("base64-zlib-denied-marker-924761");
  const expanded = Buffer.concat([Buffer.alloc(20 * 1024 * 1024, 0), marker]);
  const encoded = Buffer.from(deflateSync(expanded).toString("base64"));
  refuses(() => inspectRepresentations(encoded, bytes => bytes.includes(marker)), "uninspectable_payload");
  assert.equal(inspectRepresentations(encoded, bytes => bytes.includes(marker), 6, expanded.length * 2), true);
  const { repo } = await fixture(); commit(repo, "secret.bin", expanded);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  const before = repo.objects.inventory().map(entry => entry.id).sort();
  refuses(() => repo.objects.write("blob", encoded, "d".repeat(32)), "uninspectable_payload");
  assert.deepEqual(repo.objects.inventory().map(entry => entry.id).sort(), before);
  assert.equal(repo.objects.has(hashObject("blob", encoded)), false);
  refuses(() => inspectRepresentations(Buffer.from(Buffer.from([0x78, 0x9c, 0xff]).toString("base64")), () => false), "uninspectable_payload");
});


test("renewed no-op fetch validates held closure with one bounded process-byte pass", /** Trace a cold real process, including both transport endpoints, over an incompressible repository payload. */ async () => {
  const { repo, parent } = await fixture();
  commit(repo, "large.bin", randomBytes(4 * 1024 * 1024));
  const root = join(parent, "clone"); await cloneFrom(repo.root, root, new Date());
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const sync = pathToFileURL(join(process.cwd(), "engine/sync.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; import { fetchFrom } from ${JSON.stringify(sync)}; const repo=Repository.open(process.argv[1]); const report=await fetchFrom(repo,"origin",new Date()); process.stdout.write(JSON.stringify(report));`;
  const trace = join(parent, "noop.strace");
  const child = spawnSync("strace", ["-f", "-yy", "-e", "trace=openat,read", "-o", trace, process.execPath, "--input-type=module", "-e", program, root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout) as { upToDate: boolean; added: string[] };
  assert.equal(report.upToDate, true); assert.deepEqual(report.added, []);
  const events = readFileSync(trace, "utf8").split("\n");
  const objects = events.filter(line => /\.pmvcs\/objects\/[a-f0-9]{2}\/[a-f0-9]{62}/.test(line));
  assert.equal(objects.some(line => line.includes(repo.controlDirectory)), false, "metadata exchange reread source history");
  const paths = new Map<string, number>();
  for (const line of objects.filter(line => line.includes("openat("))) {
    const path = /"([^" ]+\/objects\/[a-f0-9]{2}\/[a-f0-9]{62})"/.exec(line)?.[1];
    assert.ok(path); paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  assert.ok(paths.size > 0);
  assert.equal([...paths.values()].every(count => count === 1), true, "held closure repeated disk reads");
  const readBytes = objects.filter(line => line.includes("read(")).reduce((total, line) => total + Number(/= ([0-9]+)$/.exec(line)?.[1] ?? 0), 0);
  const clone = Repository.open(root);
  const compressedBytes = clone.objects.inventory().reduce((total, entry) => total + readFileSync(entry.path).length, 0);
  assert.ok(readBytes >= 4 * 1024 * 1024 && readBytes <= compressedBytes, `${readBytes} read bytes exceeds ${compressedBytes} held bytes`);
  assert.ok(events.some(line => line.includes("identity")), "metadata exchange was not exercised");
  console.log(`renewed no-op cold-process trace: ${paths.size} held objects read once, ${readBytes}/${compressedBytes} compressed bytes, 0 source loose opens`);
});

test("renewed links read only bounded unrelated prefixes and preserve link validation", /** Native read-byte evidence accompanies sparse/missing/corrupt unrelated content and strict descriptor failures. */ async () => {
  const { repo, parent } = await fixture();
  commit(repo, "large.bin", randomBytes(4 * 1024 * 1024));
  const large = repo.readIndex().find(entry => entry.path === "large.bin")!;
  const link = repo.stageLink("dependency.link", linkTo(repo, repo.refs.resolveHead()!));
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(Repository.open(process.argv[1]).links()));`;
  const trace = join(parent, "links.strace");
  const child = spawnSync("strace", ["-yy", "-e", "trace=read", "-o", trace, process.execPath, "--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout)[0].id, link);
  const events = readFileSync(trace, "utf8").split("\n").filter(line => line.includes(objectPath(repo, large.id)));
  const bytes = events.reduce((total, line) => total + Number(/= ([0-9]+)$/.exec(line)?.[1] ?? 0), 0);
  assert.ok(bytes > 0 && bytes <= 64, `unrelated payload read ${bytes} compressed bytes`);
  console.log(`renewed link trace: 4 MiB payload, ${bytes} unrelated compressed read bytes`);
  rmSync(objectPath(repo, large.id)); assert.equal(repo.links()[0].id, link);
  writeFileSync(objectPath(repo, large.id), "corrupt unrelated bytes"); assert.equal(repo.links()[0].id, link);
  writeFileSync(objectPath(repo, link), deflateSync(frameObject("link", Buffer.from("corrupt descriptor"))));
  refuses(() => repo.links(), "corrupt_object");
});

test("renewed scan and status read one private layer snapshot per operation", /** strace counts actual metadata opens with many index entries and a full private snapshot. */ async () => {
  const { repo, parent } = await fixture();
  for (let i = 0; i < 12; i++) writeFileSync(join(repo.root, `file-${i}`), `content ${i}`);
  repo.stage([]); repo.commit({ message: "many files", author: signature }, new Date());
  repo.addLayer("private", new Map([["private.bin", { content: Buffer.alloc(256 * 1024, 0), executable: false }]]));
  const path = join(repo.controlDirectory, "layers.json");
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  for (const operation of ["scan", "status"] as const) {
    const program = `import { Repository } from ${JSON.stringify(url)}; const result=Repository.open(process.argv[1]).${operation}(); process.stdout.write(JSON.stringify(result));`;
    const trace = join(parent, `${operation}.strace`);
    const child = spawnSync("strace", ["-e", "trace=openat", "-P", path, "-o", trace, process.execPath, "--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(trace, "utf8").split("\n").filter(line => line.includes("openat(")).length, 1, operation);
  }
});

test("renewed live writer lasting beyond one second completes before a bounded waiter", /** Two real processes contend on the native lease without deadline changes or recovery of a live owner. */ async () => {
  const { repo } = await fixture(); const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const ownerProgram = `import { Repository } from ${JSON.stringify(url)}; Repository.open(process.argv[1]).objects.withWriteLock(()=>{process.stdout.write("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);});`;
  const waiterProgram = `import { Repository } from ${JSON.stringify(url)}; const repo=Repository.open(process.argv[1]); process.stdout.write("ready"); await new Promise(resolve=>process.stdin.once("data",resolve)); const start=performance.now(); repo.objects.withWriteLock(()=>process.stdout.write(String(performance.now()-start)));`;
  const waiter = spawn(process.execPath, ["--input-type=module", "-e", waiterProgram, repo.root], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
  let output = ""; let errors = "";
  waiter.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); }); waiter.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const waiterCompleted = new Promise<number | null>((resolve, reject) => { waiter.on("error", reject); waiter.on("close", resolve); });
  await new Promise<void>((resolve, reject) => { waiter.stdout.once("data", () => resolve()); waiter.once("error", reject); });
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram, repo.root], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const completed = new Promise<number | null>((resolve, reject) => { owner.on("error", reject); owner.on("close", resolve); });
  await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
  refuses(() => repo.objects.recoverWriterLock(), "store_locked"); waiter.stdin.end("go");
  const [waiterCode, ownerCode] = await Promise.all([waiterCompleted, completed]);
  assert.equal(waiterCode, 0, errors); assert.ok(Number(output.slice(5)) >= 1000, output);
  assert.equal(ownerCode, 0); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
});

test("renewed no-op and import refuse real held corruption and missing prerequisites", /** Disk-held bytes never become a trusted publication boundary merely because their address exists. */ async () => {
  const { repo, parent } = await fixture();
  commit(repo, "held.bin", Buffer.from("closure integrity baseline bytes"));
  const root = join(parent, "clone"); await cloneFrom(repo.root, root, new Date());
  const clone = Repository.open(root); const entry = clone.readIndex().find(entry => entry.path === "held.bin")!;
  const held = objectPath(clone, entry.id); const bytes = readFileSync(held);
  const refs = clone.refs.list("refs/"); const log = clone.operations.read();
  const metadata = Buffer.from(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: { "refs/heads/new": clone.refs.resolveHead()! }, prerequisites: [clone.refs.resolveHead()!], objects: [] })}\n`);
  for (const damage of ["missing", "changed"] as const) {
    if (damage === "missing") rmSync(held);
    else writeFileSync(held, deflateSync(frameObject("blob", Buffer.from("valid frame with corrupt content"))));
    await assert.rejects(fetchFrom(clone, "origin", new Date()), error => error instanceof ObjectStoreError && error.code === "incomplete_bundle");
    refuses(() => importBundle(clone.objects, clone.refs, metadata), "incomplete_bundle");
    assert.deepEqual(clone.refs.list("refs/"), refs); assert.deepEqual(clone.operations.read(), log);
    writeFileSync(held, bytes);
  }
  const prerequisite = clone.refs.resolveHead()!; const path = objectPath(clone, prerequisite); const commitBytes = readFileSync(path); rmSync(path);
  refuses(() => importBundle(clone.objects, clone.refs, metadata), "missing_prerequisites");
  writeFileSync(path, commitBytes);
  assert.deepEqual(clone.refs.list("refs/"), refs); assert.deepEqual(clone.operations.read(), log);
  assert.equal((await fetchFrom(clone, "origin", new Date())).upToDate, true);
});

test("renewed import closes shared payloads and standalone series once before ref publication", /** Native read-byte accounting proves deduplication while retaining every owner and structural role check. */ async () => {
  const { repo, parent } = await fixture();
  const payload = randomBytes(256 * 1024); const id = repo.objects.write("blob", payload);
  const tree = writeTree(repo.objects, [{ name: "one", mode: "100644", id, fileId: "1".repeat(32) }, { name: "two", mode: "100644", id, fileId: "2".repeat(32) }]);
  const target = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "shared leaf", items: [] });
  const series = encodeSeries({ base: target, patches: [{ commit: target }], description: "one", author: signature });
  const seriesId = hashObject("series", series);
  const archive = Buffer.from(`${BUNDLE_FORMAT}\n${JSON.stringify({ refs: { "refs/heads/imported": target }, prerequisites: [target], objects: [seriesId] })}\nseries ${seriesId} ${series.toString("base64")}\n`);
  const bundlePath = join(parent, "import.bundle"); writeFileSync(bundlePath, archive);
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href; const bundle = pathToFileURL(join(process.cwd(), "engine/bundle.ts")).href;
  const program = `import { readFileSync } from "node:fs"; import { Repository } from ${JSON.stringify(url)}; import { importBundle } from ${JSON.stringify(bundle)}; const r=Repository.open(process.argv[1]); process.stdout.write(JSON.stringify(importBundle(r.objects,r.refs,readFileSync(process.argv[2]))));`;
  const trace = join(parent, "import.strace");
  const child = spawnSync("strace", ["-yy", "-e", "trace=openat,read", "-P", objectPath(repo, id), "-o", trace, process.execPath, "--input-type=module", "-e", program, repo.root, bundlePath], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).added, [seriesId]); assert.equal(repo.refs.read("refs/heads/imported"), target);
  const events = readFileSync(trace, "utf8").split("\n");
  assert.equal(events.filter(line => line.includes("openat(")).length, 1);
  const bytes = events.filter(line => line.includes("read(")).reduce((total, line) => total + Number(/= ([0-9]+)$/.exec(line)?.[1] ?? 0), 0);
  assert.equal(bytes, readFileSync(objectPath(repo, id)).length);
  console.log(`renewed shared import trace: 2 FileIds, series base/patch and ref, 1 payload open, ${bytes} compressed bytes`);
});

test("renewed retired pruning requires authority audits and never relinquishes a bound instance", /** Explicit scope reduction preserves active/retired bytes and lets missing or reused paths be retired without foreign cleanup. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from("prune-selected-marker-528164"));
  const root = join(parent, "retired"); repo.linkInstance("retired", root); repo.unlinkInstance("retired");
  const path = "../retired"; const inventory = join(repo.controlDirectory, "unlinked-instances.json"); const before = readFileSync(inventory);
  refuses(() => repo.pruneRetiredInstance(path, "wrong", "retired", new Date()), "unauthorized");
  refuses(() => repo.pruneRetiredInstance(path, "erase-fixture", "invalid reason", new Date()), "bad_prune_reason");
  refuses(() => repo.pruneRetiredInstance("../unknown", "erase-fixture", "retired", new Date()), "unknown_retired_instance");
  refuses(() => repo.pruneRetiredInstance(path, "erase-fixture", "retired", new Date()), "instance_still_bound");
  assert.deepEqual(readFileSync(inventory), before);
  rmSync(root, { recursive: true });
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unbound_instance");
  writeFileSync(join(repo.controlDirectory, "oplog.jsonl.lock"), "occupied");
  refuses(() => repo.pruneRetiredInstance(path, "erase-fixture", "retired", new Date()), "oplog_locked");
  assert.deepEqual(readFileSync(inventory), before); rmSync(join(repo.controlDirectory, "oplog.jsonl.lock"));
  repo.pruneRetiredInstance(path, "erase-fixture", "retired", new Date());
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  const audit = repo.operations.read().at(-1)!; assert.equal(audit.command, "prune-retired-instance"); assert.match(audit.summary, /missing.*reason retired/);
  repo.linkInstance("reused", root); repo.unlinkInstance("reused"); rmSync(root, { recursive: true }); mkdirSync(root);
  await cloneFrom(repo.root, root, new Date()); const foreign = Repository.open(root);
  repo.pruneRetiredInstance(path, "erase-fixture", "reused", new Date());
  assert.match(repo.operations.read().at(-1)!.summary, /unbound.*reason reused/);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(readFileSync(join(foreign.root, "secret.bin"), "utf8"), "prune-selected-marker-528164");
  assert.equal(existsSync(join(repo.root, "secret.bin")), false);
});

test("renewed listing skips unrelated sparse and malformed prefixes while preserving operational errors", /** A partial type hint cannot excuse corrupt matching descriptors or become verification evidence. */ async () => {
  const { repo } = await fixture(); const id = repo.objects.write("blob", Buffer.from("ordinary bytes"));
  const path = objectPath(repo, id);
  for (const content of [Buffer.alloc(0), Buffer.from("garbage"), deflateSync(Buffer.from("invalid header")), deflateSync(Buffer.from("link x\0bad")), deflateSync(frameObject("record", encodeRecord({ value: 1 })))]) {
    writeFileSync(path, content); assert.equal(repo.objects.readIfType(id, "link"), undefined);
  }
  rmSync(path); assert.equal(repo.objects.readIfType(id, "link"), undefined);
  mkdirSync(path); assert.throws(() => repo.objects.readIfType(id, "link"), error => (error as NodeJS.ErrnoException).code === "EISDIR"); rmSync(path, { recursive: true });
  repo.objects.write("blob", Buffer.from("erased-descriptor-list-marker-487293"));
  const erased = commit(repo, "secret.bin", Buffer.from("erased-descriptor-list-marker-487293"));
  const selected = repo.readIndex().find(entry => entry.path === "secret.bin")!;
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.objects.readIfType(selected.id, "link"), undefined); assert.deepEqual(repo.links(), []);
  assert.deepEqual(repo.verify().missing, []); assert.equal(repo.readFileState(erased, "secret.bin").kind, "obliterated");
});

test("renewed CLI reports missing arguments and audited retired prune explicitly", /** Real installed SDK command contexts exercise public argument grammar and authority boundaries. */ async () => {
  const { repo, parent } = await fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const link = await harness.runCommand({ command: "vcs link", pmRoot: repo.root });
  assert.match(String(link.errorMessage), /requires a descriptor path/); assert.doesNotMatch(String(link.errorMessage), /requires a a/);
  const layer = await harness.runCommand({ command: "vcs layer", pmRoot: repo.root }); assert.match(String(layer.errorMessage), /requires a layer name/);
  const prune = await harness.runCommand({ command: "vcs instance prune-retired", args: ["../retired"], pmRoot: repo.root }); assert.match(String(prune.errorMessage), /reason/);
  const noCredential = await harness.runCommand({ command: "vcs instance prune-retired", args: ["../retired"], options: { reason: "retired" }, pmRoot: repo.root }); assert.match(String(noCredential.errorMessage), /erase-token-file/);
  repo.linkInstance("retired", join(parent, "retired")); repo.unlinkInstance("retired"); rmSync(join(parent, "retired"), { recursive: true });
  writeFileSync(join(repo.root, "erase-token"), "erase-fixture\n");
  const result = await harness.runCommand({ command: "vcs instance prune-retired", args: ["../retired"], options: { reason: "retired", eraseTokenFile: "erase-token" }, pmRoot: repo.root });
  assert.equal(result.errorMessage, undefined); assert.deepEqual(result.result, { ok: true, pruned: "../retired" });
});

test("renewed repeated valid arrivals refuse corrupt held duplicates before publication", /** A hash-valid carried object must not certify different bytes already stored under the same address. */ async () => {
  const { repo, parent } = await fixture();
  const target = commit(repo, "held.txt", Buffer.from("healthy carried bytes"));
  const archive = exportBundle(repo.objects, repo.refs, []);
  const root = join(parent, "clone"); await cloneFrom(repo.root, root, new Date()); const clone = Repository.open(root);
  const id = clone.readIndex().find(entry => entry.path === "held.txt")!.id;
  writeFileSync(objectPath(clone, id), deflateSync(frameObject("blob", Buffer.from("bad held duplicate"))));
  const refs = clone.refs.list("refs/"); const inventory = readdirSync(join(clone.controlDirectory, "objects"), { recursive: true }).sort();
  refuses(() => importBundle(clone.objects, clone.refs, archive), "corrupt_object");
  assert.deepEqual(clone.refs.list("refs/"), refs); assert.deepEqual(readdirSync(join(clone.controlDirectory, "objects"), { recursive: true }).sort(), inventory);
  assert.equal(clone.refs.resolveHead(), target);
});

test("renewed retired inventory refuses malformed paths and classifies broken bindings without foreign reads", /** Real control-file faults distinguish an explicit scope decision from suppressed operational I/O. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "secret.bin", Buffer.from("retired-validation-selected-marker-528913"));
  const inventory = join(repo.controlDirectory, "unlinked-instances.json");
  for (const content of [null, [1], [""], ["."], [join(parent, "absolute")], ["../retired/../other"], ["..\\retired"]]) {
    writeFileSync(inventory, JSON.stringify(content));
    refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "bad_instances");
    assert.deepEqual(repo.objects.denials(), []);
  }
  writeFileSync(inventory, "[]");
  const root = join(parent, "retired"); repo.linkInstance("retired", root); repo.unlinkInstance("retired");
  const link = join(root, ".pmvcs", "link.json"); writeFileSync(link, "invalid JSON");
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unbound_instance");
  repo.pruneRetiredInstance("../retired", "erase-fixture", "invalid_binding", new Date());
  assert.equal(readFileSync(join(root, "secret.bin"), "utf8"), "retired-validation-selected-marker-528913");
  rmSync(root, { recursive: true });
  const foreignHub = Repository.init(join(parent, "foreign-hub"));
  commit(foreignHub, "foreign.txt", Buffer.from("foreign linked instance sentinel"));
  foreignHub.linkInstance("foreign", root);
  const config = join(foreignHub.controlDirectory, "config.json"); const configBytes = readFileSync(config); rmSync(config); mkdirSync(config);
  writeFileSync(inventory, JSON.stringify(["../retired"]));
  refuses(() => repo.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unbound_instance");
  repo.pruneRetiredInstance("../retired", "erase-fixture", "foreign_hub", new Date());
  assert.equal(readFileSync(join(root, "foreign.txt"), "utf8"), "foreign linked instance sentinel");
  rmSync(config, { recursive: true }); writeFileSync(config, configBytes);
  writeFileSync(inventory, JSON.stringify(["../retired"])); rmSync(link); mkdirSync(link);
  assert.throws(() => repo.pruneRetiredInstance("../retired", "erase-fixture", "retired", new Date()), error => (error as NodeJS.ErrnoException).code === "EISDIR");
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), ["../retired"]);
});

test("renewed type listing preserves native open errors and rejects invalid addresses", /** A failed open is operational evidence rather than an unrelated corrupt-prefix classification. */ async () => {
  const { repo } = await fixture(); const id = repo.objects.write("blob", Buffer.from("real permission-bound object"));
  const path = objectPath(repo, id); chmodSync(path, 0);
  try { assert.throws(() => repo.objects.readIfType(id, "link"), error => (error as NodeJS.ErrnoException).code === "EACCES"); }
  finally { chmodSync(path, 0o644); }
  refuses(() => repo.objects.readIfType("invalid", "link"), "invalid_object_id");
});

for (const linked of [false, true]) test(`renewal erasure recovery authorizes before changing a real dead writer lock (${linked ? "shared" : "hub"})`, /** A wrong erase grant must preserve the crashed owner's lock and every payload byte. */ async () => {
  const { repo: hub, parent } = await fixture();
  commit(hub, "selected.bin", Buffer.from("recovery authorization selected marker"));
  if (linked) hub.linkInstance("recovery", join(parent, "recovery"));
  const repo = linked ? Repository.open(join(parent, "recovery")) : hub;
  const url = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `import { Repository } from ${JSON.stringify(url)}; Repository.open(process.argv[1]).objects.withWriteLock(()=>process.kill(process.pid,"SIGKILL"));`, repo.root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(crash.signal, "SIGKILL");
  const lock = join(hub.controlDirectory, "objects.lock"); const owner = readFileSync(lock);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  writeFileSync(join(repo.root, "erase-token"), "wrong-erase-grant");
  const denied = await harness.runCommand({ command: "vcs obliterate", args: ["selected.bin"], options: { recoverLock: true, eraseTokenFile: "erase-token", reason: "incident" }, pmRoot: repo.root });
  assert.match(String(denied.errorMessage), /authority|credential|Unauthorized/i);
  assert.equal(existsSync(lock), true, "unauthorized erasure recovered the dead writer");
  assert.deepEqual(readFileSync(lock), owner); assert.deepEqual(repo.objects.denials(), []);
  assert.equal(readFileSync(join(repo.root, "selected.bin"), "utf8"), "recovery authorization selected marker");
  writeFileSync(join(repo.root, "erase-token"), "erase-fixture");
  const erased = await harness.runCommand({ command: "vcs obliterate", args: ["selected.bin"], options: { recoverLock: true, eraseTokenFile: "erase-token", reason: "incident" }, pmRoot: repo.root });
  assert.equal(erased.errorMessage, undefined); assert.equal(existsSync(lock), false);
  assert.equal(repo.objects.denials().length, 1); assert.equal(existsSync(join(repo.root, "selected.bin")), false);
});

test("renewal export discovers manifests with bounded prefixes and hashes all serialized bytes", /** Native byte counts and damaged real leaves distinguish discovery hints from serialization integrity. */ async () => {
  const { repo, parent } = await fixture(); commit(repo, "export.bin", randomBytes(4 * 1024 * 1024));
  const id = repo.readIndex().find(entry => entry.path === "export.bin")!.id; const path = objectPath(repo, id);
  const compressed = readFileSync(path);
  const repoUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const bundleUrl = pathToFileURL(join(process.cwd(), "engine/bundle.ts")).href;
  const trace = join(parent, "export.strace");
  const program = `import { Repository } from ${JSON.stringify(repoUrl)}; import { exportBundle,parseBundle } from ${JSON.stringify(bundleUrl)}; const r=Repository.open(process.argv[1]); const bundle=exportBundle(r.objects,r.refs,[]); process.stdout.write(JSON.stringify(parseBundle(bundle).header.objects));`;
  const exported = spawnSync("strace", ["-yy", "-e", "trace=read", "-P", path, "-o", trace, process.execPath, "--input-type=module", "-e", program, repo.root], { encoding: "utf8", timeout: 10_000 });
  assert.equal(exported.status, 0, exported.stderr); assert.ok((JSON.parse(exported.stdout) as string[]).includes(id));
  const bytes = readFileSync(trace, "utf8").split("\n").filter(line => line.includes("read(")).reduce((sum, line) => sum + Number(/= ([0-9]+)$/.exec(line)?.[1] ?? 0), 0);
  assert.equal(bytes, compressed.length + 64, "export fully read the payload again during discovery");
  console.log(`renewal export: ${bytes} compressed bytes = ${compressed.length} serialized hash pass + 64 discovery bytes`);
  writeFileSync(path, deflateSync(frameObject("blob", Buffer.from("different valid framed content"))));
  refuses(() => exportBundle(repo.objects, repo.refs, []), "corrupt_object");
  rmSync(path); refuses(() => exportBundle(repo.objects, repo.refs, []), "object_not_found"); writeFileSync(path, compressed);
  const fragmented = writeFragmented(repo.objects, Buffer.from("export manifest integrity fixture"), 8);
  repo.writeIndex(repo.readIndex().map(entry => entry.id === id ? { ...entry, id: fragmented.manifestId } : entry));
  repo.commit({ message: "manifest", author: signature }, new Date(2000));
  const manifestPath = objectPath(repo, fragmented.manifestId); const manifestBytes = readFileSync(manifestPath);
  writeFileSync(manifestPath, deflateSync(frameObject("manifest", encodeManifest({ ...fragmented.manifest, mode: "cdc" }))));
  refuses(() => exportBundle(repo.objects, repo.refs, []), "corrupt_object");
  writeFileSync(manifestPath, deflateSync(frameObject("manifest", Buffer.from("invalid manifest"))));
  refuses(() => exportBundle(repo.objects, repo.refs, []), "corrupt_object");
  rmSync(manifestPath); refuses(() => exportBundle(repo.objects, repo.refs, []), "object_not_found"); writeFileSync(manifestPath, manifestBytes);
  assert.ok(parseBundle(exportBundle(repo.objects, repo.refs, [])).header.objects.includes(fragmented.manifest.fragments[0].id));
});

test("renewal closure discards leaf bytes with native memory and one physical hash pass", /** Compare real cold process memory to the measured reachable bytes, and trace every physical object read. */ async () => {
  const { repo, parent } = await fixture();
  const entries: TreeEntry[] = [];
  let payloadBytes = 0; const compressed = new Map<string, number>();
  for (let index = 0; index < 64; index += 1) {
    const payload = randomBytes(2 * 1024 * 1024); payloadBytes += payload.length;
    const id = repo.objects.write(index % 2 === 0 ? "blob" : "record", payload);
    entries.push({ mode: "100644" as const, name: `leaf-${index}`, id, fileId: index.toString(16).padStart(32, "0") });
    compressed.set(objectPath(repo, id), readFileSync(objectPath(repo, id)).length);
  }
  const fragmented = writeFragmented(repo.objects, randomBytes(2 * 1024 * 1024), 512 * 1024);
  entries.push({ mode: "100644", name: "fragments", id: fragmented.manifestId, fileId: "e".repeat(32) });
  const link = repo.objects.write("link", encodeLink({ version: 1, repository: repo.identity(), revision: repo.refs.resolveHead()!, mappings: [{ source: "leaf-0", destination: "pin" }] }));
  entries.push({ mode: "100644", name: "link", id: link, fileId: "f".repeat(32) });
  entries.push({ ...entries[0], name: "shared-leaf", fileId: "a".repeat(32) },
    { mode: "100644", name: "shared-manifest", id: fragmented.manifestId, fileId: "b".repeat(32) },
    { mode: "100644", name: "shared-link", id: link, fileId: "c".repeat(32) });
  const tree = writeTree(repo.objects, entries);
  const target = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "native bounded closure" });
  for (const id of [fragmented.manifestId, ...fragmented.manifest.fragments.map(fragment => fragment.id), link, tree, target]) compressed.set(objectPath(repo, id), readFileSync(objectPath(repo, id)).length);
  const repoUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const closureUrl = pathToFileURL(join(process.cwd(), "engine/closure.ts")).href;
  const trace = join(parent, "memory.strace");
  const program = `import { Repository } from ${JSON.stringify(repoUrl)}; import { inspectClosure } from ${JSON.stringify(closureUrl)}; const r=Repository.open(process.argv[1]); global.gc(); const before=process.memoryUsage(); const peakBefore=process.resourceUsage().maxRSS*1024; const report=r.objects.withWriteLock(()=>inspectClosure(r.objects,[process.argv[2],process.argv[2]])); const after=process.memoryUsage(); process.stdout.write(JSON.stringify({report,before,after,peakBefore,peakAfter:process.resourceUsage().maxRSS*1024}));`;
  const child = spawnSync("strace", ["-yy", "-e", "trace=openat,read", "-o", trace, process.execPath, "--expose-gc", "--max-old-space-size=32", "--input-type=module", "-e", program, repo.root, target], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as { report: ReturnType<typeof inspectClosure>; before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage; peakBefore: number; peakAfter: number };
  assert.deepEqual(result.report.missing, []); assert.deepEqual(result.report.corrupt, []);
  const events = readFileSync(trace, "utf8").split("\n");
  for (const [path, size] of compressed) {
    assert.equal(events.filter(line => line.includes("openat(") && line.includes(`"${path}"`)).length, 1);
    assert.equal(events.filter(line => line.includes("read(") && line.includes(`<${path}>`)).reduce((sum, line) => sum + Number(/= ([0-9]+)$/.exec(line)?.[1] ?? 0), 0), size);
  }
  const retained = result.after.arrayBuffers - result.before.arrayBuffers; const peakGrowth = result.peakAfter - result.peakBefore;
  const compressedBytes = [...compressed.values()].reduce((sum, bytes) => sum + bytes, 0);
  console.log(`renewal closure: ${payloadBytes} leaf payload bytes, ${compressed.size} reachable objects read once, ${compressedBytes} compressed bytes, ${retained} buffer growth, ${peakGrowth} native peak RSS growth`);
  assert.ok(retained < payloadBytes, `closure retained all ${payloadBytes} payload bytes (${retained} buffer growth)`);
  assert.ok(peakGrowth < payloadBytes, `closure native peak grew by repository payload size (${peakGrowth}/${payloadBytes})`);
  for (const [name, type, payload] of [["link", "link", Buffer.from("{}")], ["fragments", "manifest", Buffer.from("malformed\n")]] as const) {
    const invalid = repo.objects.write(type, payload);
    const badTree = writeTree(repo.objects, entries.map(entry => entry.name === name ? { ...entry, id: invalid } : entry));
    const badCommit = writeCommit(repo.objects, { tree: badTree, parents: [], author: signature, committer: signature, message: "hash-valid malformed structure" });
    assert.equal(inspectClosure(repo.objects, [badCommit]).corrupt.length, 1);
  }
  assert.deepEqual(inspectClosure(repo.objects, [target]).corrupt, []);
});

test("renewal closure caches malformed shared leaves without repeating physical reads", /** Hash-valid malformed structures still fail for each owner while sharing one failed physical validation. */ async () => {
  const { repo, parent } = await fixture();
  const repoUrl = pathToFileURL(join(process.cwd(), "engine/repo.ts")).href;
  const closureUrl = pathToFileURL(join(process.cwd(), "engine/closure.ts")).href;
  const program = `import { Repository } from ${JSON.stringify(repoUrl)}; import { inspectClosure } from ${JSON.stringify(closureUrl)}; const r=Repository.open(process.argv[1]); process.stdout.write(JSON.stringify(r.objects.withWriteLock(()=>inspectClosure(r.objects,[process.argv[2]]))));`;
  for (const type of ["link", "manifest"] as const) {
    const id = repo.objects.write(type, Buffer.from(type === "link" ? "{}" : "malformed\n"));
    const tree = writeTree(repo.objects, ["a", "b"].map(name => ({ name, mode: "100644", id, fileId: name.repeat(32) })));
    const target = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "shared malformed structure" });
    const trace = join(parent, `${type}.strace`);
    const child = spawnSync("strace", ["-e", "trace=openat", "-P", objectPath(repo, id), "-o", trace, process.execPath, "--input-type=module", "-e", program, repo.root, target], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout) as ReturnType<typeof inspectClosure>;
    assert.equal(report.corrupt.length, 2); assert.deepEqual(report.missing, []);
    assert.ok(report.corrupt.every(error => error.endsWith(type === "link" ? "bad_link" : "malformed_object")));
    assert.equal(readFileSync(trace, "utf8").split("\n").filter(line => line.includes("openat(")).length, 1, "shared malformed structure was physically read twice");
  }
});

test("renewal uploads hash the entire batch before denial decoding or publication", /** Real malformed tree/manifest claims and a late corrupt upload cannot publish an earlier valid object. */ async () => {
  const { repo } = await fixture(); commit(repo, "selected.bin", Buffer.from("upload ordering erased marker"));
  repo.obliterate("selected.bin", "erase-fixture", "incident", new Date());
  const transport = new FileTransport(repo.root, repo.root);
  const inventory = readdirSync(join(repo.controlDirectory, "objects"), { recursive: true }).sort();
  const denialBytes = readFileSync(join(repo.controlDirectory, "denials.json")); const refs = repo.refs.list("refs/");
  for (const type of ["tree", "manifest"] as const) {
    const validPayload = type === "tree" ? encodeTree([]) : encodeManifest({ mode: "fixed", totalLength: 0, fragments: [] });
    const id = hashObject(type, validPayload);
    await assert.rejects(() => transport.uploadObjects([{ id, type, payload: Buffer.from("malformed tree or manifest\n") }]), (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object");
    assert.deepEqual(readdirSync(join(repo.controlDirectory, "objects"), { recursive: true }).sort(), inventory);
    assert.deepEqual(readFileSync(join(repo.controlDirectory, "denials.json")), denialBytes); assert.deepEqual(repo.refs.list("refs/"), refs);
  }
  const payload = Buffer.from("fresh valid upload before corrupted claim");
  const healthy = { type: "tombstone" as const, id: hashObject("tombstone", payload), payload };
  const late = { type: "tree" as const, id: hashObject("tree", encodeTree([])), payload: Buffer.from("malformed late tree\n") };
  await assert.rejects(() => transport.uploadObjects([healthy, late]), (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object");
  assert.equal(repo.objects.has(healthy.id), false);
  writeFileSync(join(repo.controlDirectory, "denials.json"), "null");
  await assert.rejects(() => transport.uploadObjects([healthy, late]), (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object");
  assert.equal(repo.objects.has(healthy.id), false);
  await assert.rejects(() => transport.uploadObjects([healthy]), (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_tombstone");
  writeFileSync(join(repo.controlDirectory, "denials.json"), denialBytes);
  const clean = Repository.init(join(repo.root, "clean-upload"));
  const cleanTransport = new FileTransport(clean.root, clean.root);
  await assert.rejects(() => cleanTransport.uploadObjects([healthy, late]), (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_object");
  assert.equal(clean.objects.has(healthy.id), false, "an earlier upload was written before the full batch was hashed");
  await cleanTransport.uploadObjects([healthy]); assert.deepEqual(clean.objects.read(healthy.id).payload, payload);
});

test("grant repair ordinary directory names support layers links and unrelated erasure", /** Use real paths that staging already accepts, preserving unrelated bytes. */ async () => {
  const { repo } = await fixture();
  assert.deepEqual(Repository.open(repo.root, "").ignoreRules(), repo.ignoreRules());
  const ordinary = ["search/index.ts", "src/runtime/index.ts", "locks/client.ts", "transactions/model.ts", "checkpoints/data.txt", "src/search/a.txt"];
  for (const [index, path] of ordinary.entries()) commit(repo, path, Buffer.from(`ordinary source ${index}\n`));
  const pin = repo.refs.resolveHead()!;
  const paths = ordinary.map(path => `vendor/${path}`);
  for (const path of paths) assert.doesNotThrow(() => assertCompositionPath(path));
  repo.addLayer("ordinary", new Map(paths.map(path => [path, { content: Buffer.from("private ordinary overlay"), executable: false }])));
  for (const path of paths) assert.equal(readFileSync(join(repo.root, path), "utf8"), "private ordinary overlay");
  repo.removeLayer("ordinary");
  repo.stageLink("search/dependency.link", { version: 1, repository: repo.identity(), revision: pin, mappings: ordinary.map((source, index) => ({ source, destination: paths[index] })) });
  repo.resolveLink("search/dependency.link", repo, "read-fixture", "resolved-ordinary");
  for (const [index, path] of paths.entries()) assert.equal(readFileSync(join(repo.root, path), "utf8"), `ordinary source ${index}\n`);
  repo.removeLayer("resolved-ordinary");
  const selected = Buffer.from("ordinary-path-erasure-selected-marker-682943");
  const revision = commit(repo, "secret.bin", selected);
  repo.obliterate("secret.bin", "erase-fixture", "incident", new Date());
  assert.equal(repo.readFileState(revision, "secret.bin").kind, "obliterated");
  assert.equal(scanBytes(repo.controlDirectory, selected), 0);
  for (const [index, path] of ordinary.entries()) assert.equal(readFileSync(join(repo.root, path), "utf8"), `ordinary source ${index}\n`);
  assert.deepEqual(repo.verify().corrupt, []);
});

test("grant repair v2 rotation requires the current erase grant across shared instances", /** Neither a proposed token, read access nor legacy regeneration can replace a current grant. */ async () => {
  const { repo, parent } = await fixture();
  const marker = Buffer.from("rotation-protected-selected-marker-394682"); commit(repo, "secret.bin", marker);
  repo.linkInstance("shared", join(parent, "shared")); const instance = Repository.open(join(parent, "shared"));
  const path = join(repo.controlDirectory, "authority.json"); const before = readFileSync(path);
  for (const authorization of [undefined, { currentEraseCredential: "" }, { currentEraseCredential: "wrong" }, { currentEraseCredential: "read-fixture" }, { currentEraseCredential: "new-erase" }, { regenerateLegacy: true as const }]) {
    refuses(() => instance.setAuthority("replacement", "new-read", "new-erase", authorization), "unauthorized");
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(join(instance.controlDirectory, "authority.json")), false);
    assert.deepEqual(readFileSync(join(repo.root, "secret.bin")), marker);
    assert.deepEqual(readFileSync(join(instance.root, "secret.bin")), marker);
    assert.deepEqual(repo.objects.denials(), []);
  }
  instance.setAuthority("replacement", "new-read", "new-erase", { currentEraseCredential: "erase-fixture" });
  assert.equal(authorize(repo.controlDirectory, "read", "new-read"), "replacement");
  for (const old of ["erase-fixture", "read-fixture"]) refuses(() => repo.obliterate("secret.bin", old, "incident", new Date()), "unauthorized");
  repo.obliterate("secret.bin", "new-erase", "incident", new Date());
  assert.equal(existsSync(join(repo.root, "secret.bin")), false); assert.equal(existsSync(join(instance.root, "secret.bin")), false);
  assert.equal(repo.objects.denials()[0].tombstone.principal, "replacement");
});

test("grant repair distinguishes absent legacy invalid and unreadable authority files", /** Recognize only the historical unversioned SHA-256 shape and preserve every refused file. */ async () => {
  const { repo, parent } = await fixture(); const path = join(repo.controlDirectory, "authority.json");
  const original = JSON.parse(readFileSync(path, "utf8")) as { version: number; principal: string; salt: string; read: string; erase: string };
  const legacy = { principal: "fixture", salt: original.salt, read: createHash("sha256").update(`${original.salt}\0read-fixture`).digest("hex"), erase: createHash("sha256").update(`${original.salt}\0erase-fixture`).digest("hex") };
  for (const value of [null, [], {}, false, { ...original, version: 1 }, { ...original, version: 3 }, { ...original, read: "bad" }, { ...original, read: 1 }, { ...original, extra: "unknown" }, { ...original, erase: null }, { ...legacy, salt: "bad" }, { ...legacy, extra: "unknown" }]) {
    writePrivateJson(path, value); const bytes = readFileSync(path);
    for (const authorization of [undefined, { regenerateLegacy: true as const }, { currentEraseCredential: "erase-fixture" }]) {
      refuses(() => repo.setAuthority("fixture", "new-read", "new-erase", authorization), "bad_authority");
      assert.deepEqual(readFileSync(path), bytes);
    }
  }
  writeFileSync(path, "{corrupt"); refuses(() => repo.setAuthority("fixture", "new-read", "new-erase", { regenerateLegacy: true }), "bad_authority"); assert.equal(readFileSync(path, "utf8"), "{corrupt");
  chmodSync(path, 0o000);
  try { assert.throws(() => repo.setAuthority("fixture", "new-read", "new-erase"), { code: "EACCES" }); } finally { chmodSync(path, 0o600); }
  rmSync(path); mkdirSync(path); assert.throws(() => repo.setAuthority("fixture", "new-read", "new-erase"), { code: "EISDIR" }); rmSync(path, { recursive: true });
  symlinkSync(join(parent, "absent-grant"), path); refuses(() => repo.setAuthority("fixture", "new-read", "new-erase"), "bad_authority"); rmSync(path);
  refuses(() => repo.setAuthority("fixture", "new-read", "new-erase", { regenerateLegacy: true }), "unauthorized"); assert.equal(existsSync(path), false);
  configureAuthority(repo.controlDirectory, "initial", "initial-read", "initial-erase"); assert.equal(authorize(repo.controlDirectory, "erase", "initial-erase"), "initial");
  rmSync(path); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); assert.equal(authorize(repo.controlDirectory, "erase", "erase-fixture"), "fixture");
  writePrivateJson(path, legacy); const legacyBytes = readFileSync(path);
  for (const authorization of [undefined, { currentEraseCredential: "erase-fixture" }]) {
    refuses(() => repo.setAuthority("fixture", "new-read", "new-erase", authorization), "unauthorized"); assert.deepEqual(readFileSync(path), legacyBytes);
  }
  repo.setAuthority("regenerated", "new-read", "new-erase", { regenerateLegacy: true });
  assert.equal(authorize(repo.controlDirectory, "erase", "new-erase"), "regenerated");
  refuses(() => repo.setAuthority("fixture", "other-read", "other-erase", { regenerateLegacy: true }), "unauthorized");
});

test("grant repair CLI keeps current credentials separate from new tokens and legacy migration", /** Execute registered commands with real token files and unchanged grant bytes on refusal. */ async () => {
  const { repo, parent } = await fixture(); const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const readToken = join(parent, "new-read-token"); const eraseToken = join(parent, "new-erase-token"); const currentToken = join(parent, "current-token");
  writeFileSync(readToken, "new-read"); writeFileSync(eraseToken, "new-erase"); writeFileSync(currentToken, "erase-fixture");
  const options = { principal: "replacement", readTokenFile: readToken, eraseTokenFile: eraseToken };
  const path = join(repo.controlDirectory, "authority.json"); const before = readFileSync(path);
  for (const extra of [{}, { regenerateLegacy: true }, { currentEraseTokenFile: eraseToken }, { currentEraseTokenFile: readToken }, { currentEraseTokenFile: currentToken, regenerateLegacy: true }]) {
    const result = await harness.runCommand({ command: "vcs authority", pmRoot: join(repo.root, ".agents/pm"), options: { ...options, ...extra } });
    assert.ok(result.errorMessage); assert.deepEqual(readFileSync(path), before);
  }
  const rotated = await harness.runCommand({ command: "vcs authority", pmRoot: join(repo.root, ".agents/pm"), options: { ...options, currentEraseTokenFile: currentToken } });
  assert.equal(rotated.errorMessage, undefined); assert.equal(authorize(repo.controlDirectory, "erase", "new-erase"), "replacement");
  assert.equal(JSON.stringify(rotated.result).includes("new-erase"), false);
  const authority = JSON.parse(readFileSync(path, "utf8")) as { salt: string };
  writePrivateJson(path, { principal: "fixture", salt: authority.salt, read: createHash("sha256").update(`${authority.salt}\0read-fixture`).digest("hex"), erase: createHash("sha256").update(`${authority.salt}\0erase-fixture`).digest("hex") });
  const regenerated = await harness.runCommand({ command: "vcs authority", pmRoot: join(repo.root, ".agents/pm"), options: { ...options, regenerateLegacy: true } });
  assert.equal(regenerated.errorMessage, undefined); assert.equal(authorize(repo.controlDirectory, "read", "new-read"), "replacement");
  rmSync(path);
  const initial = await harness.runCommand({ command: "vcs authority", pmRoot: join(repo.root, ".agents/pm"), options });
  assert.equal(initial.errorMessage, undefined);
});

test("grant repair lower-level configuration respects a live shared writer lease", /** Independent native processes cannot replace a grant during a supported writer transaction. */ async () => {
  const { repo } = await fixture(); const path = join(repo.controlDirectory, "authority.json"); const before = readFileSync(path);
  const compositionUrl = pathToFileURL(join(process.cwd(), "engine/composition.ts")).href;
  const program = `import { configureAuthority } from ${JSON.stringify(compositionUrl)}; try { configureAuthority(process.argv[1], "replacement", "new-read", "new-erase", { currentEraseCredential: "erase-fixture" }); process.stdout.write("changed"); } catch (error) { process.stdout.write(error.code); }`;
  repo.objects.withWriteLock(/** Keep a real filesystem lease active throughout the child's attempted replacement. */ () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, repo.controlDirectory], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, "store_locked"); assert.deepEqual(readFileSync(path), before);
    configureAuthority(repo.controlDirectory, "nested", "new-read", "new-erase", { currentEraseCredential: "erase-fixture" });
    assert.equal(authorize(repo.controlDirectory, "erase", "new-erase"), "nested");
  });
});

test("grant repair standalone erasure authorizes after its writer lease begins", /** A real serialized grant replacement at acquisition invalidates credentials checked earlier. */ async () => {
  const { repo } = await fixture(); const marker = Buffer.from("standalone-erasure-authorization-marker-648293"); commit(repo, "secret.bin", marker);
  const acquire = repo.objects.withWriteLock.bind(repo.objects); let rotated = false;
  repo.objects.withWriteLock = action => {
    repo.objects.withWriteLock = acquire;
    configureAuthority(repo.controlDirectory, "replacement", "new-read", "new-erase", { currentEraseCredential: "erase-fixture" }); rotated = true;
    return acquire(action);
  };
  refuses(() => eraseFile(repo, [repo], "secret.bin", "erase-fixture", "incident", new Date()), "unauthorized");
  assert.equal(rotated, true); assert.deepEqual(readFileSync(join(repo.root, "secret.bin")), marker); assert.deepEqual(repo.objects.denials(), []);
  eraseFile(repo, [repo], "secret.bin", "new-erase", "incident", new Date()); assert.equal(existsSync(join(repo.root, "secret.bin")), false);
});

test("grant repair custom SDK and configured tracker fences preserve runtime bytes", /** Root-aware layer, link and erasure operations honor the active tracker without a basename ban. */ async () => {
  const { repo } = await fixture(); const tracker = join(repo.root, "custom/team");
  const client = new PmClient({ cwd: repo.root, pmRoot: tracker, noExtensions: true }); await client.init("custom", { defaults: true, author: "fixture" });
  const context = { command: "vcs layer", args: [], options: {}, global: { json: true, quiet: true, noPager: true }, pm_root: tracker, repo_root: repo.root };
  const active = openRepository(context); const selected = Buffer.from("custom-tracker-selected-marker-924683"); const revision = commit(active, "secret.bin", selected);
  const paths = ["custom/team/runtime/cache", "custom/team/search/cache", "custom/team/locks/item.lock", "custom/team/transactions/state", "custom/team/checkpoints/point"];
  for (const path of paths) { mkdirSync(dirname(join(repo.root, path)), { recursive: true }); writeFileSync(join(repo.root, path), selected); }
  const descriptor: RepositoryLink = { version: 1, repository: repo.identity(), revision, mappings: [{ source: "secret.bin", destination: "safe" }] };
  for (const path of paths) {
    refuses(() => active.addLayer("unsafe", new Map([[`${path}-new`, { content: Buffer.from("overlay"), executable: false }]])), "unsafe_composition_path");
    refuses(() => active.stageLink(`${path}-link`, descriptor), "unsafe_composition_path");
    refuses(() => active.stageLink("unsafe.link", { ...descriptor, mappings: [{ source: "secret.bin", destination: `${path}-new` }] }), "unsafe_composition_path");
  }
  active.stageLink("allowed.link", descriptor);
  writePrivateJson(join(active.controlDirectory, "layers.json"), [{ name: "forged", files: [{ path: paths[0], content: selected.toString("base64"), executable: false }] }]);
  refuses(() => active.layers(), "unsafe_composition_path"); refuses(() => active.removeLayer("forged", true), "unsafe_composition_path"); rmSync(join(active.controlDirectory, "layers.json"));
  const selectedEntry = active.readIndex().find(entry => entry.path === "secret.bin")!;
  active.writeIndex([...active.readIndex(), { ...selectedEntry, path: paths[0] }]);
  refuses(() => active.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "unsafe_composition_path");
  assert.deepEqual(active.objects.denials(), []); for (const path of paths) assert.deepEqual(readFileSync(join(repo.root, path)), selected);
  active.writeIndex(active.readIndex().filter(entry => entry.path !== paths[0]));
  assert.doesNotThrow(() => active.obliterate("secret.bin", "erase-fixture", "incident", new Date()));
  assert.equal(existsSync(join(repo.root, "secret.bin")), false); for (const path of paths) assert.deepEqual(readFileSync(join(repo.root, path)), selected);
  writeFileSync(join(repo.controlDirectory, "config.json"), JSON.stringify({ recordPaths: ["custom/*/Issues/*.toon"], recordPolicy: {} }));
  const configured = Repository.open(repo.root);
  refuses(() => configured.addLayer("unsafe", new Map([[`${paths[0]}-new`, { content: Buffer.from("overlay"), executable: false }]])), "unsafe_composition_path");
  configured.stageLink("configured.link", { ...descriptor, mappings: [{ source: paths[0], destination: "safe" }] });
  refuses(() => configured.resolveLink("configured.link", configured, "read-fixture", "unsafe"), "unsafe_composition_path");
  const next = Buffer.from("configured-tracker-selected-marker-374962"); commit(configured, "other.bin", next);
  configured.obliterate("other.bin", "erase-fixture", "incident", new Date());
  for (const path of paths) assert.deepEqual(readFileSync(join(repo.root, path)), selected);
});

for (const caller of ["hub", "linked"] as const) {
  test(`grant repair linked custom tracker fences rebase from ${caller}`, /** Real SDK trackers preserve runtime bytes in every shared instance while ordinary copies still refuse. */ async () => {
    const { repo, parent } = await fixture();
    const tracker = join(repo.root, "custom/team");
    const client = new PmClient({ cwd: repo.root, pmRoot: tracker, noExtensions: true });
    await client.init("custom", { defaults: true, author: "fixture" });
    const active = Repository.open(repo.root, tracker);
    assert.deepEqual(active.config.recordPaths, []);
    const selected = Buffer.from(`linked-custom-${caller}-selected-marker-628431`);
    const revision = commit(active, "secret.bin", selected);
    const sibling = join(parent, "sibling"); active.linkInstance("shared", sibling);
    const siblingTracker = join(sibling, "custom/team");
    const linkedClient = new PmClient({ cwd: sibling, pmRoot: siblingTracker, noExtensions: true });
    await linkedClient.init("custom", { defaults: true, author: "fixture" });
    const runtimePaths = ["runtime/cache", "search/cache", "locks/item.lock", "transactions/state", "checkpoints/point"];
    for (const root of [tracker, siblingTracker]) for (const path of runtimePaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), selected);
    }
    const invoked = openRepository({ command: "vcs obliterate", args: [], options: {}, global: { json: true, quiet: true, noPager: true },
      repo_root: caller === "hub" ? repo.root : sibling, pm_root: caller === "hub" ? tracker : siblingTracker });
    // The same names outside the active tracker remain ordinary project paths.
    for (const root of [repo.root, sibling]) {
      const copy = join(root, "unrelated/custom/team/runtime/cache");
      mkdirSync(dirname(copy), { recursive: true }); writeFileSync(copy, selected);
      refuses(() => invoked.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "erasure_worktree_conflict");
      assert.deepEqual(active.objects.denials(), []); assert.deepEqual(readFileSync(copy), selected);
      for (const instance of [repo.root, sibling]) assert.deepEqual(readFileSync(join(instance, "secret.bin")), selected);
      rmSync(join(root, "unrelated"), { recursive: true });
    }
    assert.doesNotThrow(() => invoked.obliterate("secret.bin", "erase-fixture", "incident", new Date()));
    for (const root of [repo.root, sibling]) assert.equal(existsSync(join(root, "secret.bin")), false);
    for (const root of [tracker, siblingTracker]) for (const path of runtimePaths) assert.deepEqual(readFileSync(join(root, path)), selected);
    assert.equal(active.readFileState(revision, "secret.bin").kind, "obliterated");
  });
}

test("grant repair tracker coordinates retain root empty and external boundaries", /** Rebasing is limited to a known internal tracker, including a repository-root tracker. */ async () => {
  for (const coordinate of ["", ".", "../outside", "absolute-outside"]) {
    const { repo, parent } = await fixture();
    const selected = Buffer.from(`tracker-coordinate-${coordinate}-marker-628934`); commit(repo, "secret.bin", selected);
    const sibling = join(parent, "sibling"); repo.linkInstance("shared", sibling);
    const pmRoot = coordinate === "absolute-outside" ? join(parent, "outside") : coordinate;
    if (coordinate === ".") {
      // A root tracker reserves root runtime, without reserving unrelated nested runtime.
      for (const root of [repo.root, sibling]) {
        rmSync(join(root, ".agents/pm"), { recursive: true });
        await new PmClient({ cwd: root, pmRoot: root, noExtensions: true }).init("root", { defaults: true, author: "fixture" });
        mkdirSync(join(root, "runtime"), { recursive: true }); writeFileSync(join(root, "runtime/cache"), selected);
      }
    } else if (coordinate !== "") {
      const client = new PmClient({ cwd: repo.root, pmRoot: join(parent, "outside"), noExtensions: true });
      await client.init("external", { defaults: true, author: "fixture" });
      for (const root of [repo.root, sibling]) {
        mkdirSync(join(root, "outside/runtime"), { recursive: true }); writeFileSync(join(root, "outside/runtime/cache"), selected);
        const active = Repository.open(repo.root, pmRoot);
        refuses(() => active.obliterate("secret.bin", "erase-fixture", "incident", new Date()), "erasure_worktree_conflict");
        assert.deepEqual(repo.objects.denials(), []); rmSync(join(root, "outside"), { recursive: true });
      }
    }
    Repository.open(repo.root, pmRoot).obliterate("secret.bin", "erase-fixture", "incident", new Date());
    for (const root of [repo.root, sibling]) {
      assert.equal(existsSync(join(root, "secret.bin")), false);
      if (coordinate === ".") assert.deepEqual(readFileSync(join(root, "runtime/cache")), selected);
    }
  }
});

test("grant repair installed CLI parses separate current and legacy flags and preserves ordinary paths", /** Exercise the actual installed host CLI with a packed extension and disposable token files. */ async () => {
  const { repo, parent } = await fixture(); installPackedExtension(repo.root);
  const authorityPath = join(repo.controlDirectory, "authority.json"); rmSync(authorityPath);
  const readToken = join(parent, "cli-read"); const eraseToken = join(parent, "cli-erase"); const currentToken = join(parent, "cli-current");
  writeFileSync(readToken, "cli-read-grant"); writeFileSync(eraseToken, "cli-erase-grant"); writeFileSync(currentToken, "cli-erase-grant");
  const common = [pmExecutable, "--json", "vcs", "authority", "--principal", "fixture", "--read-token-file", readToken, "--erase-token-file", eraseToken];
  const environment = { ...withoutPmContext(process.env), ...discardChildCoverage() };
  const initial = spawnSync(process.execPath, common, { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120_000 }); assert.equal(initial.status, 0, initial.stderr + initial.stdout);
  const original = readFileSync(authorityPath); writeFileSync(readToken, "cli-new-read"); writeFileSync(eraseToken, "cli-new-erase");
  for (const flags of [[], ["--regenerate-legacy"], ["--current-erase-token-file", eraseToken], ["--current-erase-token-file", currentToken, "--regenerate-legacy"]]) {
    const denied = spawnSync(process.execPath, [...common, ...flags], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(denied.status, 1, denied.stderr + denied.stdout); assert.deepEqual(readFileSync(authorityPath), original);
  }
  const rotated = spawnSync(process.execPath, [...common, "--current-erase-token-file", currentToken], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120_000 });
  assert.equal(rotated.status, 0, rotated.stderr + rotated.stdout); assert.equal(authorize(repo.controlDirectory, "erase", "cli-new-erase"), "fixture"); assert.equal(rotated.stdout.includes("cli-new-erase"), false);
  const overlay = join(parent, "cli-overlay"); writeFileSync(overlay, "ordinary CLI overlay\n");
  const created = spawnSync(process.execPath, [pmExecutable, "--json", "vcs", "layer", "ordinary", "src/search/a.txt", overlay], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120_000 });
  assert.equal(created.status, 0, created.stderr + created.stdout); assert.equal(readFileSync(join(repo.root, "src/search/a.txt"), "utf8"), "ordinary CLI overlay\n"); repo.removeLayer("ordinary");
  commit(repo, "src/search/a.txt", Buffer.from("unrelated CLI source\n")); commit(repo, "secret.bin", Buffer.from("installed-cli-selected-marker-374698"));
  const erased = spawnSync(process.execPath, [pmExecutable, "--json", "vcs", "obliterate", "secret.bin", "--erase-token-file", eraseToken, "--reason", "incident"], { cwd: repo.root, env: environment, encoding: "utf8", timeout: 120_000 });
  assert.equal(erased.status, 0, erased.stderr + erased.stdout); assert.equal(existsSync(join(repo.root, "secret.bin")), false); assert.equal(readFileSync(join(repo.root, "src/search/a.txt"), "utf8"), "unrelated CLI source\n");
});
