import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultTerminalPath,
  emitOsc7501,
  formatOsc7501,
  stateForHookEvent,
  writeToTerminal,
} from '../osc7501.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-osc7501-'))
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('osc7501', () => {
  test('formatOsc7501 formats valid states and strips control chars and delimiters', () => {
    expect(formatOsc7501('working')).toBe(
      '\x1b]7501;state=working:app=kyoten\x1b\\'
    );
    expect(
      formatOsc7501('blocked', {
        app: 'kyo\x07ten:test;',
        title: 'fix\nbug;now:please',
      })
    ).toBe(
      '\x1b]7501;state=blocked:app=kyo ten test:title=fix bug now please\x1b\\'
    );
    expect(formatOsc7501('idle', { app: '::;' })).toBe(
      '\x1b]7501;state=idle:app=kyoten\x1b\\'
    );
    expect(() => formatOsc7501(/** @type {any} */ ('bogus'))).toThrow(
      /Invalid OSC 7501 state/
    );
  });

  test('stateForHookEvent maps lifecycle, Notification, StopFailure, fullyIdle, and stop_hook_active', () => {
    expect(
      stateForHookEvent({ hook_event_name: 'SessionStart' }, 'claude')
    ).toBe('idle');
    expect(stateForHookEvent({ hook_event_name: 'SessionEnd' }, 'codex')).toBe(
      'idle'
    );
    expect(
      stateForHookEvent({ hook_event_name: 'UserPromptSubmit' }, 'dsh')
    ).toBe('working');
    expect(
      stateForHookEvent(
        {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
        },
        'claude'
      )
    ).toBe('blocked');
    expect(
      stateForHookEvent(
        { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
        'claude'
      )
    ).toBe('blocked');
    expect(
      stateForHookEvent({ hook_event_name: 'Notification' }, 'claude')
    ).toBe('blocked');
    expect(
      stateForHookEvent(
        { hook_event_name: 'Notification', notification_type: 'auth_success' },
        'claude'
      )
    ).toBeNull();
    expect(
      stateForHookEvent({ hook_event_name: 'StopFailure' }, 'claude')
    ).toBe('blocked');
    expect(
      stateForHookEvent(
        { hook_event_name: 'PreInvocation', invocationNum: 0 },
        'agy'
      )
    ).toBe('working');
    expect(
      stateForHookEvent(
        { hook_event_name: 'PreInvocation', invocationNum: 2 },
        'agy'
      )
    ).toBeNull();
    expect(stateForHookEvent({ hook_event_name: 'Stop' }, 'claude')).toBe(
      'done'
    );
    expect(
      stateForHookEvent(
        { hook_event_name: 'Stop', stop_hook_active: true },
        'claude'
      )
    ).toBeNull();
    expect(
      stateForHookEvent(
        { hook_event_name: 'Stop', continuationActive: true },
        'agy'
      )
    ).toBeNull();
    expect(
      stateForHookEvent(
        {
          hook_event_name: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: false,
        },
        'agy'
      )
    ).toBe('working');
    expect(
      stateForHookEvent(
        {
          hook_event_name: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
        },
        'agy'
      )
    ).toBe('done');
    expect(
      stateForHookEvent(
        { hook_event_name: 'Stop', terminationReason: 'TOOL_BLOCKED' },
        'agy'
      )
    ).toBe('blocked');
    expect(
      stateForHookEvent({ hook_event_name: 'PreToolUse' }, 'claude')
    ).toBeNull();
  });

  test('defaultTerminalPath picks env override, POSIX /dev/tty, or Windows CONOUT$', () => {
    expect(
      defaultTerminalPath({
        env: { KYOTEN_OSC7501_TTY: '/tmp/fake-tty' },
        platform: 'linux',
      })
    ).toBe('/tmp/fake-tty');
    expect(defaultTerminalPath({ env: {}, platform: 'darwin' })).toBe(
      '/dev/tty'
    );
    expect(defaultTerminalPath({ env: {}, platform: 'win32' })).toBe(
      '\\\\.\\CONOUT$'
    );
  });

  test('emitOsc7501 writes directly to terminal path (not piped stderr) and fails open', () => {
    const ttyFile = path.join(tmp, 'tty-sink');
    expect(emitOsc7501('working', { enabled: false, ttyPath: ttyFile })).toBe(
      false
    );
    expect(emitOsc7501(null, { enabled: true, ttyPath: ttyFile })).toBe(false);
    expect(emitOsc7501('working', { enabled: true, ttyPath: ttyFile })).toBe(
      true
    );
    expect(fs.readFileSync(ttyFile, 'utf-8')).toBe(
      '\x1b]7501;state=working:app=kyoten\x1b\\'
    );

    const chunks = /** @type {string[]} */ ([]);
    expect(
      emitOsc7501('blocked', {
        enabled: true,
        writer: (c) => chunks.push(c),
      })
    ).toBe(true);
    expect(chunks).toEqual(['\x1b]7501;state=blocked:app=kyoten\x1b\\']);

    expect(
      emitOsc7501('done', {
        enabled: true,
        writer: () => {
          throw new Error('EPIPE');
        },
      })
    ).toBe(false);
    expect(writeToTerminal(path.join(tmp, 'missing', 'tty'), 'x')).toBe(false);
  });
});
