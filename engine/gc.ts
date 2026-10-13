/** Conservative collection under the same interprocess transaction as writers. */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { decodeCommit, decodeManifest, decodeSeries, decodeTree } from "./model.ts";
import { ObjectStoreError, isObjectId, readControlJson, type ObjectId } from "./objects.ts";
import { PublicationLeases } from "./publication-leases.ts";
import { Repository } from "./repo.ts";

/** Exact sweep receipt: candidate addresses are informational until an explicit apply. */
export interface GcReport {
  readonly applied: boolean;
  readonly retained: number;
  readonly candidates: readonly ObjectId[];
  readonly removed: number;
  /** Active file leases conservatively retain unpublished, unattributed arrivals too. */
  readonly activeLeases: number;
}

/** Read address roots strictly: omission on corrupt metadata would turn collection into data loss. */
function addresses(value: unknown): ObjectId[] {
  if (!Array.isArray(value) || value.some(/** Reject malformed addresses before any sweep. */ (id) => typeof id !== "string" || !isObjectId(id))) {
    throw new ObjectStoreError("unsafe_gc_roots", "Collection root addresses are corrupt.");
  }
  return value;
}

/** Inspect all ref namespaces without the display API's tolerant omission of broken refs. */
function refRoots(path: string): ObjectId[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory()) throw new ObjectStoreError("unsafe_gc_roots", "Collection cannot follow a ref directory link.");
  const result: ObjectId[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) result.push(...refRoots(target));
    else {
      if (!entry.isFile()) throw new ObjectStoreError("unsafe_gc_roots", "Collection cannot follow a ref link.");
      result.push(...addresses([readFileSync(target, "utf8").trim()]));
    }
  }
  return result;
}

/** Keep both sides of every recorded movement, including detached HEAD history; torn logs refuse. */
function logRoots(control: string): ObjectId[] {
  const path = join(control, "oplog.jsonl");
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isFile()) throw new ObjectStoreError("unsafe_gc_roots", "Collection requires a real operation log.");
  const text = readFileSync(path, "utf8");
  const result: ObjectId[] = [];
  try {
    if (text !== "" && !text.endsWith("\n")) throw new Error("Truncated operation log.");
    for (const line of text.split("\n").filter(/** Empty separators carry no roots. */ (entry) => entry.trim() !== "")) {
      const value = JSON.parse(line) as { refs: { before: unknown; after: unknown }[]; head?: { before: string; after: string } };
      if (!Array.isArray(value.refs)) throw new Error("Invalid operation.");
      for (const ref of value.refs) result.push(...addresses([ref.before, ref.after].filter(/** Null records ref absence. */ (id) => id !== null)));
      if (value.head !== undefined) for (const head of [value.head.before, value.head.after]) {
        if (typeof head !== "string") throw new Error("Invalid HEAD transition.");
        if (!head.startsWith("ref: ")) result.push(...addresses([head.trim()]));
      }
    }
  } catch { throw new ObjectStoreError("unsafe_gc_roots", "Collection refuses a corrupt or truncated operation log."); }
  return result;
}

/** Open every current or retired shared instance; an unavailable owner prevents collection. */
function storageInstances(repository: Repository): Repository[] {
  const hub = Repository.open(repository.instanceLink?.hubRoot ?? repository.root);
  const retired = readControlJson(join(hub.controlDirectory, "unlinked-instances.json"), "unsafe_gc_roots", "retired instance roots", []);
  if (!Array.isArray(retired) || retired.some(/** Registry paths must remain relative. */ (path) => typeof path !== "string" || path === "" || path === "." || isAbsolute(path) || path.includes("\\") || relative(hub.root, resolve(hub.root, path)).split(sep).join("/") !== path)) {
    throw new ObjectStoreError("unsafe_gc_roots", "Collection requires valid retired instance roots.");
  }
  const paths = new Set([hub.root, ...hub.listInstances().map(/** Do not omit broken instances. */ (entry) => entry.path), ...retired.map(/** Resolve the durable retired scope from the hub. */ (path: string) => resolve(hub.root, path))]);
  return [...paths].map(/** Verify binding before trusting another instance's roots. */ (path) => {
    const instance = Repository.open(path);
    const shared = instance.instanceLink?.controlDirectory ?? instance.controlDirectory;
    if (realpathSync(shared) !== realpathSync(hub.controlDirectory)) throw new ObjectStoreError("unsafe_gc_roots", "Collection instance is no longer bound to this store.");
    return instance;
  });
}

