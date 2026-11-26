/**
 * Track 3: OSC 7501 terminal agent-status emission for Rex and Herdr interop.
 *
 * Format: `\x1b]7501;state=<state>:app=<app>[:title=<title>]\x1b\\`
 * States: `working` | `idle` | `blocked` | `done`
 */

export const OSC7501_STATES = /** @type {const} */ ([
  'working',
  'idle',
  'blocked',
  'done',
]);

/** @typedef {typeof OSC7501_STATES[number]} Osc7501State */

const CONTROL_AND_DELIM_RE = /[\x00-\x1f\x7f;:]/g;
const AGY_NORMAL_STOP_REASONS = new Set(['NO_TOOL_CALL', 'model_stop']);

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
 * Map a normalized hook event into an OSC 7501 state, or null when the event
 * does not change agent status.
 *
 * @param {Record<string, any>} normalized
 * @param {import('../harness/input.js').Harness} harness
 * @returns {Osc7501State | null}
 */
export function stateForHookEvent(normalized, harness) {
  const event = normalized?.hook_event_name;
  if (event === 'SessionStart' || event === 'SessionEnd') return 'idle';
  if (event === 'UserPromptSubmit') return 'working';
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
    return 'done';
  }
  return null;
}

/**
 * Emit an OSC 7501 sequence to `stream` only when `enabled` and `stream.isTTY`.
 * Never throws so hook execution always fails open.
 *
 * @param {Osc7501State | null} state
 * @param {{ enabled?: boolean, stream?: { isTTY?: boolean, write: (chunk: string) => unknown }, app?: string, title?: string }} [options]
 * @returns {boolean}
 */
export function emitOsc7501(
  state,
  { enabled = false, stream = process.stderr, app = 'kyoten', title } = {}
) {
  if (!enabled || !state || !stream?.isTTY) return false;
  try {
    stream.write(formatOsc7501(state, { app, title }));
    return true;
  } catch {
    return false;
  }
}
