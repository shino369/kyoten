import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTRACT_ENV } from '../../memory/queue.js';
import { writeRemoteConfig } from '../config.js';
import { handleHook, runHook } from '../hook.js';

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

/** @param {boolean} isTTY */
function makeStream(isTTY = true) {
  /** @type {string[]} */
  const chunks = [];
  return {
    isTTY,
    write: (/** @type {string} */ chunk) => chunks.push(chunk),
    output: () => chunks.join(''),
  };
}

describe('remote hook (osc7501)', () => {
  test('is silent and side-effect-free when unconfigured', () => {
    const stream = makeStream(true);
    expect(
      handleHook(
        { hook_event_name: 'Stop' },
        { harness: 'claude', rootDir: tmp, env: {}, stream }
      )
    ).toBeNull();
    expect(stream.output()).toBe('');

    expect(
      handleHook(
        { hookEventName: 'Stop' },
        { harness: 'agy', rootDir: tmp, env: {}, stream }
      )
    ).toEqual({ decision: 'allow' });
    expect(
      handleHook(
        { hookEventName: 'PreInvocation' },
        { harness: 'agy', rootDir: tmp, env: {}, stream }
      )
    ).toBeNull();
  });

  test('skips nested memory extraction or skip-agent calls', () => {
    writeRemoteConfig(tmp, { version: 1, osc7501: true });
    const stream = makeStream(true);

    handleHook(
      { hook_event_name: 'Stop' },
      {
        harness: 'claude',
        rootDir: tmp,
        env: { [EXTRACT_ENV]: '1' },
        stream,
      }
    );
    handleHook(
      { hook_event_name: 'Stop', agent_type: 'reviewer' },
      { harness: 'claude', rootDir: tmp, env: {}, stream }
    );
    expect(stream.output()).toBe('');
  });

  test('emits OSC 7501 via KYOTEN_OSC7501=1 or config.osc7501=true', () => {
    const stream = makeStream(true);
    handleHook(
      { hook_event_name: 'UserPromptSubmit' },
      { harness: 'claude', rootDir: tmp, env: { KYOTEN_OSC7501: '1' }, stream }
    );
    expect(stream.output()).toBe('\x1b]7501;state=working:app=kyoten\x1b\\');

    writeRemoteConfig(tmp, { version: 1, osc7501: true });
    const stream2 = makeStream(true);
    handleHook(
      {
        hookEventName: 'Stop',
        terminationReason: 'MAX_TURNS',
      },
      { harness: 'agy', rootDir: tmp, env: {}, stream: stream2 }
    );
    expect(stream2.output()).toBe('\x1b]7501;state=blocked:app=kyoten\x1b\\');
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
});
