/** Bounded inspection of supported raw, loose-framed, zlib and canonical base64 representations. */
import { JsonStrings } from "./json-strings.ts";
import { ZStream, zlibInflateInit2, zlibInflate, zlibInflateEnd, Z_SYNC_FLUSH, Z_STREAM_END, Z_OK } from "pako";
import { inflateSync } from "node:zlib";
import { parseFramedObject } from "./objects.ts";
import { VerificationRefusal } from "./object-error.ts";

/** Probe a newly decoded literal without mistaking a zero-output header coincidence for a compressed document. */
function inflateGuess(bytes: Buffer, limit: number): Buffer {
  const stream = new ZStream(); zlibInflateInit2(stream, 15); stream.input = Uint8Array.from(bytes); stream.next_in = 0; stream.avail_in = bytes.length;
  const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const output = new Uint8Array(Math.min(16_384, Math.max(1, limit - total + 1))); stream.output = output; stream.next_out = 0; stream.avail_out = output.length;
      const status = zlibInflate(stream, Z_SYNC_FLUSH);
      if (stream.next_out > 0) { chunks.push(Buffer.from(output.subarray(0, stream.next_out))); total += stream.next_out; }
      if (total > limit) throw new VerificationRefusal("representations", "decoded_bytes", "Supported representation exceeds the decode budget.", "uninspectable_payload");
      if (status === Z_STREAM_END || status !== Z_OK || stream.avail_in === 0 && stream.avail_out > 0) return Buffer.concat(chunks);
    }
  } finally { zlibInflateEnd(stream); }
}

/** Inspect supported nested representations with input-scaled decode accounting; ordinary raw bytes and token counts are not refusal bounds. */
export function inspectRepresentations(input: Buffer, matches: (bytes: Buffer) => boolean, maxDepth = 6, maxBytes = 16 * 1024 * 1024): boolean {
  let remaining = Math.max(maxBytes, input.length * maxDepth);
  /** Visit one decode at a time so long documents cannot exhaust a queue of base64-shaped words. */
  function visit(bytes: Buffer, depth: number, speculative = false): boolean {
    if (matches(bytes)) return true;
    if (depth > 0) {
      remaining -= bytes.length;
      if (remaining <= 0) throw new VerificationRefusal("representations", "decoded_bytes", "Supported representation exceeds the decode budget.", "uninspectable_payload");
    }
    /** Inspect a recognized decode without silently certifying bytes beyond the nesting bound. */
    const decoded = (candidate: Buffer, guess = speculative): boolean => {
      if (depth >= maxDepth) throw new VerificationRefusal("representations", "decode_depth", "Supported encoding exceeds the nesting bound.", "uninspectable_payload");
      return visit(candidate, depth + 1, guess);
    };
    if (/^[a-z]+ [0-9]+\0/.test(bytes.subarray(0, 80).toString("latin1"))) {
      let payload: Buffer;
      try { payload = parseFramedObject(bytes).payload; } catch { throw new VerificationRefusal("representations", "decode_error", "Recognizable loose framing is malformed.", "uninspectable_payload"); }
      if (decoded(payload)) return true;
    }
    const header = bytes[0];
    const flags = bytes[1];
    if (header !== undefined && flags !== undefined && (header & 15) === 8 && (header >> 4) <= 7 && ((header << 8) + flags) % 31 === 0) {
      if (speculative) {
        const guessed = inflateGuess(bytes, Math.max(1, remaining));
        // Every recoverable prefix participates, even when a new literal/hex
        // header guess ends in a codec error. Existing declared streams stay strict.
        if (guessed.length > 0 && decoded(guessed)) return true;
      } else {
        let payload: Buffer;
        try { payload = inflateSync(bytes, { maxOutputLength: Math.max(1, remaining) }); } catch (error) { throw new VerificationRefusal("representations", (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "decoded_bytes" : "decode_error", "Recognizable zlib data cannot be completely inspected.", "uninspectable_payload"); }
        if (decoded(payload)) return true;
      }
    }
    let hit = false; let pieces: Buffer[] = [];
    const json = new JsonStrings(chunk => { pieces.push(Buffer.from(chunk)); }, () => { if (pieces.length > 0) hit ||= decoded(Buffer.concat(pieces), true); pieces = []; });
    json.feed(bytes); json.finish(); if (hit) return true;
    for (const token of bytes.toString("utf8").matchAll(/[0-9a-fA-F]{2,}/g)) { const word = token[0]; for (const offset of [0, 1]) { const size = Math.floor((word.length - offset) / 2) * 2; if (size > 0 && decoded(Buffer.from(word.slice(offset, offset + size), "hex"), true)) return true; } }
    for (const match of bytes.toString("utf8").matchAll(/[A-Za-z0-9+/]{2,}={0,2}/g)) {
      const token = match[0];
      if (token.length % 4 !== 0) continue;
      const candidate = Buffer.from(token, "base64");
      if (candidate.toString("base64") === token && decoded(candidate)) return true;
    }
    return false;
  }
  return visit(input, 0);
}
