import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { HELP, runCli } from '../cli.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-cli-'))
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string[]} argv @param {Record<string, any>} [extra] */
async function cli(argv, extra = {}) {
  /** @type {string[]} */
  const lines = [];
  const code = await runCli(argv, {
    rootDir: root,
    out: (line) => lines.push(line),
    ...extra,
  });
  return { code, lines, text: lines.join('\n') };
}

describe('remote cli', () => {
  test('prints Usage help for empty args, help, and --help', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = await cli(args);
      expect(res.code).toBe(0);
      expect(res.text).toBe(HELP);
      expect(res.text.startsWith('Usage:')).toBe(true);
    }
  });

  test('manages osc7501 and status defaults', async () => {
    expect((await cli(['status'])).text).toContain(
      'OSC 7501: off | Web Push: off'
    );
    expect((await cli(['osc7501', 'on'])).text).toContain('turned on');
  });

  test('exercises full vapid and push workflow including dry-run and test delivery', async () => {
    await expect(cli(['push', 'on'])).rejects.toThrow(/initializing VAPID/);
    await expect(cli(['vapid', 'show'])).rejects.toThrow(/not initialized/);

    const initRes = await cli([
      'vapid',
      'init',
      '--subject=mailto:me@example.com',
    ]);
    expect(initRes.text).toContain('Initialized VAPID keypair');
    await expect(cli(['vapid', 'init'])).rejects.toThrow(/already exists/);

    const showJson = JSON.parse((await cli(['vapid', 'show', '--json'])).text);
    expect(showJson.subject).toBe('mailto:me@example.com');

    expect((await cli(['push', 'list'])).text).toBe(
      'No push subscriptions registered.'
    );
    expect((await cli(['push', 'on'])).text).toContain('turned on');

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const p256dh = ecdh
      .getPublicKey(undefined, 'uncompressed')
      .toString('base64url');
    const auth = crypto.randomBytes(16).toString('base64url');

    const addRes = await cli([
      'push',
      'add',
      '--endpoint',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      '--p256dh',
      p256dh,
      '--auth',
      auth,
      '--label',
      'Android',
      '--json',
    ]);
    const subId = JSON.parse(addRes.text).id;

    expect((await cli(['push', 'list'])).text).toContain('Android');
    expect((await cli(['status', '--json'])).text).toContain(subId);

    const dryTest = await cli(['push', 'test', '--dry-run']);
    expect(dryTest.text).toContain('[dry-run] Would send');

    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
    const sendTest = await cli(['push', 'test', '--title', 'Ping'], {
      fetchFn,
    });
    expect(sendTest.text).toBe('Push test: sent=1, failed=0, pruned=0.');

    expect((await cli(['push', 'remove', subId])).text).toContain(
      'Removed push subscription'
    );
    await expect(cli(['push', 'remove', subId])).rejects.toThrow(
      /No subscription/
    );
  });

  test('validates invalid options and subcommands', async () => {
    await expect(cli(['unknown'])).rejects.toThrow(/Unknown remote command/);
    await expect(cli(['status', '--bad'])).rejects.toThrow(/Unknown option/);
    await expect(cli(['osc7501', 'maybe'])).rejects.toThrow(/Usage:/);
    await expect(cli(['vapid', 'bad'])).rejects.toThrow(
      /Unknown vapid subcommand/
    );
    await expect(cli(['push', 'bad'])).rejects.toThrow(
      /Unknown push subcommand/
    );
    await expect(cli(['push', 'add', '--endpoint'])).rejects.toThrow(
      /needs a value/
    );
    await expect(cli(['push', 'add'])).rejects.toThrow(
      /Missing required flags/
    );
    await expect(cli(['push', 'remove'])).rejects.toThrow(
      /Subscription id is required/
    );
  });
});
