import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Byte-authoritative erasure proof over arbitrary object-store names, representations and interruptions. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { frameObject, hashObject, OBJECT_TYPES } from "../engine/objects.ts";
import { ErasureStorageRefusal, erasureScanLimits, erasureScanBoundary, fingerprint, fingerprintJournal, matchesFingerprints, type ErasureFingerprint, readFingerprints, scanErasureStorage, createErasureInspection, inspectErasureRepresentation } from "../engine/erasure-scan.ts";
import { writePrivateJson } from "../engine/composition.ts";
import { serializeBundle, parseBundle } from "../engine/bundle.ts";
import { JsonStrings } from "../engine/json-strings.ts";
import { inspectRepresentations } from "../engine/representations.ts";
import { objectFiles } from "../engine/object-files.ts";
import { verificationLimits } from "../engine/object-error.ts";
import { assertDestructionStorage, destructionBoundary, prepareDestruction } from "../engine/destruction.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; erasureScanBoundary.visit = () => {}; erasureScanLimits.minimum=16*1024*1024; erasureScanLimits.ratio=1032*6; erasureScanLimits.depth=6; erasureScanLimits.streams=32; erasureScanLimits.contexts=512; erasureScanLimits.wordBytes=16*1024*1024; objectFiles.opened=()=>{}; for (const dir of temporary.splice(0)) dir.cleanup(); });
let random = 314159;
/** Deterministic randomized corpus is reproducible in Node and Bun release gates. */
function number(): number { random = (Math.imul(random,1664525)+1013904223) >>> 0; return random; }
/** Make real SDK tracker state outside Git, without importing any user or fleet data. */
async function fixture(chosen?: Buffer) {
  const dir = makeTempDir(); temporary.push(dir);
  await new PmClient({cwd:dir.root,pmRoot:join(dir.root,".agents/pm"),noExtensions:true}).init("erasure-storage",{defaults:true,author:"fixture"});
  const repo = Repository.init(dir.root); repo.setAuthority("fixture","read-fixture","erase-fixture");
  let bytes: Buffer = Buffer.alloc(48+number()%96); for (let i=0;i<bytes.length;i++) bytes[i] = number() >>> 24;
  if(number()%3===0) bytes=Buffer.from(`compressible-selected-${number()}-`.repeat(23));
  if(chosen!==undefined) bytes=chosen;
  writeFileSync(join(dir.root,"asset"),bytes); repo.stage(["asset"]);
  const item = repo.readIndex()[0]; return {dir,repo,bytes,id:item.id,fileId:item.fileId!};
}
/** Place arbitrary storage without changing generation markers or acquiring an engine lease. */
function place(root: string, path: string, bytes: Buffer): string { const file=join(root,path); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,bytes); return file; }

test("decoded persisted metadata, logs, layer paths and keys cannot retain selected bytes", async t => {
  for (const where of ["metadata-value", "metadata-key", "metadata-hex-zlib", "metadata-hex-truncated", "operation-log", "lease-audit", "layer-path", "layer-value", "worktree-path", "worktree-json"] as const) await t.test(where, async () => {
    const payload = 'selected secret "quoted bytes" 937184'; const f = await fixture(Buffer.from(payload));
    let code = "unsupported_erasure_storage";
    if (where === "metadata-value") writePrivateJson(join(f.repo.controlDirectory, "remotes.json"), { backup: payload });
    if (where === "metadata-hex-zlib") writePrivateJson(join(f.repo.controlDirectory, "remotes.json"), { backup: deflateSync(f.bytes).toString("hex") });
    if (where === "metadata-hex-truncated") writePrivateJson(join(f.repo.controlDirectory, "remotes.json"), { backup: deflateSync(f.bytes).subarray(0, -2).toString("hex") });
    if (where === "metadata-key") writePrivateJson(join(f.repo.controlDirectory, "remotes.json"), { [payload]: "unrelated metadata" });
    if (where === "operation-log") f.repo.operations.append("fixture", payload, [], new Date(1));
    if (where === "lease-audit") place(f.repo.controlDirectory, `leases/${"a".repeat(32)}.jsonl`, Buffer.from(`${JSON.stringify({ note: payload })}\n`));
    if (where === "layer-path") { writePrivateJson(join(f.repo.controlDirectory, "layers.json"), [{ name: "retained-layer", files: [{ path: payload, content: Buffer.from("unrelated layer bytes").toString("base64"), executable: false }] }]); code = "erasure_layer_conflict"; }
    if (where === "layer-value") { writePrivateJson(join(f.repo.controlDirectory, "layers.json"), [{ name: "retained-layer", files: [{ path: "unrelated-layer-path", content: Buffer.from(JSON.stringify({ value: payload })).toString("base64"), executable: false }] }]); code = "erasure_layer_conflict"; }
    if (where === "worktree-json") { writeFileSync(join(f.repo.root, "unrelated.json"), JSON.stringify({ value: payload })); code = "erasure_worktree_conflict"; }
    if (where === "worktree-path") { writeFileSync(join(f.repo.root, `prefix-${payload}-suffix`), "unrelated worktree bytes"); code = "erasure_worktree_conflict"; }
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "decoded-metadata", new Date(1)), { code });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  });
});

test("native bundle bodies and headers do not hide decoded retained bytes", async t => {
  for (const where of ["body", "header"] as const) await t.test(where, async () => {
    const payload = 'selected secret "quoted bytes" 937184'; const f = await fixture(Buffer.from(payload));
    const id = f.repo.objects.write("blob", Buffer.from(JSON.stringify({ value: payload })));
    const bytes = serializeBundle(f.repo.objects, { refs: where === "header" ? { [payload]: id } : {}, prerequisites: [], objects: where === "body" ? [id] : [] }, false);
    parseBundle(bytes); // Native framing, object hashes and base64 payloads remain independently valid.
    const native = [...f.repo.objects.inventory()].find(entry => entry.id === id)!; rmSync(native.path);
    writeFileSync(join(f.repo.root, "retained.bundle"), bytes);
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "decoded-bundle", new Date(1)), { code: "erasure_worktree_conflict" });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  });
});

test("final descriptor accounting rejects a late native identity that decodes to selected bytes", async () => {
  const peer = Buffer.from("late native retained identity peer 193847"); const id = hashObject("blob", peer);
  const f = await fixture(Buffer.from(id, "hex")); const path = join(f.repo.objects.storageRoot(), id.slice(0, 2), id.slice(2)); let injected = false;
  erasureScanBoundary.visit = step => { if (step === "completed" && !injected) { injected = true; place(f.repo.objects.storageRoot(), `${id.slice(0, 2)}/${id.slice(2)}`, deflateSync(frameObject("blob", peer))); } };
  assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "late-hex-identity", new Date(1)), { code: "erasure_retained_copy" });
  assert.equal(injected, true); assert.equal(f.repo.objects.denials()[0].pending, true);
  erasureScanBoundary.visit = () => {}; rmSync(path);
  assert.equal(f.repo.obliterate(f.fileId, "erase-fixture", "late-hex-identity", new Date(1)).storage.accountable, true);
});

test("hex-encoded native identities in refs and loose or pack inventories cannot retain selected bytes", async t => {
  const peer = Buffer.from("native retained identity peer 193847"); const id = hashObject("blob", peer);
  for (const where of ["loose", "pack", "ref"] as const) await t.test(where, async () => {
    const f = await fixture(Buffer.from(id, "hex")); assert.equal(f.repo.objects.write("blob", peer), id);
    if (where === "pack") f.repo.objects.compact();
    if (where === "ref") f.repo.refs.compareAndSwap("refs/metadata/hexidentity", null, id);
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "hex-identity", new Date(1)), { code: where === "ref" ? "unsupported_erasure_storage" : "erasure_retained_copy" });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  });
});

