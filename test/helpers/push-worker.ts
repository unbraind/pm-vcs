/** Independent pusher with an IPC barrier after advertisement and before publication. */
import { exportBundle } from "../../engine/bundle.ts";
import { HttpTransport } from "../../engine/http-transport.ts";
import { ObjectStoreError } from "../../engine/objects.ts";
import { Repository } from "../../engine/repo.ts";

const [root, url, branch] = process.argv.slice(2);
const repository = Repository.open(root);
const wire = new HttpTransport(url);
const advertisement = await wire.advertise();
const ref = `refs/heads/${branch}`;
const expected = advertisement.refs.find((entry) => entry.name === ref)?.target ?? null;
const next = repository.resolve(branch);
const bundle = exportBundle(repository.objects, repository.refs, [ref]);
process.send?.({ ready: true });
process.once("message", async () => {
  try {
    await wire.push(bundle, [{ ref, expected, next }], false, new Date());
    process.send?.({ result: "ok" });
  } catch (error) {
    process.send?.({ result: error instanceof ObjectStoreError ? error.code : "unexpected" });
  }
  process.disconnect?.();
});
