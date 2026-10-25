/**
 * Raised for every fault this module can detect, so callers can distinguish a
 * repository problem from a programming error without matching on messages.
 */
export class ObjectStoreError extends Error {
  /** Stable machine-readable discriminator for the fault. */
  readonly code: string;

  /** Construct a repository fault carrying a stable code while retaining the native error message contract. */
  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}
