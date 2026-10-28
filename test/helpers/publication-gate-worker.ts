import "./isolate-session.ts";
/** Bare durability workers cannot bypass native storage verification by omitting the object layer. */
import { durability } from "../../engine/durability.ts";
const [source, destination] = process.argv.slice(2);
try { durability.rename(source!, destination!); process.stdout.write(JSON.stringify({ published: true })); }
catch (error) { if (!(error instanceof Error) || !("code" in error) || !("bound" in error)) throw error; process.stdout.write(JSON.stringify({ code: error.code, bound: error.bound })); }
