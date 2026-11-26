import crypto from 'node:crypto';
import { vi } from 'vitest';
import {
  MAX_PUSH_PLAINTEXT_BYTES,
  WebPushError,
  buildAlertPayload,
  createVapidAuthHeader,
  decryptWebPush,
  encryptWebPush,
  generateVapidKeys,
  sendWebPush,
  validatePushEndpoint,
} from '../webpush.js';

const NOW = new Date('2026-11-27T03:00:00.000Z');
const FAKE_GH_TOKEN = 'gh' + 'p_' + 'c'.repeat(36);

function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(undefined, 'uncompressed');
  const privateKey = ecdh.getPrivateKey();
  const auth = crypto.randomBytes(16).toString('base64url');
  return {
    publicKey,
    privateKey,
    p256dh: publicKey.toString('base64url'),
    auth,
  };
}

describe('webpush (RFC 8291 + RFC 8292)', () => {
  test('generateVapidKeys and createVapidAuthHeader produce verifiable ES256 JWTs', () => {
    const vapid = generateVapidKeys();
    expect(Buffer.from(vapid.publicKey, 'base64url').length).toBe(65);
    expect(Buffer.from(vapid.publicKey, 'base64url')[0]).toBe(0x04);

    const header = createVapidAuthHeader({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      subject: 'mailto:test@example.com',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      now: NOW,
    });

    expect(header).toMatch(/^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);
    const token = header.slice('vapid t='.length, header.indexOf(', k='));
    const [h, c, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf-8'));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:test@example.com');

    // Verify ES256 signature using public key
    const spkiHeader = Buffer.from(
      '3059301306072a8648ce3d020106082a8648ce3d030107034200',
      'hex'
    );
    const pubDer = Buffer.concat([
      spkiHeader,
      Buffer.from(vapid.publicKey, 'base64url'),
    ]);
    const pubKeyObj = crypto.createPublicKey({
      key: pubDer,
      format: 'der',
      type: 'spki',
    });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${c}`, 'utf-8'),
      { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url')
    );
    expect(ok).toBe(true);
  });

  test('encryptWebPush and decryptWebPush round-trip and reject tampering or invalid keys', () => {
    const sub = makeSubscriber();
    const other = makeSubscriber();
    const message = JSON.stringify({ title: 'kyoten', body: 'done' });

    const body = encryptWebPush({
      payload: message,
      p256dh: sub.p256dh,
      auth: sub.auth,
    });

    const plain = decryptWebPush({
      body,
      privateKey: sub.privateKey,
      publicKey: sub.publicKey,
      auth: sub.auth,
    });
    expect(plain.toString('utf-8')).toBe(message);

    // Wrong private key fails decryption
    expect(() =>
      decryptWebPush({
        body,
        privateKey: other.privateKey,
        publicKey: other.publicKey,
        auth: other.auth,
      })
    ).toThrow(WebPushError);

    // Tampered ciphertext fails GCM tag verification
    const tampered = Buffer.from(body);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() =>
      decryptWebPush({
        body: tampered,
        privateKey: sub.privateKey,
        publicKey: sub.publicKey,
        auth: sub.auth,
      })
    ).toThrow(/Failed to decrypt/);

    expect(() =>
      encryptWebPush({ payload: 'x', p256dh: 'bad', auth: sub.auth })
    ).toThrow(/65-byte/);
    expect(() =>
      encryptWebPush({ payload: 'x', p256dh: sub.p256dh, auth: 'bad' })
    ).toThrow(/16 bytes/);
    expect(() =>
      encryptWebPush({
        payload: Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1),
        p256dh: sub.p256dh,
        auth: sub.auth,
      })
    ).toThrow(/exceeds/);
  });

  test('validatePushEndpoint blocks non-https, credentials, and private/SSRF targets', () => {
    expect(
      validatePushEndpoint(
        'https://updates.push.services.mozilla.com/wpush/v2/abc'
      ).hostname
    ).toBe('updates.push.services.mozilla.com');
    expect(
      validatePushEndpoint('http://127.0.0.1:8080/push', {
        allowLocalhost: true,
      }).hostname
    ).toBe('127.0.0.1');

    for (const bad of [
      'not-a-url',
      'https://user:pass@example.com/push',
      'http://example.com/push',
      'https://localhost/push',
      'https://127.0.0.1/push',
      'https://10.0.0.1/push',
      'https://172.16.5.4/push',
      'https://192.168.1.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/push',
      'https://[fe80::1]/push',
      'https://printer.local/push',
    ]) {
      expect(() => validatePushEndpoint(bad)).toThrow(WebPushError);
    }
  });

  test('buildAlertPayload redacts secrets before push delivery', () => {
    const alert = buildAlertPayload({
      title: `Done with ${FAKE_GH_TOKEN}`,
      body: 'Ran curl -H "Authorization: Bearer supersecret123"',
      event: 'Stop',
      harness: 'agy',
      host: 'workstation',
      at: NOW,
    });
    expect(alert.title).not.toContain(FAKE_GH_TOKEN);
    expect(alert.body).not.toContain('supersecret123');
    expect(alert.tag).toBe('kyoten-agy-stop');
  });

  test('sendWebPush sends aes128gcm encrypted payload and detects 410 Gone', async () => {
    const vapid = generateVapidKeys();
    const sub = makeSubscriber();
    const subscription = {
      id: 'sub1',
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test',
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      addedAt: NOW.toISOString(),
    };
    const fetchOk = vi.fn(async (_url, init) => {
      const decrypted = decryptWebPush({
        body: Buffer.from(init.body),
        privateKey: sub.privateKey,
        publicKey: sub.publicKey,
        auth: sub.auth,
      });
      expect(JSON.parse(decrypted.toString('utf-8')).title).toBe('hello');
      expect(init.headers['Content-Encoding']).toBe('aes128gcm');
      expect(init.redirect).toBe('error');
      return new Response(null, { status: 201 });
    });

    const okRes = await sendWebPush({
      subscription,
      payload: {
        title: 'hello',
        body: 'world',
        tag: 't',
        event: 'Stop',
        harness: 'agy',
        host: 'pc',
        timestamp: NOW.toISOString(),
      },
      vapid: { ...vapid, subject: 'mailto:test@example.com' },
      fetchFn: /** @type {any} */ (fetchOk),
      now: NOW,
    });
    expect(okRes).toEqual({ ok: true, status: 201, gone: false });

    const fetchGone = vi.fn(async () => new Response(null, { status: 410 }));
    const goneRes = await sendWebPush({
      subscription,
      payload: 'ping',
      vapid: { ...vapid, subject: 'mailto:test@example.com' },
      fetchFn: /** @type {any} */ (fetchGone),
    });
    expect(goneRes).toEqual({ ok: false, status: 410, gone: true });
  });
});