test("native loose and packed JSON, hex and composite payload copies refuse after decoding", async t => {
  const payload = Buffer.from('selected secret "quoted bytes" 937184');
  for (const encoding of ["json-value", "json-key", "hex", "hex-zlib", "base64-json", "json-base64"] as const) for (const packed of [false, true]) await t.test(`${encoding}/${packed}`, async () => {
    const f = await fixture(payload);
    const json = Buffer.from(JSON.stringify({ value: payload.toString() }));
    const bytes = encoding === "json-value" ? json : encoding === "json-key" ? Buffer.from(JSON.stringify({ [payload.toString()]: 1 })) : encoding === "hex" ? Buffer.from(payload.toString("hex")) : encoding === "hex-zlib" ? Buffer.from(deflateSync(payload).toString("hex")) : encoding === "base64-json" ? Buffer.from(json.toString("base64")) : Buffer.from(JSON.stringify({ encoded: payload.toString("base64") }));
    f.repo.objects.write("blob", bytes); if (packed) f.repo.objects.compact();
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "decoded-object", new Date(1)), { code: "erasure_retained_copy" });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), payload); assert.equal(f.repo.objects.denials().length, 0);
  });
});

test("incremental JSON strings agree with native parsing for every escape and UTF-16 edge", () => {
  const tokens = ['""', JSON.stringify("\b\f\n\r\t/\\\""), String.raw`"\/"`, String.raw`"\ud83d\ude00"`, String.raw`"\ud83d\u0041"`, String.raw`"\ud83dx"`, String.raw`"\ud83d\n"`, String.raw`"\ud83d"`, String.raw`"\udc00"`, JSON.stringify("a".repeat(9000))];
  for (const token of tokens) {
    const pieces: Buffer[] = []; let ended = 0; const decoder = new JsonStrings(bytes => pieces.push(Buffer.from(bytes)), () => { ended++; });
    for (const byte of Buffer.from(token)) decoder.feed(Buffer.from([byte])); decoder.finish();
    assert.deepEqual(Buffer.concat(pieces), Buffer.from(JSON.parse(token) as string), token.slice(0, 50)); assert.equal(ended, 1);
    const whole: Buffer[] = []; let largest = 0; const together = new JsonStrings(bytes => { largest = Math.max(largest, bytes.length); whole.push(Buffer.from(bytes)); }, () => {});
    together.feed(Buffer.from(token)); together.finish(); assert.deepEqual(Buffer.concat(whole), Buffer.from(JSON.parse(token) as string)); assert.ok(largest <= 4096);
  }
  for (const token of ['"\\q"', '"\\u0x"', '"incomplete\\u0', '"interrupted', '"raw\ncontrol']) {
    let ended = 0; const decoder = new JsonStrings(() => {}, () => { ended++; }); decoder.feed(Buffer.from(token)); decoder.finish(); assert.ok(ended >= 1);
  }
  const selected = Buffer.from("bounded selected decoder payload 193847");
  inspectErasureRepresentation(Buffer.from(JSON.stringify({ unrelated: "native must-allow metadata 80" })), [fingerprint(selected)]);
  for (const bytes of [Buffer.from(JSON.stringify({ value: selected.toString() })), Buffer.from(deflateSync(selected).toString("hex")), Buffer.from(deflateSync(selected).subarray(0, -2).toString("hex"))]) assert.equal(inspectRepresentations(bytes, candidate => candidate.includes(selected)), true);
  assert.throws(() => inspectRepresentations(Buffer.from(JSON.stringify({ value: deflateSync(Buffer.alloc(4096)).toString("hex") })), () => false, 6, 64), { code: "uninspectable_payload" });
  const large = Buffer.from(`${"z".repeat(65_536)}${selected.toString()}`);
  assert.equal(inspectRepresentations(Buffer.from(deflateSync(large).toString("hex")), candidate => candidate.includes(selected)), true);
  const escaped = Buffer.from(JSON.stringify({ value: `${"x".repeat(4090)}selected "quoted" payload` }));
  assert.throws(() => inspectErasureRepresentation(escaped, [fingerprint(Buffer.from('selected "quoted" payload'))]), { code: "erasure_retained_copy" });
});

test("streamed decoded strings preserve escapes, Unicode and encoding state across every split", () => {
  for (const payload of ['selected "quoted" payload', "selected \\backslash\\ payload", "selected \u0001\u0007 controls", "selected café 雪 😀 payload"]) {
    const bytes = Buffer.from(JSON.stringify({ [payload]: { value: payload } }).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
    for (let split = 0; split <= bytes.length; split++) {
      const inspection = createErasureInspection([fingerprint(Buffer.from(payload))], bytes.length);
      try { inspection.feed(bytes.subarray(0, split)); inspection.feed(bytes.subarray(split)); assert.throws(() => inspection.finish(), { code: "erasure_retained_copy" }); } finally { inspection.close(); }
    }
    const hex = Buffer.from(deflateSync(Buffer.from(payload)).toString("hex"));
    for (let split = 0; split <= hex.length; split++) { const inspection = createErasureInspection([fingerprint(Buffer.from(payload))], hex.length); try { inspection.feed(hex.subarray(0, split)); inspection.feed(hex.subarray(split)); assert.throws(() => inspection.finish(), { code: "erasure_retained_copy" }); } finally { inspection.close(); } }
  }
});

test("decoded journal strings refuse every escaped retained payload before erasure", async t => {
  for (const [kind, payload, contained] of [
    ["quotes", 'selected secret "quoted bytes" 937184', false],
    ["backslashes", "selected secret \\backslash\\ bytes 937184", false],
    ["controls", "selected secret \u0001\u0007 bytes 937184", false],
    ["unicode", "selected secret café 雪 😀 937184", false],
    ["unicode-literal", "selected secret café 雪 😀 937184", false],
    ["containing-path", 'selected secret "quoted bytes" 937184', true],
  ] as const) await t.test(kind, async () => {
    const f = await fixture(Buffer.from(payload));
    const path = join(f.repo.root, contained ? `prefix-${payload}-suffix` : payload); writeFileSync(path, "unrelated native journal candidate");
    f.repo.objects.withWriteLock(() => { const plan = prepareDestruction(f.repo.controlDirectory, "escaped-retention", [{ path }]); for (const target of plan.paths) plan.remove(target); plan.finish(); });
    const ledger = join(f.repo.controlDirectory, "destruction"); const journal = readdirSync(ledger).find(name => name.endsWith(".json"))!; const record = readFileSync(join(ledger, journal), "utf8");
    if (kind === "unicode") writeFileSync(join(ledger, journal), record.replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
    const bytes = readFileSync(join(ledger, journal)); assert.equal(bytes.includes(f.bytes), kind === "unicode-literal");
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "escaped-retention", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  });
});

test("reviewer quoted filename and contents never leave a successful physical receipt", async () => {
  const payload = 'selected secret "quoted bytes" 937184'; const f = await fixture(Buffer.from(payload));
  fs.renameSync(join(f.repo.root, "asset"), join(f.repo.root, payload)); f.repo.stage([payload]);
  const fileId = f.repo.readIndex().find(entry => entry.path === payload)!.fileId!;
  assert.throws(() => f.repo.obliterate(fileId, "erase-fixture", "reviewer-quoted", new Date(1)), { code: "unsupported_erasure_storage" });
  assert.deepEqual(readFileSync(join(f.repo.root, payload)), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
});

test("erasure refuses unknown control-directory bytes and kinds before deleting anything", async () => {
  for (const mode of ["destruction-backup", "destruction-directory", "destruction-link", "destruction-json", "destruction-progress", "destruction-owner", "destruction-empty-canonical", "destruction-foreign-empty-stage", "destruction-bad-stage", "destruction-bad-pid", "refs-backup", "refs-link", "refs-lock", "refs-native-directory", "file-directory", "directory-file"] as const) {
    const f = await fixture(Buffer.from("selected control guard payload 836429"));
    const control = f.repo.controlDirectory; const ledger = join(control, "destruction"); mkdirSync(ledger, { recursive: true });
    let foreign: string;
    if (mode === "destruction-backup") foreign = place(ledger, "foreign-backup", f.bytes);
    else if (mode === "destruction-directory") foreign = place(ledger, "nested/foreign-backup", f.bytes);
    else if (mode === "destruction-link") { foreign = join(ledger, "linked"); fs.symlinkSync(join(f.repo.root, "asset"), foreign); }
    else if (mode === "destruction-json") foreign = place(ledger, `${"a".repeat(64)}.json`, Buffer.from(JSON.stringify({ format: "pm-vcs-destruction-1", backup: f.bytes.toString("base64") })));
    else if (mode === "destruction-progress") foreign = place(ledger, `${"a".repeat(64)}.${"b".repeat(32)}.progress`, f.bytes);
    else if (mode === "destruction-owner") foreign = place(ledger, `${"a".repeat(64)}.json.lock`, Buffer.from("{}"));
    else if (mode === "destruction-empty-canonical") foreign = place(ledger, `${"a".repeat(64)}.json`, Buffer.alloc(0));
    else if (mode === "destruction-foreign-empty-stage") foreign = place(ledger, "foreign.tmp", Buffer.alloc(0));
    else if (mode === "destruction-bad-stage") foreign = place(ledger, `${"a".repeat(64)}.json.${"b".repeat(12)}.tmp`, f.bytes);
    else if (mode === "destruction-bad-pid") foreign = place(ledger, `${"a".repeat(64)}.json.lock.2147483648.${"b".repeat(12)}.tmp`, Buffer.alloc(0));
    else if (mode === "refs-backup") foreign = place(control, "refs/metadata/foreign-backup", f.bytes);
    else if (mode === "refs-link") { foreign = join(control, "refs/linked"); fs.symlinkSync(join(f.repo.root, "asset"), foreign); }
    else if (mode === "refs-lock") foreign = place(control, "refs/foreign.lock", f.bytes);
    else if (mode === "refs-native-directory") foreign = place(control, `refs/ref-${process.pid}-${"a".repeat(12)}.lock/foreign`, f.bytes);
    else if (mode === "file-directory") { fs.rmSync(join(control, "remotes.json"), { force: true }); foreign = place(control, "remotes.json/foreign-backup", f.bytes); }
    else { rmSync(ledger, { recursive: true }); foreign = place(control, "destruction", f.bytes); }
    if (mode === "directory-file") assert.throws(() => assertDestructionStorage(control), { code: "unsupported_erasure_storage" });
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "control-guard", new Date(1), { purgeUnaccounted: true }), { code: "unsupported_erasure_storage" }, mode);
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes, mode);
    assert.deepEqual(f.repo.objects.readTyped(f.id, "blob"), f.bytes, mode);
    assert.equal(f.repo.objects.denials().length, 0, mode);
    assert.ok(fs.lstatSync(foreign), mode);
    assert.equal(f.repo.operations.read().filter(entry => entry.command === "obliterate").length, 0, mode);
  }
});

