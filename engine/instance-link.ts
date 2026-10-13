// Instance links: the file that binds one working tree to a hub, resolved at the
// bottom of the module graph.
//
// This module deliberately sits below the object store: a promisor remote can
// name a linked instance, whose objects live in the hub's shared store rather
// than the instance's private control directory, so `ObjectStore` needs the same
// binding the repository layer uses without importing it — a store that imported
// the repository would make object-store evaluation depend on the repository,
// whose instance wrapper subclasses the store. Everything here is pure
// validation and path resolution over the link file's documented shape.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ObjectStoreError } from "./objects.ts";

/** Directory every repository keeps its control state in. */
export const CONTROL_DIRECTORY = ".pmvcs";

/** File inside an instance's control directory naming the hub it belongs to. */
export const INSTANCE_LINK_FILE = "link.json";

/**
 * Validates parsed instance-link content.
 *
 * @param raw - Parsed JSON from the link file.
 * @returns The hub path exactly as recorded, relative to the instance root.
 * @throws ObjectStoreError When the link is not an object holding a non-empty
 *   "hub" string.
 */
export function parseInstanceLink(raw: unknown): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreError("broken_instance_link", "Instance link is not a JSON object.");
  }
  const hub = (raw as Record<string, unknown>).hub;
  if (typeof hub !== "string" || hub.length === 0) {
    throw new ObjectStoreError("broken_instance_link", 'Instance link does not name a hub under a "hub" key.');
  }
  return hub;
}

/**
 * Resolves an instance link file to the hub it names.
 *
 * The hub path is stored relative to the instance root and resolved against
 * it, so moving the hub and its instances together leaves every link valid.
 * The hub's format marker is required to exist: an instance pointing at a
 * directory that is not a repository would otherwise fail later, at the first
 * object or ref read, with errors that say nothing about the actual breakage.
 *
 * @param controlDirectory - The working tree's control directory.
 * @param root - The working tree root the link is resolved against.
 * @returns The hub's root and control directory, or null when there is no link.
 * @throws ObjectStoreError When the link is malformed or its hub is absent.
 */
export function resolveInstanceLink(
  controlDirectory: string,
  root: string,
): { readonly hubRoot: string; readonly controlDirectory: string } | null {
  let contents: string;
  try {
    contents = readFileSync(join(controlDirectory, INSTANCE_LINK_FILE), "utf8");
  } catch (error) {
    // ENOENT is the ordinary no-link case. ENOTDIR means the control
    // directory itself is not a directory, which `Repository.open` reports
    // as its own typed failure — rethrowing the raw errno here would
    // preempt that message with a syscall error.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ObjectStoreError(
      "broken_instance_link",
      `The instance link at ${join(controlDirectory, INSTANCE_LINK_FILE)} is not valid JSON. `
      + "Restore it from the hub's registry, or unlink and re-link this working tree.",
    );
  }
  const hubRelative = parseInstanceLink(parsed).split("/").join(sep);
  const hubRoot = resolve(root, hubRelative);
  const hubControl = join(hubRoot, CONTROL_DIRECTORY);
  if (!existsSync(join(hubControl, "format"))) {
    throw new ObjectStoreError(
      "broken_instance_link",
      `This instance links to ${hubRoot}, which does not hold a pm-vcs repository. `
      + "Move the hub back, repair the link file, or unlink and re-link this working tree.",
    );
  }
  return { hubRoot, controlDirectory: hubControl };
}

/**
 * Resolves which control directory a repository's objects are read from.
 *
 * A plain repository owns its own control directory; a linked instance reads
 * the hub's shared store instead, so demand hydration from a promisor that
 * names an instance must follow the same binding before reading an object.
 *
 * @param source - The remote repository's working-tree root.
 * @returns The control directory holding the objects directory to read.
 * @throws ObjectStoreError When an instance link exists but is broken.
 */
export function resolveObjectsControl(source: string): string {
  const control = join(source, CONTROL_DIRECTORY);
  return resolveInstanceLink(control, source)?.controlDirectory ?? control;
}