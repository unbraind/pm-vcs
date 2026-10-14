/** Synchronous readers use an isolated HTTP client so range reads hydrate only the requested blob. */
import { HttpTransport } from "./http-transport.ts";
import { parseBundle } from "./bundle.ts";
import { frameObject, ObjectStoreError } from "./objects.ts";
import { readFileSync } from "node:fs";
import { isMainInvocation } from "../scripts/main-invocation.ts";

/** Fetch exactly one verified blob, returning its canonical frame without writing local storage. */
export async function fetchPromisedBlob(url: string, token: string | null, id: string): Promise<Buffer> {
  const wire = new HttpTransport(url, { token });
  const result = parseBundle(await wire.fetchObjects([id]));
  const object = result.lines.find(/** An unrelated object cannot satisfy the promised address. */ (entry) => entry.id === id);
  if (object === undefined || object.type !== "blob") throw new ObjectStoreError("bad_partial_history", "The promisor did not return the requested blob.");
  return frameObject(object.type, object.payload);
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const request = JSON.parse(readFileSync(0, "utf8")) as { url: string; token: string | null; id: string };
  process.stdout.write(await fetchPromisedBlob(request.url, request.token, request.id));
}