test("erasure accepts sparse native control and regular native reference temporaries", async () => {
  for (const nativeTemporary of [false, true]) {
    const f = await fixture(Buffer.from("sparse native control payload 918236"));
    assert.equal(existsSync(join(f.repo.controlDirectory, "destruction")), false);
    rmSync(join(f.repo.controlDirectory, "refs"), { recursive: true });
    if (nativeTemporary) place(f.repo.controlDirectory, `refs/metadata/ref-${process.pid}-${"a".repeat(12)}.lock`, Buffer.from(`${f.id}\n`));
    assert.equal(f.repo.obliterate(f.fileId, "erase-fixture", "sparse-native", new Date(1)).storage.accountable, true);
    assert.equal(existsSync(join(f.repo.root, "asset")), false);
    assert.throws(() => f.repo.objects.read(f.id), { code: "object_obliterated" });
  }
});

test("native journal identities do not promote new codec guesses into declared streams", async () => {
  const f = await fixture(Buffer.from("selected native codec ancestry payload 193847")); const randomBytes = crypto.randomBytes;
  mock.method(crypto, "randomBytes", ((size: number) => size === 16 ? Buffer.from("654a7a2f000000000000000000000000", "hex") : randomBytes(size)) as typeof crypto.randomBytes); syncBuiltinESMExports();
  try { f.repo.objects.withWriteLock(() => { const path = join(f.repo.root, "ordinary-journal-candidate"); writeFileSync(path, "unrelated native candidate"); const plan = prepareDestruction(f.repo.controlDirectory, "codec-ancestry-compatibility", [{ path }]); for (const target of plan.paths) plan.remove(target); plan.finish(); }); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.repo.obliterate(f.fileId, "erase-fixture", "native-codec-ancestry", new Date(1)).storage.accountable, true);
});

test("native literal reference identities do not become compressed payload candidates", async () => {
  const f = await fixture(Buffer.from("selected literal ref payload 918263")); const peer = Buffer.from("native ref literal 38");
  const id = f.repo.objects.write("blob", peer); assert.match(id, /^80/);
  writeFileSync(join(f.repo.root, "peer"), peer); f.repo.stage(["peer"]);
  f.repo.refs.compareAndSwap("refs/metadata/literal", null, id);
  assert.equal(f.repo.refs.read("refs/metadata/literal"), id);
  assert.equal(f.repo.obliterate(f.fileId, "erase-fixture", "literal-native-ref", new Date(1)).storage.accountable, true);
  assert.equal(f.repo.refs.read("refs/metadata/literal"), id); assert.deepEqual(f.repo.objects.readTyped(id, "blob"), peer);
});

test("native reference metadata retaining selected bytes still refuses before deletion", async () => {
  const peer = Buffer.from("native ref literal 38"); const id = hashObject("blob", peer); const f = await fixture(Buffer.from(id));
  f.repo.objects.write("blob", peer); f.repo.refs.compareAndSwap("refs/metadata/literal", null, id);
  assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "retained-native-ref", new Date(1)), { code: "unsupported_erasure_storage" });
  assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0); assert.deepEqual(f.repo.objects.readTyped(id, "blob"), peer);
});

test("native reference inspection pins its bytes and namespace until classification completes", async () => {
  for (const mode of ["change", "vanish", "held", "directory", "kind", "link-before", "link-after", "root-missing", "replace-root", "arrive", "oversize"] as const) {
    const f = await fixture(Buffer.from("selected pinned ref payload 182736")); const peer = f.repo.objects.write("blob", Buffer.from("unrelated pinned ref peer")); f.repo.refs.compareAndSwap("refs/metadata/pinned", null, peer);
    const directory = join(f.repo.controlDirectory, "refs/metadata"); const path = join(directory, "pinned"); const original = readFileSync(path); let descriptor = -1; let injected = false;
    const read = fs.readFileSync; const open = fs.openSync; const list = fs.readdirSync; const stat = fs.lstatSync;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (String(args[0]) === path && mode === "kind" && !injected) { injected = true; fs.unlinkSync(path); mkdirSync(path); } return open(...args); });
    mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => { const result = list(...args); if (String(args[0]) === join(f.repo.controlDirectory, "refs") && mode === "link-before" && !injected) { injected = true; fs.renameSync(directory, `${directory}.original`); fs.symlinkSync(`${directory}.original`, directory); } return result; });
    mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { const result = stat(...args); if (String(args[0]) === path && !injected && ["held", "root-missing"].includes(mode)) { injected = true; if (mode === "held") writeFileSync(path, Buffer.concat([original, Buffer.from("\n")])); else fs.renameSync(directory, `${directory}.original`); } return result; });
    objectFiles.opened = (file, opened) => { if (opened === path) { descriptor = file.fd; if (mode === "directory" && !injected) { injected = true; fs.unlinkSync(path); mkdirSync(path); } } };
    mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      const result = read(...args);
      if (args[0] === descriptor && !injected && !["held", "root-missing"].includes(mode)) {
        injected = true;
        if (mode === "change") writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
        if (mode === "vanish") fs.unlinkSync(path);
        if (mode === "arrive") writeFileSync(join(directory, "foreign-backup"), f.bytes);
        if (["replace-root", "link-after"].includes(mode)) { fs.renameSync(directory, `${directory}.original`); if (mode === "link-after") fs.symlinkSync(`${directory}.original`, directory); else { mkdirSync(directory); fs.linkSync(join(`${directory}.original`, "pinned"), path); } }
      }
      return result;
    });
    const limit = verificationLimits.receiptBytes;
    if (mode === "oversize") { verificationLimits.receiptBytes = 64; objectFiles.opened = (_file, opened) => { if (opened === path) injected = true; }; }
    syncBuiltinESMExports();
    try { assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "pinned-native-ref", new Date(1)), { code: "unsupported_erasure_storage" }, mode); assert.equal(injected, true, mode); }
    finally { verificationLimits.receiptBytes = limit; mock.restoreAll(); syncBuiltinESMExports(); objectFiles.opened = () => {}; if (["replace-root", "link-before", "link-after", "root-missing"].includes(mode) && injected) { rmSync(directory, { recursive: true, force: true }); fs.renameSync(`${directory}.original`, directory); } else if (["directory", "kind"].includes(mode) && injected) rmSync(path, { recursive: true }); writeFileSync(path, original); }
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  }
});

