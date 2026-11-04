import "./isolate-session.ts";
/** Bare durability workers cannot bypass native storage verification by omitting the object layer. */
import { durability } from "../../engine/durability.ts";
import { openSync, closeSync } from "node:fs";
import { dirname, basename, join } from "node:path";
const [source, supplied, mode] = process.argv.slice(2);
const descriptor = mode === "descriptor" ? openSync(dirname(supplied!), "r") : undefined;
const destination = descriptor === undefined ? supplied : join(`/proc/self/fd/${descriptor}`, basename(supplied!));
try { durability.rename(source!, destination!); process.stdout.write(JSON.stringify({ published: true })); }
catch (error) { if (!(error instanceof Error) || !("code" in error) || !("bound" in error)) throw error; process.stdout.write(JSON.stringify({ code: error.code, bound: error.bound })); }

finally { if (descriptor !== undefined) closeSync(descriptor); }
