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

describe('remote config (osc7501 & herdr)', () => {
  test('returns default config when missing and normalizes writes atomically', () => {
    expect(hasRemoteConfig(tmp)).toBe(false);
    expect(readRemoteConfig(tmp)).toEqual(DEFAULT_REMOTE_CONFIG);

    writeRemoteConfig(tmp, { version: 1, osc7501: true, herdr: true });
    expect(hasRemoteConfig(tmp)).toBe(true);
    const file = remoteConfigFile(tmp);
    expect(fs.existsSync(file)).toBe(true);
    expect(readRemoteConfig(tmp)).toEqual({
      version: 1,
      osc7501: true,
      herdr: true,
    });
    const leftover = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  test('throws on corrupt JSON instead of silently discarding config', () => {
    const file = remoteConfigFile(tmp);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-valid-json', 'utf-8');
    expect(() => readRemoteConfig(tmp)).toThrow(/not valid JSON/);
  });

  test('normalizeRemoteConfig validates object shape', () => {
    expect(() => normalizeRemoteConfig(null)).toThrow(/JSON object/);
    expect(() => normalizeRemoteConfig([])).toThrow(/JSON object/);
    expect(normalizeRemoteConfig({})).toEqual({
      version: 1,
      osc7501: false,
      herdr: false,
    });
  });
});
