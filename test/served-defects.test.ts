/** Packed, globally installed CLI regression with real PM mutations on Node and Bun. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startRepositoryServer, TokenGrants } from "../engine/serve.ts";
import { Repository } from "../engine/repo.ts";
import { pmExecutable, withoutPmContext, npmPackArguments, npmPackExecutable } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
for (const runtime of [process.execPath, "bun"]) {
  // Bun is a required runtime where CI runs, so a missing Bun there must fail
  // rather than skip. Everywhere else the Node-only development setup keeps
  // working: the Bun case skips with a reason, the Node case always runs.
  const skip = runtime === "bun" && !bunAvailable && process.env.CI === undefined ? "bun is not installed" : false;
  test(`packed global served CLI protects secrets and merges real updates (${runtime === "bun" ? "bun" : "node"})`, { timeout: 240_000, skip }, async () => {
    if (runtime === "bun") assert.ok(bunAvailable, "Bun is required on CI");
    const fixture = makeTempDir();
    const secret = "regression-bearer-secret";
    const password = "regression-password-secret";
    const env = { ...withoutPmContext(process.env), ...discardChildCoverage(), HOME: join(fixture.root, "home"), PM_AUTHOR: "acceptance",
      // pm otherwise spawns a detached telemetry flusher that keeps writing under HOME after each
      // command returns (racing the fixture cleanup) and labels these runs as agent usage.
      PM_TELEMETRY_SOURCE_CONTEXT: "test", PM_TELEMETRY_INLINE_FLUSH: "1" };
    mkdirSync(env.HOME);
    const source = join(fixture.root, "source");
    mkdirSync(source);
    /** Execute a real installed CLI and scan both streams on success and failure. */
    async function pm(cwd: string, args: string[], status = 0, overrides: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
        const child = spawn(runtime, [pmExecutable, ...args, "--json"], { cwd, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
        let stdout = "", stderr = "";
        child.stdout.on("data", (bytes) => { stdout += String(bytes); });
        child.stderr.on("data", (bytes) => { stderr += String(bytes); });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({ status: code, stdout, stderr }));
      });
      for (const token of [secret, password, encodeURIComponent(secret)]) {
        assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, `credential leaked by ${args.slice(0, 2).join(" ")}: ${`${result.stdout}${result.stderr}`.replaceAll(secret, "[secret]").replaceAll(password, "[password]")}`);
      }
      assert.equal(result.status, status, `${result.stdout}${result.stderr}`);
      return result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) as Record<string, unknown>;
    }
    let server: Awaited<ReturnType<typeof startRepositoryServer>> | undefined;
    try {
      const packed = spawnSync(npmPackExecutable(process.platform), npmPackArguments(process.platform, fixture.root), { cwd: packageRoot, env, encoding: "utf8" });
      assert.equal(packed.status, 0, packed.stderr);
      const archive = packed.stdout.trim().split(/\r?\n/).at(-1) as string;
      await pm(source, ["init", "--yes", "--agent-guidance", "skip"]);
      await pm(source, ["package", "install", join(fixture.root, archive), "--global"]);
      await pm(source, ["vcs", "init", "--record-path", ".agents/pm/**/*.toon", "--set-field", "tags:set,updated_at:timestamp"]);
      const id = (await pm(source, ["create", "Task", "Shared regression record"])).id as string;
      await pm(source, ["vcs", "add"]);
      await pm(source, ["vcs", "commit", "--message", "base"]);
      server = await startRepositoryServer({ root: source, host: "127.0.0.1", port: 0, grants: new TokenGrants([{ token: secret, repository: "", access: "write" }]) });
      const url = `http://127.0.0.1:${server.port}`;
      const credentialUrl = `http://${secret}:${password}@127.0.0.1:${server.port}`;
      const a = join(fixture.root, "a"), b = join(fixture.root, "b");
      await pm(source, ["vcs", "clone", credentialUrl, a]);
      await pm(source, ["vcs", "clone", url, b], 0, { PM_VCS_TOKEN: secret });
      assert.equal(readdirSync(join(b, ".pmvcs")).includes("credentials.json"), false);
      await pm(a, ["vcs", "remote"]);
      await pm(source, ["vcs", "clone", credentialUrl, join(fixture.root, "denied")], 1, { PM_VCS_TOKEN: "invalid" });
      await pm(a, ["vcs", "remote", "add", "control", credentialUrl.replace(secret, `${secret}\t`)]);
      await pm(a, ["vcs", "remote", "add", "upstream", credentialUrl]);
      await pm(a, ["vcs", "remote", "add", "upstream", credentialUrl], 1);
      await pm(a, ["vcs", "remote", "add", "malformed", `http://${secret}@[broken`], 1);
      await pm(source, ["vcs", "clone", `http://${secret}@127.0.0.1:1`, join(fixture.root, "unreachable")], 1);
      await pm(source, ["vcs", "clone", credentialUrl, "--unknown-flag"], 2);
      await pm(a, ["vcs", "fetch", "upstream"]);
      await pm(a, ["update", id, "--priority", "1"]);
      await pm(a, ["vcs", "status"]);
      await pm(a, ["vcs", "add"]);
      await pm(a, ["vcs", "commit", "--message", "priority"]);
      await pm(a, ["vcs", "push"]);
      await pm(b, ["update", id, "--tags", "web,api"]);
      await pm(b, ["vcs", "add"]);
      await pm(b, ["vcs", "commit", "--message", "tags"]);
      await pm(b, ["vcs", "push"], 1, { PM_VCS_TOKEN: secret });
      await pm(b, ["vcs", "fetch"], 0, { PM_VCS_TOKEN: "invalid", PM_VCS_TOKEN_ORIGIN: secret });
      const merge = await pm(b, ["vcs", "merge", "origin/main", "--message", "merge fields"]);
      assert.deepEqual((merge.merge as { conflicts: unknown[] }).conflicts, []);
      await pm(b, ["vcs", "push"], 0, { PM_VCS_TOKEN: secret });
      await pm(a, ["vcs", "fetch"]);
      await pm(a, ["vcs", "merge", "origin/main"]);
      // A legacy map migrates when listed, keeping the old credential usable.
      writeFileSync(join(a, ".pmvcs/remotes.json"), JSON.stringify({ origin: credentialUrl }));
      await pm(a, ["vcs", "remote"]);
      await pm(a, ["vcs", "fetch"]);
      await pm(a, ["vcs", "fetch"], 1, { PM_VCS_TOKEN: "invalid" });
      for (const root of [source, a, b]) {
        await pm(root, ["vcs", "oplog"]);
        const verified = await pm(root, ["vcs", "verify"]);
        assert.deepEqual(verified.corrupt, []);
        const repository = Repository.open(root);
        assert.equal(repository.readIndex().some((entry) => entry.path.includes("/runtime/")), false);
        assert.equal(repository.status().untracked.some((path) => path.includes("/runtime/")), false);
        const oplog = JSON.stringify(repository.operations.read());
        const remotes = readdirSync(repository.controlDirectory).includes("remotes.json") ? readFileSync(join(repository.controlDirectory, "remotes.json"), "utf8") : "";
        for (const token of [secret, password]) assert.equal(`${oplog}${remotes}`.includes(token), false);
      }
      if (process.platform !== "win32") assert.equal(statSync(join(a, ".pmvcs/credentials.json")).mode & 0o777, 0o600);
    } finally { await server?.close(); rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}


test("missing Bun skips locally and fails explicitly on CI", () => {
  const fixture = makeTempDir();
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: fixture.root };
    delete env.CI;
    delete env.NODE_TEST_CONTEXT;
    const args = ["--test", "--test-reporter=tap", "--test-name-pattern=^packed global.*\\(bun\\)$", import.meta.filename];
    const local = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /SKIP bun is not installed/);
    const ci = spawnSync(process.execPath, args, { env: { ...env, CI: "true" }, encoding: "utf8" });
    assert.equal(ci.status, 1);
    assert.match(ci.stdout, /Bun is required on CI/);
  } finally { fixture.cleanup(); }
});
