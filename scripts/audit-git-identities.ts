/**
 * Audits every identity email in the physical Git object database.
 *
 * `cat-file --batch-all-objects` inventories reachable and unreachable commits
 * and annotated tags, including objects hidden behind replacement refs. A
 * second, streamed batch reads the raw objects without imposing a repository-
 * wide output buffer. Replacement refs are disabled for both subprocesses.
 *
 * @example
 * ```bash
 * node scripts/audit-git-identities.ts
 * ```
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = resolve(import.meta.dirname, "..");
const gitEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
const gitTimeoutMs = 120_000;
const maxIdentityHeaderBytes = 1024 * 1024;
const identityPatterns = {
  author: /^author [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
  committer: /^committer [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
  tagger: /^tagger [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
} as const;

interface GitObject {
  readonly id: string;
  readonly type: "commit" | "tag";
}

/** Runs a bounded Git subprocess while its stdout is consumed incrementally. */
async function streamGit(
  root: string,
  arguments_: readonly string[],
  input: string | undefined,
  consume: (chunk: Buffer) => void,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["--no-replace-objects", ...arguments_], {
      cwd: root,
      env: gitEnvironment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stderr = "";
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`git ${arguments_.join(" ")} timed out after ${gitTimeoutMs}ms.`));
    }, gitTimeoutMs);
    child.on("error", (error) => {
      fail(new Error(`git ${arguments_.join(" ")} failed: ${error.message}`));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        consume(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("git output consumer failed."));
      }
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0) {
        const detail = stderr.trim();
        reject(new Error(
          `git ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : signal ? ` with ${signal}` : "."}`,
        ));
        return;
      }
      resolvePromise();
    });
    if (input !== undefined) {
      child.stdin!.on("error", (error) => {
        fail(new Error(`git ${arguments_.join(" ")} stdin failed: ${error.message}`));
      });
      child.stdin!.end(input);
    }
  });
}

/** Inventories every physical commit and annotated-tag object. */
async function listIdentityObjects(root: string): Promise<GitObject[]> {
  const objects: GitObject[] = [];
  let pending = "";
  await streamGit(root, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ], undefined, (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^([0-9a-f]+) (commit|tag)$/.exec(line);
      if (match) objects.push({ id: match[1]!, type: match[2] as GitObject["type"] });
    }
  });
  if (pending.length > 0) throw new Error("git cat-file returned a truncated object inventory.");
  return objects;
}

/** Extracts exactly one required identity from an object's header block. */
function collectIdentity(
  addresses: Set<string>,
  object: GitObject,
  header: string,
  field: keyof typeof identityPatterns,
): void {
  const matches = header.split("\n").flatMap((line) => {
    const match = identityPatterns[field].exec(line);
    return match ? [match[1]!] : [];
  });
  if (matches.length !== 1) {
    throw new Error(`${object.type === "commit" ? "Commit" : "Tag"} ${object.id} must have exactly one well-formed ${field} identity.`);
  }
  addresses.add(matches[0]!);
}

/**
 * Inventories raw identity metadata from every physical commit and tag object.
 *
 * @param root - Git repository whose object database is audited.
 * @returns Unique author, committer, and tagger email addresses.
 */
export async function collectGitIdentities(root: string): Promise<Set<string>> {
  const objects = await listIdentityObjects(root);
  if (objects.length === 0) return new Set();
  const addresses = new Set<string>();
  let pending: Buffer = Buffer.alloc(0);
  let position = 0;
  let expectedSize: number | undefined;
  let remainingObjectBytes = 0;
  let identityHeader = Buffer.alloc(0);
  let identityCollected = false;
  await streamGit(root, ["cat-file", "--batch"], `${objects.map((object) => object.id).join("\n")}\n`, (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (position < objects.length) {
      const object = objects[position]!;
      if (expectedSize === undefined) {
        const headerEnd = pending.indexOf(0x0a);
        if (headerEnd < 0) return;
        const match = /^([0-9a-f]+) (commit|tag) (\d+)$/.exec(pending.subarray(0, headerEnd).toString("utf8"));
        if (!match || match[1] !== object.id || match[2] !== object.type) {
          throw new Error(`git cat-file returned an invalid header for ${object.id}.`);
        }
        expectedSize = Number.parseInt(match[3]!, 10);
        if (!Number.isSafeInteger(expectedSize)) throw new Error(`git cat-file returned an invalid size for ${object.id}.`);
        remainingObjectBytes = expectedSize;
        pending = pending.subarray(headerEnd + 1);
      }
      if (remainingObjectBytes > 0 && pending.length > 0) {
        const consumed = Math.min(remainingObjectBytes, pending.length);
        if (!identityCollected) {
          identityHeader = Buffer.concat([identityHeader, pending.subarray(0, consumed)]);
          const delimiter = identityHeader.indexOf("\n\n");
          if (delimiter >= 0) {
            const header = identityHeader.subarray(0, delimiter).toString("utf8");
            if (object.type === "commit") {
              collectIdentity(addresses, object, header, "author");
              collectIdentity(addresses, object, header, "committer");
            } else {
              collectIdentity(addresses, object, header, "tagger");
            }
            identityHeader = Buffer.alloc(0);
            identityCollected = true;
          } else if (identityHeader.length > maxIdentityHeaderBytes) {
            throw new Error(`${object.type === "commit" ? "Commit" : "Tag"} ${object.id} has an oversized identity header.`);
          }
        }
        remainingObjectBytes -= consumed;
        pending = pending.subarray(consumed);
      }
      if (remainingObjectBytes > 0) return;
      if (!identityCollected) {
        const header = identityHeader.toString("utf8");
        if (object.type === "commit") {
          collectIdentity(addresses, object, header, "author");
          collectIdentity(addresses, object, header, "committer");
        } else {
          collectIdentity(addresses, object, header, "tagger");
        }
      }
      if (pending.length === 0) return;
      if (pending[0] !== 0x0a) throw new Error(`git cat-file omitted the separator for ${object.id}.`);
      pending = pending.subarray(1);
      expectedSize = undefined;
      identityHeader = Buffer.alloc(0);
      identityCollected = false;
      position += 1;
    }
  });
  if (position !== objects.length || expectedSize !== undefined || pending.length !== 0) {
    throw new Error("git cat-file returned truncated or unrequested batch data.");
  }
  return addresses;
}

/**
 * Refuses identities absent from a public-address allowlist.
 *
 * @param root - Git repository to audit.
 * @param allowlistPath - Text file containing one approved address per line.
 */
export async function auditGitIdentities(root: string, allowlistPath: string): Promise<void> {
  const approved = new Set(
    readFileSync(allowlistPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const addresses = await collectGitIdentities(root);
  const rejected = [...addresses].filter((address) => !approved.has(address));
  if (rejected.length > 0) throw new Error(`git identity audit rejected ${rejected.length} non-public address(es).`);
  console.log(`git identity audit approved ${addresses.size} unique address(es).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await auditGitIdentities(defaultRepoRoot, resolve(defaultRepoRoot, ".github/approved-git-identities.txt"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "git identity audit failed.");
    process.exitCode = 1;
  }
}
