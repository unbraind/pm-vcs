/** Bounded decompression worker used by synchronous legacy-compatible readers. */
import { createReadStream } from "node:fs";
import { createInflate } from "node:zlib";
import { workerData } from "node:worker_threads";

/** Run one backpressured stream; errors cross the same bounded shared slot as bytes. */
async function decompress(): Promise<void> {
  const { path, shared } = workerData as { path: string; shared: SharedArrayBuffer };
  const state = new Int32Array(shared, 0, 2);
  const slot = new Uint8Array(shared, 8);
  /** Deliver one chunk and wait until the synchronous reader releases the slot. */
  const deliver = (bytes: Uint8Array, status: number): void => {
    slot.set(bytes);
    Atomics.store(state, 1, bytes.length);
    Atomics.store(state, 0, status);
    Atomics.notify(state, 0);
    if (status === 1) while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1);
  };
  const source = createReadStream(path, { highWaterMark: 16_384 });
  const inflater = createInflate({ chunkSize: 16_384 });
  source.on("error", /** Preserve operational filesystem errors rather than calling them corruption. */ (error) => inflater.destroy(error));
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) {
      const bytes = chunk as Buffer;
      for (let offset = 0; offset < bytes.length; offset += slot.length) deliver(bytes.subarray(offset, offset + slot.length), 1);
    }
    deliver(new Uint8Array(), 2);
  } catch (error) {
    const fault = error as NodeJS.ErrnoException;
    deliver(Buffer.from(JSON.stringify({ code: String(fault.code), message: fault.message })), 3);
  } finally {
    source.destroy();
    inflater.destroy();
  }
}

await decompress();
