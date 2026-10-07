// Host-native error envelopes bypass extension renderers and repeat raw argv.
// Guard final CLI writes for credential-bearing VCS invocations, preserving the
// host's rendering, exit codes, callbacks and backpressure unchanged.
import type { Writable } from "node:stream";
import { redactRemoteUrl, redactUserinfo } from "./engine/credentials.ts";

/** Scrub URL userinfo at the final write boundary of a real VCS CLI invocation. */
export function guardCredentialOutput(
  argv: readonly string[] = process.argv,
  streams: readonly Writable[] = [process.stdout, process.stderr],
): void {
  if (!argv.includes("vcs")) return;
  const replacements = argv.flatMap((arg) => {
    const clean = redactRemoteUrl(arg);
    if (clean === arg) return [];
    return [[arg, clean], [JSON.stringify(arg).slice(1, -1), JSON.stringify(clean).slice(1, -1)]];
  });
  if (replacements.length === 0) return;
  for (const stream of streams) {
    const write = stream.write;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let clean = text;
      for (const [raw, replacement] of replacements) clean = clean.split(raw).join(replacement);
      clean = redactUserinfo(clean);
      return Reflect.apply(write, stream, [clean === text ? chunk : clean, ...rest]) as boolean;
    }) as typeof stream.write;
  }
}
