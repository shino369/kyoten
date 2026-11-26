import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { vi } from 'vitest';
import { crossSpawn } from '../../spawn.js';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  COMMANDS,
  MEMORY_QUESTION,
  askLine,
  defaultDeps,
  helpText,
  main,
  packageVersion,
  parseArgs,
  parseCommandArgs,
  parseFlags,
} from '../cli.js';
import { HOME_INFO } from '../home.js';

const KEY = 'sk-test-token-1234567890';
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8')
).version;
const realRun = crossSpawn();

/** @type {string} */
let tmp;
/** @type {string} */
let bin;
/** A committed kyoten source repo: the snapshot `init` installs. */
let source = '';

beforeAll(() => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cli-src-'));
  fs.mkdirSync(path.join(source, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'kyoten', version: '0.2.0' })
  );
  fs.writeFileSync(path.join(source, 'utils', 'kyoten', 'cli.js'), '// cli\n');
  fs.writeFileSync(
    path.join(source, '.gitignore'),
    '/.kyoten/\nnode_modules/\n'
  );
  const git = (/** @type {string[]} */ ...args) =>
    spawnSync(
      'git',
      ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf-8' }
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', 'init');
});

afterAll(() => {
  fs.rmSync(source, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cli-'));
  bin = path.join(tmp, 'bin');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The path `which` finds for a fake agent in `bin` on this platform. */
const agentPath = (/** @type {string} */ name) =>
  path.join(bin, process.platform === 'win32' ? `${name}.EXE` : name);

/**
 * The home's memory config as JSON, undefined without one.
 *
 * @param {string} home
 */
function readMemory(home) {
  const file = path.join(home, 'memory', 'config.json');
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf-8'))
    : undefined;
}

/** A minimal kyoten workspace. */
function makeHome(dir = path.join(tmp, 'home')) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'kyoten' })
  );
  fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
  return dir;
}

/**
 * @param {string} home
 * @param {string} version
 */
function markManaged(home, version) {
  fs.mkdirSync(path.join(home, '.kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(home, HOME_INFO),
    JSON.stringify({
      managed: true,
      version,
      sourceCommit: 'x',
      createdAt: 'then',
    })
  );
}

class FakeChild extends EventEmitter {
  kill() {
    return true;
  }
}

/**
 * Run main() with fake I/O. The fake agent exits with `exit`; git runs for
 * real (with the real PATH), pnpm is faked with `pnpmStatus`.
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, exit?: number, stdin?: any, cwd?: string, answer?: string, pnpmStatus?: number, connect?: (port: number) => Promise<boolean>, platform?: NodeJS.Platform, canRun?: (file: string) => boolean }} [options]
 */
async function run(
  argv,
  {
    env = {},
    exit = 0,
    stdin,
    cwd = tmp,
    answer = '',
    pnpmStatus = 0,
    connect = async () => false,
    platform = process.platform,
    canRun = (/** @type {string} */ file) =>
      path.dirname(file) === bin &&
      /^(claude|codex|dsh|agy)(\.exe)?$/i.test(path.basename(file)),
  } = {}
) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @type {string[]} */
  const tty = [];
  /** @type {string[]} */
  const questions = [];
  /** @type {string[][]} */
  const pnpm = [];
  const spawn = vi.fn(
    (
      /** @type {string} */ _bin,
      /** @type {string[]} */ _args,
      /** @type {any} */ _options
    ) => {
      const child = new FakeChild();
      setImmediate(() => child.emit('exit', exit, null));
      return child;
    }
  );
  /** @type {import('../../spawn.js').Spawn} */
  const runSpawn = (file, args, options) => {
    if (file === 'pnpm') {
      pnpm.push(args);
      if (args[0] === 'memory' && args[1] === 'export') {
        fs.writeFileSync(args[args.indexOf('--out') + 1], 'TAR');
      }
      // pnpmStatus fails the work, never the version check.
      if (args[0] === '--version') return { status: 0, stdout: '12.14.0\n' };
      return { status: pnpmStatus, stdout: '' };
    }
    const opts = /** @type {{ env?: NodeJS.ProcessEnv }} */ (options);
    return realRun(file, args, {
      ...options,
      env: { ...process.env, ...opts.env, PATH: process.env.PATH },
    });
  };
  const code = await main(argv, {
    // configDir reads %APPDATA% on Windows and XDG_CONFIG_HOME elsewhere.
    env: {
      PATH: bin,
      XDG_CONFIG_HOME: path.join(tmp, 'cfg'),
      APPDATA: path.join(tmp, 'cfg'),
      ...env,
    },
    cwd,
    platform,
    homedir: path.join(tmp, 'user'),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stdin: stdin ?? Readable.from([]),
    tty: { write: (/** @type {string} */ text) => tty.push(text) },
    spawn,
    signals: new EventEmitter(),
    canRun,
    registry: () => null,
    run: runSpawn,
    ask: async (question) => {
      questions.push(question);
      return answer;
    },
    now: () => new Date(2026, 10, 22, 9, 5, 7),
    root: source,
    connect,
  });
  return { code, out, err, tty, spawn, questions, pnpm };
}

