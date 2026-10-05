// Credentials are clone-local secrets; public remote locations never contain them.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ObjectStoreError } from "./objects.ts";

/** Remove URL userinfo even from malformed URLs and embedded diagnostic text. */
export function redactUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1");
}

/** Strip an entire input URL authority, including userinfo containing control whitespace. */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

/** Split a location into a printable URL and an optional decoded bearer secret. */
export function splitRemoteCredentials(url: string): { url: string; token: string | null } {
  const clean = redactRemoteUrl(url);
  if (clean === url) return { url, token: null };
  try {
    const parsed = new URL(url);
    return { url: clean, token: decodeURIComponent(parsed.username || parsed.password) };
  } catch {
    throw new ObjectStoreError("unsupported_transport", `${clean} is not a usable remote URL.`);
  }
}

/** Resolve per-remote environment overrides before a general override or stored secret. */
export function environmentToken(remote: string, stored: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const suffix = remote.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return env[`PM_VCS_TOKEN_${suffix}`] ?? env.PM_VCS_TOKEN ?? stored;
}

/** Atomically publish JSON, creating a private temporary file when it holds secrets. */
export function writeRemoteMap(path: string, map: Record<string, string>, privateFile = false): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`, { flag: "wx", mode: privateFile ? 0o600 : 0o666 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Read a secret map without ever reflecting corrupt values into diagnostics. */
export function readCredentials(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
  // Repair permissions on an existing file too; Windows requires filesystem ACLs.
  chmodSync(path, 0o600);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ObjectStoreError("bad_credentials", "The credentials file is not valid JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new ObjectStoreError("bad_credentials", "The credentials file is not a secret map.");
  }
  return parsed as Record<string, string>;
}
