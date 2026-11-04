import { durability } from "./engine/durability.ts";
/** Execute a recorded PM test after the parent publishes a durable worker receipt. */
import { runTest, type TestRunResult } from "@unbrained/pm-cli/sdk";

const [item, author, path, receipt, raw = "{}"] = process.argv.slice(2) as [string, string, string, string, string?];
const request = JSON.parse(raw) as { command?: string; recordOnly?: boolean; bridge?: boolean; githubHead?: string | null };
let authorization = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) authorization += String(chunk);
if (authorization !== "run") throw new Error("Bisect worker was not authorized by its parent.");
try {
  const results: TestRunResult[] = [];
  if (request.recordOnly) {
    await runTest(item, { addJson: [JSON.stringify({ command: request.command })] }, { author, path });
  } else {
    const linked = request.command === undefined ? undefined : await runTest(item, { list: true }, { author, path });
    const index = linked?.tests.findIndex((test) => test.command === request.command);
    if (index === -1) throw new Error("The explicit bisect command is no longer linked to the evidence item; restore that test before resuming.");
    // Runtime directives restore ambient state before the SDK applies each test's own directives.
    // Keep one SDK run so linked commands retain their shared PM/workspace sandbox.
    const clearHead = request.bridge && request.githubHead === null;
    const restoreHead = request.bridge && request.githubHead !== null && request.githubHead !== undefined;
    const result = await runTest(item, { run: true,
      ...(index === undefined ? {} : { onlyIndex: index + 1 }),
      ...(clearHead ? { envClear: ["GITHUB_HEAD_REF"] } : {}),
      ...(restoreHead ? { envSet: [`GITHUB_HEAD_REF=${request.githubHead}`] } : {}),
    }, { author, path });
    results.push(...result.run_results);
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  durability.remove(receipt, { force: true });
}
