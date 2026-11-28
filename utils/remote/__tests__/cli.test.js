import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELP, runCli } from '../cli.js';

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

/** @param {string[]} argv */
async function cli(argv) {
  /** @type {string[]} */
  const lines = [];
  const code = await runCli(argv, {
    rootDir: tmp,
    out: (line) => lines.push(line),
  });
  return { code, lines, text: lines.join('\n') };
}

describe('remote cli (osc7501 & herdr)', () => {
  test('prints Usage help with no args, help, or --help', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = await cli(args);
      expect(res.code).toBe(0);
      expect(res.text).toBe(HELP);
      expect(res.text.startsWith('Usage:')).toBe(true);
    }
  });

  test('toggles osc7501 and herdr and reports status', async () => {
    expect((await cli(['status'])).text).toBe('OSC 7501: off\nHerdr:    off');
    expect((await cli(['osc7501', 'on'])).text).toContain('turned on');
    expect((await cli(['herdr', 'on'])).text).toContain('turned on');
    expect(JSON.parse((await cli(['status', '--json'])).text)).toEqual({
      osc7501: true,
      herdr: true,
    });
    expect((await cli(['status'])).text).toBe('OSC 7501: on\nHerdr:    on');
    expect((await cli(['osc7501', 'off'])).text).toContain('turned off');
    expect((await cli(['herdr', 'off'])).text).toContain('turned off');
  });

  test('rejects invalid commands and options', async () => {
    await expect(cli(['unknown'])).rejects.toThrow(/Unknown remote command/);
    await expect(cli(['status', '--bogus'])).rejects.toThrow(/Unknown option/);
    await expect(cli(['osc7501', 'maybe'])).rejects.toThrow(/Usage:/);
    await expect(cli(['herdr', 'maybe'])).rejects.toThrow(/Usage:/);
  });
});
