/** Incremental JSON string decoding shared by materialized and streaming erasure inspection. */
const escapes = new Map([[34,34],[92,92],[47,47],[98,8],[102,12],[110,10],[114,13],[116,9]]);
/** Shared bounded output for incremental storage decoders; consumers borrow each slot synchronously. */
export class DecodedSlots {
  private readonly bytes = Buffer.alloc(4096);
  private used = 0;
  private readonly emit: (bytes: Buffer) => void;
  /** Retain only the synchronous consumer, never a complete encoded document. */
  constructor(emit: (bytes: Buffer) => void) { this.emit = emit; }
  /** Flush before the next reuse of the fixed output storage. */
  flush(): void { if (this.used > 0) { this.emit(this.bytes.subarray(0, this.used)); this.used = 0; } }
  /** Append a byte and drain complete slots even when source input is exhausted. */
  byte(value: number): void { this.bytes[this.used++] = value; if (this.used === this.bytes.length) this.flush(); }
}
/** Decode every quoted JSON key/value without buffering a whole document or string. */
export class JsonStrings {
  private quoted = false;
  private escaped = false;
  private unicode: string | undefined;
  private high: number | undefined;
  private readonly output: DecodedSlots;
  private readonly end: () => void;
  /** Each string has a separate byte stream, so adjacent keys and values cannot invent a payload. */
  constructor(emit: (bytes: Buffer) => void, end: () => void) { this.output = new DecodedSlots(emit); this.end = end; }
  /** JSON Unicode escapes represent UTF-16 code units; lone surrogates use UTF-8 replacement semantics. */
  private unit(value: number): void {
    if (this.high !== undefined) {
      const high = this.high; this.high = undefined;
      if (value >= 0xdc00 && value <= 0xdfff) { for (const byte of Buffer.from(String.fromCharCode(high, value))) this.output.byte(byte); return; }
      for (const byte of Buffer.from(String.fromCharCode(high))) this.output.byte(byte);
    }
    if (value >= 0xd800 && value <= 0xdbff) this.high = value;
    else for (const byte of Buffer.from(String.fromCharCode(value))) this.output.byte(byte);
  }
  /** End a token independently; malformed or incomplete JSON cannot concatenate unrelated strings. */
  private finishString(): void { if (this.high !== undefined) { this.high = undefined; for (const byte of Buffer.from("\ufffd")) this.output.byte(byte); } this.output.flush(); this.end(); this.quoted = false; this.escaped = false; this.unicode = undefined; }
  /** Decode keys and values, including escapes split across arbitrary input slots. */
  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (!this.quoted) { if (byte === 34) this.quoted = true; continue; }
      if (this.unicode !== undefined) {
        if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) { this.output.flush(); this.end(); this.unicode = undefined; continue; }
        this.unicode += String.fromCharCode(byte);
        if (this.unicode.length === 4) { const value = Number.parseInt(this.unicode, 16); this.unicode = undefined; this.unit(value); }
      } else if (this.escaped) {
        this.escaped = false;
        if (byte === 117) this.unicode = "";
        else {
          const value = escapes.get(byte);
          if (value === undefined) { this.output.flush(); this.end(); } else { if (this.high !== undefined) { for (const part of Buffer.from("\ufffd")) this.output.byte(part); this.high = undefined; } this.output.byte(value); }
        }
      } else if (byte === 92) this.escaped = true;
      else if (byte === 34) this.finishString();
      else if (byte < 32) { this.output.flush(); this.end(); }
      else { if (this.high !== undefined) { for (const part of Buffer.from("\ufffd")) this.output.byte(part); this.high = undefined; } this.output.byte(byte); }
    }
    this.output.flush();
  }
  /** Flush an interrupted token conservatively; valid native records are independently schema-checked. */
  finish(): void { if (this.quoted) this.finishString(); }
}
