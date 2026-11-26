import { emitOsc7501, formatOsc7501, stateForHookEvent } from '../osc7501.js';

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
    expect(() => formatOsc7501(/** @type {any} */ ('bogus'))).toThrow(
      /Invalid OSC 7501 state/
    );
  });

  test('stateForHookEvent maps all harness lifecycle events', () => {
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
        { hook_event_name: 'Stop', terminationReason: 'NO_TOOL_CALL' },
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

  test('emitOsc7501 writes only when enabled and stream is a TTY, and fails open', () => {
    const chunks = /** @type {string[]} */ ([]);
    const ttyStream = {
      isTTY: true,
      write: (/** @type {string} */ c) => chunks.push(c),
    };
    const nonTtyStream = {
      isTTY: false,
      write: (/** @type {string} */ c) => chunks.push(c),
    };
    const brokenStream = {
      isTTY: true,
      write: () => {
        throw new Error('EPIPE');
      },
    };

    expect(emitOsc7501('working', { enabled: false, stream: ttyStream })).toBe(
      false
    );
    expect(
      emitOsc7501('working', { enabled: true, stream: nonTtyStream })
    ).toBe(false);
    expect(emitOsc7501(null, { enabled: true, stream: ttyStream })).toBe(false);
    expect(emitOsc7501('done', { enabled: true, stream: brokenStream })).toBe(
      false
    );
    expect(emitOsc7501('working', { enabled: true, stream: ttyStream })).toBe(
      true
    );
    expect(chunks).toEqual(['\x1b]7501;state=working:app=kyoten\x1b\\']);
  });
});
