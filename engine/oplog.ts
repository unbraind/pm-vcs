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

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
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

/**
 * HEAD's raw contents before and after an operation.
 *
 * Recorded separately from {@link RefTransition} because HEAD does not hold an
 * object id in the general case: attached to a branch it holds `ref: refs/heads/x`.
 * Without this, a `switch` recorded no transition at all, so `undo` iterated an
 * empty list, appended an undo entry, reported success — and left HEAD exactly
 * where it was. An undo that says it worked and did nothing is worse than one that
 * refuses.
 */
export interface HeadTransition {
  /** HEAD's raw contents before the operation. */
  readonly before: string;
  /** HEAD's raw contents after it. */
  readonly after: string;
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
  /** How the operation moved HEAD itself, when it did. */
  readonly head?: HeadTransition;
}

/**
 * Append-only operation log backed by one JSON Lines file.
 *
 * JSON Lines rather than a single JSON array, so a torn write costs one line
 * instead of the whole log, and so appends interleave whole lines rather than
 * racing to rewrite a shared array.
 *
 * The append itself is still taken under an exclusive lock, because the sequence
 * number is derived from the current length. Two agents appending concurrently
 * would otherwise both read the same length, both write the same number, and leave
 * `undo <n>` addressing only the first of the two — with the second unreachable by
 * number for the rest of the repository's life.
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
    } catch (error) {
      // No log yet is the ordinary state of a fresh repository. A log that exists
      // and cannot be read is not: reporting it as "no operations" would make
      // `undo` answer "there is nothing to undo" when in fact the record of what
      // to undo was unreachable, which is the one answer that loses work.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
   * Held under an exclusive lock: the sequence number comes from the log's current
   * length, so read-then-append is a read-modify-write and two concurrent appends
   * would assign one number twice.
   *
   * @param command - The command that ran.
   * @param summary - Human-readable summary.
   * @param refs - Every ref the operation moved.
   * @param now - Timestamp to record, injected so callers control it.
   * @param head - How the operation moved HEAD itself, when it did.
   * @returns The recorded operation, including its assigned sequence number.
   * @throws ObjectStoreError When another process holds the log's lock.
   */
  append(
    command: string,
    summary: string,
    refs: readonly RefTransition[],
    now: Date,
    head?: HeadTransition,
  ): Operation {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx");
    } catch {
      throw new ObjectStoreError("oplog_locked", `The operation log is locked by another process (${lockPath}).`);
    }
    try {
      const operation: Operation = {
        sequence: this.read().length + 1,
        command,
        at: now.toISOString(),
        summary,
        refs,
        ...(head === undefined ? {} : { head }),
      };
      appendFileSync(this.path, `${JSON.stringify(operation)}\n`);
      return operation;
    } finally {
      closeSync(descriptor);
      unlinkSync(lockPath);
    }
  }

  /**
   * Reverses an operation by restoring every ref it moved.
   *
   * Every restore is checked against the operation's recorded `after` value and
   * they are applied as **one transaction**, so an undo whose refs have since moved
   * on refuses rather than discarding whatever happened in between — and refuses
   * having written nothing. Reverting them one at a time would let an undo revert
   * two refs of three, fail on the third, and record no log entry at all, leaving a
   * half-reverted repository that no later undo can describe or repair.
   *
   * @param refs - The ref store to update.
   * @param sequence - Which operation to reverse, or null for the most recent.
   * @param now - Timestamp for the undo's own log entry.
   * @returns The undo operation that was recorded.
   * @throws ObjectStoreError When the log is empty, the sequence is unknown, or a
   *   ref or HEAD no longer holds the value the operation left it at.
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
    // HEAD is checked before anything is written, for the same reason the ref
    // transaction checks before it writes: a refusal must leave the repository
    // exactly as it was.
    if (target.head !== undefined && refs.rawHead() !== target.head.after) {
      throw new ObjectStoreError(
        "head_changed",
        `HEAD holds "${refs.rawHead()}" but reversing operation ${target.sequence} expected "${target.head.after}". `
        + "Something moved HEAD since then; re-read it and retry.",
      );
    }
    refs.transaction(target.refs.map((transition) => ({
      name: transition.ref,
      expected: transition.after,
      next: transition.before,
    })));
    if (target.head !== undefined) {
      const restored = target.head.before;
      if (restored.startsWith("ref: ")) refs.setHeadToRef(restored.slice(5).trim());
      else refs.setHeadDetached(restored);
    }
    const reversed: RefTransition[] = target.refs.map((transition) => ({
      ref: transition.ref,
      before: transition.after,
      after: transition.before,
    }));
    return this.append(
      "undo",
      `Reversed operation ${target.sequence} (${target.command}).`,
      reversed,
      now,
      target.head === undefined ? undefined : { before: target.head.after, after: target.head.before },
    );
  }
}
