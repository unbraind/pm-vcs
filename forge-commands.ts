/** Agent-facing native propose, review and land commands over either transport. */
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { openRepository, optionalString, requiredArgument, signatureFor } from "./vcs-commands.ts";
import { importBundleObjects } from "./engine/bundle.ts";
import { decodeRecord, readSeries, type RecordDocument } from "./engine/model.ts";
import { isObjectId, ObjectStoreError } from "./engine/objects.ts";
import { createSeries, exportSeriesBundle, rederiveSeries } from "./engine/series.ts";
import { remoteLeaseProofs } from "./engine/lease-workflows.ts";
import { openTransport } from "./engine/transport.ts";
import { readForgeReview, type ForgeRequest } from "./engine/forge.ts";
import type { Repository } from "./engine/repo.ts";
import { isAncestor, reachable } from "./engine/merge.ts";

/** Resolve a configured remote and keep its credential separate from printable command results. */
function remote(repository: Repository, name: string) {
  const configured = repository.remotes.require(name);
  return openTransport(configured.url, repository.root, /^https?:/i.test(configured.url) ? repository.remotes.token(name) : null);
}

/** Require a command flag whose absence must never imply a destructive update. */
function flag(context: CommandHandlerContext, name: string): string {
  const value = optionalString(context.options, name);
  if (value === undefined) throw new ObjectStoreError("missing_argument", `An explicit --${name} is required.`);
  return value;
}

/** One validated proposal or review name in the catalog. */
function proposalName(context: CommandHandlerContext): string {
  return requiredArgument(context, 0, "proposal name", "Pass the name used when the series was proposed.");
}

