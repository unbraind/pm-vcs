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
const gitTimeoutMs = 120_000;
const maxIdentityHeaderBytes = 1024 * 1024;
const identityPatterns = {
  author: /^author [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
  committer: /^committer [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
  tagger: /^tagger [^<>\n]*<([^<>\n]+)> \d+ [+-]\d+$/,
} as const;

/** Physical commit or annotated-tag object selected for raw identity-header inspection. */
export interface GitObject {
  readonly id: string;
  readonly type: "commit" | "tag";
}

/** Options for a bounded subprocess whose output is consumed incrementally. */
export interface StreamProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs: number;
}

/** Runs a bounded subprocess while its stdout is consumed incrementally. */
export async function streamProcess(
  command: string,
  arguments_: readonly string[],
  options: StreamProcessOptions,
  consume: (chunk: Buffer) => void,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stderr = "";
    /** Cancel the timer, terminate the child, and reject with actionable context. */
    const fail = (error: Error): void => {
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} ${arguments_.join(" ")} timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    child.on("error", (error) => {
      fail(new Error(`${command} ${arguments_.join(" ")} failed: ${error.message}`));
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
          `${command} ${arguments_.join(" ")} failed${detail.length > 0 ? `: ${detail}` : signal ? ` with ${signal}` : "."}`,
        ));
        return;
      }
      resolvePromise();
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", (error) => {
        fail(new Error(`${command} ${arguments_.join(" ")} stdin failed: ${error.message}`));
      });
      child.stdin!.end(options.input);
    }
  });
}

/** Runs one replacement-disabled Git command through the streamed transport. */
async function streamGit(
  root: string,
  arguments_: readonly string[],
  input: string | undefined,
  consume: (chunk: Buffer) => void,
): Promise<void> {
  await streamProcess("git", ["--no-replace-objects", ...arguments_], {
    cwd: root,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    input,
    timeoutMs: gitTimeoutMs,
  }, consume);
}

/** Incrementally parses the physical object inventory emitted by Git. */
export class GitObjectInventory {
  readonly #objects: GitObject[] = [];
  #pending = "";

  /** Accepts another raw stdout chunk from `git cat-file`. */
  consume(chunk: Buffer): void {
    this.#pending += chunk.toString("utf8");
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop()!;
    for (const line of lines) {
      const match = /^([0-9a-f]+) (blob|commit|tag|tree)$/.exec(line);
      if (!match) throw new Error("git cat-file returned an invalid object inventory record.");
      if (match[2] === "commit" || match[2] === "tag") {
        this.#objects.push({ id: match[1]!, type: match[2] });
      }
    }
  }

  /** Finishes the inventory, refusing a truncated terminal record. */
  finish(): GitObject[] {
    if (this.#pending.length > 0) throw new Error("git cat-file returned a truncated object inventory.");
    return this.#objects;
  }
}

/** Inventories every physical commit and annotated-tag object. */
async function listIdentityObjects(root: string): Promise<GitObject[]> {
  const inventory = new GitObjectInventory();
  await streamGit(root, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ], undefined, (chunk) => inventory.consume(chunk));
  return inventory.finish();
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

/** Collects the identity fields required by one raw Git object kind. */
function collectObjectIdentities(addresses: Set<string>, object: GitObject, header: string): void {
  if (object.type === "commit") {
    collectIdentity(addresses, object, header, "author");
    collectIdentity(addresses, object, header, "committer");
  } else {
    collectIdentity(addresses, object, header, "tagger");
  }
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
  const parser = new IdentityBatchParser(objects);
  await streamGit(root, ["cat-file", "--batch"], `${objects.map((object) => object.id).join("\n")}\n`, (chunk) => {
    parser.consume(chunk);
  });
  return parser.finish();
}

/** Incrementally validates raw `git cat-file --batch` identity objects. */
export class IdentityBatchParser {
  readonly #objects: readonly GitObject[];
  readonly #addresses = new Set<string>();
  #pending: Buffer = Buffer.alloc(0);
  #position = 0;
  #expectedSize: number | undefined;
  #remainingObjectBytes = 0;
  #identityHeader = Buffer.alloc(0);
  #identityCollected = false;

