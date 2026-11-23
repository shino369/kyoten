import fs from 'fs';
import os from 'os';
import path from 'path';
import { readConfig } from '../../memory/config.js';
import {
  MEMORY_CONFIG,
  memoryCheck,
  pauseSaving,
  savingState,
} from '../memory.js';

/** @type {string} */
let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-memory-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const file = () => path.join(home, MEMORY_CONFIG);

describe('pauseSaving', () => {
  test('should write the setting pnpm memory reads as off', () => {
    pauseSaving(home);

    expect(readConfig(path.join(home, 'memory')).off).toBe(true);
  });

  test('should keep the other settings', () => {
    fs.mkdirSync(path.dirname(file()));
    fs.writeFileSync(file(), JSON.stringify({ budget: 2000 }));

    pauseSaving(home);

    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({
      budget: 2000,
      off: true,
    });
  });

  test.each([['not json'], ['[1]'], ['null']])(
    'should refuse a config file holding %j',
    (text) => {
      fs.mkdirSync(path.dirname(file()));
      fs.writeFileSync(file(), text);

      expect(() => pauseSaving(home)).toThrow(
        /is not a JSON object\.\nFix: correct or move it/
      );
    }
  );
});

describe('savingState', () => {
  test('should be on without a config file', () => {
    expect(savingState(home)).toEqual({ off: false, agent: null });
  });

  test('should read off and the memory agent', () => {
    fs.mkdirSync(path.dirname(file()));
    fs.writeFileSync(
      file(),
      JSON.stringify({ off: true, extractAgent: 'codex' })
    );

    expect(savingState(home)).toEqual({ off: true, agent: 'codex' });
  });

  test('should ignore a memory agent that is not a name', () => {
    fs.mkdirSync(path.dirname(file()));
    fs.writeFileSync(file(), JSON.stringify({ off: 'yes', extractAgent: 1 }));

    expect(savingState(home)).toEqual({ off: false, agent: null });
  });
});

describe('memoryCheck', () => {
  test('should say how to opt in when saving is off', () => {
    pauseSaving(home);

    expect(memoryCheck(home)).toEqual({
      id: 'memory',
      status: 'ok',
      detail: 'automatic saving is off (opt in: kyoten run memory on)',
    });
  });

  test('should name the cost and the agent when saving is on', () => {
    expect(memoryCheck(home)).toEqual({
      id: 'memory',
      status: 'ok',
      detail:
        "automatic saving is on: each session end runs one background agent call (the session's own CLI); opt out: kyoten run memory off",
    });
  });

  test('should warn about an unreadable config file', () => {
    fs.mkdirSync(path.dirname(file()));
    fs.writeFileSync(file(), '{');

    expect(memoryCheck(home)).toMatchObject({
      id: 'memory',
      status: 'warn',
      fix: 'correct or move it, then run kyoten run memory off (or on)',
    });
  });
});
