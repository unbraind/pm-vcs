/** Native checkpoint commands delegate receipt history and rendering to the pm host. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CheckpointRefusal, inspectCheckpoints, loadCheckpointReceipt, parseCheckpointRequest, readCheckpointPolicy, updateCheckpointPolicy } from "./engine/checkpoints.ts";
import { readCommit } from "./engine/model.ts";
import { openRepository, optionalString, positiveInteger, requiredArgument, signatureFor } from "./vcs-commands.ts";

/** Read a bounded JSON input with a sanitized refusal; never echo source contents or absolute paths. */
function input(context: CommandHandlerContext, root: string): unknown {
  const path = optionalString(context.options, "input");
  if (path === undefined) throw new CheckpointRefusal("checkpoint_input_required", "Pass --input with a checkpoint request or receiver policy JSON file.");
  try {
    const bytes = readFileSync(resolve(root, path));
    if (bytes.length > 262144) throw new Error("Oversized input.");
    return JSON.parse(bytes.toString("utf8"));
  } catch { throw new CheckpointRefusal("invalid_checkpoint_input", "Supply readable valid checkpoint JSON of at most 256 KiB."); }
}
/** Register compact attach, inspect and receiver administration surfaces without Git. */
export function registerCheckpointCommands(api: ExtensionApi): void {
  const flags = [{ long: "--input", value_name: "file", value_type: "string" as const, description: "Checkpoint request or receiver policy JSON file" }];
  api.registerCommand({
    name: "vcs checkpoint attach", description: "Bind an exact durable core assurance receipt to a native change and semantic scope",
    arguments: [{ name: "revision", required: true, description: "Reachable native revision" }], flags,
    async run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const revision = requiredArgument(context, 0, "revision", "Pass a reachable native revision, for example HEAD.");
      const request = parseCheckpointRequest(input(context, repository.root));
      const verdict = await loadCheckpointReceipt(context.pm_root, request);
      const now = new Date();
      const head = repository.checkpoint(revision, request, verdict, signatureFor(context, now), now);
      return { ok: true, checkpoint: request.id, head };
    },
  });
  api.registerCommand({
    name: "vcs checkpoint inspect", description: "Check all carried validation claims against native fields and receiver policy",
    arguments: [{ name: "revision", required: true, description: "Native revision to inspect" }],
    flags: [{ long: "--limit", value_name: "count", value_type: "string", description: "Output rows, 1..100 (default 20)" }],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const id = repository.resolve(requiredArgument(context, 0, "revision", "Pass a native revision, for example HEAD."));
      return inspectCheckpoints(repository.objects, id, readCommit(repository.objects, id),
        readCheckpointPolicy(repository.instanceLink?.controlDirectory ?? repository.controlDirectory), positiveInteger(context.options, "limit", 20));
    },
  });
  api.registerCommand({
    name: "vcs checkpoint policy", description: "Set receiver-owned required validation scopes; an empty array disables requirements", flags,
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      updateCheckpointPolicy(repository.objects, repository.instanceLink?.controlDirectory ?? repository.controlDirectory, input(context, repository.root));
      return { ok: true };
    },
  });
}
