import { DecodedSlots } from "./json-strings.ts";
import { fileURLToPath } from "node:url";
import { VerificationRefusal } from "./object-error.ts";

/** Bounded byte interpretation of the file and HTTP URLs accepted by native remote storage. */
export class UrlBytes {
  private prefix = "";
  private active = false;
  private escape = "";
  private readonly output: DecodedSlots;
  private readonly complete: ((bytes: Buffer) => void) | undefined;
  private readonly initial = Buffer.alloc(80);
  private initialUsed = 0;
  private position = 0;
  private capture: { bytes: Buffer; used: number; complete: (bytes: Buffer) => void } | undefined;
  /** Output is borrowed and must be consumed synchronously; ordinary non-URL bytes allocate no decoder child. */
  constructor(emit: (bytes: Buffer) => void, complete?: (bytes: Buffer) => void) { this.output = new DecodedSlots(emit); this.complete = complete; }
  /** Native URL projection needs a complete locator; bound it independently of the containing object's size. */
  private remember(value: number): void {
    if (this.capture === undefined) return;
    if (this.capture.used === this.capture.bytes.length) throw new VerificationRefusal("representations", "url_bytes", "A native URL exceeds the bounded normalization window.", "uninspectable_payload");
    this.capture.bytes[this.capture.used++] = value;
  }
  /** Preserve malformed percent text while inspecting every complete encoded byte. */
  private accept(value: number): void {
    // URL parsing removes literal controls before percent decoding, including
    // controls inside a triplet. Decoded controls bypass this input filter.
    if (value === 9 || value === 10 || value === 13) return;
    if (this.escape.length > 0) {
      if ((value >= 48 && value <= 57) || (value >= 65 && value <= 70) || (value >= 97 && value <= 102)) {
        this.escape += String.fromCharCode(value);
        if (this.escape.length === 3) { this.output.byte(Number.parseInt(this.escape.slice(1), 16)); this.escape = ""; }
        return;
      }
      for (const byte of Buffer.from(this.escape)) this.output.byte(byte);
      this.escape = "";
    }
    if (value === 37) this.escape = "%";
    else this.output.byte(value);
  }
  /** Recognize supported schemes across any input split, then decode without retaining a complete URL. */
  feed(bytes: Uint8Array): void {
    const start = this.position; this.position += bytes.length;
    if (this.complete !== undefined && this.initialUsed < this.initial.length) { const part = bytes.subarray(0, this.initial.length - this.initialUsed); this.initial.set(part, this.initialUsed); this.initialUsed += part.length; }
    // A scheme needs a colon. Skip ordinary binary slots in native code while
    // retaining the bounded suffix needed by a scheme crossing the next slot.
    if (!this.active && !bytes.includes(58)) { this.prefix = (this.prefix + Buffer.from(bytes.subarray(-6)).toString("latin1")).slice(-6); return; }
    for (let offset = 0; offset < bytes.length; offset++) {
      const byte = bytes[offset];
      if (this.active) { this.remember(byte); this.accept(byte); continue; }
      this.prefix = (this.prefix + String.fromCharCode(byte)).slice(-6);
      const match = this.prefix.match(/(?:file|https?):$/i);
      if (match !== null) {
        this.active = true; const end = start + offset + 1;
        if (this.complete !== undefined && end <= this.initial.length && /^(?:[a-z]+ [0-9]+\0)?(?:file|https?):$/i.test(this.initial.subarray(0, end).toString("latin1"))) this.capture = { bytes: Buffer.alloc(65_536), used: 0, complete: this.complete };
        for (const part of Buffer.from(match[0])) { this.remember(part); this.output.byte(part); }
      }
    }
    this.output.flush();
  }
  /** Interrupted escapes remain literal bytes; raw inspection is independently mandatory. */
  finish(): void {
    for (const byte of Buffer.from(this.escape)) this.output.byte(byte); this.escape = ""; this.output.flush();
    if (this.capture !== undefined) { const captured = this.capture; this.capture = undefined; captured.complete(captured.bytes.subarray(0, captured.used)); }
  }
  /** Abandoned or failed proofs release captured bytes without interpreting a partial locator. */
  close(): void { this.capture = undefined; }
}

/** Use the native locator parser for canonical addresses and platform filesystem paths, then decode canonical percent bytes. */
export function nativeUrlRepresentations(bytes: Buffer): Buffer[] {
  if (!/^(?:file|https?):/i.test(bytes.subarray(0, 6).toString("latin1"))) return [];
  const text = bytes.toString("utf8"); let parsed: URL;
  try { parsed = new URL(text); } catch { return []; }
  const result: Buffer[] = [];
  if (parsed.protocol === "file:") { try { result.push(Buffer.from(fileURLToPath(parsed))); } catch { /* Malformed or foreign-platform paths still receive raw inspection. */ } }
  if (parsed.href !== text) {
    const pieces: Buffer[] = []; const decoder = new UrlBytes(bytes => pieces.push(Buffer.from(bytes))); decoder.feed(Buffer.from(parsed.href)); decoder.finish(); result.push(Buffer.concat(pieces));
  }
  return result;
}
