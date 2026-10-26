/** Inspect the real npm tarball, including compiled code and source maps, before release. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMainInvocation } from "./main-invocation.ts";

/** Patterns identify classes of private data; diagnostics never echo matched values. */
const rules: readonly [string, RegExp][] = [
  ["absolute home path", /\/(?:home|Users)\/[^/\r\n]+\//u],
  ["Windows home path", /[A-Za-z]:\\+Users\\+/iu],
  ["agent scratch path", /\/tmp\/(?:claude-\d+|pi-subagent)/u],
  ["hosted data name", /pm-hosted-data/u],
  ["service token", /\b(?:npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/u],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["credential URL", /https?:\/\/[^\s/@]+:[^\s/@]+@/iu],
  ["credential assignment", /\b(?:[A-Z][A-Z0-9_]*_)?(?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9_+/-]{32,}/iu],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9_.+/-]{32,}/u],
];

/** Return only categories and line numbers, so a failed scan cannot leak a secret. */
export function privateDataFindings(text: string): string[] {
  return text.split("\n").flatMap((line, index) => rules
    .filter(([, pattern]) => pattern.test(line))
    .map(([category]) => `line ${index + 1}: ${category}`));
}

/** Pack without lifecycle recursion, inspect every actual archive member, and remove all artifacts. */
export function verifyPack(root: string): { count: number; failures: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "pack-privacy-"));
  try {
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packs = JSON.parse(output) as { filename: string }[];
    const archive = join(scratch, packs[0].filename);
    const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trimEnd().split("\n").filter((member) => !member.endsWith("/"));
    execFileSync("tar", ["-xzf", archive, "-C", scratch]);
    const failures = members.flatMap((member) => [
      ...privateDataFindings(member).map((finding) => `archive member name: ${finding}`),
      ...privateDataFindings(readFileSync(join(scratch, member), "utf8"))
        .map((finding) => `${member}: ${finding}`),
    ]);
    return { count: members.length, failures };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Execute the same pack inspection from the CLI and tests, setting a failing process status. */
export function runIfMain(argv: string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  const result = verifyPack(root);
  for (const failure of result.failures) process.stderr.write(`pack-privacy: ${failure}\n`);
  process.stdout.write(`pack-privacy: scanned ${result.count} files; ${result.failures.length} finding(s)\n`);
  process.exitCode = result.failures.length === 0 ? 0 : 1;
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
