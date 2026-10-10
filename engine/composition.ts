/** Canonical repository links, local authorization and safe private overlay storage. */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALWAYS_IGNORED, isControlPath, isRuntimeIgnored, readIgnoreRules, type IgnoreRules } from "./ignore.ts";
import { compareByteOrder } from "./model.ts";
import { assertRegistryName, isObjectId, ObjectStore, ObjectStoreError, readControlJson } from "./objects.ts";
import { isCanonicalRepoPath } from "./worktree.ts";

/** One exact source file and destination file in a pinned repository. */
export interface LinkMapping {
  /** Canonical file path in the target revision. */
  readonly source: string;
  /** Canonical file path in this instance. */
  readonly destination: string;
}

/** A committed relationship, containing neither a local binding nor credentials. */
export interface RepositoryLink {
  /** Version of this canonical descriptor. */
  readonly version: 1;
  /** Immutable opaque identity of the target repository. */
  readonly repository: string;
  /** Exact commit object ID, never a moving branch name. */
  readonly revision: string;
  /** Explicit subset and path mapping. */
  readonly mappings: readonly LinkMapping[];
}

/** One private overlay file, independent of objects and the index. */
export interface LayerFile {
  /** Canonical instance path. */
  readonly path: string;
  /** Snapshot bytes encoded only in instance-private storage. */
  readonly content: string;
  /** Executable state of the private file. */
  readonly executable: boolean;
}

/** Named overlay snapshot; edited working bytes remain private too. */
export interface LocalLayer {
  /** Local name, unique within this instance. */
  readonly name: string;
  /** Owned files, sorted by canonical path. */
  readonly files: readonly LayerFile[];
}

/** Validate paths for composition, rejecting control state on every platform. */
export function assertCompositionPath(path: string, rules?: IgnoreRules): void {
  if (isControlPath(path) || !isCanonicalRepoPath(path) || path.includes("\\") || /^[A-Za-z]:/.test(path)
    || path.split("/").some(/** Reject private tool directories at any depth. */ (part) =>
      (ALWAYS_IGNORED as readonly string[]).includes(part))
    || (rules !== undefined && isRuntimeIgnored(path, rules))) {
    throw new ObjectStoreError("unsafe_composition_path", "Composition paths must be canonical files outside control and runtime state.");
  }
}

/** Prove every existing component is a regular directory or final regular file. */
export function assertSafeFilePath(root: string, path: string, rules: IgnoreRules = readIgnoreRules(root)): void {
  assertCompositionPath(path, rules);
  if (!lstatSync(root).isDirectory() || !lstatSync(join(root, ".pmvcs")).isDirectory()) throw new ObjectStoreError("unsafe_composition_path", "Repository and control roots must be real directories.");
  let current = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new ObjectStoreError("unsafe_composition_path", "Composition refuses symlinks and file/directory collisions.");
    }
  }
}

/** Validate and canonically encode an untrusted link, dropping no unknown fields. */
export function encodeLink(value: RepositoryLink): Buffer {
  if (value.version !== 1 || typeof value.repository !== "string" || !/^[0-9a-f]{32}$/.test(value.repository)
    || typeof value.revision !== "string" || !isObjectId(value.revision)
    || !Array.isArray(value.mappings) || value.mappings.length === 0
    || Object.keys(value).sort().join(",") !== "mappings,repository,revision,version") {
    throw new ObjectStoreError("bad_link", "A link needs version 1, repository identity, immutable revision and explicit mappings.");
  }
  const sources = new Set<string>();
  const destinations: string[] = [];
  for (const mapping of value.mappings) {
    if (mapping === null || typeof mapping !== "object" || typeof mapping.source !== "string"
      || typeof mapping.destination !== "string" || Object.keys(mapping).sort().join(",") !== "destination,source") {
      throw new ObjectStoreError("bad_link", "A mapping must contain only source and destination file paths.");
    }
    assertCompositionPath(mapping.source);
    assertCompositionPath(mapping.destination);
    if (sources.has(mapping.source) || destinations.some(/** Detect exact and ancestor collisions. */ (path) => pathsOverlap(path, mapping.destination))) {
      throw new ObjectStoreError("bad_link", "Link mappings overlap or repeat a source.");
    }
    sources.add(mapping.source);
    destinations.push(mapping.destination);
  }
  const mappings = value.mappings.map(/** Canonical field order prevents insertion-order-dependent descriptor IDs. */ (mapping) => ({ source: mapping.source, destination: mapping.destination })).sort(/** Sort independently of the caller's insertion order. */ (a, b) => compareByteOrder(a.destination, b.destination));
  return Buffer.from(JSON.stringify({ version: 1, repository: value.repository, revision: value.revision, mappings }), "utf8");
}

