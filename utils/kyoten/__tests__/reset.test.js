import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { crossSpawn } from '../../spawn.js';
import { HOME_INFO } from '../home.js';
import {
  inspectHome,
  removedPath,
  resetHome,
  stamp,
  undoCommand,
} from '../reset.js';

const run = crossSpawn();
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** @type {string} */
let tmp;
/** @type {string} */
let home;
/** @type {string[]} */
let out;
/** @type {string[]} */
let err;

/** @param {string[]} args */
function git(...args) {
  const r = spawnSync('git', ['-C', home, ...args], {
    env: GIT_ENV,
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A managed home: main one commit ahead of kyoten/upstream per `local`. */
function makeHome(local = 0) {
  fs.mkdirSync(path.join(home, 'utils', 'kyoten'), { recursive: true });
  fs.mkdirSync(path.join(home, '.kyoten'), { recursive: true });
  fs.writeFileSync(path.join(home, 'package.json'), '{"name":"kyoten"}');
  fs.writeFileSync(path.join(home, 'utils', 'kyoten', 'cli.js'), '');
  fs.writeFileSync(
    path.join(home, HOME_INFO),
    JSON.stringify({
      managed: true,
      version: '0.2.0',
      sourceCommit: 'x',
      createdAt: 'then',
    })
  );
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('add', 'package.json', 'utils');
  git('commit', '-q', '--no-gpg-sign', '-m', 'snapshot');
  git('branch', 'kyoten/upstream');
  for (let i = 0; i < local; i += 1) {
    fs.writeFileSync(path.join(home, `f${i}.txt`), `${i}`);
    git('add', `f${i}.txt`);
    git('commit', '-q', '--no-gpg-sign', '-m', `feat: local ${i}`);
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-reset-'))
  );
  home = path.join(tmp, 'home');
  out = [];
  err = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {object} [over] */
function input(over = {}) {
  return {
    home,
    config: {},
    configPath: path.join(tmp, 'cfg', 'config.json'),
    configDir: path.join(tmp, 'cfg'),
    all: false,
    yes: true,
    interactive: false,
    ask: async () => 'y',
    run,
    env: GIT_ENV,
    out: (/** @type {string} */ t) => out.push(t),
    err: (/** @type {string} */ t) => err.push(t),
    platform: /** @type {NodeJS.Platform} */ ('linux'),
    now: () => new Date(2026, 10, 22, 9, 5, 7),
    ...over,
  };
}

describe('stamp and removedPath', () => {
  test('should format local time as YYYYMMDD-HHMMSS', () => {
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });

  test('should add a suffix when the target exists', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    const first = removedPath(path.join(tmp, 'h'), date);
    fs.mkdirSync(first);
    fs.mkdirSync(`${first}-2`);

    expect(removedPath(path.join(tmp, 'h'), date)).toBe(`${first}-3`);
  });
});

describe('undoCommand', () => {
  test('should use mv on POSIX and Move-Item on Windows', () => {
    expect(undoCommand('/a.removed', '/a', 'linux')).toBe(
      'mv "/a.removed" "/a"'
    );
    expect(undoCommand('C:\\a.r', 'C:\\a', 'win32')).toContain('Move-Item');
  });
});

describe('inspectHome', () => {
  test('should count commits, dirty files, open tasks, and notes', () => {
    makeHome(2);
    fs.writeFileSync(
      path.join(home, 'package.json'),
      '{"name":"kyoten","x":1}'
    );
    for (const [name, status] of [
      ['a-1', 'active'],
      ['b-1', 'done'],
      ['c-1', 'blocked'],
    ]) {
      fs.mkdirSync(path.join(home, 'tasks', name), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'tasks', name, 'state.json'),
        JSON.stringify({ status })
      );
    }
    fs.mkdirSync(path.join(home, 'tasks', '.trash'));
    fs.mkdirSync(path.join(home, 'tasks', 'broken'));
    fs.writeFileSync(path.join(home, 'tasks', 'broken', 'state.json'), '{');
    fs.mkdirSync(path.join(home, 'memory'));
    fs.writeFileSync(
      path.join(home, 'memory', 'log.jsonl'),
      [
        { op: 'add', note: { id: 'm1' } },
        { op: 'add', note: { id: 'm2' } },
        { op: 'update', id: 'm1' },
        { op: 'delete', id: 'm2' },
        null,
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\nnot json\n'
    );

    const found = inspectHome({ home, run, env: GIT_ENV });

    expect(found.commits).toEqual(['feat: local 1', 'feat: local 0']);
    // package.json, .kyoten/, tasks/, memory/
    expect(found.dirty).toBe(4);
    expect(found.tasks).toBe(2);
    expect(found.notes).toBe(1);
  });

  test('should report unknown git state and no tasks or notes', () => {
    fs.mkdirSync(home);

    const found = inspectHome({ home, run, env: GIT_ENV });

    expect(found).toEqual({ commits: null, dirty: null, tasks: 0, notes: 0 });
  });
});

describe('resetHome', () => {
  test('should rename the home, print the undo, and unset a matching config home', async () => {
    makeHome(7);
    const configPath = path.join(tmp, 'cfg', 'config.json');
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ home, addDir: true }));

    const code = await resetHome(
      input({ config: { home, addDir: true }, configPath })
    );

    const removed = `${home}.removed-20261122-090507`;
    expect(code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(path.join(removed, 'package.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      addDir: true,
    });
    expect(out.join('\n')).toContain('local commits not on kyoten/upstream: 7');
    expect(out.join('\n')).toContain('… and 2 more');
    expect(out.join('\n')).toContain('kyoten backup');
    expect(err.join('\n')).toContain(`mv "${removed}" "${home}"`);
    expect(err.join('\n')).toContain('kyoten config set home');
  });

  test('should keep a config home that points elsewhere', async () => {
    makeHome();
    const configPath = path.join(tmp, 'cfg', 'config.json');

    await resetHome(
      input({ config: { home: path.join(tmp, 'other') }, configPath })
    );

    expect(fs.existsSync(configPath)).toBe(false);
  });

  test('should also rename the config folder with --all', async () => {
    makeHome();
    fs.mkdirSync(path.join(tmp, 'cfg'));
    fs.writeFileSync(path.join(tmp, 'cfg', 'config.json'), '{}');

    const code = await resetHome(
      input({ all: true, config: { home }, platform: 'win32' })
    );

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'cfg'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(`${tmp}/cfg.removed-20261122-090507`, 'config.json')
      )
    ).toBe(true);
    expect(out.join('\n')).toContain('config folder');
    expect(err.join('\n')).toContain('Move-Item');
    expect(err.join('\n')).not.toContain('config set home');
  });

  test('should skip a config folder that does not exist with --all', async () => {
    makeHome();

    await resetHome(input({ all: true }));

    expect(err.filter((l) => l.includes('moved to'))).toHaveLength(1);
  });

  test('should ask in a terminal and move on yes', async () => {
    makeHome();
    /** @type {string[]} */
    const questions = [];

    const code = await resetHome(
      input({
        yes: false,
        interactive: true,
        ask: async (/** @type {string} */ q) => {
          questions.push(q);
          return 'Y';
        },
      })
    );

    expect(code).toBe(0);
    expect(questions[0]).toContain('[y/N]');
    expect(fs.existsSync(home)).toBe(false);
  });

  test('should change nothing when the answer is not yes', async () => {
    makeHome();

    const code = await resetHome(
      input({ yes: false, interactive: true, ask: async () => '' })
    );

    expect(code).toBe(1);
    expect(fs.existsSync(home)).toBe(true);
    expect(err).toContain('kyoten: nothing changed');
  });

  test('should require --yes without a terminal', async () => {
    makeHome();

    await expect(resetHome(input({ yes: false }))).rejects.toThrow(
      /kyoten reset --yes/
    );
    expect(fs.existsSync(home)).toBe(true);
  });

  test('should refuse a clone with the config hint', async () => {
    makeHome();
    fs.rmSync(path.join(home, HOME_INFO));

    await expect(resetHome(input())).rejects.toThrow(
      /kyoten config unset home/
    );
  });

  test('should refuse when there is no home', async () => {
    await expect(resetHome(input())).rejects.toThrow(/no kyoten home/);
  });

  test('should explain a failed rename', async () => {
    makeHome();
    const config = path.join(tmp, 'cfg');
    fs.writeFileSync(config, 'a file, so the rename target parent is odd');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });

    await expect(resetHome(input())).rejects.toThrow(/EBUSY[\s\S]*Fix:/);
    spy.mockRestore();
  });

  test('should say where the home went when the config folder cannot move', async () => {
    makeHome();
    fs.mkdirSync(path.join(tmp, 'cfg'));
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === path.join(tmp, 'cfg')) throw new Error('EBUSY');
      real(from, to);
    });

    const message = await resetHome(
      input({ all: true, platform: 'linux' })
    ).then(
      () => '',
      (error) => error.message
    );

    expect(message).toContain(`could not rename ${path.join(tmp, 'cfg')}`);
    expect(message).toContain('EBUSY');
    expect(message).toContain(
      `\nFix: close programs that use ${path.join(tmp, 'cfg')}, then move it aside yourself; ${home} is already at ${home}.removed-20261122-090507`
    );
    spy.mockRestore();
    expect(fs.existsSync(home)).toBe(false);
    expect(err).toContain(
      `kyoten: ${home} moved to ${home}.removed-20261122-090507`
    );
    expect(err.join('\n')).toContain(
      `mv "${home}.removed-20261122-090507" "${home}"`
    );
  });

  test('should show unknown git details when git cannot be read', async () => {
    makeHome();
    fs.rmSync(path.join(home, '.git'), { recursive: true, force: true });

    await resetHome(input());

    expect(out.join('\n')).toContain('local commits: unknown');
    expect(out.join('\n')).toContain('uncommitted files: unknown');
  });
});
