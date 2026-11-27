import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runCli } from '../utils/remote/cli.js';
import { readRemoteConfig } from '../utils/remote/config.js';
import { startSubscribeServer } from '../utils/remote/subscribe-page.js';
import { generateVapidKeys } from '../utils/remote/webpush.js';

function makeP256SubKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

test.describe('remote subscribe PWA UI', () => {
  /** @type {Awaited<ReturnType<typeof startSubscribeServer>>} */
  let srv;
  /** @type {string} */
  let tmpDir;
  /** @type {ReturnType<typeof generateVapidKeys>} */
  let oldVapid;
  /** @type {ReturnType<typeof generateVapidKeys>} */
  let newVapid;

  test.beforeEach(async () => {
    oldVapid = generateVapidKeys();
    newVapid = generateVapidKeys();
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-pwa-e2e-'))
    );
    srv = await startSubscribeServer({
      port: 0,
      host: '127.0.0.1',
      vapidPublicKey: newVapid.publicKey,
    });
  });

  test.afterEach(async () => {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fills VAPID from fragment, handles permission denied, rotates mismatched VAPID key, and imports JSON via CLI stdin', async ({
    page,
  }) => {
    const subKeys = makeP256SubKeys();

    // Stub PushManager, ServiceWorker, Notification, and Clipboard in browser
    await page.addInitScript(
      ({ oldPubKey, p256dhB64, authB64 }) => {
        /** @param {string} b64u */
        function b64ToBytes(b64u) {
          const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
          const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
          const out = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
          return out.buffer;
        }

        const win = /** @type {any} */ (globalThis);
        win.__testState = {
          permission: 'denied',
          unsubscribed: 0,
          subscribedKeys: /** @type {string[]} */ ([]),
          copied: /** @type {string[]} */ ([]),
        };

        Object.defineProperty(win, 'Notification', {
          configurable: true,
          value: {
            requestPermission: async () => win.__testState.permission,
          },
        });

        Object.defineProperty(win, 'PushManager', {
          configurable: true,
          value: function PushManager() {},
        });

        /** @type {any} */
        let currentSub = {
          endpoint: 'https://fcm.googleapis.com/fcm/send/old-endpoint',
          options: { applicationServerKey: b64ToBytes(oldPubKey) },
          getKey: (/** @type {string} */ name) =>
            b64ToBytes(name === 'p256dh' ? p256dhB64 : authB64),
          unsubscribe: async () => {
            win.__testState.unsubscribed += 1;
            currentSub = null;
            return true;
          },
        };

        const fakeReg = {
          pushManager: {
            getSubscription: async () => currentSub,
            subscribe: async (/** @type {any} */ opts) => {
              const bytes = new Uint8Array(opts.applicationServerKey);
              let bin = '';
              for (const b of bytes) bin += String.fromCharCode(b);
              const b64u = btoa(bin)
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');
              win.__testState.subscribedKeys.push(b64u);
              currentSub = {
                endpoint:
                  'https://fcm.googleapis.com/fcm/send/rotated-endpoint',
                options: { applicationServerKey: bytes.buffer },
                getKey: (/** @type {string} */ name) =>
                  b64ToBytes(name === 'p256dh' ? p256dhB64 : authB64),
                unsubscribe: async () => {
                  win.__testState.unsubscribed += 1;
                  currentSub = null;
                  return true;
                },
              };
              return currentSub;
            },
          },
        };

        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: {
            register: async () => fakeReg,
            ready: Promise.resolve(fakeReg),
          },
        });

        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (/** @type {string} */ text) => {
              win.__testState.copied.push(text);
            },
          },
        });
      },
      {
        oldPubKey: oldVapid.publicKey,
        p256dhB64: subKeys.p256dh,
        authB64: subKeys.auth,
      }
    );

    await page.goto(srv.url);

    // 1. Fragment auto-fills VAPID public key, and Copy Key button copies it (iOS handoff)
    await expect(page.locator('#vapid')).toHaveValue(newVapid.publicKey);
    await page.click('#copyVapidBtn');
    await expect(page.locator('#status')).toContainText(
      'Copied VAPID public key'
    );
    const copiedAfterVapid = await page.evaluate(
      () => /** @type {any} */ (globalThis).__testState.copied
    );
    expect(copiedAfterVapid).toEqual([newVapid.publicKey]);

    // 2. Empty VAPID key produces validation error
    await page.fill('#vapid', '');
    await page.click('#subBtn');
    await expect(page.locator('#status')).toContainText(
      'VAPID public key is required'
    );

    // 3. Permission denied is reported cleanly
    await page.fill('#vapid', newVapid.publicKey);
    await page.click('#subBtn');
    await expect(page.locator('#status')).toContainText(
      'Notification permission denied'
    );

    // 4. Grant permission + malicious label with shell metacharacters:
    //    existing old-VAPID subscription MUST be unsubscribed and re-subscribed with newVapid!
    await page.evaluate(() => {
      /** @type {any} */ (globalThis).__testState.permission = 'granted';
    });
    await page.fill('#label', 'my $(whoami) phone');
    await page.click('#subBtn');

    await expect(page.locator('#status')).toContainText(
      'Rotated subscription to the new VAPID key'
    );
    await expect(page.locator('#payload')).toBeVisible();
    const state = await page.evaluate(
      () => /** @type {any} */ (globalThis).__testState
    );
    expect(state.unsubscribed).toBe(1);
    expect(state.subscribedKeys).toEqual([newVapid.publicKey]);

    const payloadText = (await page.locator('#payload').textContent()) ?? '';
    const parsed = JSON.parse(payloadText);
    expect(parsed.endpoint).toBe(
      'https://fcm.googleapis.com/fcm/send/rotated-endpoint'
    );
    expect(parsed.label).toBe('my whoami phone');
    expect(parsed.keys.p256dh).toBe(subKeys.p256dh);
    expect(parsed.keys.auth).toBe(subKeys.auth);

    // 5. Pipe generated JSON straight into `pnpm remote push add --stdin --json`
    /** @type {string[]} */
    const outLines = [];
    const exitCode = await runCli(['push', 'add', '--stdin', '--json'], {
      rootDir: tmpDir,
      out: (line) => outLines.push(line),
      readStdin: async () => payloadText,
    });
    expect(exitCode).toBe(0);
    const cliOut = outLines.join('\n');
    expect(cliOut).not.toContain(subKeys.auth);
    expect(cliOut).not.toContain(subKeys.p256dh);
    expect(JSON.parse(cliOut).label).toBe('my whoami phone');
    expect(readRemoteConfig(tmpDir).subscriptions).toHaveLength(1);
  });
});
