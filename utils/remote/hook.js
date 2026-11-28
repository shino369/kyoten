#!/usr/bin/env node
/**
 * Official cross-harness hook for status updates:
 * - OSC 7501 written to the controlling terminal (`pnpm remote osc7501 on` / `KYOTEN_OSC7501=1`)
 * - Native Herdr pane reporting via `herdr pane report-agent` (`pnpm remote herdr on` / `KYOTEN_HERDR=1`)
 *
 * Silent and zero-side-effect by default until configured. Never blocks or
 * breaks an agent session.
 */
import { normalizeHookInput, parseHarness } from '../harness/input.js';
import { QUIET_AGENTS } from '../memory/extract-env.js';
import { EXTRACT_ENV } from '../memory/queue.js';
import { mainCheckout } from '../memory/repo.js';
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import { hasRemoteConfig, readRemoteConfig } from './config.js';
import { reportHerdrStatus } from './herdr.js';
import { emitOsc7501, stateForHookEvent } from './osc7501.js';

/**
 * @param {Record<string, any>} input
 * @param {{
 *   harness?: import('../harness/input.js').Harness,
 *   rootDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   ttyPath?: string,
 *   writer?: (chunk: string) => unknown,
 *   spawnSyncFn?: typeof import('node:child_process').spawnSync,
 * }} [options]
 */
export function handleHook(
  input,
  {
    harness = 'claude',
    rootDir = ROOT_DIR,
    env = process.env,
    ttyPath,
    writer,
    spawnSyncFn,
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

  if (
    env[EXTRACT_ENV] === '1' ||
    QUIET_AGENTS.includes(normalized.agent_type)
  ) {
    return silentOutput;
  }

  const home = mainCheckout(rootDir);
  const oscEnv = env.KYOTEN_OSC7501 === '1';
  const herdrEnv = env.KYOTEN_HERDR === '1';
  const configured = hasRemoteConfig(home);
  if (!configured && !oscEnv && !herdrEnv) {
    return silentOutput;
  }

  const config = configured ? readRemoteConfig(home) : null;
  const oscEnabled = oscEnv || Boolean(config?.osc7501);
  if (oscEnabled) {
    const state = stateForHookEvent(normalized, harness);
    emitOsc7501(state, {
      enabled: true,
      env,
      ttyPath,
      writer,
      app: 'kyoten',
    });
  }

  const herdrEnabled = herdrEnv || Boolean(config?.herdr);
  if (herdrEnabled) {
    reportHerdrStatus(normalized, harness, {
      enabled: true,
      env,
      spawnSyncFn,
    });
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

/* c8 ignore start - stdin/stdout wiring; logic tested through runHook and child-process integration tests */
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
