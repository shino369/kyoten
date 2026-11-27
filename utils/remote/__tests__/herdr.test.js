import {
  herdrActionForEvent,
  reportHerdrStatus,
  resolveHerdrEnv,
  shouldReportHerdr,
} from '../herdr.js';

describe('herdr native status reporting', () => {
  const validEnv = {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-42',
    HERDR_BIN_PATH: '/usr/local/bin/herdr',
  };

  test('resolveHerdrEnv validates required env vars and blocks flag/control injection', () => {
    expect(resolveHerdrEnv({})).toBeNull();
    expect(resolveHerdrEnv({ ...validEnv, HERDR_ENV: '0' })).toBeNull();
    expect(resolveHerdrEnv({ ...validEnv, HERDR_PANE_ID: '' })).toBeNull();
    expect(resolveHerdrEnv({ ...validEnv, HERDR_BIN_PATH: '' })).toBeNull();
    expect(
      resolveHerdrEnv({ ...validEnv, HERDR_PANE_ID: '--evil' })
    ).toBeNull();
    expect(resolveHerdrEnv({ ...validEnv, HERDR_PANE_ID: 'p\n1' })).toBeNull();
    expect(
      resolveHerdrEnv({ ...validEnv, HERDR_BIN_PATH: '/bin/herdr\0x' })
    ).toBeNull();
    expect(resolveHerdrEnv(validEnv)).toEqual({
      binPath: '/usr/local/bin/herdr',
      paneId: 'pane-42',
    });
  });

  test('shouldReportHerdr targets agy and dsh by default and respects KYOTEN_HERDR_ALL=1', () => {
    expect(shouldReportHerdr('agy', validEnv)).toBe(true);
    expect(shouldReportHerdr('dsh', validEnv)).toBe(true);
    expect(shouldReportHerdr('claude', validEnv)).toBe(false);
    expect(shouldReportHerdr('codex', validEnv)).toBe(false);
    expect(
      shouldReportHerdr('claude', { ...validEnv, KYOTEN_HERDR_ALL: '1' })
    ).toBe(true);
    expect(shouldReportHerdr('agy', {})).toBe(false);
  });

  test('herdrActionForEvent maps lifecycle states and releases on SessionEnd', () => {
    expect(
      herdrActionForEvent({ hook_event_name: 'SessionEnd' }, 'agy')
    ).toEqual({ action: 'release' });
    expect(
      herdrActionForEvent({ hook_event_name: 'UserPromptSubmit' }, 'dsh')
    ).toEqual({ action: 'report', state: 'working' });
    expect(
      herdrActionForEvent(
        { hook_event_name: 'Stop', terminationReason: 'NO_TOOL_CALL' },
        'agy'
      )
    ).toEqual({ action: 'report', state: 'idle' });
    expect(
      herdrActionForEvent(
        {
          hook_event_name: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: false,
        },
        'agy'
      )
    ).toEqual({ action: 'report', state: 'working' });
    expect(
      herdrActionForEvent(
        { hook_event_name: 'Stop', terminationReason: 'MAX_TURNS' },
        'agy'
      )
    ).toEqual({ action: 'report', state: 'blocked' });
    expect(
      herdrActionForEvent({ hook_event_name: 'PreToolUse' }, 'agy')
    ).toBeNull();
  });

  test('reportHerdrStatus invokes herdr pane report-agent / release-agent and fails open', () => {
    /** @type {Array<{ bin: string, args: string[] }>} */
    const calls = [];
    /** @type {any} */
    const fakeSpawn = (
      /** @type {string} */ bin,
      /** @type {string[]} */ args
    ) => {
      calls.push({ bin, args });
      return { status: 0 };
    };

    expect(
      reportHerdrStatus(
        { hook_event_name: 'PreInvocation', invocationNum: 0 },
        'agy',
        { enabled: false, env: validEnv, spawnSyncFn: fakeSpawn }
      )
    ).toBe(false);
    expect(
      reportHerdrStatus(
        { hook_event_name: 'PreInvocation', invocationNum: 0 },
        'agy',
        { enabled: true, env: validEnv, spawnSyncFn: fakeSpawn }
      )
    ).toBe(true);
    expect(
      reportHerdrStatus({ hook_event_name: 'SessionEnd' }, 'dsh', {
        enabled: true,
        env: validEnv,
        spawnSyncFn: fakeSpawn,
      })
    ).toBe(true);
    expect(
      reportHerdrStatus({ hook_event_name: 'PreToolUse' }, 'agy', {
        enabled: true,
        env: validEnv,
        spawnSyncFn: fakeSpawn,
      })
    ).toBe(false);

    expect(calls).toEqual([
      {
        bin: '/usr/local/bin/herdr',
        args: [
          'pane',
          'report-agent',
          'pane-42',
          '--source',
          'kyoten',
          '--agent',
          'agy',
          '--state',
          'working',
        ],
      },
      {
        bin: '/usr/local/bin/herdr',
        args: ['pane', 'release-agent', 'pane-42'],
      },
    ]);

    expect(
      reportHerdrStatus({ hook_event_name: 'Stop' }, 'agy', {
        enabled: true,
        env: validEnv,
        spawnSyncFn: /** @type {any} */ (
          () => {
            throw new Error('ENOENT');
          }
        ),
      })
    ).toBe(false);
    expect(
      reportHerdrStatus({ hook_event_name: 'Stop' }, 'agy', {
        enabled: true,
        env: validEnv,
        spawnSyncFn: /** @type {any} */ (() => ({ status: 1 })),
      })
    ).toBe(false);
  });
});
