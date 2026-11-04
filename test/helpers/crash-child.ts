/** A successful enumeration probe flushes compilation before later children receive SIGKILL. */
import module from "node:module";
module.enableCompileCache?.(process.env.CRASH_COMPILE_CACHE);
process.once("exit", () => module.flushCompileCache?.());
