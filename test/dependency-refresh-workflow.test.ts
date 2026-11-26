import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import { discardChildCoverage } from "./helpers/sandbox.ts";

type GateStep = { run: string; env?: Record<string, string> };

/** Read a gate's shell script and step environment from the workflow. */
function gateStep(file: string, job: string, name: string): GateStep {
  const workflow = parseDocument(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"), { uniqueKeys: true });
  assert.deepEqual(workflow.errors, []);
  const steps = workflow.toJS().jobs[job].steps as (GateStep & { name: string })[];
  const step = steps.find(step => step.name === name);
  assert.ok(step?.run, `missing ${name}`);
  return step;
}

/** Read both tiers, expanding the deep matrix and substituting the coverage probe. */
function gateScripts(): GateStep[] {
  const quick = gateStep("ci.yml", "release-gate", "Non-coverage release gates");
  const coverage = gateStep("ci.yml", "coverage-shard", "Collect coverage shard");
  const deep = gateStep("ci-deep.yml", "deep", "Full release gate");
  return [
    quick,
    { ...coverage, run: coverage.run.replace(/^.*NPM_CONFIG_USERCONFIG=.*$/m, "NPM_CONFIG_USERCONFIG=/dev/null npm run release:check") },
    ...["npm", "bun"].map(manager => ({ ...deep, run: deep.run.replaceAll("${{ matrix.package-manager }}", manager) })),
  ];
}

const gateSpaceProbe = `df() {
  if [[ "$2" == "/" ]]; then
    if [[ "$1" == "-Pk" ]]; then
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 99999999 1 %s 1%% /\n' "$GATE_FREE_KIB"
    else
      printf 'root space fixture\n'
    fi
  else
    return 99
  fi
}
`;

/** Check optional witness tools without making them prerequisites for Node tests. */
function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { env: testEnvironment(), stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

/** Execute the PR-creation shell block with disposable Git, npm and GitHub doubles. */
function runCreationStep(failPr: boolean, failSnapshot = false): { status: number | null; calls: string[][]; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-refresh-workflow-"));
  try {
    const workflow = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
    const step = workflow.slice(workflow.indexOf("      - name: Create dependency refresh PR"));
    const marker = "        run: |\n";
    assert.ok(step.includes(marker), "PR creation must contain a shell block");
    const script = step.slice(step.indexOf(marker) + marker.length).split("\n")
      .map((line) => line.replace(/^          /u, "")).join("\n");
    const log = join(root, "calls.jsonl");
    writeFileSync(join(root, "git"), `#!/bin/sh
if [ "$1" = commit ]; then touch "$CANDIDATE_RECEIPT"; fi
if [ "$1" = push ] && [ ! -f "$SNAPSHOT_RECEIPT" ]; then exit 24; fi
exit 0
`);
    const npmDouble = `npm() {
  if [ "$*" != 'run accept:self-host' ] || [ ! -f "$CANDIDATE_RECEIPT" ]; then return 23; fi
  if [ "$FAIL_SNAPSHOT" = yes ]; then return 19; fi
  touch "$SNAPSHOT_RECEIPT"
}
`;
    writeFileSync(join(root, "date"), "#!/bin/sh\nprintf '%s\\n' '2026-10-04'\n");
    writeFileSync(join(root, "gh"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "pr" && process.env.FAIL_PR === "yes") process.exit(17);\n`);
    for (const name of ["git", "date", "gh"]) chmodSync(join(root, name), 0o755);
    const result = spawnSync("bash", ["-c", npmDouble + script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...testEnvironment(),
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "unbraind/pm-vcs",
        GITHUB_RUN_ID: "123",
        CALL_LOG: log,
        FAIL_PR: failPr ? "yes" : "no",
        FAIL_SNAPSHOT: failSnapshot ? "yes" : "no",
        CANDIDATE_RECEIPT: join(root, "candidate-committed"),
        SNAPSHOT_RECEIPT: join(root, "snapshot-verified"),
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
    return { status: result.status, calls, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("token-created refresh PR dispatches CI on its actual collision-safe head", () => {
  const result = runCreationStep(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2, "PR creation must be followed by an explicit CI dispatch");
  const [create, dispatch] = result.calls;
  assert.ok(create && dispatch);
  assert.deepEqual(create.slice(0, 2), ["pr", "create"]);
  const branch = create[create.indexOf("--head") + 1];
  assert.equal(branch, "dependency-refresh/2026-10-04-run-123");
  assert.deepEqual(dispatch, ["workflow", "run", "ci.yml", "-R", "unbraind/pm-vcs", "--ref", branch]);
});

test("failed PR creation cannot dispatch CI and retains its failure status", () => {
  const result = runCreationStep(true);
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0]?.slice(0, 2), ["pr", "create"]);
});

test("dependency refresh snapshots staged inputs and refuses publication on failed committed parity", () => {
  const refresh = gateStep("dependency-refresh.yml", "refresh", "Refresh dependencies");
  assert.match(refresh.run, /git add -- package\.json package-lock\.json\nnpm run self-host:write -- --staged/u);
  assert.match(refresh.run, /git diff --quiet HEAD -- package\.json package-lock\.json selfhost\.bundle/u);
  const result = runCreationStep(false, true);
  assert.equal(result.status, 19, result.stderr);
  assert.deepEqual(result.calls, [], "a failed candidate must not create a PR or dispatch CI");
});

test("manual CI dispatch preserves all four required check names", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const refresh = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
  assert.match(ci.slice(0, ci.indexOf("jobs:")), /^  workflow_dispatch:/mu);
  assert.match(refresh.slice(0, refresh.indexOf("concurrency:")), /^  actions: write$/mu);
  const jobs = parseDocument(ci).toJS().jobs;
  const names = ["test", "windows-acceptance-launcher"].flatMap(name => jobs[name].strategy.matrix["node-version"].map((version:number) => `${name} (${version})`));
  assert.deepEqual(names, ["test (22)", "test (26)", "windows-acceptance-launcher (22)", "windows-acceptance-launcher (26)"]);
});

test("dependency refresh provisions the CI-pinned Bun runtime before release checks", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const refresh = readFileSync(new URL("../.github/workflows/dependency-refresh.yml", import.meta.url), "utf8");
  const setupStep = parseDocument(ci).toJS().jobs["release-gate"].steps.find((step:{uses?:string})=>step.uses?.startsWith("oven-sh/setup-bun@"));
  assert.match(setupStep.uses, /^oven-sh\/setup-bun@[a-f0-9]{40}$/);
  const refreshSteps = parseDocument(refresh).toJS().jobs.refresh.steps as {uses?:string;name:string;with?:Record<string,string>}[];
  const setup = refreshSteps.findIndex(step=>step.uses === setupStep.uses);
  const gate = refresh.indexOf("      - name: Run release checks");
  assert.ok(setup >= 0, "refresh must use the same pinned Bun action as CI");
  assert.equal(refreshSteps[setup].with?.["bun-version"], setupStep.with["bun-version"]);
  assert.ok(refreshSteps.findIndex(step=>step.name === "Run release checks") > setup, "Bun must be provisioned before the release gate");
  assert.match(refresh.slice(gate), /run: npm run release:check/u);
});

test("Bun CI gate executes tracker lens tests in the Bun runtime", {
  skip: !commandAvailable("bash") || !commandAvailable("bun"),
}, () => {
  const workflow = parseDocument(readFileSync(new URL("../.github/workflows/ci-deep.yml", import.meta.url), "utf8")).toJS();
  const native = workflow.jobs.deep.steps.find((step: { name: string }) => step.name === "Native Bun contract tests").run as string;
  const script = "bun run release:check\n" + native;
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-bun-workflow-"));
  try {
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "release:check": "node -e \"require('node:fs').writeFileSync('gate-ran', 'yes')\"" } }));
    writeFileSync(join(root, "test/tracker-lenses.test.ts"), `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("runtime witness", () => { assert.ok(process.versions.bun); writeFileSync("bun-ran", process.versions.bun); });
`);
    writeFileSync(join(root, "test/change-bundles.test.ts"), "");
    const result = spawnSync("bash", ["-e", "-c", script], { env: testEnvironment({ RUNNER_TEMP: root }), cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "gate-ran"), "utf8"), "yes");
    assert.ok(readFileSync(join(root, "bun-ran"), "utf8"), "workflow must execute tests under Bun");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release gates retire only their own scratch receipts after success and failure", () => {
  const root=mkdtempSync(join(tmpdir(),"pm-vcs-gate-scratch-"));const runner=join(root,"runner");const outside=join(root,"outside");mkdirSync(runner);mkdirSync(outside);writeFileSync(join(runner,"foreign"),"unrelated runner file");writeFileSync(join(outside,"foreign"),"unrelated audit file");
  const allocations=join(root,"allocations.json");
  const probe=`import assert from 'node:assert/strict';import {mkdtempSync,readdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,sep} from 'node:path';import {ObjectStore} from ${JSON.stringify(new URL("../engine/objects.ts",import.meta.url).href)};assert.ok(tmpdir().startsWith(process.env.RUNNER_TEMP+sep));const root=mkdtempSync(join(tmpdir(),'native-store-'));new ObjectStore(join(root,'objects')).write('blob',Buffer.from('fixture'));assert.ok(readdirSync(tmpdir()).some(name=>name.startsWith('pm-vcs-namespace-')));writeFileSync(join(tmpdir(),'owned-receipt'),'fixture');writeFileSync(process.env.GATE_ALLOCATIONS,JSON.stringify({disk:tmpdir(),memory:process.env.PM_VCS_CRASH_TMPDIR}));process.exit(Number(process.env.GATE_FAILURE));`;
  try {
    for(const { run, env } of gateScripts())for(const status of [0,7])for(const metrics of [true,false]){

      const command=(metrics?'':'df() { if [[ "$2" == "/" ]]; then command df "$@"; else return 99; fi; }; du() { return 98; };\n')+'npm() { if [[ -z ${gate_probed:-} ]]; then gate_probed=yes; "$GATE_NODE" --input-type=module -e "$GATE_PROBE"; fi; }; bun() { npm; };\n'+run;
      const result=spawnSync("bash",["-c",command],{env:testEnvironment({...env,RUNNER_TEMP:runner,TMPDIR:outside,PM_VCS_CRASH_TMPDIR:outside,GATE_ALLOCATIONS:allocations,GATE_NODE:process.execPath,GATE_PROBE:probe,GATE_FAILURE:String(status)}),encoding:"utf8",timeout:60_000});
      assert.equal(result.status,status,result.stderr);assert.match(result.stdout,/gate storage before-gate/u);assert.match(result.stdout,/gate storage before-cleanup/u);if(metrics)assert.match(result.stdout,/Inodes/u);assert.deepEqual(readdirSync(runner),["foreign"]);assert.equal(readFileSync(join(runner,"foreign"),"utf8"),"unrelated runner file");assert.deepEqual(readdirSync(outside),["foreign"]);assert.equal(readFileSync(join(outside,"foreign"),"utf8"),"unrelated audit file");
      const owned=JSON.parse(readFileSync(allocations,"utf8")) as {disk:string;memory:string};assert.equal(existsSync(owned.disk),false);if(owned.memory!==outside)assert.equal(existsSync(owned.memory),false,"the gate removes its own memory scope");
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("release gate free-space guards reject a missing KiB and accept exactly twenty GiB", () => {
  const root=mkdtempSync(join(tmpdir(),"pm-vcs-gate-space-"));const runner=join(root,"runner");mkdirSync(runner);const witness=join(root,"ran");
  try{for(const { run, env } of gateScripts())for(const free of[20_971_519,20_971_520]){
    rmSync(witness,{force:true});
    const commands=gateSpaceProbe+'npm() { printf "ran\\n" >> "$GATE_WITNESS"; }; bun() { npm; };\n';
    const result=spawnSync("bash",["-c",commands+run],{env:testEnvironment({...env,RUNNER_TEMP:runner,GATE_FREE_KIB:String(free),GATE_WITNESS:witness}),encoding:"utf8",timeout:60_000});
    assert.equal(result.status,free<20_971_520?1:0,result.stderr);assert.equal(existsSync(witness),free>=20_971_520);if(free<20_971_520)assert.match(result.stderr,/fewer than 20 GiB free/u);assert.deepEqual(readdirSync(runner),[]);
  }}finally{rmSync(root,{recursive:true,force:true});}
});

test("every quick release command inherits the isolated npm user configuration", () => {
  const quick = gateStep("ci.yml", "release-gate", "Non-coverage release gates");
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const commands = scripts["release:check"].split(" && ").filter(command => command !== "npm run coverage");
  const expected = commands.map(command => `${command} /dev/null`);
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-gate-userconfig-"));
  const probe = 'npm() { printf "npm %s %s\\n" "$*" "$(printenv NPM_CONFIG_USERCONFIG)" >> "$GATE_WITNESS"; };\n';
  const run = (step: GateStep): string[] => {
    const witness = join(root, "npm-calls");
    rmSync(witness, { force: true });
    const result = spawnSync("bash", ["-c", gateSpaceProbe + probe + step.run], {
      env: testEnvironment({ NPM_CONFIG_USERCONFIG: "runner-user-config", ...step.env, RUNNER_TEMP: root, GATE_FREE_KIB: "20971520", GATE_WITNESS: witness }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(witness, "utf8").trimEnd().split("\n");
  };
  try {
    assert.deepEqual(run(quick), expected);
    const env = { ...quick.env };
    delete env.NPM_CONFIG_USERCONFIG;
    const prefixOnly = quick.run.replace(/^npm run typecheck\b/m, "NPM_CONFIG_USERCONFIG=/dev/null $&");
    const mutated = run({ run: prefixOnly, env });
    assert.equal(mutated[0], expected[0]);
    assert.throws(() => assert.deepEqual(mutated, expected), /runner-user-config/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bun witness skips when either optional tool is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-optional-tools-"));
  try {
    for (const available of ["bash", "bun"]) {
      const bin = join(root, available);
      mkdirSync(bin);
      // A version-only executable proves discovery succeeds for one tool while
      // the isolated PATH makes the other unavailable. Executing the gate fails.
      const tool = join(bin, available);
      writeFileSync(tool, `#!${process.execPath}\nprocess.exit(process.argv[2] === "--version" ? 0 : 17);\n`);
      chmodSync(tool, 0o755);
      const env: NodeJS.ProcessEnv = { ...testEnvironment(), ...discardChildCoverage(), PATH: bin };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        "--test", "--test-reporter=tap",
        "--test-name-pattern=^Bun CI gate executes tracker lens tests in the Bun runtime$",
        fileURLToPath(import.meta.url),
      ], { encoding: "utf8", env, timeout: 120_000 });
      assert.equal(result.status, 0, `${available} only: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /ok \d+ - Bun CI gate executes tracker lens tests in the Bun runtime[^\n]*# SKIP/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("quick/deep workflows retain tier boundaries, timeouts and safe change detection", () => {
  const workflows = Object.fromEntries(["ci.yml", "ci-deep.yml", "codeql.yml"].map(file => {
    const document = parseDocument(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    return [file, document.toJS()];
  }));
  const ci = workflows["ci.yml"]; const deep = workflows["ci-deep.yml"];
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(deep.jobs.deep.strategy.matrix, { "node-version": [22, 26], "package-manager": ["npm", "bun"] });
  assert.equal(deep.jobs.deep.env.PM_TEST_DEPTH, "full"); assert.equal(deep.jobs.deep.env.PM_TEST_TIME_SCALE, 3);
  assert.equal(deep.jobs.deep["timeout-minutes"], 120);
  for (const job of Object.values(ci.jobs) as { env: { PM_TEST_DEPTH: string }; "timeout-minutes": number }[]) {
    if (job.env) assert.equal(job.env.PM_TEST_DEPTH, "quick"); assert.ok(job["timeout-minutes"] <= 22);
  }
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-tier-classifier-"));
  try {
    const script = ci.jobs.changes.steps.find((step: { name: string }) => step.name === "Detect code changes").run as string;
    assert.equal(script, ci.jobs["windows-acceptance-launcher"].steps.find((step: { name: string }) => step.name === "Detect code changes").run);
    const pathsFile = join(root, "paths"); const output = join(root, "output");
    for (const [paths, code] of [
      [[], false],
      [["README.md", ".agents/pm/tasks/fixture.toon", "docs/guide.md", "LICENSE"], true],
      [["engine/source.ts", "docs/moved.md"], true],
      [[".agents/pm/nested/extension.ts"], true], [[".agents/pm/hook.mjs"], true],
      [["test/unusual\nname.test.ts"], true], [["selfhost.bundle"], true],
    ] as [string[], boolean][]) {
      writeFileSync(pathsFile, paths.map(path => path + "\0").join("")); writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", 'git() { [[ "$*" == *"--no-renames -z"* ]] || return 19; cat "$PATHS_FILE"; };\n' + script], {
        env: testEnvironment({ GITHUB_EVENT_NAME: "pull_request", BASE_SHA: "base", HEAD_SHA: "head", RUNNER_TEMP: root, GITHUB_OUTPUT: output, PATHS_FILE: pathsFile }), encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, "utf8"), `code=${code}\n`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A stale archive or invalid shipped documentation must fail before merge.
test("docs and tracker PRs retain every gate that consumes their committed inputs", () => {
  const ci = parseDocument(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"), { uniqueKeys: true }).toJS();
  const cheap = ci.jobs.test.steps.find((step: { name: string }) => step.name === "Check documentation and tracker changes");
  assert.equal(cheap.if, "needs.changes.result == 'success' && needs.changes.outputs.code != 'true'");
  for (const gate of ["changelog:check", "verify:release-changelog-date", "audit:identities", "accept:self-host", "pack:check"]) {
    assert.ok(cheap.run.split("\n").includes(`npm run ${gate}`), `cheap path must run ${gate}`);
  }
});