describe('parseArgs', () => {
  test.each([
    [[], { agent: 'claude', args: [] }],
    [['-c'], { agent: 'claude', args: ['-c'] }],
    [['fix the bug'], { agent: 'claude', args: ['fix the bug'] }],
    [['codex', '--model', 'x'], { agent: 'codex', args: ['--model', 'x'] }],
    [['--dsh', 'tui'], { agent: 'dsh', args: ['tui'] }],
    [['dscc', '--set-key'], { agent: 'dscc', args: ['--set-key'] }],
    [['agy', 'chat'], { agent: 'agy', args: ['chat'] }],
    [['--agy'], { agent: 'agy', args: [] }],
    [
      ['--no-add-dir', 'codex', 'exec'],
      { addDir: false, agent: 'codex', args: ['exec'] },
    ],
    [['codex', '--no-add-dir'], { agent: 'codex', args: ['--no-add-dir'] }],
    [['claude', 'update'], { agent: 'claude', args: ['update'] }],
    [['init', '--no-setup'], { command: 'init', args: ['--no-setup'] }],
    [['run', 'task', 'status'], { command: 'run', args: ['task', 'status'] }],
    [['--init'], { agent: 'claude', args: ['--init'] }],
    [['--home', '/h', 'codex'], { home: '/h', agent: 'codex', args: [] }],
    [['--home=/h', 'where'], { home: '/h', command: 'where', args: [] }],
    [['--help'], { help: true, agent: 'claude', args: [] }],
    [['-h'], { help: true, agent: 'claude', args: [] }],
    [['--version'], { version: true, agent: 'claude', args: [] }],
    [['codex', '--help'], { agent: 'codex', args: ['--help'] }],
  ])('should parse %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual({
      help: false,
      version: false,
      addDir: true,
      ...expected,
    });
  });

  test.each([[['--home']], [['--home=']], [['--home', '']]])(
    'should require a value for %j',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow('--home needs a directory');
    }
  );
});

describe('parseCommandArgs', () => {
  test.each([
    ['init', [], { setup: true }],
    ['init', ['d', '--no-setup'], { dir: 'd', setup: false }],
    ['init', ['--memory', 'on'], { setup: true, memory: 'on' }],
    ['init', ['--memory=off', 'd'], { dir: 'd', setup: true, memory: 'off' }],
    ['update', ['--no-setup'], { setup: false }],
    ['doctor', [], { setup: true }],
  ])('should parse %s %j', (command, args, expected) => {
    expect(parseCommandArgs(/** @type {any} */ (command), args)).toEqual(
      expected
    );
  });

  test.each([
    ['init', ['a', 'b'], 'kyoten init [<dir>] [--no-setup] [--memory on|off]'],
    ['init', ['--yes'], 'kyoten init [<dir>] [--no-setup] [--memory on|off]'],
    [
      'init',
      ['--memory'],
      'kyoten init [<dir>] [--no-setup] [--memory on|off]',
    ],
    [
      'init',
      ['--memory', 'maybe'],
      'kyoten init [<dir>] [--no-setup] [--memory on|off]',
    ],
    ['update', ['--memory', 'on'], 'kyoten update [--no-setup]'],
    ['update', ['dir'], 'kyoten update [--no-setup]'],
    ['doctor', ['--no-setup'], 'kyoten doctor'],
  ])('should refuse %s %j', (command, args, usage) => {
    expect(() => parseCommandArgs(/** @type {any} */ (command), args)).toThrow(
      `\nFix: ${usage}`
    );
  });
});

describe('packageVersion and helpText', () => {
  test('should read the version of the workspace package', () => {
    expect(packageVersion()).toBe(VERSION);
  });

  test('should read the version of another root', () => {
    expect(packageVersion(source)).toBe('0.2.0');
  });

  test('should name the version, the config file, and every command', () => {
    const help = helpText('1.2.3');

    expect(help.startsWith('Usage: kyoten')).toBe(true);
    expect(help).toContain('kyoten 1.2.3');
    expect(help).toContain('~/.config/kyoten');
    for (const command of COMMANDS) expect(help).toContain(`  ${command}`);
  });
});

