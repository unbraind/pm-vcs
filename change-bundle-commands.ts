/** Thin native bundle commands; the pm host owns registration and compact TOON/JSON rendering. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { ChangeBundleRefusal, exportChangeBundle, importChangeBundle, inspectChangeBundle, parseChangeBundleAuthorization, parseChangeBundleScope } from "./engine/change-bundles.ts";
import { readSigningKey } from "./engine/signatures.ts";
import { openRepository, optionalString, requiredArgument } from "./vcs-commands.ts";

/** Require an explicit file option rather than guessing an authority or a signing key. */
function fileOption(context: CommandHandlerContext, name: string): string {
  const value = optionalString(context.options, name);
  if (value === undefined) throw new ChangeBundleRefusal("invalid_change_bundle", "Pass the documented input, authorization, expected and key-file options required by this command.");
  return resolve(value);
}
/** Bound untrusted input before parsing and sanitize filesystem and JSON diagnostics. */
function bytes(path: string): Buffer {
  try {
    const value = readFileSync(path);
    if (value.length > 33554432) throw new Error("Oversized input.");
    return value;
  } catch { throw new ChangeBundleRefusal("invalid_change_bundle", "Supply a readable input file of at most 32 MiB."); }
}
/** JSON input carries explicit scopes and receiver policy; never resolve policy from the incoming bundle. */
function input(context: CommandHandlerContext, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes(fileOption(context, name)).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required.");
    return value as Record<string, unknown>;
  } catch { throw new ChangeBundleRefusal("invalid_change_bundle", "Pass a readable JSON object using the documented request or receiver-policy schema."); }
}
/** Register signed export, read-only inspect and explicit-CAS import without invoking Git. */
export function registerChangeBundleCommands(api: ExtensionApi): void {
  const file = [{ name: "file", required: true, description: "Capability-limited change bundle file" }];
  const authorization = { long: "--authorization", value_name: "file", value_type: "string" as const, description: "Independent receiver scope and native trusted-key policy JSON" };
  api.registerCommand({ name: "vcs bundle export", description: "Export explicitly authorized native tips with a signed scope and omission manifest", arguments: file,
    flags: [{ long: "--input", value_name: "file", value_type: "string", description: "JSON with scope, tips and signer" },
      { long: "--key-file", value_name: "file", value_type: "string", description: "External Ed25519 private key" }],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context); const request = input(context, "input");
      const scope = parseChangeBundleScope(request.scope);
      const selected = request.tips as Record<string, string>;
      const key = readSigningKey(fileOption(context, "keyFile"), repository.root);
      const archive = exportChangeBundle(repository.objects, selected, scope, request.signer as string, key);
      const output = resolve(requiredArgument(context, 0, "file", "Pass a new output file for the signed change bundle."));
      writeFileSync(output, archive, { flag: "wx", mode: 0o600 });
      return { ok: true, bytes: archive.length };
    } });
  for (const action of ["inspect", "import"] as const) api.registerCommand({ name: `vcs bundle ${action}`,
    description: action === "inspect" ? "Verify bundle scope, trust, closure and omissions without importing" : "Import a signed native bundle within independent authority and exact destination leases",
    arguments: file, flags: [authorization, ...(action === "import" ? [{ long: "--expected", value_name: "file", value_type: "string" as const, description: "Exact branch-to-current-id JSON; null requires a new branch" }] : [])],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const archive = bytes(resolve(requiredArgument(context, 0, "file", "Pass the signed change bundle file.")));
      const policy = parseChangeBundleAuthorization(input(context, "authorization"));
      const report = action === "inspect" ? inspectChangeBundle(repository.objects, archive, policy)
        : importChangeBundle(repository, archive, policy, input(context, "expected") as Record<string, string | null>);
      return { ok: true, ...report };
    } });
}
