// One real `pm vcs serve` process, for the command-surface test that spawns it.
//
// The parent test needs the serve command running in a separate process the way
// an operator runs it: the command starts the server, reports the bound
// address, and keeps its process alive because the server is listening. This
// worker activates the extension through the host's real harness, runs the
// command, prints one `SERVE-READY <port>` line the parent waits for, and then
// serves until the parent stops the process.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../../index.ts";
import { packageRoot } from "./tmp.ts";

/** Capability list the harness accepts, derived from its own signature. */
type HarnessCapabilities = NonNullable<
  NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]
>;

const [serveRoot, listen] = process.argv.slice(2);
if (serveRoot === undefined) {
  console.error("usage: serve-worker.ts <serve-root> [listen]");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
  capabilities: HarnessCapabilities;
};

const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
const run = await harness.runCommand({
  command: "vcs serve",
  options: { root: serveRoot, ...(listen === undefined ? {} : { listen }) },
  pmRoot: serveRoot,
});
if (run.errorMessage !== undefined) {
  console.error(String(run.errorMessage));
  process.exit(3);
}
const serve = (run.result as { serve: { port: number } }).serve;
console.log(`SERVE-READY ${serve.port}`);