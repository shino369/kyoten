/**
 * Machine-local remote notification, OSC 7501, and Herdr configuration
 * (`memory/remote/config.json`). Never synced and excluded from git/tarball packing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from '../memory/store.js';
import { validatePushEndpoint } from './webpush.js';

export const REMOTE_SUBDIR = 'remote';
export const REMOTE_CONFIG_FILE = 'config.json';
export const REMOTE_LOCK_FILE = 'remote.lock';
export const LAST_PUSH_FILE = 'last-push.json';
export const DEFAULT_QUIET_MS = 5000;
const LOCK_STALE_MS = 30_000;

/**
 * @typedef {import('./webpush.js').VapidKeyPair} VapidKeyPair
 * @typedef {import('./webpush.js').PushSubscription} PushSubscription
 *
 * @typedef {object} RedactedSubscription
 * @property {string} id
 * @property {string | null} label
 * @property {string} endpointHost
 * @property {string} addedAt
 *
 * @typedef {object} RemoteConfig
 * @property {number} version
 * @property {boolean} osc7501
 * @property {boolean} herdr
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
  herdr: false,
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
 * Redact a stored subscription for ordinary CLI/JSON output (omits `keys.auth`,
 * `keys.p256dh`, and endpoint path tokens).
 *
 * @param {PushSubscription} sub
 * @returns {RedactedSubscription}
 */
export function redactSubscription(sub) {
  let endpointHost = '(invalid)';
  try {
    endpointHost = new URL(sub.endpoint).host;
  } catch {
    // Keep placeholder for malformed endpoints.
  }
  return {
    id: sub.id,
    label: sub.label ?? null,
    endpointHost,
    addedAt: sub.addedAt,
  };
}

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
  const herdr = raw.herdr === true;
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
    herdr,
    pushEnabled,
    subject,
    vapid,
    subscriptions,
    quietMs,
  };
}

/**
 * Read remote config. Returns defaults when missing (`ENOENT`), and throws on
 * corrupt/unreadable JSON so callers never silently discard VAPID keys or
 * subscriptions.
 *
 * @param {string} rootDir
 * @returns {RemoteConfig}
 */
