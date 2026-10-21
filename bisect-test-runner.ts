/** Execute a recorded PM test after the parent publishes a durable worker receipt. */
import { rmSync } from "node:fs";
import { runTest } from "@unbrained/pm-cli/sdk";

const [item, author, path, receipt, command] = process.argv.slice(2) as [string, string, string, string, string?];
let authorization = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) authorization += String(chunk);
if (authorization !== "run") throw new Error("Bisect worker was not authorized by its parent.");
try {
  const linked = command === undefined ? undefined : await runTest(item, { list: true }, { author, path });
  const index = linked?.tests.findIndex((test) => test.command === command);
  if (index === -1) throw new Error("The explicit bisect command is no longer linked to the evidence item; restore that test before resuming.");
  const result = await runTest(item, { run: true, ...(index === undefined ? {} : { onlyIndex: index + 1 }) }, { author, path });
  process.stdout.write(JSON.stringify(result.run_results));
} finally {
  rmSync(receipt, { force: true });
}
