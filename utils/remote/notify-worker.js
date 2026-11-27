#!/usr/bin/env node
/**
 * Detached background worker for sending host-direct RFC 8291 Web Push alerts
 * without delaying agent hooks.
 */
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readRemoteConfig, writeRemoteConfig } from './config.js';
import { sendWebPush } from './webpush.js';

export const NOTIFY_PAYLOAD_ENV = 'KYOTEN_REMOTE_ALERT';

/**
 * Deliver `alert` to every configured push subscription and prune `404`/`410`
 * expired subscriptions.
 *
 * @param {{
 *   rootDir: string,
 *   alert: import('./webpush.js').AlertPayload,
 *   fetchFn?: typeof globalThis.fetch,
 *   allowLocalhost?: boolean,
 *   now?: Date,
 * }} input
 * @returns {Promise<{ sent: number, failed: number, pruned: number }>}
 */
export async function deliverNotifications({
  rootDir,
  alert,
  fetchFn = globalThis.fetch,
  allowLocalhost = false,
  now = new Date(),
}) {
  const config = readRemoteConfig(rootDir);
  if (!config.vapid || config.subscriptions.length === 0) {
    return { sent: 0, failed: 0, pruned: 0 };
  }
  const vapid = { ...config.vapid, subject: config.subject };
  /** @type {string[]} */
  const goneIds = [];
  let sent = 0;
  let failed = 0;

  for (const sub of config.subscriptions) {
    try {
      const res = await sendWebPush({
        subscription: sub,
        payload: alert,
        vapid,
        fetchFn,
        allowLocalhost,
        now,
      });
      if (res.ok) {
        sent += 1;
      } else if (res.gone) {
        goneIds.push(sub.id);
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  if (goneIds.length > 0) {
    const remaining = config.subscriptions.filter(
      (sub) => !goneIds.includes(sub.id)
    );
    writeRemoteConfig(rootDir, { ...config, subscriptions: remaining });
  }

  return { sent, failed, pruned: goneIds.length };
}

/* c8 ignore start - detached worker entry point; deliverNotifications is tested directly */
runIfMain(import.meta.url, async () => {
  try {
    const raw = process.env[NOTIFY_PAYLOAD_ENV];
    if (!raw) return;
    const { rootDir = ROOT_DIR, alert } = JSON.parse(raw);
    if (!alert) return;
    await deliverNotifications({ rootDir, alert });
  } catch {
    // Fail open: a push delivery error must never disturb the user's session.
  }
});
/* c8 ignore stop */