test("native destruction creation-stage SIGKILL artifacts remain retryable without accepting backup bytes", async () => {
  for (const boundary of ["destruction-owner-opened", "destruction-intent-opened", "destruction-progress-opened"]) {
    const f = await fixture(Buffer.from("native creation crash payload 817263"));
    const child = spawnSync(process.execPath, ["--import", new URL("./helpers/forbid-git.ts", import.meta.url).href, join(packageRoot, "test/helpers/erasure-purge-worker.ts"), f.repo.root, f.fileId, boundary], { env: { ...testEnvironment(), ...discardChildCoverage() }, encoding: "utf8", timeout: 120_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    f.repo.objects.recoverWriterLock();
    assert.equal(f.repo.obliterate(f.fileId, "erase-fixture", "incident", new Date(1)).storage.accountable, true, boundary);
    assert.equal(existsSync(join(f.repo.root, "asset")), false);
  }
});

/** Produce current, archived, progress and owner fixtures through native writers. */
async function nativeControlFixture() {
  const f = await fixture(Buffer.from("selected native compatibility payload 182746")); const control = f.repo.controlDirectory;
  const directory = join(control, "destruction"); let stagedOwner = "";
  destructionBoundary.visit = (step, path) => {
    if (step === "owner-written" && dirname(path) === directory && stagedOwner === "") { stagedOwner = path.replace(/\.[0-9a-f]{12}\.tmp$/, `.${"e".repeat(12)}.tmp`); fs.linkSync(path, stagedOwner); }
  };
  try {
    f.repo.objects.withWriteLock(() => {
      for (let generation = 0; generation < 2; generation++) {
        const path = join(f.repo.root, "native-candidate"); writeFileSync(path, `unrelated generation ${generation}`);
        const plan = prepareDestruction(control, "control-compatibility", [{ path }]); for (const target of plan.paths) plan.remove(target); plan.finish();
      }
    });
  } finally { destructionBoundary.visit = () => {}; }
  const names = readdirSync(directory); assert.ok(names.some(name => name.endsWith(".receipt"))); assert.ok(names.some(name => name.endsWith(".progress")));
  for (const name of names.filter(name => /\.(?:json|receipt|progress)$/.test(name))) copyFileSync(join(directory, name), join(directory, `${name}.${"d".repeat(12)}.tmp`));
  fs.linkSync(stagedOwner, stagedOwner.replace(/\.lock\..*$/, ".lock"));
  return { ...f, directory, names, stagedOwner };
}

test("erasure retains native destruction checkpoints, archives, progress and staged artifacts", async () => {
  const { directory, names, ...f } = await nativeControlFixture();
  // A native checksum can coincidentally contain a canonical base64 token
  // whose decoded prefix resembles zlib. Its fixed binary frame is still valid.
  const retained = await fixture(Buffer.from("972cad1e5f86dbbdd24f4b796e5d9621f53f637a3c63252a6f952be7fad1c47b", "hex"));
  for (const current of [f, retained]) {
    const randomBytes = crypto.randomBytes;
    mock.method(crypto, "randomBytes", ((size: number) => size === 16 ? Buffer.from("00000000000000000000000000000c54", "hex") : randomBytes(size)) as typeof crypto.randomBytes);
    syncBuiltinESMExports();
    try {
      current.repo.objects.withWriteLock(() => {
        const path = join(current.repo.root, "native-bitmap-candidate"); writeFileSync(path, "unrelated binary checksum");
        const plan = prepareDestruction(current.repo.controlDirectory, "binary-progress-compatibility", [{ path }]); for (const target of plan.paths) plan.remove(target); plan.finish();
      });
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    const ledger = join(current.repo.controlDirectory, "destruction");
    const bitmap = readdirSync(ledger).find(name => name.endsWith(".00000000000000000000000000000c54.progress"))!;
    assert.throws(() => inspectRepresentations(readFileSync(join(ledger, bitmap)), () => false), { code: "uninspectable_payload" });
  }
  assert.throws(() => retained.repo.obliterate(retained.fileId, "erase-fixture", "retained-bitmap", new Date(1)), { code: "unsupported_erasure_storage" });
  assert.deepEqual(readFileSync(join(retained.repo.root, "asset")), retained.bytes); assert.equal(retained.repo.objects.denials().length, 0);
  assertDestructionStorage(f.repo.controlDirectory);
  const receipt = f.repo.obliterate(f.fileId, "erase-fixture", "native-compatibility", new Date(1));
  assert.equal(receipt.storage.accountable, true); assert.equal(existsSync(join(f.repo.root, "asset")), false);
  for (const name of names) assert.ok(existsSync(join(directory, name)), "native audit artifacts remain historical evidence");
});

test("erasure rejects malformed native journal shapes without trusting their supported names", async () => {
  const f = await nativeControlFixture(); const owner = f.stagedOwner;
  const original = readFileSync(owner); const value = JSON.parse(original.toString()) as Record<string, unknown>;
  const patches = [{ extra: "backup" }, { format: "foreign" }, { cleanup: "foreign" }, { key: "f".repeat(64) }, { identity: "1:2:3" }, { root: 7 }, { root: "relative" }, { rootIdentity: 7 }, { rootIdentity: "bad" }, { pid: "1" }, { pid: 0 }, { pid: 2_147_483_648 }, { pid: process.pid === 1 ? 2 : 1 }];
  /** Every refused fixture leaves payloads, public reads and denial state unchanged. */
  const refused = (): void => {
    assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "journal-shape", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.deepEqual(f.repo.objects.readTyped(f.id, "blob"), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  };
  try { for (const patch of patches) { writeFileSync(owner, JSON.stringify({ ...value, ...patch })); refused(); } for (const text of ["null", "[]", "7", "invalid"]) { writeFileSync(owner, text); refused(); } }
  finally { writeFileSync(owner, original); }
  const current = f.names.find(name => name.endsWith(".json"))!; const record = JSON.parse(readFileSync(join(f.directory, current), "utf8")) as { id: string; entries: { path: string }[] };
  const wrong = record.id === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
  const foreign = join(f.directory, `${current.slice(0, 64)}.${wrong}.receipt`);
  try { writeFileSync(foreign, JSON.stringify(record)); refused(); } finally { rmSync(foreign); }
  const progress = f.names.find(name => name.endsWith(".progress") && f.names.includes(`${name.slice(0, 97)}.receipt`))!; const path = join(f.directory, progress); const bitmap = readFileSync(path);
  for (const mode of ["header", "length", "state", "archive-id"] as const) {
    const archive = join(f.directory, `${progress.slice(0, 97)}.receipt`); const archived = readFileSync(archive);
    try {
      if (mode === "archive-id") { const row = JSON.parse(archived.toString()) as { id: string }; row.id = wrong; writeFileSync(archive, JSON.stringify(row)); }
      else { const bytes = Buffer.from(bitmap); if (mode === "header") bytes[0] ^= 1; if (mode === "state") bytes[76] = 255; writeFileSync(path, mode === "length" ? Buffer.concat([bytes, Buffer.from([0])]) : bytes); }
      refused();
    } finally { writeFileSync(path, bitmap); writeFileSync(archive, archived); }
  }
  const journal = join(f.directory, current); const previous = readFileSync(journal);
  try { record.entries[0].path = f.bytes.toString(); writeFileSync(journal, JSON.stringify(record)); refused(); }
  finally { writeFileSync(journal, previous); }
});

test("erasure refuses pinned journal and directory races before deleting payloads", async () => {
  for (const mode of ["open", "read", "vanish", "held", "new-name", "directory", "root-missing", "root-link", "root-replaced"] as const) {
    const f = await nativeControlFixture(); const path = join(f.directory, mode.startsWith("root-") ? readdirSync(f.directory).sort().at(-1)! : readdirSync(f.directory).find(name => /\.json\.[0-9a-f]{12}\.tmp$/.test(name))!); const original = readFileSync(path); let descriptor = -1; let injected = false; let observations = 0;
    const read = fs.readFileSync; const stat = fs.lstatSync;
    objectFiles.opened = (file, opened) => { if (opened === path) { descriptor = file.fd; if (mode === "open" && !injected) { injected = true; writeFileSync(path, Buffer.concat([original, Buffer.from("\n")])); } } };
    mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      const result = read(...args);
      if (args[0] === descriptor && !injected && ["root-link", "root-replaced"].includes(mode)) {
        injected = true; fs.renameSync(f.directory, `${f.directory}.original`);
        if (mode === "root-link") fs.symlinkSync(`${f.directory}.original`, f.directory);
        else { mkdirSync(f.directory); for (const name of readdirSync(`${f.directory}.original`)) fs.linkSync(join(`${f.directory}.original`, name), join(f.directory, name)); }
      }
      if (args[0] === descriptor && !injected && ["read", "vanish", "new-name"].includes(mode)) {
        injected = true; if (mode === "vanish") fs.unlinkSync(path); else if (mode === "new-name") writeFileSync(join(f.directory, "foreign-backup"), "foreign bytes"); else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
      }
      return result;
    });
    mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => { const result = stat(...args); if (String(args[0]) === path && ++observations === 2 && ["held", "root-missing"].includes(mode) && !injected) { injected = true; if (mode === "root-missing") fs.renameSync(f.directory, `${f.directory}.original`); else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")])); } return result; });
    if (mode === "directory") {
      f.repo.objects.write("blob", Buffer.from("unrelated scanner tripwire"));
      erasureScanBoundary.visit = step => { if (step === "file-verified" && !injected) { injected = true; fs.renameSync(f.directory, `${f.directory}.original`); writeFileSync(f.directory, "foreign directory replacement"); } };
    }
    syncBuiltinESMExports();
    try { assert.throws(() => f.repo.obliterate(f.fileId, "erase-fixture", "journal-race", new Date(1)), { code: "unsupported_erasure_storage" }, mode); assert.equal(injected, true, mode); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); objectFiles.opened = () => {}; erasureScanBoundary.visit = () => {}; if ((mode === "directory" || mode.startsWith("root-")) && injected) { rmSync(f.directory, { recursive: true, force: true }); fs.renameSync(`${f.directory}.original`, f.directory); } else writeFileSync(path, original); }
    assert.deepEqual(readFileSync(join(f.repo.root, "asset")), f.bytes); assert.deepEqual(f.repo.objects.readTyped(f.id, "blob"), f.bytes); assert.equal(f.repo.objects.denials().length, 0);
  }
});

test("copied foreign backup.pack blocks erasure without deleting the foreign copy or publishing success", async () => {
  const f=await fixture(); f.repo.objects.compact(); const pack=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!;
  const backup=join(dirname(pack.path),"backup.pack"); copyFileSync(pack.path,backup); const original=readFileSync(backup);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),(error:unknown)=>error instanceof ErasureStorageRefusal && error.code==="unverifiable" && error.fileClass==="pack-storage" && !error.message.includes(f.bytes.toString()));
  assert.deepEqual(readFileSync(backup),original); assert.equal(f.repo.objects.denials().length,0);
  rmSync(backup); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(receipt.fileId,f.fileId);
});

test("random foreign stores refuse regardless of diagnostic payload hits", async (t) => {
  let cases=0;
  const paths=["backup.pack","packs/copy.bin","aa/renamed.data","temporary/job/partial.tmp","packs/foreign/deep/member","other/cache/record"];
  for (let encoding=0;encoding<14;encoding++) for (const path of paths) for (const retained of [false,true]) {
    const f=await fixture(); const frame=frameObject("blob",f.bytes); const root=f.repo.objects.storageRoot();
    let encoded:Buffer;
    if (encoding===0) encoded=f.bytes;
    else if (encoding===1) encoded=Buffer.from(f.bytes.toString("base64"));
    else if (encoding<5) encoded=deflateSync(frame,{level:[1,6,9][encoding-2]});
    else {
      f.repo.objects.compact(); const entry=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!; const pack=readFileSync(entry.path);
      const slice=pack.subarray(entry.packed!.offset,entry.packed!.offset+entry.packed!.length);
      encoded=encoding===5?pack:encoding===6?pack.subarray(0,pack.length-1):encoding===7?slice:encoding===8?slice.subarray(0,slice.length-3):Buffer.from(slice);
      if(encoding===9) encoded[encoded.length-1]^=1;
      if(encoding===10) encoded=slice.subarray(2,-4);
      if(encoding===11) encoded=deflateSync(frame,{level:1}).subarray(2,-4);
      if(encoding>=12) encoded=deflateSync(frameObject(encoding===12?"record":"link",f.bytes),{level:9}).subarray(2,-4);
    }
    if(!retained) encoded=Buffer.from(`unrelated-${number()}-clean-storage`);
    const offset=cases%3===0?65_520:number()%129;
    const stored=Buffer.concat([Buffer.alloc(offset,0xa7),encoded,Buffer.alloc(number()%37,0x98)]);
    const foreign=place(root,path,stored);
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${encoding}/${path}/${retained}`);
    assert.equal(f.repo.objects.denials().length,0);assert.deepEqual(readFileSync(foreign),stored);
    rmSync(foreign);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    cases++;
  }
  assert.equal(cases,168); t.diagnostic("168 randomized non-git stores: 14 encodings x 6 locations x retained/clean; random offsets include scanner chunk crossings");
});

test("a post-deletion foreign copy leaves denial pending and native accountability rejects every retry", async () => {
  const f=await fixture(); const ghost=join(f.repo.objects.storageRoot(),"packs/backup.pack"); let injected=false;
  erasureScanBoundary.visit=(step)=>{if(step==="object-deleted"&&!injected){injected=true;place(f.repo.objects.storageRoot(),"packs/backup.pack",Buffer.concat([Buffer.alloc(19,7),f.bytes]));}};
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"}); erasureScanBoundary.visit=()=>{};
  const denial=f.repo.objects.denials()[0]; assert.ok(denial.pending); assert.equal(existsSync(join(f.repo.objects.storageRoot(),f.id.slice(0,2),f.id.slice(2))),false);
  const proof=readFileSync(join(f.repo.controlDirectory,"erasure-verification.json")); assert.equal(proof.includes(f.bytes),false); assert.equal(proof.includes(Buffer.from(f.bytes.toString("base64"))),false);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(ghost); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(receipt.tombstone,denial.id); assert.equal(f.repo.objects.denials()[0].pending,false);
  const again=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)); assert.equal(again.tombstone,receipt.tombstone);
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});

test("SIGKILL at EVERY erasure proof, scan and publication boundary converges without duplicate receipts", async(t)=>{
  const probe=await fixture(); const steps:string[]=[]; erasureScanBoundary.visit=(step)=>steps.push(step);
  probe.repo.obliterate(probe.fileId,"erase-fixture","incident",new Date(1)); erasureScanBoundary.visit=()=>{};
  for(let ordinal=1;ordinal<=steps.length;ordinal++) {
    const f=await fixture();
    const child=spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-scan-worker.ts"),f.repo.root,f.fileId,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
    assert.equal(child.signal,"SIGKILL",`${ordinal}/${steps[ordinal-1]}: ${child.stderr}`);
    f.repo.objects.recoverWriterLock(); const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    assert.equal(f.repo.objects.denials()[0].pending,false); assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(f.repo.controlDirectory,"erasure-verification.json"),"utf8")).records).length,1);
    assert.equal(receipt.fileId,f.fileId);
  }
  t.diagnostic(`${steps.length} SIGKILL boundaries: ${[...new Set(steps)].join(", ")}`);
});

test("fingerprint windows, proof validation, foreign classes and native scanner faults fail safely", async()=>{
  const f=await fixture(); const a=Buffer.from("matching-window"), b=Buffer.from("window"); const patterns=[fingerprint(a),fingerprint(b),fingerprint(a)];
  assert.ok(matchesFingerprints(Buffer.from("padding-matching-window-suffix"),patterns)); assert.equal(matchesFingerprints(Buffer.from("clean"),patterns),false); assert.equal(matchesFingerprints(Buffer.from("clean"),[]),false);
  for(const value of [null,[],{bad:[]},{[f.id]:[null]},{[f.id]:[{length:0,rolling:0,digest:f.id}]},{[f.id]:[{length:2,rolling:-1,digest:f.id}]},{[f.id]:[{length:2,rolling:0,digest:"bad"}]}]) {
    const journal = value===null||Array.isArray(value)?value:fingerprintJournal(value as Record<string,ErasureFingerprint[]>);
    assert.throws(()=>readFingerprints(journal),{code:"unsupported_erasure_storage"});
  }
  assert.deepEqual(readFingerprints(fingerprintJournal({})),{});
  for(const value of [Buffer.from([255]),Buffer.from("four")]) {const proof=fingerprint(value);assert.equal(proof.rolling,0);assert.ok(matchesFingerprints(Buffer.concat([Buffer.from("prefix"),value,Buffer.from("suffix")]),[proof]));}
  const root=join(f.dir.root,"scan"); place(root,"temporary/clean.tmp",Buffer.from("clean"));
  const report=scanErasureStorage(root,patterns); assert.equal(report.foreign,1); assert.equal(report.classes["temporary-storage"],1);
  const before=objectFiles.active.size; const read=fs.readSync;
  mock.method(fs,"readSync",()=>0);syncBuiltinESMExports();assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,before);
  let changed=false;erasureScanBoundary.visit=(step)=>{if(step==="file-chunk"&&!changed){changed=true;writeFileSync(join(root,"temporary/clean.tmp"),"changed-and-longer");}};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"}); erasureScanBoundary.visit=()=>{};
  assert.equal(typeof read,"function");assert.equal(readdirSync(root).length,1);
});


test("scanner covers every regular class and refuses unreadable, aliased, changing or unbounded proof inputs",async()=>{
  const f=await fixture(); const root=join(f.dir.root,"physical");const patterns=[fingerprint(Buffer.from("absent-selected-value"))];
  place(root,"aa/"+"a".repeat(62),Buffer.from("ordinary"));
  place(root,"packs/"+"b".repeat(64)+".pack",Buffer.alloc(0));
  place(root,"packs/foreign/clean",Buffer.from("unrelated"));
  place(root,"other/deep/clean",Buffer.from("unrelated"));
  place(root,"root-copy",Buffer.from("unrelated"));
  const report=scanErasureStorage(root,patterns); assert.equal(report.files,5);assert.equal(Object.keys(report.classes).length,4);
  const plain=place(root,"other/zlib",Buffer.from([0x78,0x9c]));assert.throws(()=>scanErasureStorage(root,patterns),{code:"uninspectable_payload",status:"unverified",bound:"incomplete_stream"});
  writeFileSync(plain,deflateSync(Buffer.alloc(60_000,105)));assert.equal(scanErasureStorage(root,patterns).files,6);
  erasureScanLimits.minimum=0; erasureScanLimits.ratio=0;
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});erasureScanLimits.minimum=16*1024*1024;erasureScanLimits.ratio=1032*6;
  const target=place(f.dir.root,"not-a-directory",Buffer.from("outside"));assert.throws(()=>scanErasureStorage(target,patterns),{code:"unsupported_erasure_storage"});
  fs.symlinkSync(target,join(root,"alias"));assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});rmSync(join(root,"alias"));
  const stat=fs.fstatSync;
  for(const field of ["dev","ino","size","mtimeNs","not-file","oversized"]) {
    let calls=0;
    mock.method(fs,"fstatSync",(...args:Parameters<typeof fs.fstatSync>)=>{
      const value=stat(...args) as fs.BigIntStats;calls++;
      if(field==="not-file")return Object.assign(Object.create(value) as fs.BigIntStats,{isFile:()=>false});
      if(field==="oversized")return Object.assign(Object.create(value) as fs.BigIntStats,{size:BigInt(Number.MAX_SAFE_INTEGER)+1n});
      return calls===2?Object.assign(Object.create(value) as fs.BigIntStats,{[field]:value[field as "dev"|"ino"|"size"|"mtimeNs"]+1n}):value;
    });syncBuiltinESMExports();assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});mock.restoreAll();syncBuiltinESMExports();
  }
  const wrong={...fingerprint(Buffer.from("candidate")),digest:f.id};assert.equal(matchesFingerprints(Buffer.from("candidate"),[wrong]),false);
  assert.equal(objectFiles.active.size,0);
});


test("scanner refuses native open/read failures and namespace arrivals without leaking owners or content",async()=>{
  const f=await fixture(); const root=join(f.dir.root,"io");place(root,"data",Buffer.from("ordinary"));const patterns=[fingerprint(f.bytes)];
  for(const method of ["openSync","readSync"] as const) {
    mock.method(fs,method,()=>{throw Object.assign(new Error("private file contents must not escape"),{code:"EACCES"});});syncBuiltinESMExports();
    assert.throws(()=>scanErasureStorage(root,patterns),(error:unknown)=>error instanceof ErasureStorageRefusal && error.fileClass==="object-root" && !error.message.includes("private file contents"));
    mock.restoreAll();syncBuiltinESMExports();assert.equal(objectFiles.active.size,0);
  }
  let once=false;erasureScanBoundary.visit=(step)=>{if(step==="file-verified"&&!once){once=true;place(root,"new-copy",f.bytes);}};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"unsupported_erasure_storage"});erasureScanBoundary.visit=()=>{};
  assert.throws(()=>scanErasureStorage(root,patterns),{code:"erasure_retained_copy"});
});


test("embedded compressed payloads are detected without a literal raw hit and full decoded slots drain after input exhaustion",async()=>{
  const selected=Buffer.from("selected-compressed-unique-marker-736294".repeat(64)); const f=await fixture(selected);
  const encoded=deflateSync(frameObject("blob",selected),{level:9});assert.equal(encoded.includes(selected),false);
  const generic=join(f.dir.root,"generic-zlib");place(generic,"arbitrary.data",Buffer.concat([Buffer.alloc(65_535,7),encoded.subarray(0,encoded.length-2)]));
  assert.throws(()=>scanErasureStorage(generic,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  rmSync(join(generic,"arbitrary.data"));
  const path=place(f.repo.objects.storageRoot(),"packs/renamed.data",Buffer.concat([Buffer.alloc(65_535,7),encoded.subarray(0,encoded.length-2)]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const unrelated=Buffer.alloc(52_854);for(let i=0;i<unrelated.length;i++)unrelated[i]=97+i%9;
  const root=join(f.dir.root,"compressed-slots");place(root,"unrelated",deflateSync(unrelated,{level:8}));
  assert.equal(scanErasureStorage(root,[fingerprint(selected)]).files,1);
});

test("SIGKILL at every native proof/denial write step resumes with retained foreign temporaries and one receipt",async(t)=>{
  const probe=await fixture();
  /** Use a real child so a crash cannot run JavaScript cleanup or release its writer lease. */
  const run=(f:Awaited<ReturnType<typeof fixture>>,ordinal:number)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-proof-crash.ts"),f.repo.root,f.fileId,String(ordinal)],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
  const listing=run(probe,0);assert.equal(listing.status,0,listing.stderr);const steps=JSON.parse(listing.stdout) as string[];assert.ok(steps.length>=30);
  for(let ordinal=1;ordinal<=steps.length;ordinal++){
    const f=await fixture();const child=run(f,ordinal);assert.equal(child.signal,"SIGKILL",`${ordinal}/${steps[ordinal-1]}: ${child.stderr}`);
    f.repo.objects.recoverWriterLock();const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
    assert.equal(receipt.fileId,f.fileId);assert.equal(f.repo.objects.denials()[0].pending,false);
    assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
  }
  t.diagnostic(`${steps.length} native before/after crash cuts across proof and both denial publications`);
});

test("one non-git tracker serializes a competing erasure at EVERY proof/scan/publication boundary and reports peer success truthfully",async(t)=>{
  const f=await fixture();let attempts=0;
  /** Spawn the same real SDK/engine path, never a mocked lease or manufactured tracker. */
  const run=(mode:string)=>spawnSync(process.execPath,["--import",new URL("./helpers/forbid-git.ts",import.meta.url).href,join(packageRoot,"test/helpers/erasure-peer.ts"),f.repo.root,f.fileId,mode],{env:{...testEnvironment(),...discardChildCoverage(),GIT_CEILING_DIRECTORIES:dirname(f.dir.root)},encoding:"utf8",timeout:30_000});
  erasureScanBoundary.visit=()=>{const peer=run("blocked");assert.equal(peer.status,0,peer.stderr);assert.equal(peer.stdout.trim(),"store_locked");attempts++;};
  const own=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));erasureScanBoundary.visit=()=>{};
  assert.equal(attempts,9);const peer=run("complete");assert.equal(peer.status,0,peer.stderr);const receipt=JSON.parse(peer.stdout) as {tombstone:string};assert.equal(receipt.tombstone,own.tombstone);
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);assert.equal(objectFiles.active.size,0);
  t.diagnostic(`${attempts} competing transitions on the same non-git tracker, followed by truthful idempotent peer success`);
});


test("missing historic/imported diagnostics never bypass native accountability",async()=>{
  const f=await fixture();f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const proofPath=join(f.repo.controlDirectory,"erasure-verification.json");const proof=readFileSync(proofPath);rmSync(proofPath);
  const ghost=place(f.repo.objects.storageRoot(),"packs/foreign-copy",Buffer.concat([Buffer.alloc(31,5),f.bytes]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.ok(readFileSync(ghost).includes(f.bytes));
  writeFileSync(proofPath,proof);assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});
  rmSync(ghost);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});


test("headerless native compressed member copies block erasure",async()=>{
  const selected=Buffer.from("headerless-compressed-marker-739168".repeat(64));const f=await fixture(selected);f.repo.objects.compact();
  const entry=f.repo.objects.inventory().find((entry)=>entry.id===f.id)!;const pack=readFileSync(entry.path);
  const body=pack.subarray(entry.packed!.offset+2,entry.packed!.offset+entry.packed!.length-4);assert.equal(body.includes(selected),false);
  place(f.repo.objects.storageRoot(),"temporary/copied-body",Buffer.concat([Buffer.alloc(17,7),body]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);
});


test("physical proof includes dormant object directories in every registered instance",async()=>{
  const f=await fixture();f.repo.commit({message:"selected",author:{name:"Fixture",email:"fixture@example.invalid",timestamp:1,timezoneOffsetMinutes:0}},new Date(1));
  const instance=makeTempDir();temporary.push(instance);f.repo.linkInstance("secondary",instance.root);
  const local=join(Repository.open(instance.root).controlDirectory,"objects");
  const ghost=place(local,"packs/backup.pack",deflateSync(frameObject("blob",f.bytes)));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);
  place(f.repo.objects.storageRoot(),"packs/active-cache",Buffer.from("harmless active class overlap"));
  writeFileSync(ghost,"harmless foreign instance cache");place(local,"packs/"+"f".repeat(64)+".pack",Buffer.from("harmless inactive native-looking record"));assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2)),{code:"unverifiable"});const receipt=f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(2),{purgeUnaccounted:true});
  assert.equal(receipt.purge.deleted,3);assert.equal(receipt.storage.foreign,0);assert.equal(existsSync(ghost),false);assert.equal(existsSync(join(instance.root,"asset")),false);
});


test("type-independent erasure catches retyped native bodies with stripped wrappers",async()=>{
  const selected=Buffer.from("selected-type-independent-private-marker-389162".repeat(64));const f=await fixture(selected);
  const encoded=deflateSync(frameObject("record",selected),{level:9}).subarray(2,-4);assert.equal(encoded.includes(selected),false);
  const path=place(f.repo.objects.storageRoot(),"packs/foreign-copy",encoded);
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});assert.equal(f.repo.objects.denials().length,0);assert.deepEqual(readFileSync(path),encoded);
});


test("every native object kind and compression level remains denied after wrapper stripping",async(t)=>{
  const selected=Buffer.from("all-kind-native-compressed-marker-681429".repeat(64));const f=await fixture(selected);let cases=0;
  const path=join(f.repo.objects.storageRoot(),"packs/all-kind-copy");mkdirSync(dirname(path),{recursive:true});
  for(const kind of OBJECT_TYPES)for(const level of [1,6,9]){
    const body=deflateSync(frameObject(kind,selected),{level}).subarray(2,-4);writeFileSync(path,body);
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${kind}/${level}`);
    assert.deepEqual(readFileSync(path),body);assert.equal(f.repo.objects.denials().length,0);cases++;
  }
  rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));assert.equal(cases,27);t.diagnostic(`${OBJECT_TYPES.length} frame kinds x three native compression levels = ${cases} wrapper-stripped cases`);
});


