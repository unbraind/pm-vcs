/** Verified bounded synchronous streams over the loose zlib store. */
import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { Inflate } from "pako";
import { basename, dirname, resolve } from "node:path";
import { ObjectStore, ObjectStoreError, type ObjectLocation, type ObjectId, type ObjectType } from "./objects.ts";

/** Stream verified payload chunks without materializing compressed or inflated object bytes. */
export function objectPayloadChunks(path: string | ObjectLocation, id: ObjectId, type: ObjectType, timeoutMs = 30_000): Generator<Buffer> {
  return verifiedPayloadChunks(typeof path === "string" ? resolve(path) : path, id, type, timeoutMs);
}

/** Decode a captured physical path or transferred location, with deterministic ownership on every exit. */
function* verifiedPayloadChunks(path: string | ObjectLocation, id: ObjectId, type: ObjectType, timeoutMs: number): Generator<Buffer> {
  const location = typeof path === "string" ? (() => {
    const loose = basename(dirname(path)) === id.slice(0, 2) && basename(path).slice(0, 62) === id.slice(2) && /^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(basename(path));
    const native = loose || (basename(dirname(path)) === "packs" && /^[0-9a-f]{64}\.pack$/.test(basename(path)));
    const store = new ObjectStore(native ? dirname(dirname(path)) : dirname(path));
    return store.resolveLocation(id, { path, standalone: !native });
  })() : path;
  if (location === undefined) throw new ObjectStoreError("object_not_found", `No object ${id} in a stable storage generation.`);
  try {
    location.check();
    // A 64-byte compressed push expands by at most the DEFLATE ratio, with 16 KiB output slots.
    // The synchronous decoder owns only JS memory: no worker, native stream, or deferred close.
    const pending: Buffer[] = [];
    const inflater = new Inflate({ chunkSize: 16_384, windowBits: 15 });
    inflater.onData = /** Retain bounded output only until the next consumer yield. */ (bytes) => { pending.push(Buffer.from(bytes)); };
    const input = Buffer.alloc(64);
    let offset = 0;
    const digest = createHash("sha256");
    let length: number | undefined;
    let consumed = 0;
    while (offset < location.length) {
      const started = performance.now();
      const count = readSync(location.fd, input, 0, Math.min(input.length, location.length - offset), location.offset + offset);
      if (count === 0) throw new ObjectStoreError("corrupt_object", "Pinned compressed object was truncated.");
      offset += count;
      inflater.push(input.subarray(0, count), offset === location.length);
      if (performance.now() - started >= timeoutMs) throw new ObjectStoreError("object_stream_timeout", "Synchronous decompression exceeded its per-step deadline.");
      if (inflater.err !== 0) throw new ObjectStoreError("corrupt_object", "Object could not be decompressed.");
      for (const chunk of pending.splice(0)) {
        digest.update(chunk);
        let payload = chunk;
        if (length === undefined) {
          const end = chunk.indexOf(0);
          // Full 16 KiB slots (or the final slot) contain every valid <=32-byte header in the first output slot.
          if (end < 0 || end > 32) throw new ObjectStoreError("malformed_object", "Object stream has an invalid frame header.");
          const header = chunk.subarray(0, end);
          const match = /^([a-z]+) (0|[1-9][0-9]*)$/.exec(header.toString("latin1"));
          if (match === null || !Number.isSafeInteger(Number(match[2]))) throw new ObjectStoreError("malformed_object", "Object stream has malformed framing.");
          location.validateFrame(match[1], header.length + 1 + Number(match[2]));
          if (match[1] !== type) throw new ObjectStoreError("object_type_mismatch", "Object stream has the wrong kind.");
          length = Number(match[2]);
          payload = chunk.subarray(end + 1);
        }
        consumed += payload.length;
        if (consumed > length) throw new ObjectStoreError("malformed_object", "Object stream exceeds its declared payload length.");
        location.check();
        yield payload;
      }
    }
    if (!inflater.ended) throw new ObjectStoreError("corrupt_object", "Compressed object has a truncated zlib frame.");
    if (length === undefined || consumed !== length) throw new ObjectStoreError("malformed_object", "Object stream has a truncated payload.");
    if (digest.digest("hex") !== id) throw new ObjectStoreError("corrupt_object", "Object stream content does not match its address.");
    location.check();
  } finally {
    location.close();
  }
}

/** Decode bounded newline-terminated metadata lines and verify the entire enclosing object. */
export function* objectPayloadLines(chunks: Iterable<Buffer>): Generator<string> {
  let partial = "";
  for (const chunk of chunks) {
    const text = partial + chunk.toString("latin1");
    let offset = 0;
    for (;;) {
      const next = text.indexOf("\n", offset);
      if (next < 0) break;
      if (next - offset > 128) throw new ObjectStoreError("malformed_object", "Manifest line exceeds its canonical bound.");
      yield text.slice(offset, next);
      offset = next + 1;
    }
    partial = text.slice(offset);
    if (partial.length > 128) throw new ObjectStoreError("malformed_object", "Manifest line exceeds its canonical bound.");
  }
  if (partial.length > 0) throw new ObjectStoreError("malformed_object", "Manifest lacks the canonical terminating newline.");
}
