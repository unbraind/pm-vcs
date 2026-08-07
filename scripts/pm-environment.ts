/** PM context variables that must not leak into disposable acceptance projects. */
const pmContextKeys = [
  "PM_GLOBAL_PATH",
  "PM_PATH",
  "PM_SOURCE_PM_PATH",
  "PM_SOURCE_WORKSPACE_ROOT",
] as const;

/**
 * Copies an environment without the parent invocation's PM tracker context.
 *
 * Disposable projects must discover their own tracker. Deleting the keys keeps
 * that contract explicit and avoids relying on child-process value coercion.
 *
 * @param environment - Parent environment to copy and sanitize.
 * @returns An independent environment with PM tracker discovery variables absent.
 */
export function withoutPmContext(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const key of pmContextKeys) delete isolated[key];
  return isolated;
}
