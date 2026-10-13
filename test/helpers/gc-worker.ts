/** Real cross-process upload/publication and interrupted-sweep fixtures. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cloneFrom } from "../../engine/sync.ts";
import { collectGarbage } from "../../engine/gc.ts";
import { exportBundle, parseBundle } from "../../engine/bundle.ts";
import { Repository } from "../../engine/repo.ts";
import { acquirePublicationLeases } from "./publication-consumers.ts";
import { FileTransport } from "../../engine/transport.ts";

const [action, root, remote] = process.argv.slice(2);
const repository = action === "clone" ? null : Repository.open(root);
if (action === "crash") {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = path => {
    unlink(path);
    if (String(path).replaceAll("\\", "/").includes("/objects/")) {
      process.send?.({ deleted: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
  };
  syncBuiltinESMExports();
  collectGarbage(repository!, true);
} else if (action === "hold-gc") {
  repository!.objects.withWriteLock(() => {
    process.send?.({ locked: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    collectGarbage(repository!, true);
  });
  process.disconnect?.();
} else if (action === "upload") {
  const wire = new FileTransport(remote, remote);
  const bundle = exportBundle(repository!.objects, repository!.refs, ["refs/heads/main"]);
  await wire.uploadObjects(parseBundle(bundle).lines);
  process.send?.({ uploaded: true });
  process.once("message", async () => {
    const update = [{ ref: "refs/heads/main", expected: null, next: repository!.resolve("main") }];
    const proofs = await acquirePublicationLeases(wire, update, bundle);
    await wire.publish(update, false, new Date(), proofs);
    process.send?.({ published: true });
    process.disconnect?.();
  });
} else {
  await cloneFrom(remote, root, new Date());
  process.send?.({ cloned: true });
  process.disconnect?.();
}
