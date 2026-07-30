import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { DEFAULT_CONFIG, type RepositoryConfig, isRecordPath, matchesGlob, parseConfig, readConfig, writeConfig } from "../engine/config.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

test("matchesGlob supports *, ** and ? across and within segments", () => {
  assert.equal(matchesGlob("a/b/c.txt", "a/**/*.txt"), true);
  // **/ absorbs an immediately following slash, so a/**/b also matches a/b.
  assert.equal(matchesGlob("a/b", "a/**/b"), true);
  assert.equal(matchesGlob("a/x/y/b", "a/**/b"), true);
  // * does not cross a segment boundary.
  assert.equal(matchesGlob("a/b/c", "a/*"), false);
  assert.equal(matchesGlob("a/b", "a/*"), true);
  // ? is one character within a segment.
  assert.equal(matchesGlob("a1", "a?"), true);
  assert.equal(matchesGlob("a12", "a?"), false);
  // Literal characters are escaped, not treated as regex.
  assert.equal(matchesGlob("a.b", "a.b"), true);
  assert.equal(matchesGlob("axb", "a.b"), false);
});

test("isRecordPath matches any configured pattern", () => {
  const config: RepositoryConfig = { recordPaths: ["items/*.toon", "data/records/**"], recordPolicy: {} };
  assert.equal(isRecordPath("items/x.toon", config), true);
  assert.equal(isRecordPath("data/records/nested/y.json", config), true);
  assert.equal(isRecordPath("README.md", config), false);
});

test("parseConfig accepts a full valid config and the defaults", () => {
  const parsed = parseConfig({
    recordPaths: ["items/*.toon"],
    recordPolicy: { fields: { priority: "scalar", tags: "set" }, fallback: "sequence" },
  });
  assert.deepEqual(parsed.recordPaths, ["items/*.toon"]);
  assert.equal(parsed.recordPolicy.fields?.priority, "scalar");
  assert.equal(parsed.recordPolicy.fields?.tags, "set");
  assert.equal(parsed.recordPolicy.fallback, "sequence");

  // An empty object yields an effective no-op config: no record paths, no
  // field overrides and no fallback. parseConfig normalises recordPolicy to
  // carry an empty fields map, which is equivalent to the literal default.
  const empty = parseConfig({});
  assert.deepEqual(empty.recordPaths, []);
  assert.equal(empty.recordPolicy.fallback, undefined);
  assert.deepEqual(Object.keys(empty.recordPolicy.fields ?? {}), []);
});

test("parseConfig rejects every malformed shape", () => {
  const bad = (raw: unknown): void => {
    assert.throws(
      () => parseConfig(raw),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_config",
    );
  };
  bad(null);
  bad("string");
  bad([]);
  // recordPaths not an array of strings.
  bad({ recordPaths: "x" });
  bad({ recordPaths: [1] });
  // recordPolicy not an object.
  bad({ recordPolicy: "x" });
  bad({ recordPolicy: [] });
  // recordPolicy.fields not an object.
  bad({ recordPolicy: { fields: [] } });
  // An unknown field strategy is refused rather than silently treated as scalar.
  bad({ recordPolicy: { fields: { priority: "whatever" } } });
  bad({ recordPolicy: { fields: { priority: 1 } } });
  // An unknown fallback strategy is refused.
  bad({ recordPolicy: { fallback: "nope" } });
});

test("readConfig returns defaults for an absent file and parses a real one", () => {
  dir = makeTempDir();
  const path = `${dir.root}/config.json`;
  assert.deepEqual(readConfig(path), DEFAULT_CONFIG);

  const config: RepositoryConfig = { recordPaths: ["items/*.toon"], recordPolicy: { fields: { tags: "set" } } };
  writeConfig(path, config);
  assert.deepEqual(readConfig(path), config);
});

test("readConfig rejects a file that is not valid JSON", () => {
  dir = makeTempDir();
  const path = `${dir.root}/config.json`;
  writeFileSync(path, "{not json");
  assert.throws(
    () => readConfig(path),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_config",
  );
});
