import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REMOTE_CONFIG,
  addSubscription,
  hasRemoteConfig,
  normalizeRemoteConfig,
  readRemoteConfig,
  remoteConfigFile,
  removeSubscription,
  writeRemoteConfig,
} from '../config.js';
import { generateVapidKeys } from '../webpush.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-cfg-'))
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('remote config', () => {
  test('reads defaults when unconfigured and normalizes valid config', () => {
    expect(hasRemoteConfig(root)).toBe(false);
    expect(readRemoteConfig(root)).toEqual(DEFAULT_REMOTE_CONFIG);

    const vapid = generateVapidKeys();
    const written = writeRemoteConfig(root, {
      ...DEFAULT_REMOTE_CONFIG,
      osc7501: true,
      pushEnabled: true,
      vapid,
      quietMs: 1000,
    });
    expect(hasRemoteConfig(root)).toBe(true);
    expect(fs.existsSync(remoteConfigFile(root))).toBe(true);
    expect(readRemoteConfig(root)).toEqual(written);

    expect(() => normalizeRemoteConfig(null)).toThrow(/JSON object/);
    expect(() =>
      normalizeRemoteConfig({ vapid: { publicKey: '', privateKey: '' } })
    ).toThrow(/Invalid VAPID/);
  });

  test('addSubscription and removeSubscription manage push endpoints safely', () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const p256dh = ecdh
      .getPublicKey(undefined, 'uncompressed')
      .toString('base64url');
    const auth = crypto.randomBytes(16).toString('base64url');

    const sub = addSubscription(root, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      p256dh,
      auth,
      label: 'Pixel 9',
    });
    expect(sub.id).toMatch(/^[0-9a-f]{8}$/);
    expect(readRemoteConfig(root).subscriptions).toHaveLength(1);

    expect(removeSubscription(root, 'missing')).toBe(false);
    expect(removeSubscription(root, sub.id)).toBe(true);
    expect(readRemoteConfig(root).subscriptions).toHaveLength(0);

    expect(() =>
      addSubscription(root, {
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-2',
        p256dh: '',
        auth,
      })
    ).toThrow(/required/);
  });
});