describe('main: help, version, where', () => {
  test('should print the help', async () => {
    const { code, out } = await run(['--help']);

    expect(code).toBe(0);
    expect(out[0]).toContain('kyoten 0.2.0');
    expect(out[0]).not.toContain(tmp);
  });

  test('should print the help for the help command', async () => {
    const { out } = await run(['help']);

    expect(out[0]).toContain('Usage');
  });

  test.each([[['--version']], [['version']]])(
    'should print the version for %j',
    async (argv) => {
      const { code, out } = await run(argv);

      expect(code).toBe(0);
      expect(out).toEqual(['0.2.0']);
    }
  );

  test('should print the home on stdout and the rule on stderr', async () => {
    const { code, out, err } = await run(['where'], {
      env: { KYOTEN_HOME: path.join(tmp, 'k') },
    });

    expect(code).toBe(0);
    expect(out).toEqual([path.join(tmp, 'k')]);
    expect(err).toEqual(['kyoten: chosen by KYOTEN_HOME']);
  });

  test('should report an invalid config file', async () => {
    fs.mkdirSync(path.join(tmp, 'cfg', 'kyoten'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'), '{');

    const { code, err } = await run(['where']);

    expect(code).toBe(1);
    expect(err[0]).toMatch(/config\.json is not valid JSON/);
  });
});

describe('main: init and update', () => {
  test('should create a home in <dir> and make it the default', async () => {
    const home = path.join(tmp, 'new-home');

    const { code, err, pnpm } = await run(['init', home, '--no-setup']);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'), 'utf-8')
    );
    expect(code).toBe(0);
    expect(
      fs.readFileSync(path.join(home, 'utils', 'kyoten', 'cli.js'), 'utf-8')
    ).toBe('// cli\n');
    expect(config).toEqual({ home });
    expect(err.at(-2)).toBe(
      `kyoten: ${home} is now the default home (${path.join(tmp, 'cfg', 'kyoten', 'config.json')})`
    );
    expect(pnpm).toEqual([['--version']].slice(0, 0));
  });

  test('should create the resolved home without changing the config', async () => {
    const home = path.join(tmp, 'k');

    const { code, pnpm } = await run(['init'], { env: { KYOTEN_HOME: home } });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, HOME_INFO))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'))).toBe(
      false
    );
    expect(pnpm.slice(1).map((args) => args[0])).toEqual([
      'install',
      'workspace:setup',
    ]);
  });

  test('should turn memory saving off in a new home outside a terminal', async () => {
    const home = path.join(tmp, 'k');

    const { err, questions } = await run(['init', '--no-setup'], {
      env: { KYOTEN_HOME: home },
    });

    expect(readMemory(home)).toEqual({ off: true });
    expect(questions).toEqual([]);
    expect(err.join('\n')).toContain(
      'memory saving is off (recall works; save a note by hand with: kyoten run memory add "…" --force); opt in with: kyoten run memory on'
    );
  });

  test.each([
    ['y', undefined],
    ['', { off: true }],
    ['no', { off: true }],
  ])(
    'should ask about memory saving in a terminal (answer %j)',
    async (answer, expected) => {
      const home = path.join(tmp, 'k');

      const { questions } = await run(['init', '--no-setup'], {
        env: { KYOTEN_HOME: home },
        stdin: { isTTY: true },
        answer,
      });

      expect(questions).toEqual([MEMORY_QUESTION]);
      expect(readMemory(home)).toEqual(expected);
    }
  );

  test.each([
    ['on', undefined],
    ['off', { off: true }],
  ])('should follow --memory %s without asking', async (value, expected) => {
    const home = path.join(tmp, 'k');

    const { questions, err } = await run(
      ['init', '--no-setup', '--memory', value],
      { env: { KYOTEN_HOME: home }, stdin: { isTTY: true } }
    );

    expect(questions).toEqual([]);
    expect(readMemory(home)).toEqual(expected);
    if (value === 'on') {
      expect(err.join('\n')).toContain(
        'memory saving is on; turn it off with: kyoten run memory off'
      );
    }
  });

  test('should turn memory saving off even when setup fails', async () => {
    const home = path.join(tmp, 'k');

    const { code } = await run(['init'], {
      env: { KYOTEN_HOME: home },
      pnpmStatus: 1,
    });

    expect(code).toBe(1);
    expect(readMemory(home)).toEqual({ off: true });
  });

  test('should leave no published home if writing the memory choice fails', async () => {
    const home = path.join(tmp, 'k');
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(path.join('memory', 'config.json'))) {
        throw new Error('cannot write memory choice');
      }
      rename(from, to);
    });

    try {
      const { code, err } = await run([
        '--home',
        home,
        'init',
        '--no-setup',
        '--memory',
        'off',
      ]);

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('cannot write memory choice');
      expect(fs.existsSync(home)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('should explain an empty home folder outside a terminal', async () => {
    const home = path.join(tmp, 'empty-home');
    fs.mkdirSync(home);

    const { code, err, questions, spawn } = await run([], {
      env: { KYOTEN_HOME: home },
    });

    expect(code).toBe(1);
    expect(questions).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('Fix: kyoten init');
  });

  test('should leave memory alone in an existing workspace', async () => {
    const home = makeHome();

    const { questions } = await run(['init', home, '--no-setup'], {
      stdin: { isTTY: true },
    });

    expect(questions).toEqual([]);
    expect(readMemory(home)).toBeUndefined();
  });

  test('should update a home kyoten created', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });

    const { code, err } = await run(['update', '--no-setup'], {
      env: { KYOTEN_HOME: home },
    });

    expect(code).toBe(0);
    expect(err.at(-1)).toBe(`kyoten: ${home} already has kyoten 0.2.0`);
  });
});

