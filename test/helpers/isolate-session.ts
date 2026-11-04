/** Install a deterministic parent test context before importing SDK or extension modules. */
import { testEnvironment } from "./test-environment.ts";

/** Preserve runner-owned instrumentation while selecting only deliberate operational test inputs. */
export function isolateTestSession(): void {
  const isolated = testEnvironment();
  for (const key of ["NODE_V8_COVERAGE", "NODE_TEST_CONTEXT"]) {
    if (process.env[key] === undefined) delete isolated[key]; else isolated[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolated, key)) delete process.env[key];
  for (const [key, value] of Object.entries(isolated)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

isolateTestSession();
