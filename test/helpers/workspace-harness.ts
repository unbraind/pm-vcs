/** Real host dispatch with source and tracker coordinates for disposable fixtures. */
import { basename, dirname, resolve } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

let commandQueue: Promise<void> = Promise.resolve();

/** Find the source of a conventional tracker or a fixture with a flat tracker. */
function fixtureWorkspace(pmRoot: string): string {
  const tracker = resolve(pmRoot);
  const parent = dirname(tracker);
  return basename(tracker) === "pm" && basename(parent) === ".agents" ? dirname(parent) : tracker;
}

/** Select the fixture workspace for each real host invocation and restore its caller's environment. */
export async function createWorkspaceHarness(
  ...args: Parameters<typeof createExtensionTestHarness>
): ReturnType<typeof createExtensionTestHarness> {
  const harness = await createExtensionTestHarness(...args);
  return {
    ...harness,
    runCommand(request) {
      // Workspace selection is a process setting. Serialize dispatches within
      // each test process so concurrent fixtures cannot lend each other roots.
      const command = commandQueue.then(async () => {
        if (request.pmRoot === undefined || request.pmRoot === "") return harness.runCommand(request);
        const previous = process.env.PM_SOURCE_WORKSPACE_ROOT;
        process.env.PM_SOURCE_WORKSPACE_ROOT = fixtureWorkspace(request.pmRoot);
        try {
          return await harness.runCommand(request);
        } finally {
          if (previous === undefined) delete process.env.PM_SOURCE_WORKSPACE_ROOT;
          else process.env.PM_SOURCE_WORKSPACE_ROOT = previous;
        }
      });
      commandQueue = command.then(() => undefined, () => undefined);
      return command;
    },
  };
}
