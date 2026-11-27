/**
 * Machine-local remote configuration (`memory/remote/config.json`).
 * Never synced and excluded from git/tarball packing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir, readJsonOrNull } from '../memory/store.js';
import { writeFileAtomic } from '../task/store.js';

export const REMOTE_SUBDIR = 'remote';
export const REMOTE_CONFIG_FILE = 'config.json';

/**
 * @typedef {object} RemoteConfig
 * @property {number} version
 * @property {boolean} osc7501
 */

/** @type {Readonly<RemoteConfig>} */
export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  version: 1,
  osc7501: false,
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
  };
}

/**
 * @param {string} rootDir
 * @returns {RemoteConfig}
 */
export function readRemoteConfig(rootDir) {
  const parsed = readJsonOrNull(remoteConfigFile(rootDir));
  if (!parsed) {
    return { ...DEFAULT_REMOTE_CONFIG };
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