/** Decode a descriptor, requiring its exact canonical representation. */
export function decodeLink(payload: Buffer): RepositoryLink {
  let value: RepositoryLink;
  try { value = JSON.parse(payload.toString("utf8")) as RepositoryLink; } catch {
    throw new ObjectStoreError("bad_link", "Link descriptor is not JSON.");
  }
  if (value === null || typeof value !== "object" || !encodeLink(value).equals(payload)) {
    throw new ObjectStoreError("bad_link", "Link descriptor is not canonical.");
  }
  return value;
}

/** Whether two exact paths compete for a file or one of its parent directories. */
export function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Flush directory changes where Node supports this guarantee; strict physical erasure refuses unsupported Windows durability. */
export function syncDirectory(path: string, required = true, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    if (required) throw new ObjectStoreError("unsupported_durability", "Physical erasure requires directory fsync, unavailable through Node on Windows.");
    return;
  }
  const directory = openSync(path, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Atomically replace private metadata with file fsync and supported directory fsync; Windows has no directory-flush guarantee. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!lstatSync(dirname(path)).isDirectory()) throw new ObjectStoreError("unsafe_composition_path", "Private metadata cannot follow a control-directory symlink.");
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path), false);
  } finally { rmSync(temporary, { force: true }); }
}

/** Read and strictly validate all private overlay snapshots. */
export function readLayers(control: string, rules?: IgnoreRules): LocalLayer[] {
  const raw = readControlJson(join(control, "layers.json"), "bad_layers", "private layers", []);
  if (!Array.isArray(raw)) throw new ObjectStoreError("bad_layers", "Private layers must be an array.");
  const names = new Set<string>();
  const paths: string[] = [];
  for (const layer of raw as LocalLayer[]) {
    if (layer === null || typeof layer !== "object" || typeof layer.name !== "string" || !Array.isArray(layer.files) || layer.files.length === 0) {
      throw new ObjectStoreError("bad_layers", "Each layer needs a name and files.");
    }
    assertRegistryName(layer.name, "bad_layers", "Layer");
    if (names.has(layer.name)) throw new ObjectStoreError("bad_layers", "Layer names repeat.");
    names.add(layer.name);
    for (const file of layer.files) {
      if (file === null || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string"
        || typeof file.executable !== "boolean" || Buffer.from(file.content, "base64").toString("base64") !== file.content) {
        throw new ObjectStoreError("bad_layers", "Layer files need canonical paths, base64 content and executable state.");
      }
      assertCompositionPath(file.path, rules);
      if (paths.some(/** Refuse ambiguous file ownership across snapshots. */ (path) => pathsOverlap(path, file.path))) {
        throw new ObjectStoreError("bad_layers", "Private layer paths overlap.");
      }
      paths.push(file.path);
    }
  }
  return raw as LocalLayer[];
}

