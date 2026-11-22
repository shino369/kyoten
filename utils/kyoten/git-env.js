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
 * Not for the agent CLIs: their environment is built in launch.js.
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
