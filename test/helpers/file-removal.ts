/** Observe removal even when the file disappears before watcher registration. */
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";

/** Wait for absence with one bounded deadline, closing the watcher on every outcome. */
export async function waitForFileRemoval(path: string, timeoutMs = 60_000): Promise<void> {
  const watcher = watch(dirname(path));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker receipt was not removed before the deadline")), timeoutMs);
      /** Share completion and timer cleanup between the initial observation and notifications. */
      const check = (): void => {
        if (!existsSync(path)) { clearTimeout(timeout); resolve(); }
      };
      watcher.on("change", check);
      watcher.once("error", error => { clearTimeout(timeout); reject(error); });
      check();
    });
  } finally {
    watcher.close();
  }
}
