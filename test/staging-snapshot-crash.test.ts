import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "../engine/repo.ts";
import { objectFiles } from "../engine/object-files.ts";
import { readWorkingFile } from "../engine/worktree.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { testEnvironment } from "./helpers/test-environment.ts";

for (const [cut, linked] of [["created", false], ["written", false], ["index", false], ["created", true], ["written", true]] as const) test(`SIGKILL ${cut} staging snapshot in ${linked ? "shared instance" : "primary"} allows retry and authorized erasure`, async () => {
  const scope = makeTempDir(); const report = join(scope.root, "observation.json");
  const hub = Repository.init(join(scope.root, "repo")); let repo = hub;
  try {
    repo.setAuthority("fixture", "snapshot-read", "snapshot-erase");
    writeFileSync(join(repo.root, "victim"), "original target\n"); repo.stage(["victim"]);
    repo.commit({ message: "snapshot base", author: { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
    if (linked) repo = Repository.open(hub.linkInstance("snapshot", join(scope.root, "instance")).path);
    assert.equal(existsSync(join(repo.root, ".git")), false);
    const victim = repo.readIndex()[0].fileId!;
    const paths = [...Array.from({ length: 8 }, (_, i) => `padding-${i}`), "victim", "last"];
    for (const [i, path] of paths.entries()) writeFileSync(join(repo.root, path), Buffer.alloc(512 * 1024, i + 1));
    const before = readFileSync(join(repo.controlDirectory, "index"));
    const child = fork(join(packageRoot, "test/helpers/staging-snapshot-worker.ts"), [repo.root, JSON.stringify(paths), cut, report], {
      env: testEnvironment(), stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = ""; child.stderr!.on("data", bytes => { stderr += String(bytes); });
    const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Snapshot worker timeout: ${stderr}`)); }, 120_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(killed.signal, "SIGKILL", stderr);
    const observation = JSON.parse(readFileSync(report, "utf8")) as { bytes: number; mode: number | null; directoryMode: number | null; named: boolean; links: number };
    if (process.platform !== "win32") {
      if (observation.mode !== null) assert.equal(observation.mode, 0o600);
      if (observation.directoryMode !== null) assert.equal(observation.directoryMode, 0o700);
    }
    if (cut === "created") assert.equal(observation.bytes, 0);
    else assert.ok(observation.bytes >= 512 * 1024);
    if (cut !== "index") assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before);
    repo.objects.recoverWriterLock();
    repo.stage(paths); assert.equal(repo.readIndex().length, paths.length);
    const erased = repo.obliterate(victim, "snapshot-erase", "interrupted-staging-fixture", new Date(1));
    assert.equal(erased.fileId, victim); assert.equal(existsSync(join(repo.root, "victim")), false);
    assert.equal(existsSync(join(hub.root, "victim")), false);
    assert.ok(readFileSync(join(repo.root, "last")).equals(Buffer.alloc(512 * 1024, paths.length)), "Unrelated file retains exact bytes.");

    if (cut !== "created") {
      assert.equal(observation.named, false);
      if (process.platform !== "win32") assert.equal(observation.links, 0);
    }
    for (const control of new Set([repo.controlDirectory, hub.controlDirectory])) {
      assert.deepEqual(readdirSync(control).filter(name => name.startsWith("stage-")), []);
      for (const name of readdirSync(control).filter(name => /^objects\.lock\..*\.tmp$/.test(name))) {
        assert.equal(readFileSync(join(control, name)).length, 0, "bootstrap residues contain no payload bytes");
      }
    }
  } finally { scope.cleanup(); }
});

test("snapshot reads use explicit offsets and refuse truncated private descriptors", () => {
  const scope = makeTempDir();
  try {
    const repo = Repository.init(join(scope.root, "repo")); const path = join(scope.root, "snapshot");
    writeFileSync(path, "prefixPAYLOADsuffix"); const fd = openSync(path, "r");
    try {
      readFileSync(fd); // An unrelated descriptor cursor must not select the wrong snapshot.
      assert.equal(repo["readStagingSnapshot"](fd, 6, 7).toString(), "PAYLOAD");
      assert.equal(repo["readStagingSnapshot"](fd, 0, 0).length, 0);
      assert.throws(() => repo["readStagingSnapshot"](fd, 0, 100), { code: "source_changed" });
    } finally { closeSync(fd); }
  } finally { scope.cleanup(); }
});


test("deferred refusal closes its anonymous snapshot without publishing payloads", () => {
  const scope = makeTempDir();
  try {
    const repo = Repository.init(join(scope.root, "repo"));
    const paths = Array.from({ length: 10 }, (_, i) => `payload-${i}`);
    for (const path of paths) writeFileSync(join(repo.root, path), Buffer.alloc(512 * 1024, 65));
    const handles = objectFiles.active.size; const inventory = repo.objects.inventory().map(entry => entry.id);
    const visits = new Set<string>(); const failure = new Error("fixture deferred read failure");
    assert.throws(() => repo.stage(paths, (root, path) => {
      if (visits.has(path) && path === paths.at(-1)) throw failure;
      visits.add(path); return readWorkingFile(root, path);
    }), error => error === failure);
    assert.equal(objectFiles.active.size, handles);
    assert.deepEqual(repo.objects.inventory().map(entry => entry.id), inventory); assert.deepEqual(repo.readIndex(), []);
    repo.stage(paths); assert.equal(repo.readIndex().length, paths.length);
    assert.equal(objectFiles.active.size, handles);
  } finally { scope.cleanup(); }
});