test("corrupt fingerprint journal cannot hide a retained raw copy after original bytes disappear",async()=>{
  const selected=Buffer.from("selected-proof-corruption-private-marker-348719".repeat(64));const f=await fixture(selected);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  const path=join(f.repo.controlDirectory,"erasure-verification.json");const saved=readFileSync(path);const journal=JSON.parse(saved.toString()) as {records:Record<string,ErasureFingerprint[]>};
  const id=f.repo.objects.denials()[0].id;const patterns=journal.records[id];const original=fingerprint(selected);const index=patterns.findIndex((item)=>item.length===original.length&&item.digest===original.digest);assert.ok(index>=0);
  patterns[index]={...patterns[index],rolling:(patterns[index].rolling^1)>>>0};writeFileSync(path,JSON.stringify(journal));
  const foreign=place(f.repo.objects.storageRoot(),"packs/foreign-copy",Buffer.concat([Buffer.alloc(19,7),selected]));
  assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),(error:unknown)=>error instanceof ErasureStorageRefusal&&error.code==="unverifiable");assert.ok(readFileSync(foreign).includes(selected));
  writeFileSync(path,saved);assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"});rmSync(foreign);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));
  assert.equal(f.repo.operations.read().filter((entry)=>entry.command==="obliterate").length,1);
});

