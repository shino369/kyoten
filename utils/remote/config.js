/**
 * Machine-local remote configuration (`memory/remote/config.json`).
 * Never synced and excluded from git/tarball packing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from '../memory/store.js';

export const REMOTE_SUBDIR = 'remote';
export const REMOTE_CONFIG_FILE = 'config.json';

/**
 * @typedef {object} RemoteConfig
 * @property {number} version
 * @property {boolean} osc7501
 * @property {boolean} herdr
 */

/** @type {Readonly<RemoteConfig>} */
export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  version: 1,
  osc7501: false,
  herdr: false,
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
  return {
    version: 1,
    osc7501: raw.osc7501 === true,
    herdr: raw.herdr === true,
  };
}

/**
 * Read remote config. Returns defaults when missing (`ENOENT`), and throws on
 * corrupt/unreadable files so callers never silently overwrite config.
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
      return { ...DEFAULT_REMOTE_CONFIG };
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
 * (`0o600` on POSIX) so secrets are never briefly world-readable.
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
