/** Manual public-data validation; pass one extracted committed public tracker, never a live tracker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssuranceWorkspaceContext, evaluateAssuranceGate, type AssuranceDocument } from "@unbrained/pm-cli/sdk";
import { attachCheckpoint, createSemanticCheckpoint, inspectCheckpoints, type CheckpointRequest } from "../../engine/checkpoints.ts";
import { decodeRecord, encodeRecord, readCommit, type Commit } from "../../engine/model.ts";
import { Repository } from "../../engine/repo.ts";
import { buildTree, flattenTree } from "../../engine/worktree.ts";

const source = process.argv[2]; assert.ok(source, "Pass an extracted committed public tracker directory");
const root = mkdtempSync(join(tmpdir(), "pm-vcs-public-checkpoints-"));
const tracker = join(root, ".agents/pm"); cpSync(source, tracker, { recursive: true });
const inventory: { path: string; bytes: Buffer }[] = [];
/** Enumerate and freeze only the copied public tracker. */
function freeze(prefix = ""): void {
  for (const entry of readdirSync(join(tracker, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) freeze(path);
    else { assert.ok(entry.isFile()); inventory.push({ path, bytes: readFileSync(join(tracker, path)) }); chmodSync(join(tracker, path), 0o444); }
  }
  chmodSync(join(tracker, prefix), 0o555);
}
freeze();
/** Hash source paths and bytes to detect any change after the read-only validation. */
function sourceDigest(): string {
  const hash = createHash("sha256");
  for (const entry of inventory) hash.update(entry.path).update(readFileSync(join(tracker, entry.path)));
  return hash.digest("hex");
}
const before = sourceDigest();
const repo = Repository.init(root, "main", { recordPaths: [".agents/pm/**/*.toon"], recordPolicy: {} });
repo.stage([]); const id = repo.commit({ message: "public snapshot", author: { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
const commit = readCommit(repo.objects, id); const tree = flattenTree(repo.objects, commit.tree);
const records = [...tree].filter(([path]) => path.endsWith(".toon")).map(([path, entry]) => ({ path, entry, document: decodeRecord(repo.objects.readTyped(entry.id, "record")) }));
const document: AssuranceDocument = { version: 1, measurements: [{ id: "population", source: { kind: "items" } }],
  assertions: [{ id: "present", measurement_id: "population", owner_item_id: records[0].document.id as string, scope: { kind: "all" }, floor: 1, enforcement: "block", negative_control: { cases: [{ observed: 1, expected: "pass" }, { observed: 0, expected: "fail" }] } }],
  gates: [{ id: "public-audit", assertion_ids: ["present"], triggers: ["ci"] }] };
const context = await createAssuranceWorkspaceContext(tracker, { tree_id: commit.tree, resolve_tree: false, strict_read: true });
const verdict = await evaluateAssuranceGate("public-audit", document, context, { trigger: "ci" });
assert.equal(verdict.verdict, "pass");
let valid = 0; let irrelevantRetained = 0; let relevantInvalidated = 0; let dependencyInvalidated = 0; let maxJsonBytes = 0;
const started = performance.now();
for (const record of records) {
  const request: CheckpointRequest = { id: "public-validation", scope: [{ path: record.path, fields: ["status", "acceptance_criteria", "dependencies"] }], dependencies: [{ path: ".agents/pm/settings.json" }], gateId: "public-audit", assertionId: "present", receipt: { treeId: commit.tree, evaluatedAt: verdict.evaluated_at } };
  const claim = createSemanticCheckpoint(repo.objects, id, commit, request, verdict);
  const carried = { ...commit, checkpoints: attachCheckpoint(commit, claim) };
  /** Write only derived native objects, never change the copied tracker. */
  const changed = (path: string, next: Buffer, kind: "record" | "blob"): Commit => {
    const entries = new Map(tree); entries.set(path, { ...entries.get(path)!, id: repo.objects.write(kind, next) });
    return { ...carried, tree: buildTree(repo.objects, entries) };
  };
  const original = inspectCheckpoints(repo.objects, id, carried, [request]);
  valid += Number(original.ok); maxJsonBytes = Math.max(maxJsonBytes, Buffer.byteLength(JSON.stringify(original)));
  irrelevantRetained += Number(inspectCheckpoints(repo.objects, id, changed(record.path, encodeRecord({ ...record.document, title: "Unrelated presentation edit", updated_at: "2026-10-23T00:00:00.000Z" }), "record")).ok);
  relevantInvalidated += Number(!inspectCheckpoints(repo.objects, id, changed(record.path, encodeRecord({ ...record.document, status: record.document.status === "closed" ? "open" : "closed" }), "record")).ok);
  dependencyInvalidated += Number(!inspectCheckpoints(repo.objects, id, changed(".agents/pm/settings.json", Buffer.from('{"policy_revision":"changed"}'), "blob")).ok);
}
assert.equal(valid, records.length); assert.equal(irrelevantRetained, valid); assert.equal(relevantInvalidated, valid); assert.equal(dependencyInvalidated, valid);
assert.equal(sourceDigest(), before); assert.equal(existsSync(join(root, ".git")), false);
console.log(JSON.stringify({ files: inventory.length, bytes: inventory.reduce((sum, row) => sum + row.bytes.length, 0), items: records.length,
  historyRecords: inventory.filter(row => row.path.startsWith("history/") && row.path.endsWith(".jsonl")).reduce((sum, row) => sum + row.bytes.toString().trim().split("\n").filter(Boolean).length, 0),
  sourceDigest: before, valid, irrelevantRetained, relevantInvalidated, dependencyInvalidated, comparisons: valid * 4,
  maxJsonBytes, durationMs: Math.round(performance.now() - started), trackerBytesUnchanged: true, gitRepository: false }, null, 2));
