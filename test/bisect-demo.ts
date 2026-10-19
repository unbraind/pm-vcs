/** Reproduce bisect against 34 committed snapshots of a public package tracker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient, runTest } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { effectiveChangeId, readCommit, readTree } from "../engine/model.ts";
import { installPackedExtension, pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";

const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const commits = execFileSync("git", ["-C", source, "log", "-34", "--format=%H", "--", ".agents/pm"], { encoding: "utf8" }).trim().split("\n").reverse();
assert.equal(commits.length, 34);
const root = mkdtempSync(join(tmpdir(), "pm-vcs-public-bisect-"));
const previousWorkspace = process.env.PM_SOURCE_WORKSPACE_ROOT;
process.env.PM_SOURCE_WORKSPACE_ROOT = root;
try {
  const pmRoot = join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
  await client.init("demo", { defaults: true, author: "demo-agent" });
  const item = (await client.create({ type: "Task", title: "Public tracker regression demo", author: "demo-agent" })).item.id;
  await runTest(item, { add: ["command=node probe.mjs"] }, { path: pmRoot, author: "demo-agent" });
  const repository = Repository.init(root);
  writeFileSync(join(root, "probe.mjs"), 'import { existsSync } from "node:fs"; process.exit(existsSync("regression.flag") ? 1 : 0);\n');
  const imported: string[] = [];
  const publicTrees = new Set<string>();
  for (const [index, commit] of commits.entries()) {
    const copy = join(root, "public-tracker");
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy);
    const archive = execFileSync("git", ["-C", source, "archive", commit, ".agents/pm"], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync("tar", ["-x", "--strip-components=2", "-C", copy], { input: archive });
    if (index === 17) writeFileSync(join(root, "regression.flag"), "deliberate reproducer introduced with public snapshot 18\n");
    writeFileSync(join(root, "source-revision.txt"), `${commit}\n`);
    repository.stage([]);
    imported.push(repository.commit({ message: `Public tracker snapshot ${index + 1}: ${commit}`, items: [item],
      author: { name: "demo-agent", email: "demo@example.invalid", timestamp: 1000 + index, timezoneOffsetMinutes: 0 } }, new Date()));
  }
  for (const commit of imported) {
    const entry = readTree(repository.objects, readCommit(repository.objects, commit).tree).find((entry) => entry.name === "public-tracker");
    assert.ok(entry, "the real public tracker must be carried by every imported snapshot");
    publicTrees.add(entry.id);
  }
  assert.ok(publicTrees.size >= 30, "at least 30 distinct public tracker trees must be imported");
  installPackedExtension(root);
  const environment = { ...withoutPmContext(process.env), PM_SOURCE_WORKSPACE_ROOT: root, PM_AUTHOR: "demo-agent" };
  const run = (args: string[]) => execFileSync(process.execPath, [pmExecutable, "--author", "demo-agent", ...args], { cwd: root, env: environment, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  run(["vcs", "bisect", "start", imported[0], imported[33], "--item", item, "--json"]);
  const result = JSON.parse(run(["vcs", "bisect", "run", "--json", "--full"])) as { bisect: { verdict: { commit: string; change: string }; steps: { by: string }[] } };
  assert.equal(result.bisect.verdict.commit, imported[17]);
  assert.equal(result.bisect.verdict.change, effectiveChangeId(imported[17], readCommit(repository.objects, imported[17])));
  assert.equal(repository.refs.resolveHead(), imported[33]);
  assert.equal(readFileSync(join(root, "regression.flag"), "utf8"), "deliberate reproducer introduced with public snapshot 18\n");
  writeFileSync(destination, run(["vcs", "bisect", "status", "--budget", "16000"]));
  process.stdout.write(JSON.stringify({ imported: 34, distinctPublicTrees: publicTrees.size, sourceFirst: commits[0], sourceLast: commits[33], knownBadSource: commits[17],
    firstBad: result.bisect.verdict, executions: result.bisect.steps.filter((step) => step.by === "run").length, originalRestored: true }) + "\n");
} finally {
  if (previousWorkspace === undefined) delete process.env.PM_SOURCE_WORKSPACE_ROOT;
  else process.env.PM_SOURCE_WORKSPACE_ROOT = previousWorkspace;
  rmSync(root, { recursive: true, force: true });
}