test("journal rejects unknown versions, checksum changes and malformed signature records",async()=>{
  const f=await fixture();const base=fingerprintJournal({[f.id]:[fingerprint(f.bytes)]});
  for(const patch of [{format:"foreign"},{records:null},{records:[]},{records:7},{checksum:7},{checksum:"bad"},{checksum:"0".repeat(64)}]) assert.throws(()=>readFingerprints({...base,...patch}),{code:"unsupported_erasure_storage"});
  for(const entry of [[],7,{length:null,rolling:0,digest:f.id},{length:2,rolling:1.5,digest:f.id},{length:2,rolling:0x1_0000_0000,digest:f.id},{length:2,rolling:0,digest:7},{...fingerprint(f.bytes),foreign:true}]) {
    const records={[f.id]:[entry]} as unknown as Record<string,ErasureFingerprint[]>;
    assert.throws(()=>readFingerprints(fingerprintJournal(records)),{code:"unsupported_erasure_storage"});
  }
  assert.throws(()=>readFingerprints(7),{code:"unsupported_erasure_storage"});
});

test("nested native encodings remain detectable across offsets, base64 alignments and truncated checksums",async(t)=>{
  const selected=Buffer.from("recursive-native-private-marker-527193".repeat(32));const f=await fixture(selected);
  f.repo.objects.compact();const entry=f.repo.objects.inventory().find((item)=>item.id===f.id)!;const packed=readFileSync(entry.path);
  const compressed=deflateSync(frameObject("record",selected),{level:9});const body=compressed.subarray(2,-4);
  const base64=(bytes:Buffer)=>Buffer.from(bytes.toString("base64"));
  let six=body;for(let depth=0;depth<6;depth++)six=base64(six);
  const representations=[base64(body),base64(compressed),base64(packed),deflateSync(base64(body)),base64(deflateSync(base64(body))),base64(base64(body)),base64(compressed.subarray(0,-2)),base64(Buffer.concat([compressed.subarray(0,-1),Buffer.from([compressed.at(-1)!^1])])),six];
  f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));let cases=0;
  for(const encoded of representations)for(let prefix=0;prefix<4;prefix++)for(const crossing of [false,true]){
    const path=place(f.repo.objects.storageRoot(),"foreign/nested-copy",Buffer.concat([Buffer.alloc(crossing?65_535:7,0xa7),Buffer.from("A".repeat(prefix)),encoded,Buffer.from("BBB!suffix")]));
    assert.throws(()=>f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1)),{code:"unverifiable"},`${cases}/${prefix}/${crossing}`);
    rmSync(path);f.repo.obliterate(f.fileId,"erase-fixture","incident",new Date(1));cases++;
  }
  assert.equal(cases,72);assert.equal(objectFiles.active.size,0);t.diagnostic("72 nested codec cases: 9 representations x 4 alignments x 2 offsets; each followed by a clean successful retry");
});

