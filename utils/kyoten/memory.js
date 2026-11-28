/**
 * Memory saving in a home. A new home kyoten creates has automatic saving
 * off unless the user opts in, because each session end then costs one
 * background agent call. kyoten writes the same file and setting as
 * `pnpm memory off` (`memory/config.json`, `"off": true`), so this works
 * before the home's dependencies are installed (`kyoten init --no-setup`).
 */
import fs from 'fs';
import path from 'path';
import {
  AGY_MEMORY_FIX,
  memoryPolicyKey,
  readConfig,
} from '../memory/config.js';
import { readIfExists, writeFileAtomic } from '../task/store.js';

export const MEMORY_CONFIG = path.join('memory', 'config.json');

/**
 * @typedef {{ id: string, status: 'ok' | 'warn', detail: string, fix?: string }} MemoryCheck
 */

/**
 * The home's memory settings as a plain object ({} without the file).
 *
 * @param {string} home
 * @returns {Record<string, unknown>}
 */
function readSettings(home) {
  const file = path.join(home, MEMORY_CONFIG);
  const text = readIfExists(file);
  if (text === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${file} is not a JSON object.\nFix: correct or move it, then run kyoten run memory off (or on)`
    );
  }
  return parsed;
}

/**
 * Turn automatic memory saving off in `home`, keeping the other settings.
 *
 * @param {string} home
 */
export function pauseSaving(home) {
  const settings = readSettings(home);
  const file = path.join(home, MEMORY_CONFIG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(
    file,
    `${JSON.stringify({ ...settings, off: true }, null, 2)}\n`
  );
}

/**
 * Whether automatic saving is off, and the configured memory agent (null:
 * the session's own CLI).
 *
 * @param {string} home
 * @returns {{ off: boolean, agent: string | null }}
 */
export function savingState(home) {
  const settings = readSettings(home);
  return {
    off: settings.off === true,
    agent:
      typeof settings.extractAgent === 'string' ? settings.extractAgent : null,
  };
}

/**
 * The doctor line for memory saving.
 *
 * @param {string} home
 * @returns {MemoryCheck}
 */
export function memoryCheck(home) {
  try {
    const { off, agent } = savingState(home);
    if (!off) {
      const { autoExtract, autoConsolidate } = readConfig(
        path.join(home, 'memory')
      );
      const key = memoryPolicyKey(agent ?? 'agy', {});
      const disabled = [
        ...(!autoExtract[key] ? ['extraction'] : []),
        ...(!autoConsolidate[key] ? ['consolidation'] : []),
      ];
      if (disabled.length > 0) {
        const fix =
          key === 'agy' && !autoExtract.agy
            ? [AGY_MEMORY_FIX]
            : !autoExtract[key]
              ? [`pnpm memory set --auto-extract ${key}=on`]
              : [];
        if (!autoConsolidate[key])
          fix.push(`pnpm memory set --auto-consolidate ${key}=on`);
        return {
          id: 'memory',
          status: 'ok',
          detail: `automatic saving is on; ${disabled.join(' and ')} disabled for ${key}`,
          fix: fix.join('; '),
        };
      }
    }
    return {
      id: 'memory',
      status: 'ok',
      detail: off
        ? 'automatic saving is off (opt in: kyoten run memory on)'
        : `automatic saving is on: each session end runs one background agent call (${agent ?? "the session's own CLI"}); opt out: kyoten run memory off`,
    };
  } catch (error) {
    const [detail, fix] = /** @type {Error} */ (error).message.split('\nFix: ');
    return { id: 'memory', status: 'warn', detail, fix };
  }
}
