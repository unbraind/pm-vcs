/**
 * Raised for every fault this module can detect, so callers can distinguish a
 * repository problem from a programming error without matching on messages.
 */
export class ObjectStoreError extends Error {
  /** Repository faults are negative verification outcomes, including legacy decoder refusals. */
  readonly status = "unverified";
  /** Legacy discriminators remain an explicit failure boundary when no narrower budget is involved. */
  readonly bound: string;
  /** Stable machine-readable discriminator for the fault. */
  readonly code: string;

  /** Construct a repository fault carrying a stable code while retaining the native error message contract. */
  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
    this.bound = code;
  }
}

/** A verifier's overall outcome is distinct from counts of individually inspected records. */
export interface VerificationResult { readonly status: "verified" | "unverified"; readonly verifier: string; readonly bound?: string }

/** Incomplete work is a typed refusal, never a positive certificate with a warning. */
export class VerificationRefusal extends ObjectStoreError {
  /** The verifier that could not finish its proof. */
  readonly verifier: string;
  /** Exact exhausted bound or failed decode, without including inspected content. */
  override readonly bound: string;
  /** A caller must supply complete evidence before requesting certification again. */
  readonly remedy = "Supply complete supported evidence and retry verification; this result grants no certificate or deletion authority.";
  /** Legacy refusal codes remain usable while every incomplete result explicitly names its bound. */
  constructor(verifier: string, bound: string, detail: string, code = "unverified") {
    super(code, `unverified: ${verifier}/${bound}. ${detail} Supply complete supported evidence before retrying.`);
    this.name = "VerificationRefusal"; this.verifier = verifier; this.bound = bound;
  }
}

/** Work limits are independently forceable without reducing production coverage or safety thresholds. @internal */
export const verificationLimits = { integrityObjects: 1_000_000, integrityMs: 300_000, reachabilityObjects: 1_000_000, reachabilityMs: 300_000, receiptRecords: 100_000, receiptMs: 300_000, receiptBytes: 64 * 1024 * 1024, checkpointRecords: 1000, accountabilityFiles: 1_000_000, accountabilityFileBytes: Number.MAX_SAFE_INTEGER, accountabilityDecodedBytes: Number.MAX_SAFE_INTEGER, accountabilityMs: 300_000, erasureMs: 300_000 };

/** A limit is a refusal boundary; reaching it cannot produce a success result. @internal */
export function assertVerificationBound(verifier: string, bound: string, used: number, maximum: number): void {
  if (used >= maximum) throw new VerificationRefusal(verifier, bound, "The configured verification work bound was reached.");
}
