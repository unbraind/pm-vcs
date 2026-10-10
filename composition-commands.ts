/** Native CLI operations for pinned links, private overlays and authorized erasure. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { openRepository, optionalString, requiredArgument, sourceWorkingRoot } from "./vcs-commands.ts";
import { Repository } from "./engine/repo.ts";
import { decodeLink } from "./engine/composition.ts";
import { ObjectStoreError } from "./engine/objects.ts";

/** Read an explicitly named local credential without storing it in descriptor or command output. */
function credential(context: CommandHandlerContext, flag: string): string {
  const file = optionalString(context.options, flag);
  if (file === undefined) throw new ObjectStoreError("missing_credential", `An explicit --${flag.replace(/[A-Z]/g, /** Convert SDK option casing to command flag spelling. */ (letter) => `-${letter.toLowerCase()}`)} is required.`);
  return readFileSync(resolve(sourceWorkingRoot(context), file), "utf8").trim();
}

/** Register complete engine-backed composition and lifecycle commands. */
export function registerCompositionCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs recover-lock",
    description: "Recover a confirmed dead ordinary writer or an aged empty legacy lock without erasure authority.",
    /** Recover only the lease; pending erasure still requires its separate authorized cleanup. */
    run(context: CommandHandlerContext) {
      openRepository(context).objects.recoverWriterLock();
      return { ok: true };
    },
  });
  api.registerCommand({
    name: "vcs instance prune-retired",
    description: "Explicitly relinquish a missing or unbound retired cleanup path with erasure authority and a local audit reason.",
    arguments: [{ name: "path", required: true, description: "Stored hub-relative retired instance path" }],
    flags: [
      { long: "--erase-token-file", value_name: "file", value_type: "string", description: "Local permanent-erasure credential file" },
      { long: "--reason", value_name: "code", value_type: "string", description: "Bounded audit reason for relinquishing cleanup scope" },
    ],
    /** Record the scope reduction before removing its inventory entry; never delete instance bytes. */
    run(context: CommandHandlerContext) {
      const path = requiredArgument(context, 0, "retired instance path", "pm vcs instance prune-retired path --reason retired");
      const reason = optionalString(context.options, "reason");
      if (reason === undefined) throw new ObjectStoreError("bad_prune_reason", "An explicit --reason code is required.");
      openRepository(context).pruneRetiredInstance(path, credential(context, "eraseTokenFile"), reason, new Date());
      return { ok: true, pruned: path };
    },
  });
  api.registerCommand({
    name: "vcs authority",
    description: "Configure distinct local credentials for pinned-target reads and permanent erasure; grants never enter bundles.",
    flags: [
      { long: "--principal", value_name: "name", value_type: "string", description: "Audit principal" },
      { long: "--read-token-file", value_name: "file", value_type: "string", description: "Separate target read credential file" },
      { long: "--erase-token-file", value_name: "file", value_type: "string", description: "Permanent-erasure credential file" },
    ],
    /** Configure grants only in clone-local control storage. */
    run(context: CommandHandlerContext) {
      const principal = optionalString(context.options, "principal");
      if (principal === undefined) throw new ObjectStoreError("bad_authority", "An explicit audit principal is required.");
      openRepository(context).setAuthority(principal, credential(context, "readTokenFile"), credential(context, "eraseTokenFile"));
      return { ok: true, principal };
    },
  });
  api.registerCommand({
    name: "vcs link",
    description: "Stage a canonical committed link descriptor, or list pinned links without contacting their targets.",
    arguments: [{ name: "descriptor", required: false, description: "Repository-relative descriptor path" }],
    flags: [
      { long: "--spec", value_name: "file", value_type: "string", description: "Canonical JSON link descriptor file" },
      { long: "--list", description: "List staged typed links" },
    ],
    /** Stage only immutable descriptor metadata, never target bytes. */
    run(context: CommandHandlerContext) {
      const repo = openRepository(context);
      if (context.options?.list === true) return { ok: true, links: repo.links() };
      const path = requiredArgument(context, 0, "descriptor path", "pm vcs link descriptor --spec link.json");
      const spec = optionalString(context.options, "spec");
      if (spec === undefined) throw new ObjectStoreError("bad_link", "A canonical --spec file is required.");
      return { ok: true, id: repo.stageLink(path, decodeLink(readFileSync(resolve(sourceWorkingRoot(context), spec)))) };
    },
  });
  api.registerCommand({
    name: "vcs link resolve",
    description: "Resolve an exact immutable pin with separately supplied target credentials into a private layer.",
    arguments: [{ name: "descriptor", required: true, description: "Staged link path" }],
    flags: [
      { long: "--target", value_name: "directory", value_type: "string", description: "Explicit local target repository binding" },
      { long: "--read-token-file", value_name: "file", value_type: "string", description: "Target's separate read credential file" },
      { long: "--layer", value_name: "name", value_type: "string", description: "Name for private resolved files" },
    ],
    /** Verify target identity, revision and authorization before private materialization. */
    run(context: CommandHandlerContext) {
      const target = optionalString(context.options, "target");
      const layer = optionalString(context.options, "layer");
      if (target === undefined || layer === undefined) throw new ObjectStoreError("bad_link", "Resolution requires an explicit --target and --layer.");
      const repo = openRepository(context);
      const created = repo.resolveLink(requiredArgument(context, 0, "descriptor path", "pm vcs link resolve descriptor"),
        Repository.open(resolve(sourceWorkingRoot(context), target)), credential(context, "readTokenFile"), layer);
      return { ok: true, layer: { name: created.name, paths: created.files.map(/** Report ownership without printing private bytes. */ (file) => file.path) } };
    },
  });
  api.registerCommand({
    name: "vcs layer",
    description: "Overlay exact paths privately, list exclusions, or remove a layer restoring current underlying index bytes.",
    arguments: [
      { name: "name", required: false, description: "Private layer name" },
      { name: "destination", required: false, description: "Canonical destination path" },
      { name: "source", required: false, description: "Source file for the overlay snapshot" },
    ],
    flags: [
      { long: "--list", description: "Show names and excluded paths" },
      { long: "--remove", description: "Remove the named layer" },
      { long: "--discard-edits", description: "Explicitly discard edited overlay bytes during removal" },
      { long: "--executable", description: "Overlay file is executable" },
    ],
    /** Keep private bytes outside objects, index, history and ordinary status changes. */
    run(context: CommandHandlerContext) {
      const repo = openRepository(context);
      if (context.options?.list === true) return { ok: true, layers: repo.layers().map(/** Listing exposes ownership but never content. */ (layer) => ({ name: layer.name, paths: layer.files.map(/** Extract canonical exclusion paths. */ (file) => file.path) })) };
      const name = requiredArgument(context, 0, "layer name", "pm vcs layer local destination source");
      if (context.options?.remove === true) { repo.removeLayer(name, context.options?.discardEdits === true); return { ok: true, removed: name }; }
      const destination = requiredArgument(context, 1, "destination path", "pm vcs layer local destination source");
      const source = requiredArgument(context, 2, "source file", "pm vcs layer local destination source");
      repo.addLayer(name, new Map([[destination, { content: readFileSync(resolve(sourceWorkingRoot(context), source)), executable: context.options?.executable === true }]]));
      return { ok: true, layer: { name, paths: [destination] } };
    },
  });
  api.registerCommand({
    name: "vcs obliterate",
    description: "Permanently erase every historical payload of one stable FileId under explicit local authority, or resume interrupted cleanup.",
    arguments: [{ name: "file", required: true, description: "FileId or indexed canonical path" }],
    flags: [
      { long: "--erase-token-file", value_name: "file", value_type: "string", description: "Local permanent-erasure credential file" },
      { long: "--reason", value_name: "code", value_type: "string", description: "Bounded audit reason code" },
      { long: "--recover-lock", description: "Explicitly recover a crashed writer lock before authorized cleanup" },
    ],
    /** Persist denial before byte deletion and return only the typed audit receipt. */
    run(context: CommandHandlerContext) {
      const repo = openRepository(context);
      const token = credential(context, "eraseTokenFile");
      const reason = optionalString(context.options, "reason");
      if (reason === undefined) throw new ObjectStoreError("bad_tombstone", "An explicit --reason code is required.");
      if (context.options?.recoverLock === true) repo.objects.recoverWriterLock();
      return { ok: true, erasure: repo.obliterate(requiredArgument(context, 0, "FileId or indexed path", "pm vcs obliterate file --reason incident"), token, reason, new Date()) };
    },
  });
}