describe('parseFlags', () => {
  test('should collect flags and one folder', () => {
    const parsed = parseFlags('backup', ['d', '--include-key'], {
      flags: ['--include-key'],
      dir: 'optional',
    });

    expect(parsed.dir).toBe('d');
    expect(parsed.flags.has('--include-key')).toBe(true);
  });

  test.each([
    [['--nope'], { flags: ['--yes'] }, /unexpected argument/],
    [['a', 'b'], { flags: [], dir: 'optional' }, /unexpected argument/],
    [[], { flags: ['--yes'], dir: 'required' }, /needs a folder/],
  ])('should reject %j', (args, spec, message) => {
    expect(() => parseFlags('x', args, /** @type {any} */ (spec))).toThrow(
      message
    );
  });
});

describe('main: config', () => {
  const configFile = () => path.join(tmp, 'cfg', 'kyoten', 'config.json');

  test('should set, get, show, and unset through the CLI', async () => {
    const set = await run([
      'config',
      'set',
      'args.dscc',
      '--dangerously-skip-permissions',
    ]);
    const get = await run(['config', 'get', 'args.dscc']);
    const show = await run(['config']);
    const path_ = await run(['config', 'path']);
    const unset = await run(['config', 'unset', 'args.dscc']);

    expect(set.code).toBe(0);
    expect(JSON.parse(get.out[0])).toEqual(['--dangerously-skip-permissions']);
    expect(show.out[0]).toBe(configFile());
    expect(path_.out).toEqual([configFile()]);
    expect(unset.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({});
  });

  test('should print a Fix line for a bad key', async () => {
    const { code, err } = await run(['config', 'set', 'nope', 'x']);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('kyoten: Fix:');
  });
});

describe('main: reset', () => {
  test('should move a home aside with --yes and print the undo', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });

    const { code, out, err } = await run(['reset', '--yes'], {
      env: { KYOTEN_HOME: home },
    });

    const removed = `${home}.removed-20261122-090507`;
    expect(code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(removed)).toBe(true);
    expect(out.join('\n')).toContain(home);
    expect(err.join('\n')).toContain(removed);
  });

  test('should ask first on a terminal', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });

    const { code, questions } = await run(['reset', '--all'], {
      env: { KYOTEN_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      answer: 'n',
    });

    expect(code).toBe(1);
    expect(questions[0]).toContain('[y/N]');
    expect(fs.existsSync(home)).toBe(true);
  });

  test('should require --yes without a terminal', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });

    const { code, err } = await run(['reset'], { env: { KYOTEN_HOME: home } });

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('kyoten reset --yes');
  });
});

describe('main: backup and restore', () => {
  test('should back up a home and restore it into another', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });
    const folder = path.join(tmp, 'bk');

    const backup = await run(['backup', folder], {
      env: { KYOTEN_HOME: home },
    });
    const other = path.join(tmp, 'k2');
    const restore = await run(['restore', folder, '--yes'], {
      env: { KYOTEN_HOME: other },
    });

    expect(backup.code).toBe(0);
    expect(backup.out).toEqual([folder]);
    expect(fs.existsSync(path.join(folder, 'manifest.json'))).toBe(true);
    expect(restore.code, restore.err.join('\n')).toBe(0);
    expect(restore.out).toEqual([other]);
    expect(fs.existsSync(path.join(other, HOME_INFO))).toBe(true);
    expect(restore.pnpm.map((args) => args[0])).toContain('memory');
  });

  test('should use the dscc profile path and --include-key', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });
    await run(['dscc', '--set-key'], {
      stdin: Readable.from([`${KEY}\n`]),
      env: { KYOTEN_HOME: home },
    });
    const folder = path.join(tmp, 'bk');

    const { code } = await run(['backup', folder, '--include-key'], {
      env: { KYOTEN_HOME: home },
    });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(folder, 'dscc.env'))).toBe(true);
  });

  test('should name the missing folder for restore', async () => {
    const { code, err } = await run(['restore']);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('needs a folder');
  });
});

