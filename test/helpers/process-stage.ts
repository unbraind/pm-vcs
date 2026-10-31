/** Engine-produced orphan staging fixtures share the same native failure protocol in every recovery matrix. */
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { durability } from "../../engine/durability.ts";
import { destructionBoundary } from "../../engine/destruction.ts";
import { objectFiles } from "../../engine/object-files.ts";

/** Select the documented native temporary cohort for one final lease destination. */
export function nativeStagePrefix(path: string): string { return `owner-${createHash("sha256").update(basename(path)).digest("hex").slice(0, 24)}-`; }
/** Inject a real native retirement failure after publication; the engine must retain ownership and close its descriptor. */
export function abandonProcessStage(path: string): string {
 const unlink = fs.unlinkSync; let staged = "";
 destructionBoundary.visit = (step, target) => { if (step === "process-owner-published" && target === path) staged = join(dirname(path), readdirSync(dirname(path)).find(name => name.startsWith(nativeStagePrefix(path)))!); };
 mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => { if (String(args[0]).startsWith(join(dirname(path), nativeStagePrefix(path)))) throw Object.assign(new Error("native staging retirement interrupted"), { code: "EIO" }); return unlink(...args); }); syncBuiltinESMExports();
 try { assert.throws(() => durability.claim(path, "fixture_locked"), { code: "EIO" }); } finally { mock.restoreAll(); syncBuiltinESMExports(); destructionBoundary.visit = () => {}; }
 assert.ok(existsSync(staged)); assert.equal(existsSync(path), false); assert.equal(objectFiles.active.size, 0); return staged;
}
