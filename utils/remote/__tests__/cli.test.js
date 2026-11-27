import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { HELP, runCli } from '../cli.js';
import { readRemoteConfig } from '../config.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-cli-'))
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

/**
 * @param {string[]} argv
 * @param {Parameters<typeof runCli>[1]} [extra]
 */
async function cli(argv, extra = {}) {
  /** @type {string[]} */
  const lines = [];
  const code = await runCli(argv, {
    rootDir: tmp,
    cwd: tmp,
    out: (line) => lines.push(line),
    ...extra,
  });
  return { code, lines, text: lines.join('\n') };
}

describe('remote cli (osc7501, herdr & web push)', () => {
  test('prints Usage help with no args, help, or --help', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = await cli(args);
      expect(res.code).toBe(0);
      expect(res.text).toBe(HELP);
      expect(res.text.startsWith('Usage:')).toBe(true);
    }
  });

  test('toggles osc7501 and herdr and reports status', async () => {
    expect((await cli(['osc7501', 'on'])).text).toContain('turned on');
    expect((await cli(['herdr', 'on'])).text).toContain('turned on');
    const st = JSON.parse((await cli(['status', '--json'])).text);
    expect(st.osc7501).toBe(true);
    expect(st.herdr).toBe(true);
    expect(st.pushEnabled).toBe(false);
    expect((await cli(['osc7501', 'off'])).text).toContain('turned off');
    expect((await cli(['herdr', 'off'])).text).toContain('turned off');
  });

  test('vapid init/show, rotation clears stale subscriptions, and push add redacts secrets in JSON output', async () => {
    await expect(cli(['vapid', 'show'])).rejects.toThrow(/not initialized/);
    await expect(cli(['push', 'on'])).rejects.toThrow(
      /before initializing VAPID/
    );

    const init = JSON.parse(
      (
        await cli([
          'vapid',
          'init',
          '--subject',
          'mailto:dev@example.com',
          '--json',
        ])
      ).text
    );
    expect(init.publicKey).toBeTruthy();
    expect(init.clearedSubscriptions).toBe(0);

    await expect(cli(['vapid', 'init'])).rejects.toThrow(/already exists/);

    const sub = sampleSubscriber();
    // Import via --stdin (keeps auth out of argv)
    const stdinPayload = JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/phone-stdin',
      label: 'pixel',
      keys: sub,
    });
    const added = JSON.parse(
      (
        await cli(['push', 'add', '--stdin', '--json'], {
          readStdin: async () => stdinPayload,
        })
      ).text
    );
    expect(added.id).toBeTruthy();
    expect(added.label).toBe('pixel');
    expect(added.endpointHost).toBe('fcm.googleapis.com');
    // Ordinary CLI JSON output must NEVER include auth or p256dh
    expect(JSON.stringify(added)).not.toContain(sub.auth);
    expect(JSON.stringify(added)).not.toContain(sub.p256dh);

    // Import via --file
    const subFile = path.join(tmp, 'sub.json');
    fs.writeFileSync(
      subFile,
      JSON.stringify({
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/f',
        keys: sub,
      })
    );
    const addedFile = JSON.parse(
      (await cli(['push', 'add', '--file', subFile, '--json'])).text
    );
    expect(addedFile.endpointHost).toBe('updates.push.services.mozilla.com');

    // List --json must also be redacted
    const listed = JSON.parse((await cli(['push', 'list', '--json'])).text);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(sub.auth);
    expect(JSON.stringify(listed)).not.toContain(sub.p256dh);

    // Rotating VAPID with --force must clear stale subscriptions!
    const rotated = JSON.parse(
      (await cli(['vapid', 'init', '--force', '--json'])).text
    );
    expect(rotated.publicKey).not.toBe(init.publicKey);
    expect(rotated.clearedSubscriptions).toBe(2);
    expect(readRemoteConfig(tmp).subscriptions).toEqual([]);
  });

  test('push test (dry-run and live) and push remove work cleanly', async () => {
    await cli(['vapid', 'init']);
    const sub = sampleSubscriber();
    const added = JSON.parse(
      (
        await cli([
          'push',
          'add',
          '--endpoint',
          'https://fcm.googleapis.com/fcm/send/direct',
          '--p256dh',
          sub.p256dh,
          '--auth',
          sub.auth,
          '--json',
        ])
      ).text
    );
    await cli(['push', 'on']);

    const dry = JSON.parse(
      (await cli(['push', 'test', '--dry-run', '--json'])).text
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.subscriptions).toBe(1);

    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
    const live = JSON.parse(
      (
        await cli(['push', 'test', '--json'], {
          fetchFn: /** @type {any} */ (fetchFn),
        })
      ).text
    );
    expect(live).toEqual({ sent: 1, failed: 0, pruned: 0 });

    await cli(['push', 'remove', added.id]);
    expect((await cli(['push', 'list'])).text).toContain(
      'No push subscriptions'
    );
  });

  test('subscribe-page validates --base-url BEFORE writing bundle files', async () => {
    await cli(['vapid', 'init']);
    const badOut = path.join(tmp, 'should-not-exist');
    await expect(
      cli([
        'push',
        'subscribe-page',
        '--out',
        badOut,
        '--base-url',
        'http://insecure.example.com/push',
      ])
    ).rejects.toThrow(/https:\/\//);
    // Directory must NOT have been created or populated on invalid --base-url
    expect(fs.existsSync(badOut)).toBe(false);

    const goodOut = path.join(tmp, 'good-pwa');
    const res = JSON.parse(
      (
        await cli([
          'push',
          'subscribe-page',
          '--out',
          goodOut,
          '--base-url',
          'https://shino369.github.io/kyoten-push/',
          '--json',
        ])
      ).text
    );
    expect(res.subscribeUrl).toMatch(
      /^https:\/\/shino369\.github\.io\/kyoten-push\/#vapid=/
    );
    expect(fs.existsSync(path.join(goodOut, 'index.html'))).toBe(true);
  });

  test('subscribe-serve validates port and invokes startServer', async () => {
    await cli(['vapid', 'init']);
    await expect(
      cli(['push', 'subscribe-serve', '--port', '99999'])
    ).rejects.toThrow(/Invalid --port/);

    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      server: /** @type {any} */ ({}),
      port: 8787,
      url: 'http://127.0.0.1:8787/#vapid=KEY',
      close,
    }));
    const res = JSON.parse(
      (
        await cli(['push', 'subscribe-serve', '--port', '8787', '--json'], {
          startServer: /** @type {any} */ (startServer),
          waitForClose: async () => {},
        })
      ).text
    );
    expect(res.port).toBe(8787);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid commands and options', async () => {
    await expect(cli(['unknown'])).rejects.toThrow(/Unknown remote command/);
    await expect(cli(['vapid', 'bogus'])).rejects.toThrow(/Unknown vapid/);
    await expect(cli(['push', 'bogus'])).rejects.toThrow(/Unknown push/);
    await expect(cli(['push', 'add'])).rejects.toThrow(/Missing subscription/);
    await expect(cli(['push', 'remove'])).rejects.toThrow(/id is required/);
    await expect(cli(['push', 'remove', 'nope'])).rejects.toThrow(
      /No subscription/
    );
    await expect(cli(['status', '--bogus'])).rejects.toThrow(/Unknown option/);
    await expect(cli(['osc7501', 'maybe'])).rejects.toThrow(/Usage:/);
    await expect(cli(['herdr', 'maybe'])).rejects.toThrow(/Usage:/);
  });
});
