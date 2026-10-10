/** Real operator JSON and compressed-header discovery regressions. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { constants, deflateRawSync, deflateSync, inflateSync } from "node:zlib";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { decodeLink, encodeLink, type RepositoryLink } from "../engine/composition.ts";
import { decodeManifest, encodeManifest, type Signature } from "../engine/model.ts";
import { frameObject, hashObject, ObjectStoreError } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { exportBundle, parseBundle } from "../engine/bundle.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const temps: ReturnType<typeof makeTempDir>[] = [];
const modeDenialSupported = process.platform !== "win32" && process.getuid !== undefined && process.getuid() !== 0;
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
afterEach(() => { for (const temp of temps.splice(0)) temp.cleanup(); });

/** One ordinary repository with a sibling operator input directory. */
function fixture() {
  const temp = makeTempDir(); temps.push(temp);
  const repo = Repository.init(join(temp.root, "repo"));
  const spec = join(temp.root, "input.json");
  const link: RepositoryLink = { version: 1, repository: "1".repeat(32), revision: "2".repeat(64),
    mappings: [{ source: "src/z", destination: "vendor/z" }, { source: "src/a", destination: "vendor/a" }] };
  return { repo, spec, link };
}

/** Compressed storage path used only for synthetic damage and native prefix probes. */
function objectPath(repo: Repository, id: string): string {
  return join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
}

/** Capture every object byte and the complete index before a refusal. */
function snapshot(repo: Repository) {
  return { index: readFileSync(join(repo.controlDirectory, "index")),
    objects: repo.objects.inventory().map(entry => [entry.path, createHash("sha256").update(readFileSync(entry.path)).digest("hex")]) };
}

for (const format of ["pretty", "newline"] as const) test(`JSON header repair accepts ${format} operator specs and preserves strict stored bytes`, async () => {
  const { repo, spec, link } = fixture();
  const canonical = encodeLink(link);
  const input = format === "pretty" ? JSON.stringify({ mappings: link.mappings, revision: link.revision, repository: link.repository, version: 1 }, null, 2) : canonical.toString() + "\n";
  writeFileSync(spec, input);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], options: { spec }, pmRoot: repo.root });
  assert.equal(result.errorMessage, undefined, "ordinary JSON whitespace must stage successfully");
  const id = hashObject("link", canonical);
  assert.deepEqual(result.result, { ok: true, id });
  assert.deepEqual(readFileSync(join(repo.root, "dependency.link")), canonical);
  assert.deepEqual(repo.objects.readTyped(id, "link"), canonical);
  assert.deepEqual(repo.links(), [{ path: "dependency.link", id, link: decodeLink(canonical) }]);
  assert.throws(() => decodeLink(Buffer.from(input)), error => error instanceof ObjectStoreError && error.code === "bad_link");
  repo.commit({ message: "canonical descriptor", author }, new Date(1000));
  assert.equal(repo.status().clean, true);
});

test("JSON header repair rejects invalid roots, JSON and fields without object or index publication", async () => {
  const { repo, spec, link } = fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const before = snapshot(repo);
  const inputs = ["{", "null", "[]", "1", "true", '"link"', "{}",
    JSON.stringify({ ...link, extra: 1 }), JSON.stringify({ ...link, version: "1" }),
    JSON.stringify({ ...link, repository: 1 }), JSON.stringify({ ...link, revision: "branch" }),
    JSON.stringify({ ...link, mappings: null }), JSON.stringify({ ...link, mappings: [] }),
    JSON.stringify({ ...link, mappings: [null] }), JSON.stringify({ ...link, mappings: [1] }),
    JSON.stringify({ ...link, mappings: [{ source: 1, destination: "a" }] }),
    JSON.stringify({ ...link, mappings: [{ source: "a", destination: "b", extra: 1 }] })];
  for (const input of inputs) {
    writeFileSync(spec, input);
    const result = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], options: { spec }, pmRoot: repo.root });
    assert.equal(result.errorCode, "bad_link", input);
    assert.deepEqual(snapshot(repo), before, input);
  }
});

