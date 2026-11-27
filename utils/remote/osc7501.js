/**
 * Track 3: OSC 7501 terminal agent-status emission for Rex and OSC 7501 terminals.
 *
 * Format: `\x1b]7501;state=<state>:app=<app>[:title=<title>]\x1b\\`
 * States: `working` | `idle` | `blocked` | `done`
 */
import fs from 'node:fs';

export const OSC7501_STATES = /** @type {const} */ ([
  'working',
  'idle',
  'blocked',
  'done',
]);

/** @typedef {typeof OSC7501_STATES[number]} Osc7501State */

const CONTROL_AND_DELIM_RE = /[\x00-\x1f\x7f;:]/g;
const AGY_NORMAL_STOP_REASONS = new Set(['NO_TOOL_CALL', 'model_stop']);
const NON_BLOCKING_NOTIFICATIONS = new Set(['auth_success']);

/**
 * Strip control characters and OSC field delimiters (`:` / `;`).
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeField(value) {
  return value.replace(CONTROL_AND_DELIM_RE, ' ').trim();
}

/**
 * Format an OSC 7501 status sequence.
 *
 * @param {Osc7501State} state
 * @param {{ app?: string, title?: string }} [options]
 * @returns {string}
 */
export function formatOsc7501(state, { app = 'kyoten', title } = {}) {
  if (!OSC7501_STATES.includes(state)) {
    throw new Error(
      `Invalid OSC 7501 state "${String(state)}"; expected one of: ${OSC7501_STATES.join(', ')}.`
    );
  }
  const cleanApp = sanitizeField(app) || 'kyoten';
  const cleanTitle = typeof title === 'string' ? sanitizeField(title) : '';
  const fields = [
    `state=${state}`,
    `app=${cleanApp}`,
    ...(cleanTitle ? [`title=${cleanTitle}`] : []),
  ];
  return `\x1b]7501;${fields.join(':')}\x1b\\`;
}

/**
 * Map a normalized hook event into an agent status state, or null when the
 * event does not represent a user-visible state transition.
 *
 * @param {Record<string, any>} normalized
 * @param {import('../harness/input.js').Harness} harness
 * @returns {Osc7501State | null}
 */
export function stateForHookEvent(normalized, harness) {
  const event = normalized?.hook_event_name;
  if (event === 'SessionStart' || event === 'SessionEnd') return 'idle';
  if (event === 'UserPromptSubmit') return 'working';
  if (event === 'Notification') {
    const type =
      typeof normalized.notification_type === 'string'
        ? normalized.notification_type
        : '';
    if (type && NON_BLOCKING_NOTIFICATIONS.has(type)) return null;
    return 'blocked';
  }
  if (event === 'StopFailure') return 'blocked';
  if (harness === 'agy' && event === 'PreInvocation') {
    if (
      typeof normalized.invocationNum === 'number' &&
      normalized.invocationNum !== 0
    ) {
      return null;
    }
    return 'working';
  }
  if (event === 'Stop') {
    if (
      harness === 'agy' &&
      typeof normalized.terminationReason === 'string' &&
      !AGY_NORMAL_STOP_REASONS.has(normalized.terminationReason)
    ) {
      return 'blocked';
    }
    if (harness === 'agy' && normalized.fullyIdle === false) {
      return 'working';
    }
    if (
      normalized.stop_hook_active === true ||
      normalized.continuationActive === true
    ) {
      return null;
    }
    return 'done';
  }
  return null;
}

/**
 * Controlling terminal device path for hooks whose stdout/stderr are piped by
 * the harness. `KYOTEN_OSC7501_TTY` overrides the path (useful for custom
 * terminal sinks and integration tests).
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {string}
 */
export function defaultTerminalPath({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (typeof env.KYOTEN_OSC7501_TTY === 'string' && env.KYOTEN_OSC7501_TTY) {
    return env.KYOTEN_OSC7501_TTY;
  }
  return platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
}

/**
 * Write `chunk` directly to the controlling terminal path. Fails silently when
 * no controlling terminal is attached.
 *
 * @param {string} ttyPath
 * @param {string} chunk
 * @returns {boolean}
 */
export function writeToTerminal(ttyPath, chunk) {
  let fd;
  try {
    fd = fs.openSync(ttyPath, 'w');
    fs.writeSync(fd, chunk, null, 'utf-8');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors; fail open.
      }
    }
  }
}

/**
 * Emit an OSC 7501 sequence to the controlling terminal (never to the hook's
 * piped stdout/stderr). Always fails open.
 *
 * @param {Osc7501State | null} state
 * @param {{
 *   enabled?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   ttyPath?: string,
 *   writer?: (chunk: string) => unknown,
 *   app?: string,
 *   title?: string,
 * }} [options]
 * @returns {boolean}
 */
export function emitOsc7501(
  state,
  {
    enabled = false,
    env = process.env,
    platform = process.platform,
    ttyPath,
    writer,
    app = 'kyoten',
    title,
  } = {}
) {
  if (!enabled || !state) return false;
  try {
    const seq = formatOsc7501(state, { app, title });
    if (writer) {
      writer(seq);
      return true;
    }
    const target = ttyPath || defaultTerminalPath({ env, platform });
    return writeToTerminal(target, seq);
  } catch {
    return false;
  }
}
