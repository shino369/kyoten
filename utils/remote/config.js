/**
 * Machine-local remote notification & OSC 7501 configuration (`memory/remote/config.json`).
 * Never synced and excluded from git/tarball packing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir, readJsonOrNull } from '../memory/store.js';
import { writeFileAtomic } from '../task/store.js';
import { validatePushEndpoint } from './webpush.js';

export const REMOTE_SUBDIR = 'remote';
export const REMOTE_CONFIG_FILE = 'config.json';
export const LAST_PUSH_FILE = 'last-push.json';
export const DEFAULT_QUIET_MS = 5000;

/**
 * @typedef {import('./webpush.js').VapidKeyPair} VapidKeyPair
 * @typedef {import('./webpush.js').PushSubscription} PushSubscription
 *
 * @typedef {object} RemoteConfig
 * @property {number} version
 * @property {boolean} osc7501
 * @property {boolean} pushEnabled
 * @property {string} subject
 * @property {VapidKeyPair | null} vapid
 * @property {PushSubscription[]} subscriptions
 * @property {number} quietMs
 */

/** @type {Readonly<RemoteConfig>} */
export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  version: 1,
  osc7501: false,
  pushEnabled: false,
  subject: 'mailto:kyoten@localhost',
  vapid: null,
  subscriptions: [],
  quietMs: DEFAULT_QUIET_MS,
});

/** @param {string} rootDir */
export const remoteDir = (rootDir) =>
  path.join(memoryDir(rootDir), REMOTE_SUBDIR);

/** @param {string} rootDir */
export const remoteConfigFile = (rootDir) =>
  path.join(remoteDir(rootDir), REMOTE_CONFIG_FILE);

/** @param {string} rootDir */
export const hasRemoteConfig = (rootDir) =>
  fs.existsSync(remoteConfigFile(rootDir));

/**
 * @param {unknown} input
 * @returns {RemoteConfig}
 */
export function normalizeRemoteConfig(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Remote config must be a JSON object.');
  }
  const raw = /** @type {Record<string, unknown>} */ (input);
  const osc7501 = raw.osc7501 === true;
  const pushEnabled = raw.pushEnabled === true;
  const subject =
    typeof raw.subject === 'string' && raw.subject.trim()
      ? raw.subject.trim()
      : DEFAULT_REMOTE_CONFIG.subject;
  const quietMs =
    typeof raw.quietMs === 'number' &&
    Number.isInteger(raw.quietMs) &&
    raw.quietMs >= 0
      ? raw.quietMs
      : DEFAULT_QUIET_MS;
  /** @type {VapidKeyPair | null} */
  let vapid = null;
  if (raw.vapid !== undefined && raw.vapid !== null) {
    const v = /** @type {Record<string, unknown>} */ (raw.vapid);
    if (
      typeof v.publicKey !== 'string' ||
      typeof v.privateKey !== 'string' ||
      !v.publicKey ||
      !v.privateKey
    ) {
      throw new Error('Invalid VAPID keypair in remote config.');
    }
    vapid = { publicKey: v.publicKey, privateKey: v.privateKey };
  }
  const subscriptions = Array.isArray(raw.subscriptions)
    ? /** @type {PushSubscription[]} */ (
        raw.subscriptions.filter(
          (s) =>
            s &&
            typeof s === 'object' &&
            typeof s.id === 'string' &&
            typeof s.endpoint === 'string' &&
            typeof s.keys?.p256dh === 'string' &&
            typeof s.keys?.auth === 'string'
        )
      )
    : [];

  return {
    version: 1,
    osc7501,
    pushEnabled,
    subject,
    vapid,
    subscriptions,
    quietMs,
  };
}

/**
 * @param {string} rootDir
 * @returns {RemoteConfig}
 */
export function readRemoteConfig(rootDir) {
  const parsed = readJsonOrNull(remoteConfigFile(rootDir));
  if (!parsed) {
    return { ...DEFAULT_REMOTE_CONFIG, subscriptions: [] };
  }
  return normalizeRemoteConfig(parsed);
}

/**
 * @param {string} rootDir
 * @param {RemoteConfig} config
 * @returns {RemoteConfig}
 */
export function writeRemoteConfig(rootDir, config) {
  const normalized = normalizeRemoteConfig(config);
  const file = remoteConfigFile(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
  }
  return normalized;
}

/**
 * Add (or update by endpoint) a browser Web Push subscription.
 *
 * @param {string} rootDir
 * @param {{ endpoint: string, p256dh: string, auth: string, label?: string, allowLocalhost?: boolean, now?: Date }} input
 * @returns {PushSubscription}
 */
export function addSubscription(
  rootDir,
  { endpoint, p256dh, auth, label, allowLocalhost = false, now = new Date() }
) {
  validatePushEndpoint(endpoint, { allowLocalhost });
  if (!p256dh || !auth) {
    throw new Error('Both --p256dh and --auth keys are required.');
  }
  const cfg = readRemoteConfig(rootDir);
  const id = crypto
    .createHash('sha256')
    .update(endpoint)
    .digest('hex')
    .slice(0, 8);
  /** @type {PushSubscription} */
  const sub = {
    id,
    ...(label ? { label: label.trim() } : {}),
    endpoint,
    keys: { p256dh, auth },
    addedAt: now.toISOString(),
  };
  const next = cfg.subscriptions.filter((s) => s.id !== id);
  next.push(sub);
  writeRemoteConfig(rootDir, { ...cfg, subscriptions: next });
  return sub;
}

/**
 * Remove a subscription by id. Returns true if found and removed.
 *
 * @param {string} rootDir
 * @param {string} id
 * @returns {boolean}
 */
export function removeSubscription(rootDir, id) {
  const cfg = readRemoteConfig(rootDir);
  const next = cfg.subscriptions.filter((s) => s.id !== id);
  if (next.length === cfg.subscriptions.length) return false;
  writeRemoteConfig(rootDir, { ...cfg, subscriptions: next });
  return true;
}
