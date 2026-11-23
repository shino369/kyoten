import fs from 'fs';
import os from 'os';
import path from 'path';
import { runConfig } from '../config-cmd.js';

/** @type {string} */
let tmp;
/** @type {string} */
let file;
/** @type {string[]} */
let out;
/** @type {string[]} */
let err;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cfgcmd-'));
  file = path.join(tmp, 'cfg', 'config.json');
  out = [];
  err = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeHome(dir = path.join(tmp, 'home')) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"kyoten"}');
  fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
  return dir;
}

function readBack() {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
}

/**
 * @param {string[]} args
 * @param {object} [config]
 */
function run(args, config = readBack()) {
  return runConfig({
    args,
    file,
    config,
    cwd: tmp,
    homedir: tmp,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
}

describe('runConfig show', () => {
  test('should print the path and the JSON', () => {
    run([], { addDir: true });

    expect(out[0]).toBe(file);
    expect(JSON.parse(out[1])).toEqual({ addDir: true });
  });

  test('should print only the path for path', () => {
    run(['path']);

    expect(out).toEqual([file]);
  });
});

describe('runConfig set, get, unset', () => {
  test('should round trip addDir as a boolean', () => {
    run(['set', 'addDir', 'false']);
    run(['get', 'addDir']);

    expect(readBack()).toEqual({ addDir: false });
    expect(out).toEqual(['false']);
    expect(err[0]).toContain('addDir saved');
  });

  test('should store addDir true', () => {
    run(['set', 'addDir', 'true']);

    expect(readBack()).toEqual({ addDir: true });
  });

  test('should reject a bad addDir value', () => {
    expect(() => run(['set', 'addDir', 'maybe'])).toThrow(/true or false/);
  });

  test('should store every word of args.<agent>, dashes included', () => {
    run(['set', 'args.dscc', '--dangerously-skip-permissions', '-x', 'y']);
    run(['get', 'args.dscc']);

    expect(readBack()).toEqual({
      args: { dscc: ['--dangerously-skip-permissions', '-x', 'y'] },
    });
    expect(JSON.parse(out[0])).toHaveLength(3);
  });

  test('should refuse an unknown agent', () => {
    expect(() => run(['set', 'args.nope', 'x'])).toThrow(/not an agent/);
  });

  test('should refuse args without a word', () => {
    expect(() => run(['set', 'args.claude'])).toThrow(/at least one/);
  });

  test('should set home to an existing workspace', () => {
    const home = makeHome();

    run(['set', 'home', home]);
    run(['get', 'home']);

    expect(readBack()).toEqual({ home });
    expect(out).toEqual([home]);
  });

  test('should expand ~ for home', () => {
    const home = makeHome();

    run(['set', 'home', '~/home']);

    expect(readBack()).toEqual({ home });
  });

  test('should refuse a home that is not a workspace', () => {
    expect(() => run(['set', 'home', path.join(tmp, 'nothing')])).toThrow(
      /not a kyoten workspace/
    );
  });

  test('should refuse a wrong number of values', () => {
    expect(() => run(['set', 'home', 'a', 'b'])).toThrow(/exactly one/);
    expect(() => run(['set', 'addDir'])).toThrow(/exactly one value/);
  });

  test('should unset agents and drop an empty args', () => {
    run(['set', 'args.dscc', '-a']);
    run(['set', 'args.codex', '-b']);
    run(['unset', 'args.dscc']);
    run(['unset', 'args.codex']);

    expect(readBack()).toEqual({});
    expect(err.at(-1)).toContain('removed');
  });

  test('should keep other keys on unset', () => {
    run(['set', 'addDir', 'true']);
    run(['set', 'args.codex', '-b']);
    run(['unset', 'addDir']);

    expect(readBack()).toEqual({ args: { codex: ['-b'] } });
  });

  test('should unset home', () => {
    const home = makeHome();
    run(['set', 'home', home]);

    run(['unset', 'home']);

    expect(readBack()).toEqual({});
  });

  test('should say nothing changed when unsetting a missing key', () => {
    run(['unset', 'home']);

    expect(err[0]).toContain('nothing changed');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('should fail get for a missing key', () => {
    expect(() => run(['get', 'home'])).toThrow(/not set/);
  });
});

describe('runConfig errors', () => {
  test.each([
    [['bogus']],
    [['get']],
    [['set']],
    [['get', 'nope']],
    [['get', 'home', 'x']],
    [['path', 'x']],
  ])('should fail with a Fix line for %j', (args) => {
    expect(() => run(args)).toThrow(/Fix:/);
  });
});
