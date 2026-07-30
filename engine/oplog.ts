// Operation log and undo.
//
// Every command that moves a ref appends what it moved, before and after. That
// buys two things an agent needs and a plain commit history does not give:
// "what did I just do" survives a lost transcript, and "put it back" is one
// command rather than a reasoning problem about which id was the old tip.
//
// Undo is always possible because objects are never removed. Rewinding a ref
// makes a commit unreachable, not absent, so the same undo record can move it
// forward again.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ObjectId } from "./objects.ts";
import { ObjectStoreError } from "./objects.ts";
import type { RefStore } from "./refs.ts";

/** One ref's value before and after an operation. */
export interface RefTransition {
  readonly ref: string;
  /** The ref's value before, or null when it did not exist. */
  readonly before: ObjectId | null;
  /** The ref's value after, or null when the operation deleted it. */
  readonly after: ObjectId | null;
}

/** One recorded operation. */
export interface Operation {
  /** Monotonic sequence number, starting at 1. */
  readonly sequence: number;
  /** The command that ran, e.g. `commit` or `merge`. */
  readonly command: string;
  /** ISO-8601 timestamp of when it was recorded. */
  readonly at: string;
  /** Human-readable summary, shown by `op log`. */
  readonly summary: string;
  /** Every ref the operation moved. */
  readonly refs: readonly RefTransition[];
}

/**
 * Append-only operation log backed by one JSON Lines file.
 *
 * JSON Lines rather than a single JSON array so an append is one `appendFileSync`
 * with no read-modify-write: two agents appending concurrently interleave whole
 * lines instead of racing to rewrite a shared array.
 */
export class OperationLog {
  /** Absolute path to the log file. */
  private readonly path: string;

  /**
   * @param path - Log file path. Its directory is created on demand.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Reads every recorded operation, oldest first.
   *
   * A line that will not parse is skipped rather than fatal: the log is a
   * convenience, and one torn append must not make the repository unusable.
   *
   * @returns The operations in recorded order.
   */
  read(): Operation[] {
    let contents: string;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const operations: Operation[] = [];
    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        operations.push(JSON.parse(line) as Operation);
      } catch {
        continue;
      }
    }
    return operations;
  }

  /**
   * Appends an operation.
   *
   * @param command - The command that ran.
   * @param summary - Human-readable summary.
   * @param refs - Every ref the operation moved.
   * @param now - Timestamp to record, injected so callers control it.
   * @returns The recorded operation, including its assigned sequence number.
   */
  append(command: string, summary: string, refs: readonly RefTransition[], now: Date): Operation {
    const operation: Operation = {
      sequence: this.read().length + 1,
      command,
      at: now.toISOString(),
      summary,
      refs,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(operation)}\n`);
    return operation;
  }

  /**
   * Reverses an operation by restoring every ref it moved.
   *
   * Each restore is a compare-and-swap against the operation's recorded `after`
   * value, so an undo whose refs have since moved on refuses rather than
   * discarding whatever happened in between.
   *
   * @param refs - The ref store to update.
   * @param sequence - Which operation to reverse, or null for the most recent.
   * @param now - Timestamp for the undo's own log entry.
   * @returns The undo operation that was recorded.
   * @throws ObjectStoreError When the log is empty, the sequence is unknown, or a
   *   ref no longer holds the value the operation left it at.
   */
  undo(refs: RefStore, sequence: number | null, now: Date): Operation {
    const operations = this.read();
    if (operations.length === 0) {
      throw new ObjectStoreError("nothing_to_undo", "The operation log is empty, so there is nothing to undo.");
    }
    const target = sequence === null
      ? operations[operations.length - 1]
      : operations.find((operation) => operation.sequence === sequence);
    if (!target) {
      throw new ObjectStoreError("unknown_operation", `No operation numbered ${sequence} in the log.`);
    }
    const reversed: RefTransition[] = [];
    for (const transition of target.refs) {
      refs.compareAndSwap(transition.ref, transition.after, transition.before);
      reversed.push({ ref: transition.ref, before: transition.after, after: transition.before });
    }
    return this.append("undo", `Reversed operation ${target.sequence} (${target.command}).`, reversed, now);
  }
}
