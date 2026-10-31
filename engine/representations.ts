/** Bounded inspection of supported raw, loose-framed, zlib and canonical base64 representations. */
import { inflateSync } from "node:zlib";
import { parseFramedObject } from "./objects.ts";
import { VerificationRefusal } from "./object-error.ts";

/** Inspect supported nested representations with input-scaled decode accounting; ordinary raw bytes and token counts are not refusal bounds. */
export function inspectRepresentations(input: Buffer, matches: (bytes: Buffer) => boolean, maxDepth = 6, maxBytes = 16 * 1024 * 1024): boolean {
  let remaining = Math.max(maxBytes, input.length * maxDepth);
  /** Visit one decode at a time so long documents cannot exhaust a queue of base64-shaped words. */
  function visit(bytes: Buffer, depth: number): boolean {
    if (matches(bytes)) return true;
    if (depth > 0) {
      remaining -= bytes.length;
      if (remaining <= 0) throw new VerificationRefusal("representations", "decoded_bytes", "Supported representation exceeds the decode budget.", "uninspectable_payload");
    }
    /** Inspect a recognized decode without silently certifying bytes beyond the nesting bound. */
    const decoded = (candidate: Buffer): boolean => {
      if (depth >= maxDepth) throw new VerificationRefusal("representations", "decode_depth", "Supported encoding exceeds the nesting bound.", "uninspectable_payload");
      return visit(candidate, depth + 1);
    };
    if (/^[a-z]+ [0-9]+\0/.test(bytes.subarray(0, 80).toString("latin1"))) {
      let payload: Buffer;
      try { payload = parseFramedObject(bytes).payload; } catch { throw new VerificationRefusal("representations", "decode_error", "Recognizable loose framing is malformed.", "uninspectable_payload"); }
      if (decoded(payload)) return true;
    }
    const header = bytes[0];
    const flags = bytes[1];
    if (header !== undefined && flags !== undefined && (header & 15) === 8 && (header >> 4) <= 7 && ((header << 8) + flags) % 31 === 0) {
      let payload: Buffer;
      try { payload = inflateSync(bytes, { maxOutputLength: Math.max(1, remaining) }); } catch (error) { throw new VerificationRefusal("representations", (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "decoded_bytes" : "decode_error", "Recognizable zlib data cannot be completely inspected.", "uninspectable_payload"); }
      if (decoded(payload)) return true;
    }
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
