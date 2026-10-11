import { spawnSync } from "node:child_process";
import { pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";
/** Real PM tracker, SDK extension loader and safe prototype-like remote names. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { remoteLeaseProofs } from "../engine/lease-workflows.ts";
import { createSandbox } from "./helpers/sandbox.ts";
import { packageRoot, makeTempDir as temporaryDirectory } from "./helpers/tmp.ts";

test("real extension lease and push workflows persist __proto__, constructor and toString remotes safely", async () => {
  const sandbox = createSandbox({ mergeInstall: false, commitFence: false });
  const dir = temporaryDirectory();
  try {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
    const sender = Repository.init(sandbox.root);
    writeFileSync(join(sender.root, "asset"), "leased asset"); sender.stage(["asset"]);
    sender.commit({ message: "asset", author: { name: "Author", email: "author@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date());
    const fileId = sender.readIndex()[0].fileId!;
    for (const remote of ["__proto__", "constructor", "toString"]) {
      const receiver = Repository.init(join(dir.root, remote)); sender.remotes.add(remote, receiver.root);
      assert.deepEqual(remoteLeaseProofs(sender, remote), []);
      const acquire = await harness.runCommand({ command: "vcs lease", args: ["acquire", fileId, remote], options: { refs: "refs/heads/main", ttlMs: "60000" }, pmRoot: sandbox.pmRoot });
      assert.equal(acquire.handled, true, acquire.errorMessage ?? "Acquire failed");
      assert.equal(remoteLeaseProofs(sender, remote).length, 1);
      const pushed = await harness.runCommand({ command: "vcs push", args: [remote], pmRoot: sandbox.pmRoot });
      assert.equal(pushed.handled, true, pushed.errorMessage ?? "Push failed"); assert.equal(receiver.resolve("main"), sender.resolve("main"));
      for (const action of ["inspect", "renew", "release"]) {
        const result = await harness.runCommand({ command: "vcs lease", args: [action, fileId, remote], pmRoot: sandbox.pmRoot });
        assert.equal(result.handled, true, result.errorMessage ?? "Lease operation failed");
      }
      assert.deepEqual(remoteLeaseProofs(sender, remote), []);
      const registry = JSON.parse(readFileSync(join(sender.controlDirectory, "lease-proofs.json"), "utf8")) as Record<string, unknown>;
      assert.ok(Object.hasOwn(registry, remote)); assert.ok(Object.hasOwn(registry, "__proto__"));
    }
    // Install actual compiled extension bytes in the SDK's project extension layout.
    const installed = join(sandbox.pmRoot, "extensions", "pm-vcs"); mkdirSync(installed, { recursive: true });
    for (const name of ["manifest.json", "package.json"]) copyFileSync(join(packageRoot, name), join(installed, name));
    cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
    symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "junction");
    writeFileSync(join(sender.root, "asset"), "CLI leased revision"); sender.stage(["asset"]);
    sender.commit({ message: "CLI lease workflow", author: { name: "Author", email: "author@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date());
    for (const remote of ["__proto__", "constructor", "toString"]) {
      for (const action of ["acquire", "push", "release"]) {
        const arguments_ = action === "push" ? ["vcs", "push", remote]
          : ["vcs", "lease", action, fileId, remote, "--refs", "refs/heads/main", "--ttl-ms", "86400000"];
        const result = spawnSync(process.execPath, [pmExecutable, ...arguments_, "--json"], { cwd: sender.root, env: withoutPmContext(process.env), encoding: "utf8", timeout: 120000 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        if (action === "acquire") {
          const state = JSON.parse(result.stdout) as { lease: { expiry: number } }; assert.ok(state.lease.expiry - Date.now() > 86280000); assert.ok(state.lease.expiry - Date.now() <= 86400000);
        }
      }
      assert.equal(Repository.open(join(dir.root, remote)).resolve("main"), sender.resolve("main"));
      assert.deepEqual(remoteLeaseProofs(sender, remote), []);
    }
    const origin = Repository.init(join(dir.root, "origin")); sender.remotes.add("origin", origin.root);
    const absent = await harness.runCommand({ command: "vcs lease", args: ["inspect", fileId], pmRoot: sandbox.pmRoot });
    assert.equal(absent.handled, true, absent.errorMessage ?? "Inspect failed");
    assert.equal((absent.result as { lease: unknown }).lease, null);
    const bad = await harness.runCommand({ command: "vcs lease", args: ["unknown", fileId], pmRoot: sandbox.pmRoot });
    assert.equal(bad.handled, false); assert.match(bad.errorMessage!, /Unknown lease action/);
  } finally { sandbox.cleanup(); dir.cleanup(); }
});