/** Register the local series verbs and remote forge workflow. */
export function registerForgeCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs series create", description: "Produce a native series from (base, tip] with stable canonical bytes.",
    arguments: [{ name: "base", required: true, description: "Exclusive range base" }, { name: "tip", required: true, description: "Inclusive range tip" }],
    flags: [{ long: "--description", value_name: "text", value_type: "string", description: "Proposal description" }],
    /** Use the command author once; rederive later reuses this stored signature. */
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const base = repository.resolve(requiredArgument(context, 0, "base", "Pass base and tip revisions."));
      const tip = repository.resolve(requiredArgument(context, 1, "tip", "Pass base and tip revisions."));
      return { ok: true, id: createSeries(repository.objects, base, tip, { description: flag(context, "description"), author: signatureFor(context, new Date()) }) };
    },
  });
  for (const action of ["rederive", "apply"] as const) api.registerCommand({
    name: `vcs series ${action}`, description: action === "apply" ? "Apply a fetched series onto HEAD." : "Reproduce a fetched series using its original range and author; compare canonical bytes.",
    arguments: [{ name: "id", required: true, description: "Native series object id" }],
    /** Reuse the stored series metadata to make identity independent of the fetching agent's clock. */
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const id = requiredArgument(context, 0, "series id", "Pass a fetched series object id.");
      const series = readSeries(repository.objects, id);
      if (series.patches.length === 0) throw new ObjectStoreError("empty_series", "The series contains no patches.");
      if (action === "apply") {
        const now = new Date();
        const author = signatureFor(context, now);
        const tip = series.patches.at(-1)!.commit;
        // Landing on the original base preserves the exact commits and permits rederivation from the applied HEAD,
        // but only when base..tip holds exactly the declared patches: a merge patch's other parent must never
        // enter the applied history undeclared.
        if (repository.refs.resolveHead() === series.base && isAncestor(repository.objects, series.base, tip)
          && rangeIsExactlyDeclared(repository, series.base, tip, series.patches.map(patch => patch.commit))) {
          repository.merge(tip, { message: "Apply native series\n", author }, now);
          return { ok: true, commit: repository.refs.resolveHead()! };
        }
        const commit = repository.objects.withWriteLock(/** Keep all patch replays inside one native mutation lease. */ () => {
          let tip = series.base;
          for (const patch of series.patches) tip = repository.cherryPick(patch.commit, author, now);
          return tip;
        });
        return { ok: true, commit };
      }
      const derived = rederiveSeries(repository.objects, series.base, series.patches.at(-1)!.commit, { description: series.description, author: series.author });
      if (!repository.objects.readTyped(id, "series").equals(repository.objects.readTyped(derived, "series"))) throw new ObjectStoreError("series_mismatch", "The rederived series bytes differ.");
      return { ok: true, id: derived, identical: true };
    },
  });
  api.registerCommand({
    name: "vcs series push", description: "Propose or CAS-update a named series on a served repository, carrying saved FileId lease proofs.",
    arguments: [{ name: "name", required: true, description: "Proposal catalog name" }, { name: "id", required: true, description: "Local series object id" }, { name: "remote", required: false, description: "Configured remote, default origin" }],
    flags: [{ long: "--branch", value_name: "ref", value_type: "string", description: "Explicit refs/heads branch lease scope" }, { long: "--expected", value_name: "id", value_type: "string", description: "Observed series id when updating; omit to create only" }],
    /** Include the complete native closure and never acquire leases implicitly. */
    async run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const name = proposalName(context);
      const id = requiredArgument(context, 1, "series id", "Pass the local series id to propose.");
      const remoteName = context.args[2]?.trim() || "origin";
      const result = await remote(repository, remoteName).forge({ action: "publish", kind: "series", name, series: id,
        expected: optionalString(context.options, "expected") ?? null, branch: flag(context, "branch"),
        bundle: exportSeriesBundle(repository.objects, id).toString("base64"), proofs: remoteLeaseProofs(repository, remoteName) });
      return { ok: true, ...result };
    },
  });
  for (const kind of ["series", "review"] as const) for (const action of ["list", "fetch"] as const) api.registerCommand({
    name: `vcs ${kind} ${action}`, description: `Read the remote ${kind} catalog${action === "fetch" ? " and import its verified native objects" : ""}.`,
    arguments: [...(action === "fetch" ? [{ name: "name", required: true, description: "Proposal name" }] : []), { name: "remote", required: false, description: "Configured remote, default origin" }],
    /** Persist fetched immutable objects without moving a working branch. */
    async run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const remoteName = context.args[action === "fetch" ? 1 : 0]?.trim() || "origin";
      const request: ForgeRequest = { action, kind, ...(action === "fetch" ? { name: proposalName(context) } : {}) };
      const result = await remote(repository, remoteName).forge(request);
      if (action === "fetch") {
        repository.objects.withWriteLock(/** Imported catalogs remain native GC roots without changing the working branch. */ () => {
          importBundleObjects(repository.objects, Buffer.from(result.bundle as string, "base64"));
          const ref = `refs/forge-${kind}/${request.name!}`;
          const before = repository.refs.read(ref);
          const after = kind === "series" ? result.id : result.revision;
          if (typeof after !== "string" || !isObjectId(after)) throw new ObjectStoreError("invalid_object_id", "The fetched forge root is not a valid object id.");
          if (!repository.objects.has(after)) throw new ObjectStoreError("object_not_found", "The fetched forge root is absent from the local object store.");
          if (kind === "series") readSeries(repository.objects, after);
          else readForgeReview(repository, after);
          repository.refs.compareAndSwap(ref, before, after);
          repository.operations.append("forge-fetch", "Fetched verified native forge objects.", [{ ref, before, after }], new Date());
        });
      }
      const { bundle: _bundle, ...receipt } = result;
      return { ok: true, ...receipt };
    },
  });
  api.registerCommand({
    name: "vcs review update", description: "Merge a JSON field patch against an observed review revision; return the recorded resolution outcome.",
    arguments: [{ name: "name", required: true, description: "Proposal name" }, { name: "remote", required: false, description: "Configured remote, default origin" }],
    flags: [{ long: "--base", value_name: "revision", value_type: "string", description: "Observed native review revision" }, { long: "--fields", value_name: "json", value_type: "string", description: "JSON object containing only the fields to change" }],
    /** The server supplies principal identity and preserves unrelated concurrent fields. */
    async run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const fields: RecordDocument = decodeRecord(Buffer.from(flag(context, "fields")));
      return { ok: true, ...await remote(repository, context.args[1]?.trim() || "origin").forge({ action: "publish", kind: "review", name: proposalName(context), expected: flag(context, "base"), fields }) };
    },
  });
}

/**
 * Whether the commits reachable from `tip` but not from `base` are exactly the declared patch commits.
 *
 * @param repository - Repository holding the commits.
 * @param base - The series base (exclusive).
 * @param tip - The last declared patch (inclusive).
 * @param declared - Every declared patch commit.
 * @returns True when a fast-forward to `tip` adds no undeclared commit.
 */
function rangeIsExactlyDeclared(repository: Repository, base: string, tip: string, declared: readonly string[]): boolean {
  const excluded = reachable(repository.objects, base);
  const range = [...reachable(repository.objects, tip)].filter(id => !excluded.has(id));
  const expected = new Set(declared);
  return range.length === expected.size && range.every(id => expected.has(id));
}
