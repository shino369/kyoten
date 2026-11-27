#!/usr/bin/env node
/**
 * Official cross-harness hook for OSC 7501 status updates (Herdr / Rex) and
 * opt-in host-direct E2EE Web Push notifications on agent Stop/idle.
 *
 * Silent and zero-side-effect by default until configured via `pnpm remote`
 * (or `KYOTEN_OSC7501=1`). Never blocks or breaks an agent session.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHookInput, parseHarness } from '../harness/input.js';
import { SKIP_AGENTS } from '../memory/hook.js';
import { EXTRACT_ENV } from '../memory/queue.js';
import { mainCheckout } from '../memory/repo.js';
import { readJsonOrNull } from '../memory/store.js';
import { runIfMain } from '../module-runner.js';
import { writeFileAtomic } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  LAST_PUSH_FILE,
  hasRemoteConfig,
  readRemoteConfig,
  remoteDir,
} from './config.js';
import { NOTIFY_PAYLOAD_ENV } from './notify-worker.js';
import { emitOsc7501, stateForHookEvent } from './osc7501.js';
import { buildAlertPayload } from './webpush.js';

export const NOTIFY_WORKER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'notify-worker.js'
);

/**
 * Spawn the detached notification worker so hooks return immediately.
 *
 * @param {{ rootDir: string, alert: import('./webpush.js').AlertPayload, env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn, execPath?: string }} options
 */
export function kickNotify({
  rootDir,
  alert,
  env = process.env,
  spawn = nodeSpawn,
  execPath = process.execPath,
}) {
  const child = spawn(execPath, [NOTIFY_WORKER_SCRIPT], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...env,
      [EXTRACT_ENV]: '1',
      [NOTIFY_PAYLOAD_ENV]: JSON.stringify({ rootDir, alert }),
    },
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * @param {string} rootDir
 * @param {number} quietMs
 * @param {Date} now
 * @returns {boolean}
 */
function shouldThrottlePush(rootDir, quietMs, now) {
  if (quietMs <= 0) return false;
  const file = path.join(remoteDir(rootDir), LAST_PUSH_FILE);
  const last = /** @type {{ at?: number } | null} */ (readJsonOrNull(file));
  const nowMs = now.getTime();
  if (typeof last?.at === 'number' && nowMs - last.at < quietMs) {
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ at: nowMs }));
  return false;
}

/**
 * @param {Record<string, any>} input
 * @param {{
 *   harness?: import('../harness/input.js').Harness,
 *   rootDir?: string,
 *   now?: Date,
 *   env?: NodeJS.ProcessEnv,
 *   stream?: { isTTY?: boolean, write: (chunk: string) => unknown },
 *   kick?: typeof kickNotify,
 *   hostname?: string,
 * }} [options]
 */
export function handleHook(
  input,
  {
    harness = 'claude',
    rootDir = ROOT_DIR,
    now = new Date(),
    env = process.env,
    stream = process.stderr,
    kick = kickNotify,
    hostname = os.hostname() || 'kyoten',
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

  if (
    event === 'Stop' &&
    config?.pushEnabled &&
    config.vapid &&
    config.subscriptions.length > 0 &&
    !(harness === 'agy' && normalized.fullyIdle === false) &&
    !shouldThrottlePush(home, config.quietMs, now)
  ) {
    const state = stateForHookEvent(normalized, harness);
    const title =
      state === 'blocked'
        ? `kyoten (${harness}) needs input`
        : `kyoten (${harness}) finished`;
    const body =
      state === 'blocked'
        ? `${hostname}: ${harness} is waiting for attention.`
        : `${hostname}: ${harness} turn completed.`;
    const alert = buildAlertPayload({
      title,
      body,
      event: String(event),
      harness,
      host: hostname,
      at: now,
    });
    kick({ rootDir: home, alert, env });
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