/** Local grants are salted hashes and never enter an exported bundle. */
export interface LocalAuthority {
  /** Version 2 uses fixed scrypt parameters and a 32-byte verifier. */
  readonly version: 2;
  /** Audit principal selected by the local operator. */
  readonly principal: string;
  /** Random salt separating credential hashes across repositories. */
  readonly salt: string;
  /** Hash of the read credential for link resolution. */
  readonly read: string;
  /** Hash of the permanent-erasure credential. */
  readonly erase: string;
}

/** Separate authorization for a current v2 rotation or explicit historical grant regeneration. */
export type AuthorityChangeAuthorization =
  | { readonly currentEraseCredential: string; readonly regenerateLegacy?: never }
  | { readonly regenerateLegacy: true; readonly currentEraseCredential?: never };

/** Historical unversioned salted SHA-256 grant shape; it cannot authorize v2 operations. */
type LegacyAuthority = Omit<LocalAuthority, "version"> & { readonly version?: never };

/** Distinguish genuine absence from invalid JSON values and recognize only supported complete grant shapes. */
function readAuthority(control: string): LocalAuthority | LegacyAuthority | null | undefined {
  const path = join(control, "authority.json");
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
  const raw = readControlJson(path, "bad_authority", "local authority") as Partial<LocalAuthority> | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || typeof raw.principal !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(raw.principal)
    || typeof raw.salt !== "string" || !/^[0-9a-f]{32}$/.test(raw.salt)
    || typeof raw.read !== "string" || !/^[0-9a-f]{64}$/.test(raw.read)
    || typeof raw.erase !== "string" || !/^[0-9a-f]{64}$/.test(raw.erase)) return null;
  const fields = Object.keys(raw).sort().join(",");
  if (raw.version === 2 && fields === "erase,principal,read,salt,version") return raw as LocalAuthority;
  if (fields === "erase,principal,read,salt") return raw as LegacyAuthority;
  return null;
}

/** Configure separate grants in shared control storage, authorizing replacement within its writer lease. */
export function configureAuthority(control: string, principal: string, read: string, erase: string, authorization?: AuthorityChangeAuthorization): void {
  new ObjectStore(join(control, "objects")).withWriteLock(/** Classification, current authorization and atomic replacement share one physical store lease. */ () => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(principal) || read.length === 0 || erase.length === 0 || read === erase) {
      throw new ObjectStoreError("bad_authority", "Authority needs an audit principal and two distinct nonempty credentials.");
    }
    const current = readAuthority(control);
    if (current === null) throw new ObjectStoreError("bad_authority", "Invalid local authority requires explicit trusted-filesystem recovery.");
    if (authorization?.regenerateLegacy === true && (current === undefined || current.version === 2)) {
      throw new ObjectStoreError("unauthorized", "Legacy regeneration applies only to a recognized historical SHA-256 grant.");
    }
    if (current !== undefined) {
      if (current.version === 2) authorize(control, "erase", authorization?.currentEraseCredential ?? "");
      else if (authorization?.regenerateLegacy !== true) {
        throw new ObjectStoreError("unauthorized", "Historical SHA-256 grants require explicit --regenerate-legacy.");
      }
    }
    const salt = randomBytes(16).toString("hex");
    writePrivateJson(join(control, "authority.json"), { version: 2, principal, salt, read: credentialHash(salt, read), erase: credentialHash(salt, erase) });
  });
}

/** Hash a credential with repository-local salt without retaining its raw value. */
function credentialHash(salt: string, credential: string): string {
  return scryptSync(credential, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}

/** Authorize one action independently of the enclosing repository and return its audit principal. */
export function authorize(control: string, action: "read" | "erase", credential: string): string {
  const raw = readAuthority(control);
  if (raw === undefined || raw === null || raw.version !== 2
    || !timingSafeEqual(Buffer.from(raw[action], "hex"), Buffer.from(credentialHash(raw.salt, credential), "hex"))) {
    throw new ObjectStoreError("unauthorized", "A matching current version 2 credential is required; historical grants require vcs authority --regenerate-legacy.");
  }
  return raw.principal;
}
