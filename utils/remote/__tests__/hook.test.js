import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { EXTRACT_ENV } from '../../memory/queue.js';
import {
  DEFAULT_REMOTE_CONFIG,
  addSubscription,
  readRemoteConfig,
  updateRemoteConfig,
  writeRemoteConfig,
} from '../config.js';
import {
  NOTIFY_WORKER_SCRIPT,
  handleHook,
  kickNotify,
  runHook,
} from '../hook.js';
import { NOTIFY_PAYLOAD_ENV, deliverNotifications } from '../notify-worker.js';
import { generateVapidKeys } from '../webpush.js';

const HOOK_SCRIPT = fileURLToPath(new URL('../hook.js', import.meta.url));

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-remote-hook-'))
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

describe('remote hook (osc7501, herdr & web push)', () => {
  test('is silent and side-effect-free when unconfigured', () => {
    const chunks = /** @type {string[]} */ ([]);
    const writer = (/** @type {string} */ c) => chunks.push(c);
    const kick = vi.fn();

    expect(
      handleHook(
        { hook_event_name: 'Stop' },
        { harness: 'claude', rootDir: tmp, env: {}, writer, kick }
      )
    ).toBeNull();
    expect(chunks).toEqual([]);
    expect(kick).not.toHaveBeenCalled();

    expect(
      handleHook(
        { hookEventName: 'Stop' },
        { harness: 'agy', rootDir: tmp, env: {}, writer, kick }
      )
    ).toEqual({ decision: 'allow' });
  });

  test('skips nested memory extraction or skip-agent calls', () => {
    writeRemoteConfig(tmp, {
      ...DEFAULT_REMOTE_CONFIG,
      osc7501: true,
      herdr: true,
    });
    const chunks = /** @type {string[]} */ ([]);
    const writer = (/** @type {string} */ c) => chunks.push(c);

    handleHook(
      { hook_event_name: 'Stop' },
      {
        harness: 'claude',
        rootDir: tmp,
        env: { [EXTRACT_ENV]: '1' },
        writer,
      }
    );
    handleHook(
      { hook_event_name: 'Stop', agent_type: 'reviewer' },
      { harness: 'claude', rootDir: tmp, env: {}, writer }
    );
    expect(chunks).toEqual([]);
  });

  test('pushes on done and Claude Notification (blocked), throttles repeats, and skips fullyIdle=false or stop_hook_active', () => {
    const vapid = generateVapidKeys();
    const sub = sampleSubscriber();
    writeRemoteConfig(tmp, {
      ...DEFAULT_REMOTE_CONFIG,
      osc7501: true,
      pushEnabled: true,
      vapid,
      quietMs: 5000,
    });
    addSubscription(tmp, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/phone1',
      ...sub,
      label: 'phone',
    });

    const kick = vi.fn();
    const t0 = new Date('2026-11-28T03:00:00.000Z');
    const t1 = new Date('2026-11-28T03:00:02.000Z');
    const t2 = new Date('2026-11-28T03:00:10.000Z');
    const t3 = new Date('2026-11-28T03:00:20.000Z');

    // agy Stop with fullyIdle=false must NOT push
    handleHook(
      {
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: false,
      },
      { harness: 'agy', rootDir: tmp, now: t0, env: {}, kick }
    );
    expect(kick).not.toHaveBeenCalled();

    // Claude Stop with stop_hook_active=true (task loop) must NOT push
    handleHook(
      { hook_event_name: 'Stop', stop_hook_active: true },
      { harness: 'claude', rootDir: tmp, now: t0, env: {}, kick }
    );
    expect(kick).not.toHaveBeenCalled();

    // Normal Stop triggers push
    handleHook(
      {
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
      },
      {
        harness: 'agy',
        rootDir: tmp,
        now: t0,
        env: {},
        kick,
        hostname: 'my-pc',
      }
    );
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick.mock.calls[0][0].alert.title).toBe('kyoten (agy) finished');

    // Within quietMs: throttled
    handleHook(
      { hook_event_name: 'Stop' },
      { harness: 'claude', rootDir: tmp, now: t1, env: {}, kick }
    );
    expect(kick).toHaveBeenCalledTimes(1);

    // After quietMs: Claude Notification (permission_prompt) triggers "needs input" push!
    handleHook(
      {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      },
      { harness: 'claude', rootDir: tmp, now: t2, env: {}, kick }
    );
    expect(kick).toHaveBeenCalledTimes(2);
    expect(kick.mock.calls[1][0].alert.title).toBe(
      'kyoten (claude) needs input'
    );

    // StopFailure also triggers "needs input" push
    handleHook(
      { hook_event_name: 'StopFailure' },
      { harness: 'claude', rootDir: tmp, now: t3, env: {}, kick }
    );
    expect(kick).toHaveBeenCalledTimes(3);
    expect(kick.mock.calls[2][0].alert.title).toBe(
      'kyoten (claude) needs input'
    );
  });

  test('kickNotify spawns detached worker with EXTRACT_ENV=1 and payload env', () => {
    const unref = vi.fn();
    const on = vi.fn();
    const spawn = vi.fn(
      (
        /** @type {string} */ _exe,
        /** @type {string[]} */ _args,
        /** @type {any} */ _opts
      ) => ({ unref, on })
    );
    const alert = {
      title: 't',
      body: 'b',
      tag: 'tag',
      event: 'Stop',
      harness: 'agy',
      host: 'pc',
      timestamp: '2026-11-28T00:00:00.000Z',
    };

    kickNotify({
      rootDir: tmp,
      alert,
      env: {},
      spawn: /** @type {any} */ (spawn),
      execPath: '/usr/bin/node',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawn.mock.calls[0];
    expect(exe).toBe('/usr/bin/node');
    expect(args).toEqual([NOTIFY_WORKER_SCRIPT]);
    expect(opts.detached).toBe(true);
    expect(opts.env[EXTRACT_ENV]).toBe('1');
    expect(JSON.parse(opts.env[NOTIFY_PAYLOAD_ENV]).alert.title).toBe('t');
    expect(unref).toHaveBeenCalled();
  });

  test('deliverNotifications enforces pushEnabled on automatic worker and prunes 410 without clobbering concurrent config changes', async () => {
    const vapid = generateVapidKeys();
    const sub1 = sampleSubscriber();
    const sub2 = sampleSubscriber();
    writeRemoteConfig(tmp, {
      ...DEFAULT_REMOTE_CONFIG,
      pushEnabled: true,
      vapid,
    });
    const added1 = addSubscription(tmp, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/ok',
      ...sub1,
    });
    addSubscription(tmp, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/gone',
      ...sub2,
    });

    const alert = {
      title: 'kyoten',
      body: 'done',
      tag: 't',
      event: 'Stop',
      harness: 'agy',
      host: 'pc',
      timestamp: '2026-11-28T00:00:00.000Z',
    };

    // Simulate user turning push off AFTER worker was spawned: automatic worker must NOT send
    updateRemoteConfig(tmp, (cfg) => ({ ...cfg, pushEnabled: false }));
    const fetchOff = vi.fn(async () => new Response(null, { status: 201 }));
    const skipped = await deliverNotifications({
      rootDir: tmp,
      alert,
      automatic: true,
      fetchFn: /** @type {any} */ (fetchOff),
    });
    expect(skipped).toEqual({ sent: 0, failed: 0, pruned: 0 });
    expect(fetchOff).not.toHaveBeenCalled();

    // Explicit push test (`automatic: false`) still sends even when pushEnabled is false
    const testRes = await deliverNotifications({
      rootDir: tmp,
      alert,
      automatic: false,
      fetchFn: /** @type {any} */ (fetchOff),
    });
    expect(testRes).toEqual({ sent: 2, failed: 0, pruned: 0 });

    // Re-enable and simulate concurrent push off + new subscription added while 410 prune runs
    updateRemoteConfig(tmp, (cfg) => ({ ...cfg, pushEnabled: true }));
    const sub3 = sampleSubscriber();
    let call = 0;
    const fetchRace = vi.fn(async (url) => {
      call += 1;
      if (call === 1) {
        // Mid-delivery, user disables push and adds a 3rd subscription!
        updateRemoteConfig(tmp, (cfg) => ({ ...cfg, pushEnabled: false }));
        addSubscription(tmp, {
          endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/new',
          ...sub3,
        });
      }
      if (String(url).endsWith('/gone')) {
        return new Response(null, { status: 410 });
      }
      return new Response(null, { status: 201 });
    });

    const raced = await deliverNotifications({
      rootDir: tmp,
      alert,
      automatic: true,
      fetchFn: /** @type {any} */ (fetchRace),
    });
    expect(raced).toEqual({ sent: 1, failed: 0, pruned: 1 });
    const finalCfg = readRemoteConfig(tmp);
    // Concurrent pushEnabled=false and new subscription MUST be preserved!
    expect(finalCfg.pushEnabled).toBe(false);
    expect(finalCfg.subscriptions).toHaveLength(2);
    expect(finalCfg.subscriptions.some((s) => s.id === added1.id)).toBe(true);
    expect(
      finalCfg.subscriptions.some((s) => s.endpoint.endsWith('/new'))
    ).toBe(true);
  });

  test('runHook and child-process boundary deliver OSC 7501 with piped stdio', () => {
    expect(runHook('not-json', { harness: 'claude' })).toBe('');
    expect(runHook('not-json', { harness: 'agy' })).toBe('{}');

    const ttyFile = path.join(tmp, 'child-tty-sink');
    const res = spawnSync(
      process.execPath,
      [HOOK_SCRIPT, '--harness', 'codex'],
      {
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          KYOTEN_OSC7501: '1',
          KYOTEN_OSC7501_TTY: ttyFile,
        },
        windowsHide: true,
      }
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(fs.readFileSync(ttyFile, 'utf-8')).toBe(
      '\x1b]7501;state=working:app=kyoten\x1b\\'
    );
  });
});
