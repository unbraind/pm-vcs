/** Run the fleet's fail-closed jscpd gate over every production TypeScript file. */
import { globSync } from "node:fs";
import { resolve, sep } from "node:path";
import { runDuplicationGate } from "pm-ops/duplication";

// Resolve this package independently of caller cwd; an explicit root supports
// disposable repository checks. Enumerate paths because jscpd's basename glob
// interpretation of *.ts differs from fast-glob's root-only interpretation.
const repoRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
await runDuplicationGate({
  repoRoot,
  globs: globSync(["*.ts", "src/**/*.ts", "engine/**/*.ts", "scripts/**/*.ts"], { cwd: repoRoot })
    .map((file) => file.split(sep).join("/")),
});