describe('main: doctor', () => {
  test('should report a missing home as a warning and pass', async () => {
    const { code, out } = await run(['doctor'], {
      env: { DSCC_PROFILE: path.join(tmp, 'none.env') },
    });

    expect(code).toBe(0);
    expect(
      out.some(
        (line) =>
          line.startsWith('! home: ') && line.includes('does not exist yet')
      )
    ).toBe(true);
    expect(out.at(-1)).toBe('kyoten is ready.');
  });

  test('should fail for a home without dependencies', async () => {
    const home = makeHome();

    const { code, out } = await run(['--home', home, 'doctor']);

    expect(code).toBe(1);
    expect(out).toContain(
      `✗ workspace: dependencies are not installed\n    Fix: kyoten --home "${home}" init`
    );
    expect(out.at(-1)).toBe('1 problem(s) need a fix (see the Fix lines).');
  });
});

describe('main: launch', () => {
  test('should start the agent in the home and return its exit code', async () => {
    const home = makeHome();

    const { code, err, spawn } = await run(['--home', home, '-c'], {
      exit: 3,
      env: { CLAUDE_CODE_SESSION_ID: 'parent' },
    });

    expect(code).toBe(3);
    expect(err).toEqual([`kyoten: claude in ${home} (--home)`]);
    const [file, args, options] = spawn.mock.calls[0];
    expect([file, args]).toEqual([agentPath('claude'), ['-c']]);
    expect(options.cwd).toBe(home);
    expect(options.env.KYOTEN_CALLER_DIR).toBe(tmp);
    expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  test('should put the config defaults before the agent arguments', async () => {
    const home = makeHome();
    const configPath = path.join(tmp, 'cfg', 'kyoten', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ home, args: { codex: ['--search'] } })
    );

    const { spawn, err } = await run(['codex', 'resume']);

    expect(spawn.mock.calls[0][1]).toEqual(['--search', 'resume']);
    expect(err[0]).toBe(`kyoten: codex in ${home} (${configPath})`);
  });

  test('should start agy in the home with no added arguments', async () => {
    const home = makeHome();

    const { spawn, err } = await run(['--home', home, 'agy']);

    expect(spawn.mock.calls[0][0]).toBe(agentPath('agy'));
    expect(spawn.mock.calls[0][1]).toEqual([]);
    expect(spawn.mock.calls[0][2].cwd).toBe(home);
    expect(err).toEqual([`kyoten: agy in ${home} (--home)`]);
  });

  describe('projects outside the home', () => {
    /** A git repository outside the home, with a folder inside it. */
    function makeRepo() {
      const repo = fs.realpathSync.native(
        fs.mkdtempSync(path.join(tmp, 'proj-'))
      );
      fs.mkdirSync(path.join(repo, '.git'));
      fs.mkdirSync(path.join(repo, 'src'));
      return repo;
    }

    test.each(['claude', 'dscc', 'codex', 'agy'])(
      'should put --add-dir first for %s',
      async (agent) => {
        const home = makeHome();
        const repo = makeRepo();
        const profile = path.join(tmp, 'dscc.env');
        fs.writeFileSync(
          profile,
          `ANTHROPIC_BASE_URL=https://ds\nANTHROPIC_AUTH_TOKEN=${KEY}\n`
        );
        const configPath = path.join(tmp, 'cfg', 'kyoten', 'config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(
          configPath,
          JSON.stringify({ args: { [agent]: ['--x'] } })
        );

        const { spawn, err } = await run(['--home', home, agent, 'fix it'], {
          cwd: path.join(repo, 'src'),
          env: { DSCC_PROFILE: profile },
        });

        expect(spawn.mock.calls[0][1]).toEqual([
          `--add-dir=${repo}`,
          '--x',
          'fix it',
        ]);
        expect(spawn.mock.calls[0][2].env.KYOTEN_ADD_DIR).toBe(repo);
        expect(err.at(-1)).toBe(
          `kyoten: ${agent} in ${home} (--home); --add-dir=${repo}`
        );
      }
    );

    test('should leave out a repository a Windows .cmd shim cannot take and still start the agent', async () => {
      const home = makeHome();
      const repo = path.join(tmp, 'hello!world');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      const real = fs.realpathSync.native(repo);

      const { code, spawn, err } = await run(['--home', home, 'codex'], {
        cwd: repo,
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\cmd.exe' },
        canRun: (file) => /[\\/]codex\.cmd$/i.test(file),
      });

      expect(code).toBe(0);
      expect(spawn.mock.calls[0][0]).toBe('C:\\Windows\\cmd.exe');
      expect(spawn.mock.calls[0][1].join(' ')).not.toContain('--add-dir');
      expect(spawn.mock.calls[0][2].env.KYOTEN_ADD_DIR).toBeUndefined();
      expect(err).toContain(
        `kyoten: --add-dir=${real} left out: cmd.exe cannot pass a path with % or ! to the codex .cmd shim, so codex gets only the home (rename the folder to add it; --no-add-dir hides this)`
      );
      expect(err.at(-1)).toBe(`kyoten: codex in ${home} (--home)`);
    });

    test.each(['dsh'])('should not add a directory for %s', async (agent) => {
      const home = makeHome();
      const repo = makeRepo();

      const { spawn, err } = await run(['--home', home, agent], {
        cwd: repo,
      });

      expect(spawn.mock.calls[0][1].join(' ')).not.toContain('--add-dir');
      expect(spawn.mock.calls[0][2].env.KYOTEN_ADD_DIR).toBeUndefined();
      expect(err).toContain(`kyoten: ${agent} in ${home} (--home)`);
    });

    test('should not add a directory with --no-add-dir', async () => {
      const home = makeHome();
      const repo = makeRepo();

      const { spawn } = await run(['--home', home, '--no-add-dir', 'codex'], {
        cwd: repo,
      });

      expect(spawn.mock.calls[0][1]).toEqual([]);
    });

    test('should not add a directory when the config says addDir is false', async () => {
      const home = makeHome();
      const repo = makeRepo();
      const configPath = path.join(tmp, 'cfg', 'kyoten', 'config.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ addDir: false }));

      const { spawn } = await run(['--home', home], { cwd: repo });

      expect(spawn.mock.calls[0][1]).toEqual([]);
    });

    test('should not add a directory when started in the home', async () => {
      const home = makeHome();
      fs.mkdirSync(path.join(home, '.git'));

      const { spawn } = await run(['--home', home], { cwd: home });

      expect(spawn.mock.calls[0][1]).toEqual([]);
    });

    test.each(['claude', 'codex', 'dsh', 'dscc'])(
      'should set KYOTEN_AGENT to %s and replace an inherited value',
      async (agent) => {
        const home = makeHome();
        const profile = path.join(tmp, 'agent-profile.env');
        fs.writeFileSync(
          profile,
          'ANTHROPIC_BASE_URL=https://ds\nANTHROPIC_AUTH_TOKEN=k\n'
        );

        const { spawn } = await run(['--home', home, agent], {
          env: { KYOTEN_AGENT: 'stale', DSCC_PROFILE: profile },
        });

        expect(spawn.mock.calls[0][2].env.KYOTEN_AGENT).toBe(agent);
      }
    );

    test('should set KYOTEN_AGENT to agy from a plain shell and refuse agy from another harness', async () => {
      const home = makeHome();

      const ok = await run(['--home', home, 'agy']);
      expect(ok.code).toBe(0);
      expect(ok.spawn.mock.calls[0][2].env.KYOTEN_AGENT).toBe('agy');

      const blocked = await run(['--home', home, 'agy'], {
        env: { KYOTEN_AGENT: 'claude' },
      });
      expect(blocked.code).toBe(1);
      expect(blocked.spawn).not.toHaveBeenCalled();
      expect(blocked.err.join('\n')).toContain('Terms of Service');
    });

    test('should not pass on an inherited KYOTEN_ADD_DIR', async () => {
      const home = makeHome();

      const { spawn } = await run(['--home', home], {
        env: { KYOTEN_ADD_DIR: '/stale' },
      });

      expect(spawn.mock.calls[0][2].env.KYOTEN_ADD_DIR).toBeUndefined();
    });
  });

  test('should hint at kyoten update for a home made by an older kyoten', async () => {
    const home = makeHome();
    markManaged(home, '0.1.0');

    const { err } = await run(['--home', home]);

    expect(err[0]).toBe(
      'kyoten: kyoten 0.2.0 is available for this home (it has 0.1.0): kyoten update'
    );
  });

  test('should hint at a newer kyoten for a home made by one', async () => {
    const home = makeHome();
    markManaged(home, '0.3.0');

    const { err } = await run(['--home', home]);

    expect(err[0]).toBe(
      'kyoten: this home has kyoten 0.3.0, newer than this kyoten 0.2.0: npx kyoten@latest'
    );
  });

  test('should give no hint when the versions match', async () => {
    const home = makeHome();
    markManaged(home, '0.2.0');

    const { err } = await run(['--home', home]);

    expect(err).toEqual([`kyoten: claude in ${home} (--home)`]);
  });

  test('should explain a missing home outside a terminal', async () => {
    const { code, err } = await run([]);

    expect(code).toBe(1);
    expect(err).toEqual([
      `kyoten: no kyoten home at ${path.join(tmp, 'user', '.kyoten')} yet.`,
      'kyoten: Fix: kyoten init',
    ]);
  });

  test('should refuse a home that holds something else', async () => {
    const home = path.join(tmp, 'other');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'x'), 'x');

    const { code, err } = await run(['--home', home]);

    expect(code).toBe(1);
    expect(err[0]).toBe(`kyoten: ${home} (--home) is not a kyoten workspace.`);
  });

  test('should offer to create a missing home in a terminal and stop on no', async () => {
    const { code, err, questions, spawn } = await run([], {
      stdin: { isTTY: true },
      answer: 'n',
    });

    expect(code).toBe(1);
    expect(questions).toEqual([
      `kyoten: no kyoten home at ${path.join(tmp, 'user', '.kyoten')} yet. Create it now? [Y/n] `,
    ]);
    expect(err).toEqual([
      'kyoten: nothing created; run kyoten init when you are ready',
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should create the home on Enter, then start the agent', async () => {
    const home = path.join(tmp, 'user', '.kyoten');

    const { code, spawn, pnpm } = await run([], {
      stdin: { isTTY: true },
      answer: '',
    });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, HOME_INFO))).toBe(true);
    expect(pnpm.map((args) => args[0])).toEqual([
      '--version',
      'install',
      'workspace:setup',
    ]);
    expect(spawn.mock.calls[0][2].cwd).toBe(home);
    expect(readMemory(home)).toEqual({ off: true });
  });

  test.each(['claude', 'codex'])(
    'should discard dscc provider variables when launching %s from dscc',
    async (agent) => {
      const home = makeHome();
      const { spawn } = await run(['--home', home, agent], {
        env: {
          KYOTEN_AGENT: 'dscc',
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: KEY,
        },
      });

      const env = spawn.mock.calls[0][2].env;
      expect(env.KYOTEN_AGENT).toBe(agent);
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    }
  );

  test('should start dscc with the profile instead of inherited keys', async () => {
    const home = makeHome();
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(
      profile,
      `ANTHROPIC_BASE_URL=https://ds\nANTHROPIC_AUTH_TOKEN=${KEY}\n9X=1\n`
    );

    const { spawn, err } = await run(['--home', home, 'dscc'], {
      env: { DSCC_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-inherited' },
    });

    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ds');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(err[0]).toBe(
      'kyoten: dscc profile line 3 skipped: not a variable name: 9X'
    );
  });
});