test("recursive scanner refuses unsupported inspection depth and bounded codec resources without a false success",async()=>{
  const f=await fixture();const root=join(f.dir.root,"bounded-codecs");const path=place(root,"data",Buffer.from("ordinary"));const patterns=[fingerprint(f.bytes)];
  const encoded=Buffer.from(deflateSync(Buffer.from("ordinary bounded representation")).toString("base64"));
  for(const limit of ["depth","contexts","streams","wordBytes"] as const){
    writeFileSync(path,limit==="streams"?deflateSync(Buffer.from("ordinary")):encoded);
    const prior=erasureScanLimits[limit];erasureScanLimits[limit]=0;
    assert.throws(()=>scanErasureStorage(root,patterns),{code:"uninspectable_payload"},limit);erasureScanLimits[limit]=prior;
    assert.equal(objectFiles.active.size,0);
  }
  let deep=Buffer.from("ordinary very deeply wrapped representation");for(let depth=0;depth<8;depth++)deep=Buffer.from(deep.toString("base64"));
  writeFileSync(path,deep);assert.throws(()=>scanErasureStorage(root,patterns),{code:"uninspectable_payload"});
});

test("streaming scanner preserves nested state across compressed input slots and closes active dictionaries on faults",async()=>{
  const f=await fixture();const root=join(f.dir.root,"streaming-codecs");const selected=Buffer.from("compressed-slot-selected-marker-937216".repeat(64));
  const noise=Buffer.alloc(100_000);for(let i=0;i<noise.length;i++)noise[i]=number()>>>24;
  const compressed=deflateSync(Buffer.concat([noise,selected]));assert.ok(compressed.length>65_536);assert.equal(compressed.includes(selected),false);
  const path=place(root,"data",compressed);assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  writeFileSync(path,Buffer.from(compressed.toString("base64")));assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
  writeFileSync(path,compressed);erasureScanBoundary.visit=(step)=>{if(step==="file-chunk")throw new Error("injected scan interruption");};
  assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"unsupported_erasure_storage"});erasureScanBoundary.visit=()=>{};assert.equal(objectFiles.active.size,0);
  // No terminal byte window exists until the final unpadded base64 word is flushed at EOF.
  writeFileSync(path,Buffer.from(deflateSync(selected).toString("base64").replace(/=+$/,"")));
  assert.throws(()=>scanErasureStorage(root,[fingerprint(selected)]),{code:"erasure_retained_copy"});
});


