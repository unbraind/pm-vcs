import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The pm CLI treats the extension manifest vocabulary as a closed set of 18
 * known keys (name, version, entry, priority, description, author,
 * capabilities, manifest_version, pm_min_version, pm_max_version, engines,
 * trusted, provenance, sandbox_profile, permissions, activation,
 * contributions, legacy_capability_aliases). Since pm-cli 2026.8.19, any
 * other top-level key in manifest.json produces a `manifest_unknown_key`
 * finding. This repo carried an inert top-level `pm` object
 * (`{"compatibility": "v2"}`) that nothing ever read; it leaked such
 * findings into downstream strict-assertion checks - for example the
 * unbraind/pm-linear PRs #75/#76 expect exactly ["pm_min_version_unmet"]
 * but observed ["manifest_unknown_key", "pm_min_version_unmet"]. This test
 * guards against the key reappearing by asserting the manifest produces no
 * unknown-key findings when checked with the exact pinned CLI version.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