test("JSON header repair preserves missing, directory and permission errors for operator files", async () => {
  const { repo, spec } = fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const before = snapshot(repo);
  for (const code of ["ENOENT", "EISDIR", "EACCES"] as const) {
    if (code === "EACCES" && !modeDenialSupported) continue;
    if (code === "EISDIR") mkdirSync(spec);
    if (code === "EACCES") { rmSync(spec, { recursive: true }); writeFileSync(spec, "{}"); chmodSync(spec, 0); }
    try {
      const result = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], options: { spec }, pmRoot: repo.root });
      assert.ok(String(result.errorMessage).includes(code));
      assert.doesNotMatch(String(result.errorMessage), /not valid JSON/);
      assert.deepEqual(snapshot(repo), before);
    } finally { if (code === "EACCES") chmodSync(spec, 0o600); }
  }
});

test("JSON header repair discovers a real large canonical link across a dynamic DEFLATE header", () => {
  const { repo, link } = fixture();
  const large: RepositoryLink = { ...link, mappings: Array.from({ length: 400 }, (_, i) => {
    const hex = createHash("sha256").update(`mapping-${i}`).digest("hex");
    return { source: `src/${hex.slice(0, 16)}/${i}.bin`, destination: `vendor/${hex.slice(16, 32)}/${i}.bin` };
  }) };
  const id = repo.stageLink("large.link", large);
  const compressed = readFileSync(objectPath(repo, id));
  assert.equal((compressed[2] >> 1) & 3, 2, "ObjectStore.write must produce a genuine dynamic block");
  const initial = inflateSync(compressed.subarray(0, 64), { finishFlush: constants.Z_SYNC_FLUSH });
  assert.equal(initial.includes(0), false, "fixture must defeat the predecessor prefix");
  const discovered = repo.objects.readIfType(id, "link");
  assert.ok(discovered, "a valid large canonical link must not disappear from discovery");
  assert.deepEqual(discovered.payload, encodeLink(large));
  assert.deepEqual(repo.links(), [{ path: "large.link", id, link: decodeLink(encodeLink(large)) }]);
  repo.commit({ message: "large link", author }, new Date(1000));
  assert.equal(repo.status().clean, true);
  assert.equal(parseBundle(exportBundle(repo.objects, repo.refs, [])).header.objects.includes(id), true);
});

test("JSON header repair discovers a real large canonical manifest and exports all real fragments", () => {
  const { repo } = fixture();
  const fragments = Array.from({ length: 700 }, (_, i) => {
    const payload = Buffer.alloc(32 + (i * 15485863) % 256);
    createHash("sha256").update(`fragment-${i}`).digest().copy(payload);
    return { id: repo.objects.write("blob", payload), length: payload.length };
  });
  const manifest = { totalLength: fragments.reduce((sum, fragment) => sum + fragment.length, 0), fragments };
  const payload = encodeManifest(manifest);
  const id = repo.objects.write("manifest", payload);
  const compressed = readFileSync(objectPath(repo, id));
  assert.equal((compressed[2] >> 1) & 3, 2, "ObjectStore.write must produce a genuine dynamic block");
  assert.equal(inflateSync(compressed.subarray(0, 64), { finishFlush: constants.Z_SYNC_FLUSH }).includes(0), false);
  const discovered = repo.objects.readIfType(id, "manifest");
  assert.ok(discovered, "a valid large canonical manifest must not disappear from discovery");
  assert.deepEqual(discovered.payload, payload);
  assert.deepEqual(decodeManifest(payload), manifest);
  repo.writeIndex([{ path: "fragmented.bin", id, mode: "100644", fileId: "a".repeat(32) }]);
  repo.commit({ message: "large manifest", author }, new Date(1000));
  const objects = new Set(parseBundle(exportBundle(repo.objects, repo.refs, [])).header.objects);
  assert.equal(objects.has(id), true);
  assert.equal(fragments.every(fragment => objects.has(fragment.id)), true, "discovery cannot omit fragment closure");
});

