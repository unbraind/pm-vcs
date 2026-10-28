/** Real engine publication fixtures shared by crash and interleaving models. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join, relative, sep } from "node:path";
import type { Repository } from "../../engine/repo.ts";
import { durability } from "../../engine/durability.ts";
import { destructionBoundary } from "../../engine/destruction.ts";
/** Stop the actual journaled rename before its syscall; the original source and immutable capability remain. */
export function prepareControlPublication(repo: Repository, destination: string, bytes: string, sourceOverride?: string): string {
 const tag = createHash("sha256").update(destination + bytes).digest("hex").slice(0,12); const name = relative(repo.controlDirectory,destination).split(sep).join("/"); const source = sourceOverride ?? (name.startsWith("refs/") ? join(dirname(destination),`ref-${process.pid}-${tag}.lock`) : `${destination}.${process.pid}.${tag}.tmp`); mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, bytes, { flag: "wx" });
 const control = repo.instanceLink?.controlDirectory ?? repo.controlDirectory; let cut = false;
 destructionBoundary.visit = (step,path) => { if (step === "before-delete" && resolve(control,path) === source) { cut = true; throw new Error("prepared publication boundary"); } };
 try { assert.throws(() => durability.rename(source,destination)); } finally { destructionBoundary.visit = () => {}; }
 assert.ok(cut); assert.ok(existsSync(source)); return source;
}
