/**
 * Track 3: Native Herdr pane agent-status reporting (`herdr pane report-agent`
 * and `herdr pane release-agent`).
 *
 * Herdr v0.9.5+ injects `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH`
 * into panes it manages, and expects agents without native Herdr integrations
 * (such as `agy` and `dsh`) to report state via `$HERDR_BIN_PATH pane report-agent`.
 * Harnesses that Herdr manages natively (`claude`, `codex`) retain Herdr's own
 * lifecycle authority unless `KYOTEN_HERDR_ALL=1` is set.
 */
import { spawnSync } from 'node:child_process';
import { stateForHookEvent } from './osc7501.js';

/** Harnesses with native Herdr integrations that keep lifecycle authority. */
export const HERDR_NATIVE_HARNESSES = new Set(['claude', 'codex']);

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * @typedef {{ action: 'report', state: 'working' | 'idle' | 'blocked' } | { action: 'release' }} HerdrAction
 */

/**
 * Validate Herdr environment variables injected into a managed pane.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ binPath: string, paneId: string } | null}
 */
export function resolveHerdrEnv(env = process.env) {
  if (env.HERDR_ENV !== '1') return null;
  const binPath =
    typeof env.HERDR_BIN_PATH === 'string' ? env.HERDR_BIN_PATH.trim() : '';
  const paneId =
    typeof env.HERDR_PANE_ID === 'string' ? env.HERDR_PANE_ID.trim() : '';
  if (!binPath || !paneId) return null;
  if (
    binPath.includes('\0') ||
    CONTROL_CHAR_RE.test(paneId) ||
    paneId.startsWith('-')
  ) {
    return null;
  }
  return { binPath, paneId };
}

/**
 * Determine whether kyoten's hook should invoke Herdr for `harness`.
 *
 * @param {import('../harness/input.js').Harness} harness
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldReportHerdr(harness, env = process.env) {
  if (!resolveHerdrEnv(env)) return false;
  if (env.KYOTEN_HERDR_ALL === '1') return true;
  return !HERDR_NATIVE_HARNESSES.has(harness);
}

/**
 * Map a normalized hook event to a Herdr pane action, or null when no update
 * should be sent.
 *
 * @param {Record<string, any>} normalized
 * @param {import('../harness/input.js').Harness} harness
 * @returns {HerdrAction | null}
 */
export function herdrActionForEvent(normalized, harness) {
  if (normalized?.hook_event_name === 'SessionEnd') {
    return { action: 'release' };
  }
  const state = stateForHookEvent(normalized, harness);
  if (!state) return null;
  if (state === 'done') return { action: 'report', state: 'idle' };
  return { action: 'report', state };
}

/**
 * Report agent status to Herdr (`pane report-agent` / `pane release-agent`).
 * Never throws so hook execution always fails open.
 *
 * @param {Record<string, any>} normalized
 * @param {import('../harness/input.js').Harness} harness
 * @param {{
 *   enabled?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncFn?: typeof spawnSync,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {boolean}
 */
export function reportHerdrStatus(
  normalized,
  harness,
  {
    enabled = false,
    env = process.env,
    spawnSyncFn = spawnSync,
    timeoutMs = 1500,
  } = {}
) {
  if (!enabled || !shouldReportHerdr(harness, env)) return false;
  const target = resolveHerdrEnv(env);
  if (!target) return false;
  const action = herdrActionForEvent(normalized, harness);
  if (!action) return false;

  const args =
    action.action === 'release'
      ? ['pane', 'release-agent', target.paneId]
      : [
          'pane',
          'report-agent',
          target.paneId,
          '--source',
          'kyoten',
          '--agent',
          harness,
          '--state',
          action.state,
        ];

  try {
    const res = spawnSyncFn(target.binPath, args, {
      stdio: 'ignore',
      timeout: timeoutMs,
      windowsHide: true,
    });
    return !res?.error && res?.status === 0;
  } catch {
    return false;
  }
}
