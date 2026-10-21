/** Execute a recorded PM test after the parent publishes a durable worker receipt. */
import { rmSync } from "node:fs";
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
    const linked = await runTest(item, { list: true }, { author, path });
    const index = request.command === undefined ? undefined : linked.tests.findIndex((test) => test.command === request.command);
    if (index === -1) throw new Error("The explicit bisect command is no longer linked to the evidence item; restore that test before resuming.");
    const selected = index === undefined ? linked.tests.map((_, position) => position) : [index];
    for (const position of selected) {
      const test = linked.tests[position];
      // The SDK consumes the bridge for provenance; commands retain their original environment.
      const clearHead = request.bridge && request.githubHead === null && test.env_set?.GITHUB_HEAD_REF === undefined;
      const restoreHead = request.bridge && request.githubHead !== null && request.githubHead !== undefined;
      const result = await runTest(item, { run: true, onlyIndex: position + 1,
        ...(clearHead ? { envClear: ["GITHUB_HEAD_REF"] } : {}),
        ...(restoreHead ? { envSet: [`GITHUB_HEAD_REF=${request.githubHead}`] } : {}),
      }, { author, path });
      results.push(...result.run_results);
    }
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  rmSync(receipt, { force: true });
}