test("suffix filters share width while full SHA proofs distinguish lengths and content",()=>{
  const long=Buffer.from("long-selected-suffix");const short=Buffer.from("d-suffix");const patterns=[fingerprint(long),fingerprint(short),fingerprint(long)];
  assert.equal(patterns[0].rolling,patterns[1].rolling);
  assert.equal(matchesFingerprints(short,[patterns[0]]),false);
  assert.ok(matchesFingerprints(Buffer.concat([Buffer.from("padding"),long]),patterns));
  assert.ok(matchesFingerprints(short,patterns));
  assert.equal(matchesFingerprints(Buffer.from("long-modified-suffix"),[patterns[0]]),false);
});

test("strict physical inventory refuses unknown names while compaction preserves them with reasons",async()=>{
  const f=await fixture();const root=f.repo.objects.storageRoot();const foreign=place(root,"foreign-record",Buffer.from("clean foreign bytes"));
  assert.throws(()=>f.repo.objects.inventory(),{code:"unsupported_erasure_storage"});
  assert.ok(f.repo.objects.compact().skippedCount>0);assert.ok(existsSync(foreign));rmSync(foreign);
  const leaf=place(root,"aa/foreign-record",Buffer.from("clean foreign bytes"));
  assert.throws(()=>f.repo.objects.inventory(),{code:"unsupported_erasure_storage"});
  assert.ok(f.repo.objects.compact().skippedCount>0);assert.ok(existsSync(leaf));
});

test("scanner filter work stays bounded independently of selected representation lengths",()=>{
  const patterns=Array.from({length:40},(_,index)=>fingerprint(Buffer.alloc(100+index,65+index%10)));const bytes=Buffer.alloc(1024,255);
  const imul=Math.imul;let calls=0;mock.method(Math,"imul",(a:number,b:number)=>{calls++;return imul(a,b);});
  assert.equal(matchesFingerprints(bytes,patterns),false);
  assert.ok(calls<=bytes.length*3+128,`rolling filter performed ${calls} operations for ${bytes.length} bytes and ${patterns.length} lengths`);
});

test("constant byte runs skip only equivalent windows and retain cross-chunk matches",async()=>{
  const patterns=Array.from({length:40},(_,index)=>fingerprint(Buffer.alloc(100+index,65+index%10)));const bytes=Buffer.alloc(4096,255);
  const imul=Math.imul;let calls=0;mock.method(Math,"imul",(a:number,b:number)=>{calls++;return imul(a,b);});
  assert.equal(matchesFingerprints(bytes,patterns),false);assert.ok(calls<700,`${calls} operations over one constant run`);mock.restoreAll();
  assert.ok(matchesFingerprints(bytes,[fingerprint(Buffer.alloc(139,255))]));
  const f=await fixture();const root=join(f.dir.root,"constant-runs");const pattern=Buffer.from([255,255,255,254]);const path=place(root,"data",bytes);
  assert.equal(scanErasureStorage(root,[fingerprint(pattern)]).files,1);
  for(const boundary of [65_536,131_072]){
    writeFileSync(path,Buffer.concat([Buffer.alloc(boundary,255),Buffer.from([254])]));
    assert.throws(()=>scanErasureStorage(root,[fingerprint(pattern)]),{code:"erasure_retained_copy"});
  }
});


test("a selected byte decoded only by the final partial quartet cannot escape physical verification",async()=>{
 const f=await fixture();const root=join(f.dir.root,"final-partial-quartet");place(root,"partial",Buffer.from("YQ"));
 assert.throws(()=>scanErasureStorage(root,[fingerprint(Buffer.from("a"))]),{code:"erasure_retained_copy",status:"unverified"});assert.equal(objectFiles.active.size,0);
});
