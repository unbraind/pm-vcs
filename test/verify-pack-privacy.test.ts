/** Real npm packs prove the allowlist and privacy gate reject contaminated shipped documentation. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { privateDataFindings, runIfMain, verifyPack } from "../scripts/verify-pack-privacy.ts";

const repo = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
const contaminants = [
  ["absolute home path", "/" + "home/example/project/"],
  ["absolute home path", "/" + "Users/example/project/"],
  ["absolute home path", "/" + "Users/Example User/project/"],
  ["Windows home path", "C:" + "\\Users\\example\\project"],
  ["Windows home path", "C:" + "\\\\Users\\\\example\\\\project"],
  ["agent scratch path", "/" + "tmp/claude-123/heavy-gate.lock"],
  ["agent scratch path", "/" + "tmp/pi-subagent/task"],
  ["hosted data name", "pm-" + "hosted-data"],
  ["service token", "npm_" + "a".repeat(36)],
  ["service token", "ghp_" + "b".repeat(36)],
  ["service token", "github_pat_" + "c".repeat(60)],
  ["service token", "xoxb-" + "d".repeat(30)],
  ["service token", "AKIA" + "E".repeat(16)],
  ["service token", "sk-proj-" + "f".repeat(40)],
  ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ["credential URL", "https://example:synthetic@example.test"],
  ["credential assignment", '"password": "' + "g".repeat(40) + '"'],
  ["credential assignment", "PM_VCS_TOKEN=" + "i".repeat(40)],
  ["bearer credential", "Bearer " + "h".repeat(40)],
];

/** Build a non-Git consumer fixture using the real documentation and package allowlist. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pack-privacy-test-"));
  cpSync(join(repo, "docs"), join(root, "docs"), { recursive: true });
  cpSync(join(repo, "README.md"), join(root, "README.md"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.js"), "export const example = true;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "privacy-fixture", version: "1.0.0", files: manifest.files }));
  return root;
}

test("the package ships README-linked docs and examples, excluding evidence and future scratch docs", () => {
  const root = fixture();
  try {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const linked = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/gu)].map((match) => match[1]);
    for (const file of linked) assert.ok(manifest.files.includes(file), file);
    assert.ok(manifest.files.includes("docs/bisect-demo.txt"));
    assert.ok(manifest.files.every((file) => !file.startsWith("docs/") || !file.endsWith("/")));
    for (const file of ["certification-2026.10.4.md", "action-revision-audit.md", "phase6-scale-receipt.md", "future-scratch.md"]) {
      writeFileSync(join(root, "docs", file), contaminants[0][1]);
    }
    const result = verifyPack(root);
    assert.deepEqual(result.failures, []);
    // Eleven consumer docs, README, package manifest and one compiled fixture file.
    assert.equal(result.count, 14);
    assert.match(manifest.scripts["release:check"], /&& npm run pack:check &&/u);
    assert.equal(manifest.scripts["pack:check"], "node scripts/verify-pack-privacy.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adding each private-data class to a shipped doc fails the real tarball check without echoing values", () => {
  const root = fixture();
  try {
    for (const [category, value] of contaminants) {
      writeFileSync(join(root, "docs/bisect.md"), `Safe guide\n${value}\n`);
      const result = verifyPack(root);
      assert.deepEqual(result.failures, [`package/docs/bisect.md: line 2: ${category}`]);
      assert.ok(!result.failures.join("\n").includes(value));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiled maps and archive names are also scanned", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "dist/index.js.map"), JSON.stringify({ sources: [contaminants[0][1]] }));
    writeFileSync(join(root, "dist", "pm-" + "hosted-data.txt"), "safe\n");
    const result = verifyPack(root);
    assert.deepEqual(result.failures, [
      "package/dist/index.js.map: line 1: absolute home path",
      "archive member name: line 1: hosted data name",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary placeholders and short example tokens remain safe", () => {
  assert.deepEqual(privateDataFindings('$TMPDIR/heavy-gate.lock\n$HOME/project\n"token": "example-read-token"\nPM_VCS_TOKEN="$WRITE_TOKEN"'), []);
});

test("CLI wiring reports success and failure with corresponding process exit codes", () => {
  const root = fixture();
  const moduleUrl = import.meta.resolve("../scripts/verify-pack-privacy.ts");
  const entry = fileURLToPath(moduleUrl);
  const saved = process.exitCode;
  try {
    assert.equal(runIfMain(process.argv, moduleUrl, root), false);
    assert.equal(runIfMain([process.execPath, entry], moduleUrl, root), true);
    assert.equal(process.exitCode, 0);
    writeFileSync(join(root, "docs/bisect.md"), contaminants[0][1]);
    assert.equal(runIfMain([process.execPath, entry], moduleUrl, root), true);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed npm pack propagates failure and cleans up", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "package.json"), "invalid json");
    assert.throws(() => verifyPack(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
