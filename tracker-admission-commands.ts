/** Compact explicit tracker admission over the same SDK capture path as programmatic callers. */
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { TrackerAdmissionRefusal, TrackerCapture } from "./engine/tracker-admission.ts";
import { openRepository, requiredArgument, signatureFor, sourceWorkingRoot } from "./vcs-commands.ts";
/** Read one bounded regular JSON file; refuse before opening any native revision for mutation. */
function input(context: CommandHandlerContext): unknown {
  const path = context.options?.input;
  if (typeof path !== "string" || path.trim() === "") throw new TrackerAdmissionRefusal("invalid_tracker_admission", "Pass --input with a tracker admission JSON file of at most 32 KiB.");
  let descriptor: number | undefined;
  let value: unknown;
  try {
    descriptor = openSync(resolve(sourceWorkingRoot(context), path), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Invalid input file.");
    const content = Buffer.alloc(32769);
    let length = 0;
    while (length < content.length) {
      const count = readSync(descriptor, content, length, content.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 32768) throw new Error("Changing input file.");
    value = JSON.parse(content.subarray(0, length).toString("utf8"));
  } catch { throw new TrackerAdmissionRefusal("invalid_tracker_admission", "Supply readable valid tracker admission JSON of at most 32 KiB."); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  return value;
}
/** Register one native commit command; retry receipts remain machine readable in both host formats. */
export function registerTrackerAdmissionCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "vcs commit-tracker", description: "Commit staged source plus explicitly selected SDK-verified tracker item/history pairs, or return a retry witness",
    arguments: [{ name: "message", required: true, description: "Native revision message" }],
    flags: [{ long: "--input", value_name: "file", value_type: "string", description: "Strict items/expectedTip JSON, at most 32 KiB" }],
    async run(context: CommandHandlerContext) {
      const raw = input(context);
      const message = requiredArgument(context, 0, "message", "Supply a native revision message.");
      const repository = openRepository(context);
      const now = new Date();
      return new TrackerCapture(repository, context.pm_root, raw).commit({ message, author: signatureFor(context, now) }, now);
    },
  });
}
