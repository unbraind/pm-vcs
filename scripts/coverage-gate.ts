import { durability } from "../engine/durability.ts";
import { createHash } from "node:crypto";
/** Shard the existing c8 gate and merge location-keyed raw hits before enforcing its unchanged per-file thresholds. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { globSync, mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { shardTestFiles } from "../test/helpers/ci-shards.ts";

/** Run a c8 command with independent output and no inherited test-runner context. */
function c8(root: string, args: string[]): number {
  const { NODE_TEST_CONTEXT: _context, NODE_TEST_WORKER_ID: _worker, ...env } = process.env;
  const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("c8/bin/c8.js"), ...args], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Merge V8 offsets through c8 before conversion so conditional range inventories equal an unsharded run. */
export function mergeCoverage(root: string, paths: readonly string[], total: number): number {
  const flags = coverageFlags(root).filter(flag => !flag.startsWith("--temp-directory="));
  if (paths.length !== total || total < 1) throw new Error("coverage-gate: missing shards");
  const scratch = mkdtempSync(join(root, "coverage", "merged-raw-"));
  try {
    const ordinals = new Set<string>();
    for (const [index, path] of paths.entries()) {
      const artifact = JSON.parse(readFileSync(resolve(root, path), "utf8"));
      if (!Array.isArray(artifact.raw)) throw new Error(`coverage-gate: ${path} has no raw hits array`);
      if (typeof artifact.shard !== "string") throw new Error(`coverage-gate: ${path} has no shard ordinal`);
      if (artifact.node !== process.versions.node || ordinals.has(artifact.shard)) throw new Error("coverage-gate: duplicate shard or runtime mismatch");
      ordinals.add(artifact.shard);
      if (artifact.digest !== coverageDigest(root)) throw new Error("coverage-gate: source mismatch");
      const result = artifact.raw.map((script: {url: string}) => {
        if (script.url.startsWith("..") || resolve(root, script.url) === script.url) throw new Error("coverage-gate: non-relative source");
        return {...script, url:pathToFileURL(resolve(root, script.url)).href};
      });
      writeFileSync(join(scratch, `coverage-${index}.json`), JSON.stringify({result}));
    }
    for (let i = 1; i <= total; i++) if (!ordinals.has(`${i}/${total}`)) throw new Error("coverage-gate: incomplete shard set");
    const finalPath = join(root, "coverage/coverage-final.json");
    const summaryPath = join(root, "coverage/coverage-summary.json");
    rmSync(finalPath, { force: true });
    rmSync(summaryPath, { force: true });
    const status = c8(root, ["report", ...flags, `--temp-directory=${scratch}`]);
    if (status !== 0 && !(existsSync(finalPath) && existsSync(summaryPath))) return status;
    const merged = JSON.parse(readFileSync(finalPath, "utf8"));
    writeFileSync(join(root, "coverage/merged.json"), JSON.stringify(merged, null, 2));
    console.log("Merged coverage:", readFileSync(summaryPath, "utf8"));
    return status;
  } finally {
    durability.discardTemporary(scratch);
  }
}

/** Keep the deep/local command intact; PR shards only replace collection and output arguments. */
export function runCoverageShard(root: string, shard: string, output: string): number {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard) || Number(shard.split("/")[0]) > Number(shard.split("/")[1])) throw new Error("coverage-gate: invalid shard");
  const flags = coverageFlags(root).filter(flag => flag !== "--100" && !flag.startsWith("--temp-directory=") && !flag.startsWith("--reporter="));
  const status = c8(root, [...flags, "--check-coverage=false", `--temp-directory=${output}/tmp`, `--reports-dir=${output}`, "--reporter=json", "--reporter=json-summary", "node", "--expose-gc", "--no-concurrent-array-buffer-sweeping", "--test", "--test-concurrency=1", ...shardTestFiles(root, shard)]);
  if (status !== 0) return status;
  const raw = JSON.parse(readFileSync(resolve(root, output, "coverage-final.json"), "utf8"));
  const hits = Object.fromEntries(Object.entries(raw).map(([file, data]) => [relative(root, file).replaceAll("\\", "/"), { ...(data as object), path: relative(root, file).replaceAll("\\", "/") }]));
  const sources = new Set(globSync(["*.ts", "src/**/*.ts", "engine/**/*.ts", "scripts/**/*.ts"], {cwd:root}).map(file => pathToFileURL(resolve(root,file)).href));
  const offsets = readdirSync(resolve(root,output,"tmp")).filter(name => name.endsWith(".json")).flatMap(name => {
    const data = JSON.parse(readFileSync(resolve(root,output,"tmp",name),"utf8"));
    return data.result.filter((script: {url:string}) => sources.has(script.url)).map((script: {url:string}) => ({...script,url:relative(root,fileURLToPath(script.url)).replaceAll("\\","/")}));
  });
  writeFileSync(resolve(root, output, "hits.json"), JSON.stringify({ shard, node: process.versions.node, digest: coverageDigest(root), hits, raw:offsets }));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  process.exitCode = args[0] === "--shard" ? runCoverageShard(process.cwd(), args[1]!, args[3]!) : mergeCoverage(process.cwd(), args.slice(2), Number(args[1]));
}

/** Bind artifacts to the complete measured source inventory and original gate options. */
function coverageDigest(root: string): string {
  const sources = globSync(["*.ts", "src/**/*.ts", "engine/**/*.ts", "scripts/**/*.ts"], {cwd:root}).sort();
  return createHash("sha256").update(JSON.stringify(sources.map(file => [file, readFileSync(join(root,file),"utf8")])) + readFileSync(join(root,"package.json"),"utf8")).digest("hex");
}

/** Read the original c8 source scope and options from the unchanged local/deep command. */
function coverageFlags(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const command = manifest.scripts.coverage.split(" && ").at(-1) as string;
  const tokens = command.replaceAll("'", "").split(" ");
  return tokens.slice(1, tokens.indexOf("node"));
}
