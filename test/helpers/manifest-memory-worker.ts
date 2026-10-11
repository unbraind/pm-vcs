/** Bounded-heap process measuring metadata retained during real streaming operations. */
import { writeFileSync } from "node:fs";
import { ObjectStore, type ObjectId, type ObjectType } from "../../engine/objects.ts";
import { readFragmentedToFile, readFragmentRange } from "../../engine/fragments.ts";
const [root, id, operation, destination, expected] = process.argv.slice(2);
/** Sample live heap at the first actual fragment read, after the caller has obtained metadata. */
class HeapStore extends ObjectStore {
  maximum = 0;
  samples = 0;
  /** Perform actual disk reads and measure live metadata still retained by the production caller. */
  readTyped(id: ObjectId, type: ObjectType): Buffer {
    if (type === "blob" && this.samples === 0) {
      global.gc?.(); this.maximum = process.memoryUsage().heapUsed; this.samples++;
    }
    return super.readTyped(id, type);
  }
}
const store = new HeapStore(root);
if (operation === "read") readFragmentedToFile(store, id, destination);
else {
  const length = Number(expected);
  const range = readFragmentRange(store, id, length - 1, length);
  if (!range.equals(Buffer.from("x"))) throw new Error("Incorrect range bytes.");
}
writeFileSync(destination + ".measurement.json", JSON.stringify({ maximumHeap: store.maximum, samples: store.samples, operation }));