  /** Creates a parser for the exact ordered objects requested from Git. */
  constructor(objects: readonly GitObject[]) {
    this.#objects = objects;
  }

  /** Accepts another raw stdout chunk from `git cat-file --batch`. */
  consume(chunk: Buffer): void {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    while (this.#position < this.#objects.length) {
      const object = this.#objects[this.#position]!;
      if (this.#expectedSize === undefined) {
        const headerEnd = this.#pending.indexOf(0x0a);
        if (headerEnd < 0) return;
        const match = /^([0-9a-f]+) (commit|tag) (\d+)$/.exec(this.#pending.subarray(0, headerEnd).toString("utf8"));
        if (!match || match[1] !== object.id || match[2] !== object.type) {
          throw new Error(`git cat-file returned an invalid header for ${object.id}.`);
        }
        this.#expectedSize = Number.parseInt(match[3]!, 10);
        if (!Number.isSafeInteger(this.#expectedSize)) throw new Error(`git cat-file returned an invalid size for ${object.id}.`);
        this.#remainingObjectBytes = this.#expectedSize;
        this.#pending = this.#pending.subarray(headerEnd + 1);
      }
      if (this.#remainingObjectBytes > 0 && this.#pending.length > 0) {
        const consumed = Math.min(this.#remainingObjectBytes, this.#pending.length);
        if (!this.#identityCollected) {
          this.#identityHeader = Buffer.concat([this.#identityHeader, this.#pending.subarray(0, consumed)]);
          const delimiter = this.#identityHeader.indexOf("\n\n");
          if (delimiter >= 0) {
            if (delimiter > maxIdentityHeaderBytes) {
              throw new Error(`${object.type === "commit" ? "Commit" : "Tag"} ${object.id} has an oversized identity header.`);
            }
            const header = this.#identityHeader.subarray(0, delimiter).toString("utf8");
            collectObjectIdentities(this.#addresses, object, header);
            this.#identityHeader = Buffer.alloc(0);
            this.#identityCollected = true;
          } else if (this.#identityHeader.length > maxIdentityHeaderBytes) {
            throw new Error(`${object.type === "commit" ? "Commit" : "Tag"} ${object.id} has an oversized identity header.`);
          }
        }
        this.#remainingObjectBytes -= consumed;
        this.#pending = this.#pending.subarray(consumed);
      }
      if (this.#remainingObjectBytes > 0) return;
      if (!this.#identityCollected) {
        const header = this.#identityHeader.toString("utf8");
        collectObjectIdentities(this.#addresses, object, header);
      }
      if (this.#pending.length === 0) return;
      if (this.#pending[0] !== 0x0a) throw new Error(`git cat-file omitted the separator for ${object.id}.`);
      this.#pending = this.#pending.subarray(1);
      this.#expectedSize = undefined;
      this.#identityHeader = Buffer.alloc(0);
      this.#identityCollected = false;
      this.#position += 1;
    }
  }

  /** Finishes the batch, refusing missing, partial, or surplus bytes. */
  finish(): Set<string> {
    if (this.#position !== this.#objects.length || this.#expectedSize !== undefined || this.#pending.length !== 0) {
      throw new Error("git cat-file returned truncated or unrequested batch data.");
    }
    return this.#addresses;
  }
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

/** Runs the command-line audit and converts a refusal into a failing exit code. */
export async function main(root: string, allowlistPath: string): Promise<void> {
  try {
    await auditGitIdentities(root, allowlistPath);
  } catch (error) {
    console.error(String(error).replace(/^Error: /, ""));
    process.exitCode = 1;
  }
}

/** Returns whether the current process directly invoked this module. */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  return argv[1] !== undefined && pathToFileURL(resolve(argv[1])).href === moduleUrl;
}

await [
  async (_root: string, _allowlistPath: string): Promise<void> => {},
  main,
][Number(isMainInvocation(process.argv, import.meta.url))]!(
  defaultRepoRoot,
  resolve(defaultRepoRoot, ".github/approved-git-identities.txt"),
);
