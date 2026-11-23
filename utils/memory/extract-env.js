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
