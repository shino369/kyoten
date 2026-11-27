/**
 * The variable that keeps the memory hooks silent (no core block, no recall,
 * no extraction queue). The memory worker sets it, and every headless agent
 * call (utils/loop/adapters.js runAgent: pnpm agent ask, pnpm loop and its
 * reviews, pnpm swarm, the memory jobs) passes it on, so a headless session
 * neither sees personal memory nor gets saved into it. Kept import-free so
 * the launcher can load it before an install and adapters can share it with
 * memory without circular dependencies.
 */
export const EXTRACT_ENV = 'MEMORY_EXTRACT';

/** Review roles that work from a clean context: the memory hooks stay silent for them. */
export const QUIET_AGENTS = ['reviewer', 'verifier'];

/**
 * Whether the memory hooks (recall, core block, language guard) stay silent:
 * a headless run (EXTRACT_ENV) or a review role.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {unknown} agentType the hook input's `agent_type`
 */
export const quietRun = (env, agentType) =>
  env[EXTRACT_ENV] === '1' ||
  (typeof agentType === 'string' && QUIET_AGENTS.includes(agentType));
