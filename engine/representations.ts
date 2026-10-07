/** Bounded inspection of supported raw, loose-framed, zlib and canonical base64 representations. */
import { inflateSync } from "node:zlib";
import { ObjectStoreError, parseFramedObject } from "./objects.ts";

/** Inspect every supported nested representation, refusing incomplete inspection instead of certifying it clean. */
export function inspectRepresentations(input: Buffer, matches: (bytes: Buffer) => boolean, maxDepth = 6, maxBytes = 16 * 1024 * 1024): boolean {
  const pending = [{ bytes: input, depth: 0 }];
  let remaining = maxBytes;
  let inspected = 0;
  while (pending.length > 0) {
    const { bytes, depth } = pending.pop()!;
    remaining -= bytes.length;
    inspected += 1;
    if (remaining < 0 || inspected > 4096) throw new ObjectStoreError("uninspectable_payload", "Supported representation exceeds the inspection budget.");
    if (matches(bytes)) return true;
    const decoded: Buffer[] = [];
    if (/^[a-z]+ [0-9]+\0/.test(bytes.subarray(0, 80).toString("latin1"))) {
      try { decoded.push(parseFramedObject(bytes).payload); } catch { throw new ObjectStoreError("uninspectable_payload", "Recognizable loose framing is malformed."); }
    }
    const header = bytes[0];
    const flags = bytes[1];
    if (header !== undefined && flags !== undefined && (header & 15) === 8 && (header >> 4) <= 7 && ((header << 8) + flags) % 31 === 0) {
      try { decoded.push(inflateSync(bytes, { maxOutputLength: Math.max(1, remaining) })); } catch { throw new ObjectStoreError("uninspectable_payload", "Recognizable zlib data cannot be completely inspected."); }
    }
    for (const token of bytes.toString("utf8").match(/[A-Za-z0-9+/]{2,}={0,2}/g) ?? []) {
      if (token.length % 4 !== 0) continue;
      const candidate = Buffer.from(token, "base64");
      if (candidate.toString("base64") === token) {
        if (decoded.length + pending.length >= 4096) throw new ObjectStoreError("uninspectable_payload", "Supported representation exceeds the work budget.");
        decoded.push(candidate);
      }
    }
    if (decoded.length > 0 && depth >= maxDepth) throw new ObjectStoreError("uninspectable_payload", "Supported encoding exceeds the nesting bound.");
    for (const candidate of decoded) pending.push({ bytes: candidate, depth: depth + 1 });
  }
  return false;
}
