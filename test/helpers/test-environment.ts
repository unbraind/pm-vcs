/** Explicit operational inputs for test children; agent/session and PM discovery state are fixture-owned. */
export const TEST_ENVIRONMENT_KEYS = [
  "PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "GITHUB_ACTIONS",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "npm_execpath", "npm_node_execpath", "npm_config_cache", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG", "npm_config_registry", "NPM_CONFIG_REGISTRY",
  "BUN_INSTALL", "BUN_BE_BUN",
] as const;

/** Select only operational keys, then add deliberate fixture overrides; no host environment object is copied. */
export function testEnvironment(overrides: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of TEST_ENVIRONMENT_KEYS) if (source[key] !== undefined) selected[key] = source[key];
  return { ...selected, NODE_ENV: "test", PM_SEARCH_REFRESH_INLINE: "1", PM_AGENT_PROBES: "0", GIT_TERMINAL_PROMPT: "0", NODE_V8_COVERAGE: "", ...overrides };
}