describe('main: dsh web workspace hint', () => {
  test.each([[[]], [['web', '--no-open']], [['--no-open']]])(
    'should say which Web UI workspace to choose for dsh %j',
    async (args) => {
      const home = makeHome();

      const { err } = await run(['--home', home, 'dsh', ...args]);

      expect(err.at(-1)).toBe(
        `kyoten: in the DSH Web UI, click Choose workspace, add ${home}, and select it; sessions in another workspace still run this home's hooks`
      );
    }
  );

  test('should not print the hint for another dsh profile', async () => {
    const home = makeHome();

    const { err } = await run(['--home', home, 'dsh', 'tui']);

    expect(err.join('\n')).not.toContain('Choose workspace');
  });
});

describe('main: doctor dsh web', () => {
  test('should probe the dsh web port from the config when dsh is found', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, 'node_modules'));
    fs.mkdirSync(path.join(tmp, 'cfg', 'kyoten'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'cfg', 'kyoten', 'config.json'),
      JSON.stringify({ args: { dsh: ['--port', '4100'] } })
    );
    const probed = /** @type {number[]} */ ([]);

    const { out } = await run(['--home', home, 'doctor'], {
      connect: async (/** @type {number} */ port) => {
        probed.push(port);
        return true;
      },
    });

    expect(probed).toEqual([4100]);
    expect(out.join('\n')).toContain(
      '! dsh-web: something answers on 127.0.0.1:4100'
    );
  });

  test('should probe the default port without a config', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, 'node_modules'));
    const connect = vi.fn(async () => false);

    const { out } = await run(['--home', home, 'doctor'], { connect });

    expect(connect).toHaveBeenCalledWith(3080);
    expect(out.join('\n')).toContain('✓ dsh-web: 127.0.0.1:3080 is free');
  });

  test('should not probe without dsh', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, 'node_modules'));
    const connect = vi.fn(async () => true);

    // No folder on PATH holds a dsh the fake canRun accepts.
    const { out } = await run(['--home', home, 'doctor'], {
      connect,
      env: { PATH: path.join(tmp, 'empty') },
    });

    expect(connect).not.toHaveBeenCalled();
    expect(out.join('\n')).not.toContain('dsh-web');
  });
});