/** Plan and optionally sweep only after all roots and all physical objects validate under one writer lock. */
export function collectGarbage(repository: Repository, apply = false): GcReport {
  return repository.objects.withWriteLock(/** Never reuse a stale plan across a publication or a retry. */ () => {
    const store = repository.objects;
    const shared = repository.instanceLink?.controlDirectory ?? repository.controlDirectory;
    const roots = new Set(refRoots(join(shared, "refs")));
    for (const instance of storageInstances(repository)) {
      const head = instance.refs.resolveHead();
      if (head !== null) roots.add(head);
      for (const id of logRoots(instance.controlDirectory)) roots.add(id);
      for (const entry of instance.readIndex()) roots.add(entry.id);
      const merge = instance.readMergeState();
      if (merge !== null) for (const id of addresses([merge.ours, merge.theirs, ...merge.bases])) roots.add(id);
    }
    for (const denial of store.denials()) {
      if (denial.pending) throw new ObjectStoreError("erasure_incomplete", "Finish authorized erasure before collection.");
      roots.add(denial.id);
    }
    const pinned = store.uploadRoots().filter(/** Erasure may leave a harmless historical pin. */ (id) => store.has(id));
    let activeLeases = 0;
    const leases = new PublicationLeases(store, shared);
    const directory = join(shared, "leases");
    if (existsSync(directory)) {
      if (!lstatSync(directory).isDirectory()) throw new ObjectStoreError("unsafe_gc_roots", "Collection requires a real lease directory.");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{32}\.jsonl$/.test(entry.name)) throw new ObjectStoreError("unsafe_gc_roots", "Collection lease inventory is invalid.");
        const lease = leases.inspect(entry.name.slice(0, 32));
        if (lease !== null && lease.active && lease.expiry > Date.now()) activeLeases++;
      }
    }
    const inventory: { id: ObjectId; path: string }[] = [];
    // Complete the physical preflight before unlinking even the first candidate.
    for (const item of store.walkInventory()) {
      inventory.push({ id: item.id, path: item.path });

    }
    const partial = store.partialState();
    const retained = new Set<ObjectId>(pinned);
    if (activeLeases > 0) for (const item of inventory) retained.add(item.id);
    const visited = new Set<ObjectId>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id) || store.denial(id) !== undefined) continue;
      visited.add(id);
      if (partial?.promised.includes(id) === true && !store.has(id)) continue;
      const object = store.read(id);
      retained.add(id);
      if (object.type === "commit") { const commit = decodeCommit(object.payload); pending.push(commit.tree, ...(partial?.shallow.includes(id) === true ? [] : commit.parents)); }
      else if (object.type === "tree") pending.push(...decodeTree(object.payload).map(/** Trees own every sparse and visible entry. */ (entry) => entry.id));
      else if (object.type === "manifest") { const manifest = decodeManifest(object.payload); pending.push(...(manifest.pages ?? manifest.fragments).map(/** Traverse bounded manifest pages and their leaves. */ (entry) => entry.id)); }
      else if (object.type === "series") { const series = decodeSeries(object.payload); pending.push(series.base, ...series.patches.map(/** Review series keep all patch commits. */ (patch) => patch.commit)); }
    }
    const candidates = inventory.filter(/** Physical copies of a retained address remain retained. */ (item) => !retained.has(item.id));
    if (apply) {
      for (const candidate of candidates) unlinkSync(candidate.path);
      store.releaseUploadRoots(visited);
    }
    return { applied: apply, retained: retained.size, candidates: [...new Set(candidates.map(/** Report addresses without exposing physical paths. */ (item) => item.id))].sort(), removed: apply ? candidates.length : 0, activeLeases };
  });
}
