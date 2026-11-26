import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { EXTRACT_ENV } from '../../memory/queue.js';
import {
  addSubscription,
  writeRemoteConfig,
  DEFAULT_REMOTE_CONFIG,
} from '../config.js';
import {
  NOTIFY_WORKER_SCRIPT,
  handleHook,
  kickNotify,
  runHook,
} from '../hook.js';
import { NOTIFY_PAYLOAD_ENV, deliverNotifications } from '../notify-worker.js';
import { generateVapidKeys } from '../webpush.js';

const NOW = new Date('2026-11-27T03:00:00.000Z');
/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-hook-'))
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedPushConfig({
  osc7501 = true,
  pushEnabled = true,
  quietMs = 5000,
} = {}) {
  const vapid = generateVapidKeys();
  writeRemoteConfig(root, {
    ...DEFAULT_REMOTE_CONFIG,
    osc7501,
    pushEnabled,
    vapid,
    quietMs,
  });
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return addSubscription(root, {
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/sub-a',
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
    label: 'phone',
    now: NOW,
  });
}

describe('remote hook and notify-worker', () => {
  test('is silent with no config and handles protocol defaults across harnesses', () => {
    const kick = vi.fn();
    expect(
      runHook(JSON.stringify({ hook_event_name: 'SessionStart' }), {
        rootDir: root,
        kick,
      })
    ).toBe('');
    expect(
      runHook(JSON.stringify({ hookEventName: 'PreInvocation' }), {
        harness: 'agy',
        rootDir: root,
        kick,
      })
    ).toBe('{}');
    expect(
      runHook(JSON.stringify({ hookEventName: 'Stop' }), {
        harness: 'agy',
        rootDir: root,
        kick,
      })
    ).toBe('{"decision":"allow"}');
    expect(runHook('{bad json', { harness: 'agy', rootDir: root, kick })).toBe(
      '{}'
    );
    expect(
      runHook('{bad json', { harness: 'claude', rootDir: root, kick })
    ).toBe('');
    expect(kick).not.toHaveBeenCalled();
  });

  test('skips reviewer/verifier and EXTRACT_ENV runs', () => {
    seedPushConfig();
    const kick = vi.fn();
    const chunks = /** @type {string[]} */ ([]);
    const stream = {
      isTTY: true,
      write: (/** @type {string} */ c) => chunks.push(c),
    };

    handleHook(
      { hook_event_name: 'Stop', agent_type: 'reviewer' },
      { rootDir: root, stream, kick, now: NOW }
    );
    handleHook(
      { hook_event_name: 'Stop' },
      { rootDir: root, stream, kick, now: NOW, env: { [EXTRACT_ENV]: '1' } }
    );

    expect(chunks).toEqual([]);
    expect(kick).not.toHaveBeenCalled();
  });

  test('emits OSC 7501 via KYOTEN_OSC7501=1 or config and dispatches throttled push on Stop', () => {
    const chunks = /** @type {string[]} */ ([]);
    const stream = {
      isTTY: true,
      write: (/** @type {string} */ c) => chunks.push(c),
    };
    const kick = vi.fn();

    // Env-only OSC 7501 works without config file
    handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0 },
      {
        harness: 'agy',
        rootDir: root,
        stream,
        kick,
        env: { KYOTEN_OSC7501: '1' },
      }
    );
    expect(chunks).toEqual(['\x1b]7501;state=working:app=kyoten\x1b\\']);
    expect(kick).not.toHaveBeenCalled();

    // Full config: Stop emits OSC 7501 done/blocked and kicks worker once within quietMs
    seedPushConfig({ osc7501: true, pushEnabled: true, quietMs: 5000 });
    handleHook(
      { hookEventName: 'Stop', fullyIdle: false },
      { harness: 'agy', rootDir: root, stream, kick, now: NOW, hostname: 'box' }
    );
    expect(kick).not.toHaveBeenCalled();

    handleHook(
      {
        hookEventName: 'Stop',
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      },
      { harness: 'agy', rootDir: root, stream, kick, now: NOW, hostname: 'box' }
    );
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick.mock.calls[0][0].alert).toMatchObject({
      harness: 'agy',
      event: 'Stop',
      host: 'box',
    });

    // Throttled 2s later (< quietMs 5000)
    handleHook(
      { hook_event_name: 'Stop' },
      {
        harness: 'claude',
        rootDir: root,
        stream,
        kick,
        now: new Date(NOW.getTime() + 2000),
      }
    );
    expect(kick).toHaveBeenCalledTimes(1);

    // Allowed 6s later
    handleHook(
      { hook_event_name: 'Stop' },
      {
        harness: 'claude',
        rootDir: root,
        stream,
        kick,
        now: new Date(NOW.getTime() + 6000),
      }
    );
    expect(kick).toHaveBeenCalledTimes(2);
  });

  test('deliverNotifications sends encrypted alerts and prunes 410 Gone subscriptions', async () => {
    const sub1 = seedPushConfig();
    const ecdh2 = crypto.createECDH('prime256v1');
    ecdh2.generateKeys();
    const sub2 = addSubscription(root, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-b',
      p256dh: ecdh2
        .getPublicKey(undefined, 'uncompressed')
        .toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
      label: 'old-phone',
      now: NOW,
    });

    const fetchFn = vi.fn(async (url) => {
      if (String(url).includes('sub-a'))
        return new Response(null, { status: 201 });
      return new Response(null, { status: 410 });
    });

    const res = await deliverNotifications({
      rootDir: root,
      alert: {
        title: 't',
        body: 'b',
        tag: 'tag',
        event: 'Stop',
        harness: 'agy',
        host: 'pc',
        timestamp: NOW.toISOString(),
      },
      fetchFn: /** @type {any} */ (fetchFn),
      now: NOW,
    });

    expect(res).toEqual({ sent: 1, failed: 0, pruned: 1 });
    const after = JSON.parse(
      fs.readFileSync(
        path.join(root, 'memory', 'remote', 'config.json'),
        'utf-8'
      )
    );
    expect(after.subscriptions.map((/** @type {any} */ s) => s.id)).toEqual([
      sub1.id,
    ]);
    expect(sub2.id).not.toBe(sub1.id);

    const failFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const failRes = await deliverNotifications({
      rootDir: root,
      alert: {
        title: 't',
        body: 'b',
        tag: 'tag',
        event: 'Stop',
        harness: 'agy',
        host: 'pc',
        timestamp: NOW.toISOString(),
      },
      fetchFn: /** @type {any} */ (failFetch),
      now: NOW,
    });
    expect(failRes).toEqual({ sent: 0, failed: 1, pruned: 0 });

    const emptyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kyoten-remote-empty-')
    );
    try {
      expect(
        await deliverNotifications({
          rootDir: emptyRoot,
          alert: {
            title: 't',
            body: 'b',
            tag: 'tag',
            event: 'Stop',
            harness: 'agy',
            host: 'pc',
            timestamp: NOW.toISOString(),
          },
          fetchFn: /** @type {any} */ (failFetch),
        })
      ).toEqual({ sent: 0, failed: 0, pruned: 0 });
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test('kickNotify spawns detached notify-worker with EXTRACT_ENV and payload', () => {
    const unref = vi.fn();
    const on = vi.fn();
    const spawn = vi.fn(() => /** @type {any} */ ({ on, unref }));
    const alert = {
      title: 'done',
      body: 'ok',
      tag: 'kyoten-agy-stop',
      event: 'Stop',
      harness: 'agy',
      host: 'box',
      timestamp: NOW.toISOString(),
    };

    kickNotify({
      rootDir: root,
      alert,
      spawn: /** @type {any} */ (spawn),
      execPath: 'node',
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = /** @type {any[]} */ (spawn.mock.calls[0]);
    expect(bin).toBe('node');
    expect(args).toEqual([NOTIFY_WORKER_SCRIPT]);
    expect(opts.detached).toBe(true);
    expect(opts.env[EXTRACT_ENV]).toBe('1');
    expect(JSON.parse(opts.env[NOTIFY_PAYLOAD_ENV])).toEqual({
      rootDir: root,
      alert,
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
