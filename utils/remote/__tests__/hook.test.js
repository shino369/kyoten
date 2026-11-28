import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACT_ENV } from '../../memory/queue.js';
import { writeRemoteConfig } from '../config.js';
import { handleHook, runHook } from '../hook.js';

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

describe('remote hook (osc7501 & herdr)', () => {
  test('is silent and side-effect-free when unconfigured', () => {
    const chunks = /** @type {string[]} */ ([]);
    const writer = (/** @type {string} */ c) => chunks.push(c);
    expect(
      handleHook(
        { hook_event_name: 'Stop' },
        { harness: 'claude', rootDir: tmp, env: {}, writer }
      )
    ).toBeNull();
    expect(chunks).toEqual([]);

    expect(
      handleHook(
        { hookEventName: 'Stop' },
        { harness: 'agy', rootDir: tmp, env: {}, writer }
      )
    ).toEqual({ decision: 'allow' });
    expect(
      handleHook(
        { hookEventName: 'PreInvocation' },
        { harness: 'agy', rootDir: tmp, env: {}, writer }
      )
    ).toBeNull();
  });

  test('skips nested memory extraction or skip-agent calls', () => {
    writeRemoteConfig(tmp, { version: 1, osc7501: true, herdr: true });
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

  test('emits OSC 7501 via KYOTEN_OSC7501=1 or config.osc7501=true, including Notification and fullyIdle', () => {
    const ttyFile = path.join(tmp, 'tty-sink');
    handleHook(
      {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      },
      {
        harness: 'claude',
        rootDir: tmp,
        env: { KYOTEN_OSC7501: '1', KYOTEN_OSC7501_TTY: ttyFile },
      }
    );
    expect(fs.readFileSync(ttyFile, 'utf-8')).toBe(
      '\x1b]7501;state=blocked:app=kyoten\x1b\\'
    );

    writeRemoteConfig(tmp, { version: 1, osc7501: true, herdr: false });
    const chunks = /** @type {string[]} */ ([]);
    handleHook(
      {
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: false,
      },
      {
        harness: 'agy',
        rootDir: tmp,
        env: {},
        writer: (c) => chunks.push(c),
      }
    );
    expect(chunks).toEqual(['\x1b]7501;state=working:app=kyoten\x1b\\']);
  });

  test('reports status to Herdr when enabled via config or KYOTEN_HERDR=1', () => {
    /** @type {Array<{ bin: string, args: string[] }>} */
    const calls = [];
    const env = {
      KYOTEN_HERDR: '1',
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'p-9',
      HERDR_BIN_PATH: '/bin/herdr',
    };
    handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0 },
      {
        harness: 'agy',
        rootDir: tmp,
        env,
        spawnSyncFn: /** @type {any} */ (
          (/** @type {string} */ bin, /** @type {string[]} */ args) => {
            calls.push({ bin, args });
            return { status: 0 };
          }
        ),
      }
    );
    expect(calls).toEqual([
      {
        bin: '/bin/herdr',
        args: [
          'pane',
          'report-agent',
          'p-9',
          '--source',
          'kyoten',
          '--agent',
          'agy',
          '--state',
          'working',
        ],
      },
    ]);
  });

  test('runHook always fails open with protocol-valid output', () => {
    expect(runHook('not-json', { harness: 'claude' })).toBe('');
    expect(runHook('not-json', { harness: 'agy' })).toBe('{}');
    expect(
      runHook(JSON.stringify({ hookEventName: 'Stop' }), {
        harness: 'agy',
        rootDir: tmp,
        env: {},
      })
    ).toBe('{"decision":"allow"}');
    expect(
      runHook(JSON.stringify({ hookEventName: 'PreInvocation' }), {
        harness: 'agy',
        rootDir: tmp,
        env: {},
      })
    ).toBe('{}');
    expect(
      runHook(JSON.stringify({ hook_event_name: 'Stop' }), {
        harness: 'claude',
        rootDir: /** @type {any} */ (null),
      })
    ).toBe('');
  });

  test('process boundary: delivers OSC 7501 with piped stdout/stderr and keeps agy protocol valid', () => {
    const ttyFile = path.join(tmp, 'child-tty-sink');
    const codexRes = spawnSync(
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
    expect(codexRes.status).toBe(0);
    expect(codexRes.stdout).toBe('');
    expect(codexRes.stderr).toBe('');
    expect(fs.readFileSync(ttyFile, 'utf-8')).toBe(
      '\x1b]7501;state=working:app=kyoten\x1b\\'
    );

    const agyRes = spawnSync(
      process.execPath,
      [HOOK_SCRIPT, '--harness', 'agy'],
      {
        input: JSON.stringify({
          hookEventName: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
        }),
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
    expect(agyRes.status).toBe(0);
    expect(agyRes.stdout).toBe('{"decision":"allow"}');
    expect(agyRes.stderr).toBe('');
    expect(fs.readFileSync(ttyFile, 'utf-8')).toBe(
      '\x1b]7501;state=done:app=kyoten\x1b\\'
    );

    const badJsonAgy = spawnSync(
      process.execPath,
      [HOOK_SCRIPT, '--harness', 'agy'],
      {
        input: '{bad',
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    expect(badJsonAgy.status).toBe(0);
    expect(badJsonAgy.stdout).toBe('{}');
  });
});
