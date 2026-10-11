/** Real independent receiver process, synchronized by IPC without SDK doubles. */
import { FileTransport } from "../../engine/transport.ts";
import { ObjectStoreError } from "../../engine/objects.ts";
const [root, fileId, action, first, second] = process.argv.slice(2);
const wire = new FileTransport("receiver", root);
process.send?.({ ready: true });
process.once("message", async () => {
  try {
    if (action === "publish") await wire.publish(JSON.parse(first), false, new Date(0), JSON.parse(second));
    else await wire.lease({ action: action as "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60_000, token: first });
    process.send?.({ code: "ok" });
  } catch (error) { process.send?.({ code: error instanceof ObjectStoreError ? error.code : "unexpected" }); }
  process.disconnect?.();
});
