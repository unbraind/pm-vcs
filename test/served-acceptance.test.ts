/** Multi-process socket publication and real PM TOON record convergence acceptance. */
import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { cloneFrom, fetchFrom, pushTo } from "../engine/sync.ts";
import { startRepositoryServer } from "../engine/serve.ts";
import { pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const author = { name: "Agent", email: "agent@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date("2026-10-05T00:00:00Z");

/** Write, stage and commit one change with stable fixture attribution. */
function commit(repository: Repository, path: string, text: string): string {
  writeFileSync(join(repository.root, path), text);
  repository.stage([path]);
  return repository.commit({ message: "agent change\n", author }, now);
}

/** Start a pusher and hold it after it has read the receiver's branch tips. */
async function preparePusher(root: string, url: string, branch: string): Promise<{ worker: ChildProcess; result: Promise<string> }> {
  const worker = fork(join(packageRoot, "test/helpers/push-worker.ts"), [root, url, branch], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    worker.on("error", rejectReady);
    worker.once("exit", (code) => { if (code !== 0) rejectReady(new Error(`pusher exited ${code}`)); });
    worker.once("message", () => resolveReady());
  });
  const result = new Promise<string>((resolveResult, rejectResult) => {
    worker.on("message", (message: { result?: string }) => { if (message.result !== undefined) resolveResult(message.result); });
    worker.on("error", rejectResult);
  });
  await ready;
  return { worker, result };
}

test("two real processes race on one branch and both land on different branches", { timeout: 60_000 }, async () => {
  const fixture = makeTempDir();
  const source = Repository.init(join(fixture.root, "origin"));
  const base = commit(source, "base.txt", "base");
  const server = await startRepositoryServer({ root: fixture.root, host: "127.0.0.1", port: 0 });
  const workers: ChildProcess[] = [];
  try {
    const url = `http://127.0.0.1:${server.port}/origin`;
    const a = Repository.open((await cloneFrom(url, join(fixture.root, "a"), now)).root);
    const b = Repository.open((await cloneFrom(url, join(fixture.root, "b"), now)).root);
    const tipA = commit(a, "a.txt", "a");
    const tipB = commit(b, "b.txt", "b");
    const pair = await Promise.all([preparePusher(a.root, url, "main"), preparePusher(b.root, url, "main")]);
    workers.push(...pair.map((pusher) => pusher.worker));
    for (const pusher of pair) pusher.worker.send("publish");
    assert.deepEqual((await Promise.all(pair.map((pusher) => pusher.result))).sort(), ["non_fast_forward", "ok"]);
    assert.ok([tipA, tipB].includes(source.refs.read("refs/heads/main") ?? ""));
    assert.notEqual(source.refs.read("refs/heads/main"), base);
    assert.equal(readdirSync(join(source.controlDirectory, "refs/heads")).some((path) => path.endsWith(".lock")), false);
    a.createBranch("agent-a", tipA, now);
    b.createBranch("agent-b", tipB, now);
    const separate = await Promise.all([preparePusher(a.root, url, "agent-a"), preparePusher(b.root, url, "agent-b")]);
    workers.push(...separate.map((pusher) => pusher.worker));
    for (const pusher of separate) pusher.worker.send("publish");
    assert.deepEqual(await Promise.all(separate.map((pusher) => pusher.result)), ["ok", "ok"]);
    assert.equal(source.refs.read("refs/heads/agent-a"), tipA);
    assert.equal(source.refs.read("refs/heads/agent-b"), tipB);
    for (const id of source.allReachable()) source.objects.read(id);
  } finally {
    for (const worker of workers) worker.kill();
    await server.close();
    fixture.cleanup();
  }
});

/** Run the installed PM CLI against one disposable tracker and return its JSON receipt. */
function pm(root: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [pmExecutable, ...args, "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: "acceptance" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("two served clones commit real PM item fields, merge them and verify all three stores", { timeout: 120_000 }, async () => {
  const fixture = makeTempDir();
  const root = join(fixture.root, "origin");
  mkdirSync(root);
  pm(root, ["init", "served-acceptance", "--yes", "--agent-guidance", "skip"]);
  const id = pm(root, ["create", "Task", "Shared served item"]).id as string;
  const itemPath = join(".agents/pm", readdirSync(join(root, ".agents/pm"), { recursive: true }).find((path) => String(path).endsWith(`${id}.toon`)) as string);
  const source = Repository.init(root, "main", {
    recordPaths: [".agents/pm/**/*.toon"],
    recordPolicy: { fields: { tags: "set", comments: "sequence", updated_at: "timestamp" } },
  });
  source.stage([]);
  source.commit({ message: "base PM record\n", author }, now);
  const server = await startRepositoryServer({ root: fixture.root, host: "127.0.0.1", port: 0 });
  try {
    const url = `http://127.0.0.1:${server.port}/origin`;
    const a = Repository.open((await cloneFrom(url, join(fixture.root, "a"), now)).root);
    const b = Repository.open((await cloneFrom(url, join(fixture.root, "b"), now)).root);
    pm(a.root, ["update", id, "--priority", "1"]);
    pm(b.root, ["update", id, "--tags", "web,api"]);
    for (const repository of [a, b]) {
      assert.ok(readdirSync(join(repository.root, ".agents/pm/runtime")).length > 0);
      assert.equal(repository.status().untracked.some((path) => path.includes("/runtime/")), false);
      repository.stage([]);
      assert.equal(repository.readIndex().some((entry) => entry.path.includes("/runtime/")), false);
      repository.commit({ message: "agent PM field\n", author }, now);
    }
    await pushTo(a, "origin", [], false, now);
    await assert.rejects(pushTo(b, "origin", [], false, now), { code: "non_fast_forward" });
    await fetchFrom(b, "origin", now);
    const merged = b.merge("origin/main", { message: "merge agent fields\n", author }, now);
    assert.equal(merged.conflicts.length, 0, JSON.stringify(merged.conflicts));
    await pushTo(b, "origin", [], false, now);
    await fetchFrom(a, "origin", now);
    a.merge("origin/main", { message: "converge\n", author }, now);
    const record = readFileSync(join(a.root, itemPath), "utf8");
    assert.match(record, /priority: 1/);
    assert.match(record, /web/);
    assert.match(record, /api/);
    assert.equal(readFileSync(join(b.root, itemPath), "utf8"), record);
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
    for (const repository of [source, a, b]) {
      const verified = await harness.runCommand({ command: "vcs verify", pmRoot: repository.root });
      assert.equal(verified.errorMessage, undefined);
      assert.deepEqual((verified.result as { corrupt: string[] }).corrupt, []);
      assert.equal(repository.refs.read("refs/heads/main"), b.refs.read("refs/heads/main"));
    }
    console.log("E2E: served base PM TOON; cloned agents A/B; committed priority/tags; A push accepted; B stale push refused; B fetched and merged with zero conflicts; B push accepted; A fetched and fast-forwarded; vcs verify clean on origin/A/B.");
  } finally { await server.close(); fixture.cleanup(); }
});