describe('main: run', () => {
  test('should run the pnpm script in the home and return its exit code', async () => {
    const home = makeHome();

    const { code, spawn, err } = await run(
      ['--home', home, 'run', 'task', 'status', '--json'],
      {
        exit: 3,
        env: { CODEX_THREAD_ID: 'kept', GONE: undefined, GIT_DIR: '/o/.git' },
      }
    );

    expect(code).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0];
    expect(path.basename(file)).toMatch(/^pnpm/);
    expect(args.slice(-3)).toEqual(['task', 'status', '--json']);
    expect(options.cwd).toBe(home);
    expect(options.stdio).toBe('inherit');
    expect(options.env.CODEX_THREAD_ID).toBe('kept');
    expect('GONE' in options.env).toBe(false);
    expect('GIT_DIR' in options.env).toBe(false);
    expect(err).toEqual([]);
  });

  test.each([[[]], [['--help']], [['-h']]])(
    'should list the home scripts for run %j',
    async (args) => {
      const home = makeHome();
      fs.writeFileSync(
        path.join(home, 'package.json'),
        JSON.stringify({
          name: 'kyoten',
          scripts: { task: 'node t.js', check: 'x', memory: 'y' },
        })
      );

      const { code, out, spawn } = await run(['--home', home, 'run', ...args]);

      expect(code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(out[0]).toContain('Usage: kyoten run <script> [args…]');
      expect(out[0]).toContain('  check\n  memory\n  task');
    }
  );

  test('should list no scripts for a home without any', async () => {
    const home = makeHome();

    const { out } = await run(['--home', home, 'run']);

    expect(out[0]).toContain('(none)');
  });

  test('should explain a missing home', async () => {
    const { code, err, spawn } = await run([
      '--home',
      path.join(tmp, 'none'),
      'run',
      'check',
    ]);

    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('Fix: kyoten init');
  });

  test('should refuse a home that holds something else', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'x'), '');

    const { code, err } = await run(['--home', other, 'run', 'check']);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('is not a kyoten workspace');
  });
});

