import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REMOTE_CONFIG,
  addSubscription,
  claimPushThrottle,
  hasRemoteConfig,
  normalizeRemoteConfig,
  parseSubscriptionPayload,
  pruneSubscriptions,
  readRemoteConfig,
  redactSubscription,
  remoteConfigFile,
  removeSubscription,
  updateRemoteConfig,
  writeRemoteConfig,
} from '../config.js';
import { generateVapidKeys } from '../webpush.js';

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

function sampleKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

describe('remote config (osc7501, herdr & web push)', () => {
  test('returns default config when missing and writes atomically with no leftover temp files', () => {
    expect(hasRemoteConfig(tmp)).toBe(false);
    expect(readRemoteConfig(tmp)).toEqual(DEFAULT_REMOTE_CONFIG);

    const vapid = generateVapidKeys();
    writeRemoteConfig(tmp, {
      ...DEFAULT_REMOTE_CONFIG,
      osc7501: true,
      herdr: true,
      pushEnabled: true,
      vapid,
    });
    expect(hasRemoteConfig(tmp)).toBe(true);
    const file = remoteConfigFile(tmp);
    expect(fs.existsSync(file)).toBe(true);
    const loaded = readRemoteConfig(tmp);
    expect(loaded.osc7501).toBe(true);
    expect(loaded.herdr).toBe(true);
    expect(loaded.pushEnabled).toBe(true);
    expect(loaded.vapid).toEqual(vapid);
    const leftover = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  test('throws on corrupt JSON instead of silently discarding VAPID keys', () => {
    const file = remoteConfigFile(tmp);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{corrupt', 'utf-8');
    expect(() => readRemoteConfig(tmp)).toThrow(/not valid JSON/);
  });

  test('normalizeRemoteConfig validates shape and VAPID fields', () => {
    expect(() => normalizeRemoteConfig(null)).toThrow(/JSON object/);
    expect(() => normalizeRemoteConfig([])).toThrow(/JSON object/);
    expect(() =>
      normalizeRemoteConfig({ vapid: { publicKey: 'only' } })
    ).toThrow(/Invalid VAPID/);
    expect(normalizeRemoteConfig({})).toEqual(DEFAULT_REMOTE_CONFIG);
  });

  test('adds, deduplicates, prunes under lock, redacts, and removes subscriptions', () => {
    const keys = sampleKeys();
    const sub1 = addSubscription(tmp, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/phone1',
      ...keys,
      label: 'pixel',
    });
    const sub2 = addSubscription(tmp, {
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/phone2',
      ...keys,
      label: 'firefox',
    });
    expect(readRemoteConfig(tmp).subscriptions).toHaveLength(2);

    // Redaction hides auth and p256dh and endpoint path
    const redacted = redactSubscription(sub1);
    expect(redacted).toEqual({
      id: sub1.id,
      label: 'pixel',
      endpointHost: 'fcm.googleapis.com',
      addedAt: sub1.addedAt,
    });
    expect(JSON.stringify(redacted)).not.toContain(keys.auth);
    expect(JSON.stringify(redacted)).not.toContain(keys.p256dh);

    // Prune removes only goneIds while preserving concurrent updates
    updateRemoteConfig(tmp, (cfg) => ({ ...cfg, pushEnabled: false }));
    expect(pruneSubscriptions(tmp, [sub1.id])).toBe(1);
    const afterPrune = readRemoteConfig(tmp);
    expect(afterPrune.pushEnabled).toBe(false);
    expect(afterPrune.subscriptions.map((s) => s.id)).toEqual([sub2.id]);
    expect(pruneSubscriptions(tmp, [])).toBe(0);

    expect(removeSubscription(tmp, sub2.id)).toBe(true);
    expect(removeSubscription(tmp, sub2.id)).toBe(false);
    expect(readRemoteConfig(tmp).subscriptions).toHaveLength(0);
  });

  test('parseSubscriptionPayload accepts nested PushSubscriptionJSON and flat JSON', () => {
    const keys = sampleKeys();
    const nested = parseSubscriptionPayload(
      JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/a',
        label: 'my phone',
        keys,
      })
    );
    expect(nested).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/a',
      p256dh: keys.p256dh,
      auth: keys.auth,
      label: 'my phone',
    });
    const flat = parseSubscriptionPayload(
      JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/b',
        ...keys,
      })
    );
    expect(flat.endpoint).toBe('https://fcm.googleapis.com/fcm/send/b');
    expect(() => parseSubscriptionPayload('{bad')).toThrow(
      /Invalid subscription JSON/
    );
    expect(() => parseSubscriptionPayload('[]')).toThrow(/JSON object/);
    expect(() => parseSubscriptionPayload('{}')).toThrow(/must include/);
  });

  test('claimPushThrottle atomically gates pushes within quietMs', () => {
    const t0 = new Date('2026-11-28T00:00:00.000Z');
    const t1 = new Date('2026-11-28T00:00:02.000Z');
    const t2 = new Date('2026-11-28T00:00:06.000Z');
    expect(claimPushThrottle(tmp, 0, t0)).toBe(false);
    expect(claimPushThrottle(tmp, 5000, t0)).toBe(false);
    expect(claimPushThrottle(tmp, 5000, t1)).toBe(true);
    expect(claimPushThrottle(tmp, 5000, t2)).toBe(false);
  });
});
