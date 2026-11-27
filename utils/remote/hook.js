#!/usr/bin/env node
/**
 * Official cross-harness hook for OSC 7501 status updates (Herdr / Rex).
 *
 * Silent and zero-side-effect by default until configured via `pnpm remote osc7501 on`
 * (or `KYOTEN_OSC7501=1`). Never blocks or breaks an agent session.
 */
import { normalizeHookInput, parseHarness } from '../harness/input.js';
import { SKIP_AGENTS } from '../memory/hook.js';
import { EXTRACT_ENV } from '../memory/queue.js';
import { mainCheckout } from '../memory/repo.js';
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import { hasRemoteConfig, readRemoteConfig } from './config.js';
import { emitOsc7501, stateForHookEvent } from './osc7501.js';

/**
 * @param {Record<string, any>} input
 * @param {{
 *   harness?: import('../harness/input.js').Harness,
 *   rootDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stream?: { isTTY?: boolean, write: (chunk: string) => unknown },
 * }} [options]
 */
export function handleHook(
  input,
  {
    harness = 'claude',
    rootDir = ROOT_DIR,
    env = process.env,
    stream = process.stderr,
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const event = normalized.hook_event_name;
  const silentOutput =
    harness === 'agy'
      ? event === 'Stop'
        ? { decision: 'allow' }
        : null
      : null;

  if (env[EXTRACT_ENV] === '1' || SKIP_AGENTS.includes(normalized.agent_type)) {
    return silentOutput;
  }

  const home = mainCheckout(rootDir);
  const oscEnv = env.KYOTEN_OSC7501 === '1';
  const configured = hasRemoteConfig(home);
  if (!configured && !oscEnv) {
    return silentOutput;
  }

  const config = configured ? readRemoteConfig(home) : null;
  const oscEnabled = oscEnv || Boolean(config?.osc7501);
  if (oscEnabled) {
    const state = stateForHookEvent(normalized, harness);
    emitOsc7501(state, { enabled: true, stream, app: 'kyoten' });
  }

  return silentOutput;
}

/**
 * Parse hook stdin and always fail open with protocol-valid output.
 *
 * @param {string} raw
 * @param {Parameters<typeof handleHook>[1]} [options]
 * @returns {string}
 */
export function runHook(raw, options = {}) {
  const harness = options?.harness ?? 'claude';
  let parsed = {};
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return harness === 'agy' ? '{}' : '';
  }
  const normalized = normalizeHookInput(parsed, harness);
  const agyStop = harness === 'agy' && normalized.hook_event_name === 'Stop';
  const empty = agyStop
    ? '{"decision":"allow"}'
    : harness === 'agy'
      ? '{}'
      : '';
  try {
    const output = handleHook(parsed, options);
    return output ? JSON.stringify(output) : empty;
  } catch {
    return empty;
  }
}

/* c8 ignore start - stdin/stdout wiring; logic tested through runHook */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  const failOpen = () => {
    if (harness === 'agy') process.stdout.write('{}', () => process.exit(0));
    else process.exit(0);
  };
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    const out = runHook(data, { harness });
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
  process.stdin.on('error', failOpen);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