describe('main: dscc profile', () => {
  test('should show the dscc profile without a home', async () => {
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(profile, `ANTHROPIC_AUTH_TOKEN=${KEY}\n`);

    const { code, out } = await run(['dscc', '--show'], {
      env: { DSCC_PROFILE: profile },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `profile: ${profile}`,
      '',
      'ANTHROPIC_AUTH_TOKEN=sk-t...7890',
    ]);
  });

  test('should save a piped key', async () => {
    const profile = path.join(tmp, 'p', 'dscc.env');

    const { code, err } = await run(['dscc', '--set-key'], {
      env: { DSCC_PROFILE: profile },
      stdin: Readable.from([`${KEY}\n`]),
    });

    expect(code).toBe(0);
    expect(err).toEqual([`kyoten: key saved to ${profile} (new profile)`]);
    expect(fs.readFileSync(profile, 'utf-8')).toContain(
      `ANTHROPIC_AUTH_TOKEN=${KEY}`
    );
  });

  test('should prompt for the key without echo in a terminal', async () => {
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(profile, 'ANTHROPIC_AUTH_TOKEN=\n');
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      setEncoding: () => {},
      pause: () => {},
      resume() {
        setImmediate(() => stdin.emit('data', `${KEY}\r`));
      },
    });

    const { code, err, tty } = await run(['dscc', '--set-key'], {
      env: { DSCC_PROFILE: profile },
      stdin,
    });

    expect(code).toBe(0);
    expect(tty).toEqual(['DeepSeek API key (hidden): ', '\n']);
    expect(err).toEqual([`kyoten: key saved to ${profile}`]);
  });
});

describe('main: errors', () => {
  test('should print a thrown value that is not an Error', async () => {
    /** @type {string[]} */
    const errors = [];

    const code = await main(['where'], {
      ...defaultDeps(),
      cwd: tmp,
      env: {
        XDG_CONFIG_HOME: path.join(tmp, 'cfg'),
        APPDATA: path.join(tmp, 'cfg'),
      },
      out: () => {
        // eslint-disable-next-line no-throw-literal -- main() must also report a thrown non-Error
        throw 'boom';
      },
      err: (text) => errors.push(text),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(['kyoten: boom']);
  });
});

describe('askLine', () => {
  test('should return one answer and stop reading', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = askLine({ input, output, question: 'Q? ' });
    input.write('yes\nmore\n');

    await expect(answer).resolves.toBe('yes');
    expect(String(output.read())).toBe('Q? ');
  });
});

describe('defaultDeps', () => {
  test('should ask on stderr and read the answer from stdin', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      /** @type {any} */ (input)
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const answer = defaultDeps().ask('Create? ');
    input.write('y\n');

    await expect(answer).resolves.toBe('y');
    expect(stderr.mock.calls.map((call) => call[0])).toContain('Create? ');
  });
});