export function readRemoteConfig(rootDir) {
  const file = remoteConfigFile(rootDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { ...DEFAULT_REMOTE_CONFIG, subscriptions: [] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Remote config at ${file} is not valid JSON (${detail}). Refusing to overwrite it.`
    );
  }
  return normalizeRemoteConfig(parsed);
}

/**
 * Atomically write a private file with restrictive creation permissions
 * (`0o600` on POSIX, `0o700` parent dir) so VAPID private keys are never
 * briefly world-readable.
 *
 * @param {string} file
 * @param {string} content
 * @param {{ platform?: NodeJS.Platform, retryMs?: number }} [options]
 */
export function writePrivateFileAtomic(
  file,
  content,
  { platform = process.platform, retryMs = 2000 } = {}
) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmp = `${file}.${process.pid}.${suffix}.tmp`;
  const deadline = Date.now() + retryMs;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    for (;;) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : null;
        if (
          platform !== 'win32' ||
          (code !== 'EPERM' && code !== 'EBUSY') ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Acquire an exclusive machine-local lock around remote config / throttle
 * read-modify-write operations.
 *
 * @template T
 * @param {string} rootDir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number }} [options]
 * @returns {T}
 */
export function withRemoteLock(rootDir, fn, { timeoutMs = 2000 } = {}) {
  const dir = remoteDir(rootDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, REMOTE_LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : null;
      if (code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for remote lock at ${lockPath}.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close error.
    }
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * @param {string} rootDir
 * @param {RemoteConfig} config
 * @returns {RemoteConfig}
 */
export function writeRemoteConfig(rootDir, config) {
  const normalized = normalizeRemoteConfig(config);
  const file = remoteConfigFile(rootDir);
  writePrivateFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/**
 * Atomically read-modify-write remote config under lock so concurrent workers
 * and CLI commands never clobber each other's changes.
 *
 * @param {string} rootDir
 * @param {(current: RemoteConfig) => RemoteConfig} updater
 * @returns {RemoteConfig}
 */
export function updateRemoteConfig(rootDir, updater) {
  return withRemoteLock(rootDir, () => {
    const current = readRemoteConfig(rootDir);
    const next = updater(current);
    return writeRemoteConfig(rootDir, next);
  });
}

/**
 * Atomically check and update the push throttle timestamp under lock so two
 * simultaneous Stop hooks cannot both pass and double-push.
 *
 * @param {string} rootDir
 * @param {number} quietMs
 * @param {Date} now
 * @returns {boolean} true if throttled (caller should skip pushing)
 */
export function claimPushThrottle(rootDir, quietMs, now) {
  if (quietMs <= 0) return false;
  return withRemoteLock(rootDir, () => {
    const file = path.join(remoteDir(rootDir), LAST_PUSH_FILE);
    const nowMs = now.getTime();
    let lastAt = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof parsed?.at === 'number') lastAt = parsed.at;
    } catch {
      // Missing or corrupt throttle file; reset below.
    }
    if (lastAt !== null && nowMs - lastAt < quietMs) {
      return true;
    }
    writePrivateFileAtomic(file, JSON.stringify({ at: nowMs }));
    return false;
  });
}

/**
 * Parse a JSON subscription payload (from stdin or a private file).
 * Accepts either Web Push `PushSubscriptionJSON` (`{ endpoint, keys: { p256dh, auth }, label? }`)
 * or flat `{ endpoint, p256dh, auth, label? }`.
 *
 * @param {string} raw
 * @returns {{ endpoint: string, p256dh: string, auth: string, label?: string }}
 */
export function parseSubscriptionPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid subscription JSON: ${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Subscription payload must be a JSON object.');
  }
  const obj = /** @type {Record<string, any>} */ (parsed);
  const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint.trim() : '';
  const p256dh =
    typeof obj.keys?.p256dh === 'string'
      ? obj.keys.p256dh.trim()
      : typeof obj.p256dh === 'string'
        ? obj.p256dh.trim()
        : '';
  const auth =
    typeof obj.keys?.auth === 'string'
      ? obj.keys.auth.trim()
      : typeof obj.auth === 'string'
        ? obj.auth.trim()
        : '';
  const label =
    typeof obj.label === 'string' && obj.label.trim()
      ? obj.label.trim()
      : undefined;
  if (!endpoint || !p256dh || !auth) {
    throw new Error(
      'Subscription JSON must include endpoint, keys.p256dh, and keys.auth.'
    );
  }
  return { endpoint, p256dh, auth, ...(label ? { label } : {}) };
}

/**
 * Add (or update by endpoint) a browser Web Push subscription under lock.
 *
 * @param {string} rootDir
 * @param {{
 *   endpoint: string,
 *   p256dh: string,
 *   auth: string,
 *   label?: string,
 *   allowLocalhost?: boolean,
 *   allowCustomHost?: boolean,
 *   now?: Date,
 * }} input
 * @returns {PushSubscription}
 */
export function addSubscription(
  rootDir,
  {
    endpoint,
    p256dh,
    auth,
    label,
    allowLocalhost = false,
    allowCustomHost = false,
    now = new Date(),
  }
) {
  validatePushEndpoint(endpoint, { allowLocalhost, allowCustomHost });
  if (!p256dh || !auth) {
    throw new Error('Both p256dh and auth keys are required.');
  }
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
  updateRemoteConfig(rootDir, (cfg) => {
    const next = cfg.subscriptions.filter((s) => s.id !== id);
    next.push(sub);
    return { ...cfg, subscriptions: next };
  });
  return sub;
}

/**
 * Remove a subscription by id under lock. Returns true if found and removed.
 *
 * @param {string} rootDir
 * @param {string} id
 * @returns {boolean}
 */
export function removeSubscription(rootDir, id) {
  let removed = false;
  updateRemoteConfig(rootDir, (cfg) => {
    const next = cfg.subscriptions.filter((s) => s.id !== id);
    removed = next.length !== cfg.subscriptions.length;
    return removed ? { ...cfg, subscriptions: next } : cfg;
  });
  return removed;
}

/**
 * Prune expired subscription ids (`404`/`410`) under lock without overwriting
 * concurrent changes to `pushEnabled`, `vapid`, or newly added subscriptions.
 *
 * @param {string} rootDir
 * @param {string[]} goneIds
 * @returns {number} count actually pruned
 */
export function pruneSubscriptions(rootDir, goneIds) {
  if (goneIds.length === 0) return 0;
  const goneSet = new Set(goneIds);
  let pruned = 0;
  updateRemoteConfig(rootDir, (cfg) => {
    const remaining = cfg.subscriptions.filter((s) => !goneSet.has(s.id));
    pruned = cfg.subscriptions.length - remaining.length;
    return pruned > 0 ? { ...cfg, subscriptions: remaining } : cfg;
  });
  return pruned;
}