test("JSON header repair bounds prefix output for highly compressible real payloads", () => {
  const { repo } = fixture();
  const payload = Buffer.alloc(512 * 1024, 120);
  const id = repo.objects.write("blob", payload);
  const compressed = readFileSync(objectPath(repo, id));
  assert.throws(() => inflateSync(compressed.subarray(0, 64), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 4096 }), error => (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE");
  assert.equal(repo.objects.readIfType(id, "link"), undefined);
  assert.deepEqual(repo.objects.readIfType(id, "blob")?.payload, payload);
});

test("JSON header repair preserves malformed, truncated and nonmatching discovery semantics and full matching integrity", () => {
  const { repo } = fixture();
  const id = repo.objects.write("blob", Buffer.from("synthetic original"));
  const path = objectPath(repo, id);
  for (const compressed of [Buffer.alloc(0), Buffer.from("bad zlib"), Buffer.from([0x78]),
    deflateSync(Buffer.from("no header")), deflateSync(Buffer.from("x".repeat(4096))),
    deflateSync(Buffer.from("link x\0bad")), deflateSync(frameObject("record", Buffer.from("unrelated")))]) {
    writeFileSync(path, compressed);
    assert.equal(repo.objects.readIfType(id, "link"), undefined);
  }
  for (const [framed, code] of [[Buffer.from("link 999\0bad"), "malformed_object"], [frameObject("link", Buffer.from("changed hash")), "corrupt_object"]] as const) {
    writeFileSync(path, deflateSync(framed));
    assert.throws(() => repo.objects.readIfType(id, "link"), error => error instanceof ObjectStoreError && error.code === code);
  }
  const valid = deflateSync(frameObject("link", Buffer.alloc(4096, 120)));
  writeFileSync(path, valid.subarray(0, valid.length - 2));
  assert.throws(() => repo.objects.readIfType(id, "link"), error => error instanceof ObjectStoreError && error.code === "corrupt_object");
  rmSync(path); assert.equal(repo.objects.readIfType(id, "link"), undefined);
  mkdirSync(path); assert.throws(() => repo.objects.readIfType(id, "link"), error => (error as NodeJS.ErrnoException).code === "EISDIR");
  rmSync(path, { recursive: true }); writeFileSync(path, valid);
  if (modeDenialSupported) {
    chmodSync(path, 0);
    try { assert.throws(() => repo.objects.readIfType(id, "link"), error => (error as NodeJS.ErrnoException).code === "EACCES"); }
    finally { chmodSync(path, 0o600); }
  }
  assert.throws(() => repo.objects.readIfType("invalid", "link"), error => error instanceof ObjectStoreError && error.code === "invalid_object_id");
});

test("JSON header repair reports ambiguous padded streams explicitly instead of hiding valid objects", () => {
  const { repo, link } = fixture();
  const payload = encodeLink(link); const framed = frameObject("link", payload);
  const id = repo.objects.write("link", payload); const path = objectPath(repo, id);
  // Real legal zlib framing: empty non-final stored blocks precede Node's actual compressed frame.
  const empty = Buffer.from([0, 0, 0, 255, 255]);
  const adler = deflateSync(framed).subarray(-4);
  writeFileSync(path, Buffer.concat([Buffer.from([0x78, 0x01]), ...Array.from({ length: 14000 }, () => empty), deflateRawSync(framed), adler]));
  assert.deepEqual(repo.objects.readTyped(id, "link"), payload, "the padded frame remains valid and hash-verified");
  assert.throws(() => repo.objects.readIfType(id, "link"), error => error instanceof ObjectStoreError && error.code === "object_prefix_limit");
});

test("JSON header repair cannot bypass permanent denial through matching recreated physical bytes", () => {
  const { repo } = fixture(); const payload = Buffer.from("prefix-denial-selected-fixture-487193");
  repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(repo.root, "selected.bin"), payload); repo.stage(["selected.bin"]);
  repo.commit({ message: "selected", author }, new Date(1000));
  const selected = repo.readIndex()[0];
  repo.obliterate("selected.bin", "erase-fixture", "incident", new Date(2000));
  const path = objectPath(repo, selected.id); writeFileSync(path, deflateSync(frameObject("blob", payload)));
  if (modeDenialSupported) chmodSync(path, 0);
  try {
    assert.equal(repo.objects.readIfType(selected.id, "blob"), undefined, "denial must precede physical prefix I/O");
    assert.throws(() => repo.objects.read(selected.id), error => error instanceof ObjectStoreError && error.code === "object_obliterated");
    assert.throws(() => repo.objects.write("blob", payload, selected.fileId), error => error instanceof ObjectStoreError && error.code === "object_obliterated");
  } finally { if (modeDenialSupported) chmodSync(path, 0o600); }
});
