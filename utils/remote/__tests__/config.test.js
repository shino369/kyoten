import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REMOTE_CONFIG,
  hasRemoteConfig,
  normalizeRemoteConfig,
  readRemoteConfig,
  remoteConfigFile,
  writeRemoteConfig,
} from '../config.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-cfg-'))
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('remote config (osc7501)', () => {
  test('returns default config when missing and normalizes writes', () => {
    expect(hasRemoteConfig(tmp)).toBe(false);
    expect(readRemoteConfig(tmp)).toEqual(DEFAULT_REMOTE_CONFIG);

    writeRemoteConfig(tmp, { version: 1, osc7501: true });
    expect(hasRemoteConfig(tmp)).toBe(true);
    expect(fs.existsSync(remoteConfigFile(tmp))).toBe(true);
    expect(readRemoteConfig(tmp)).toEqual({ version: 1, osc7501: true });
  });

  test('normalizeRemoteConfig validates object shape', () => {
    expect(() => normalizeRemoteConfig(null)).toThrow(/JSON object/);
    expect(() => normalizeRemoteConfig([])).toThrow(/JSON object/);
    expect(normalizeRemoteConfig({})).toEqual({ version: 1, osc7501: false });
  });
});
