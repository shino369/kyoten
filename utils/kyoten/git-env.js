/**
 * The environment for kyoten's own git processes.
 *
 * Inherited `GIT_*` variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_CONFIG*`, `GIT_NAMESPACE`, ...) decide which
 * repository and configuration git uses. A git hook or an IDE terminal sets
 * them, and they would send kyoten's git calls to another repository. So
 * every `GIT_*` variable is dropped; `set` adds back the ones kyoten sets on
 * purpose (a scratch `GIT_INDEX_FILE`, its snapshot identity).
 *
 * The agent CLIs and kyoten's pnpm children use childEnv below instead.
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, string>} [set]
 * @param {NodeJS.Platform} [platform]  Windows names are case-insensitive
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(
  env = process.env,
  set = {},
  platform = process.platform
) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    const folded = platform === 'win32' ? name.toUpperCase() : name;
    if (!folded.startsWith('GIT_')) out[name] = value;
  }
  return { ...out, ...set };
}

/**
 * The variables git sets for a hook, an alias, or `git -c` that decide which
 * repository and configuration a child git uses. They are dropped from the
 * agent CLIs and from kyoten's pnpm children (setup, workspace check, memory
 * export and import, kyoten run), whose git calls must act on the home. The
 * user's own preferences (`GIT_SSH_COMMAND`, `GIT_EDITOR`, `GIT_CONFIG_GLOBAL`,
 * …) stay.
 */
export const REPO_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_*',
  'GIT_CONFIG_VALUE_*',
];

/**
 * `env` without REPO_GIT_VARS (an entry ending in `*` is a name prefix).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]  Windows names are case-insensitive
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(env = process.env, platform = process.platform) {
  /** @param {string} name */
  const fold = (name) => (platform === 'win32' ? name.toUpperCase() : name);
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    const folded = fold(name);
    const repoVar = REPO_GIT_VARS.some((entry) =>
      entry.endsWith('*')
        ? folded.startsWith(entry.slice(0, -1))
        : folded === entry
    );
    if (!repoVar) out[name] = value;
  }
  return out;
}
