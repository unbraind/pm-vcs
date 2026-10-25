/** Verified bounded synchronous streams over the loose zlib store. */
import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ObjectStore, ObjectStoreError, type ObjectLocation, type ObjectId, type ObjectType } from "./objects.ts";

/** Stream verified payload chunks without materializing compressed or inflated object bytes. */
export function* objectPayloadChunks(path: string | ObjectLocation, id: ObjectId, type: ObjectType, timeoutMs = 30_000): Generator<Buffer> {
  const location = typeof path === "string" ? (() => {
    const loose = basename(dirname(path)) === id.slice(0, 2) && basename(path).slice(0, 62) === id.slice(2) && /^[0-9a-f]{62}(?:\.[0-9]+\.[0-9a-f]{12}\.tmp)?$/.test(basename(path));
    const native = loose || (basename(dirname(path)) === "packs" && /^[0-9a-f]{64}\.pack$/.test(basename(path)));
    const store = new ObjectStore(native ? dirname(dirname(path)) : dirname(path));
    return store.resolveLocation(id, { path, standalone: !native });
  })() : path;
  if (location === undefined) throw new ObjectStoreError("object_not_found", `No object ${id} in a stable storage generation.`);
  try { location.check(); } catch (error) { closeSync(location.fd); throw error; }
  const shared = new SharedArrayBuffer(65_536 + 8);
  const state = new Int32Array(shared, 0, 2);
  const slot = Buffer.from(shared, 8);
  const worker = new Worker(new URL(`./object-stream-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url), { workerData: { fd: location.fd, offset: location.offset, length: location.length, shared }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
  const digest = createHash("sha256");
  let header = Buffer.alloc(0);
  let length: number | undefined;
  let consumed = 0;
  try {
    for (;;) {
      while (Atomics.load(state, 0) === 0) {
        if (Atomics.wait(state, 0, 0, timeoutMs) === "timed-out") throw new ObjectStoreError("object_stream_timeout", "Decompression worker did not produce a bounded chunk.");
      }
      const status = Atomics.load(state, 0);
      if (status === 2) break;
      const chunk = Buffer.from(slot.subarray(0, Atomics.load(state, 1)));
      if (status === 3) {
        const fault = JSON.parse(chunk.toString()) as { code: string; message: string };
        if (fault.code.startsWith("Z_")) throw new ObjectStoreError("corrupt_object", "Object could not be decompressed.");
        throw Object.assign(new Error(fault.message), { code: fault.code });
      }
      digest.update(chunk);
      let payload = chunk;
      if (length === undefined) {
        const end = chunk.indexOf(0);
        if (end < 0) {
          header = Buffer.concat([header, chunk]);
          if (header.length > 32) throw new ObjectStoreError("malformed_object", "Object stream has an invalid frame header.");
          Atomics.store(state, 0, 0);
          Atomics.notify(state, 0);
          continue;
        }
        if (header.length + end > 32) throw new ObjectStoreError("malformed_object", "Object stream has an invalid frame header.");
        header = Buffer.concat([header, chunk.subarray(0, end)]);
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
      Atomics.store(state, 0, 0);
      Atomics.notify(state, 0);
    }
    if (length === undefined || consumed !== length) throw new ObjectStoreError("malformed_object", "Object stream has a truncated payload.");
    if (digest.digest("hex") !== id) throw new ObjectStoreError("corrupt_object", "Object stream content does not match its address.");
    location.check();
  } finally {
    // The parent owns the descriptor. Keep it pinned until worker I/O is fully terminated, then close exactly once.
    void worker.terminate().then(() => closeSync(location.fd));
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
