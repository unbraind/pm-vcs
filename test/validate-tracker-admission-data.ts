import "./helpers/isolate-session.ts";
/** Measure only an explicitly supplied disposable public-tracker copy; never modify the source tracker. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { TrackerCapture } from "../engine/tracker-admission.ts";
import { flattenTree } from "../engine/worktree.ts";
import { readCommit } from "../engine/model.ts";
import { trackerAdmissionDigest } from "./helpers/tracker-admission-digest.ts";
const input = process.argv[2]; assert.ok(input, "Supply a disposable non-git public tracker copy.");
const root = resolve(input); const pmRoot = join(root, ".agents/pm");
const before = trackerAdmissionDigest(pmRoot);
const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
const list = await client.listAllComplete({ includeBody: true });
const ids = list.items.map(item => item.id).sort();
const repo = Repository.init(root); const started = performance.now();
let admitted = 0; let retries = 0; let historyBytes = 0; let historyEntries = 0; let selectedBytes = 0;
const reasons = new Map<string, number>();
for (let offset = 0; offset < ids.length; offset += 100) {
  const items = ids.slice(offset, offset + 100);
  const report = await new TrackerCapture(repo, pmRoot, { items, expectedTip: repo.refs.readHead().target }).commit({ message: "Public tracker admission validation", author: { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 }, allowEmpty: true }, new Date(1));
  if (report.ok) admitted += items.length;
  else { retries += report.retry.length; for (const retry of report.retry) reasons.set(retry.reason, (reasons.get(retry.reason) ?? 0) + 1); }
}
const head = repo.refs.readHead().target;
if (head !== null) for (const [path, entry] of flattenTree(repo.objects, readCommit(repo.objects, head).tree)) {
  const bytes = repo.objects.readTyped(entry.id, "blob"); selectedBytes += bytes.length;
  if (path.endsWith(".jsonl")) { historyBytes += bytes.length; historyEntries += bytes.toString("utf8").split("\n").filter(Boolean).length; }
}
assert.equal(trackerAdmissionDigest(pmRoot), before, "Admission must leave every source tracker byte unchanged.");
console.log(JSON.stringify({ sourceItems: ids.length, admitted, retries, reasons: Object.fromEntries(reasons), nativeFiles: head === null ? 0 : flattenTree(repo.objects, readCommit(repo.objects, head).tree).size, selectedBytes, historyBytes, historyEntries, elapsedMs: Math.round(performance.now() - started), sourceUnchanged: true, gitRequired: false }));
