/** Explicit agent signing and receiver-administered trust/revocation commands. */
import { readFileSync } from "node:fs";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { openRepository, requiredArgument, signatureFor } from "./vcs-commands.ts";
import { ObjectStoreError } from "./engine/objects.ts";
import { readSigningKey } from "./engine/signatures.ts";
import { updateTrustedKeys } from "./engine/signature-policy.ts";

/** Read public input without forwarding filesystem errors or potentially sensitive path text. */
function publicKeyFile(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch { throw new ObjectStoreError("bad_signature_policy", "Cannot read the public key file."); }
}
/** Register narrow commands: private keys are used only for explicit signing, never during push. */
export function registerSigningCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs sign",
    description: "Explicitly sign a change with an external Ed25519 PEM private key; replay descendants atomically. Content-changing rewrites invalidate signatures and require signing again.",
    arguments: [{ name: "revision", description: "Revision to attest (default HEAD)", required: false }],
    flags: [{ long: "--key", value_name: "file", value_type: "string", description: "Private key file outside the repository" }],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      if (typeof context.options?.key !== "string") throw new ObjectStoreError("invalid_signing_key", "Pass --key with an external Ed25519 private key file.");
      const key = readSigningKey(context.options.key, repository.root);
      if (repository.instanceLink !== null) readSigningKey(context.options.key, repository.instanceLink.hubRoot);
      const now = new Date();
      return { ok: true, head: repository.sign(context.args[0] ?? "HEAD", key, signatureFor(context, now), now) };
    },
  });
  api.registerCommand({
    name: "vcs trust-key",
    description: "Enable signature enforcement and trust an Ed25519 public key for one author email identity. Run on the receiver as its administrator.",
    arguments: [{ name: "identity", description: "Author email this key may attest", required: true },
      { name: "public-key", description: "PEM public key file", required: true }],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const identity = requiredArgument(context, 0, "identity", "Supply the agent's author email.");
      const path = requiredArgument(context, 1, "public key file", "Supply an Ed25519 public key file.");
      return { ok: true, keyId: updateTrustedKeys(repository.objects, repository.instanceLink?.controlDirectory ?? repository.controlDirectory,
        { identity, publicKey: publicKeyFile(path) }) };
    },
  });
  api.registerCommand({
    name: "vcs revoke-key",
    description: "Append an effective-time revocation by public key fingerprint, serialized with publication. Existing revocations are retained.",
    arguments: [{ name: "fingerprint", description: "SHA-256 SPKI fingerprint to revoke", required: true }],
    flags: [{ long: "--effective-at", value_name: "instant", value_type: "string", description: "ISO instant; defaults to receiver time" }],
    run(context: CommandHandlerContext) {
      const repository = openRepository(context);
      const keyId = requiredArgument(context, 0, "fingerprint", "Supply the fingerprint returned by trust-key.");
      const effectiveAt = context.options?.effectiveAt === undefined ? Date.now() : Date.parse(String(context.options.effectiveAt));
      return { ok: true, keyId: updateTrustedKeys(repository.objects, repository.instanceLink?.controlDirectory ?? repository.controlDirectory,
        { keyId, effectiveAt }) };
    },
  });
}
