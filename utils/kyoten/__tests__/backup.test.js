import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { crossSpawn } from '../../spawn.js';
import {
  BACKUP_FILES,
  backupHome,
  readManifest,
  restoreBackup,
  restoreSummary,
} from '../backup.js';
import { HOME_INFO } from '../home.js';

const realRun = crossSpawn();
const POSIX = process.platform !== 'win32';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** @type {string} */
let tmp;
/** @type {string[]} */
let out;
/** @type {string[]} */
let err;
/** @type {{ args: string[], cwd?: string, env?: NodeJS.ProcessEnv }[]} */
let pnpm;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-bk-')));
  out = [];
  err = [];
  pnpm = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    env: GIT_ENV,
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A managed home with one snapshot commit on main and kyoten/upstream.
 *
 * @param {string} dir
 * @param {{ managed?: boolean, message?: string }} [options]
 */
function makeHome(dir, { managed = true, message = 'snapshot' } = {}) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"kyoten"}');
  fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '/.kyoten/\n');
  if (managed) {
    fs.mkdirSync(path.join(dir, '.kyoten'));
    fs.writeFileSync(
      path.join(dir, HOME_INFO),
      JSON.stringify({
        managed: true,
        version: '0.2.0',
        sourceCommit: 'x',
        createdAt: 'then',
      })
    );
  }
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message);
  git(dir, 'branch', 'kyoten/upstream');
}

/**
 * @param {string} dir
 * @param {string} file
 * @param {string} content
 * @param {string} subject
 */
function commitFile(dir, file, content, subject) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', subject);
}

/**
 * Real git, fake pnpm (memory export writes a file; import is recorded).
 *
 * @param {{ exportStatus?: number, dryStatus?: number, importStatus?: number }} [fail]
 * @returns {import('../../spawn.js').Spawn}
 */
function makeRun({ exportStatus = 0, dryStatus = 0, importStatus = 0 } = {}) {
  return (bin, args, options) => {
    const opts = /** @type {{ cwd?: string, env?: NodeJS.ProcessEnv }} */ (
      options
    );
    if (bin === 'pnpm') {
      pnpm.push({ args, cwd: opts.cwd, env: opts.env });
      if (args[1] === 'export') {
        if (exportStatus) return { status: exportStatus, stderr: 'no export' };
        fs.writeFileSync(args[args.indexOf('--out') + 1], 'TARBALL');
        return { status: 0, stdout: '' };
      }
      const status = args.includes('--dry-run') ? dryStatus : importStatus;
      return { status, stderr: status ? 'no import' : '' };
    }
    return realRun(bin, args, options);
  };
}

/** @param {object} [over] */
function backupInput(over = {}) {
  return {
    home: path.join(tmp, 'home'),
    dir: undefined,
    includeKey: false,
    configFile: path.join(tmp, 'cfg', 'config.json'),
    profileFile: path.join(tmp, 'cfg', 'dscc.env'),
    version: '0.2.0',
    run: makeRun(),
    env: GIT_ENV,
    out: (/** @type {string} */ t) => out.push(t),
    err: (/** @type {string} */ t) => err.push(t),
    now: () => new Date(2026, 10, 22, 9, 5, 7),
    cwd: tmp,
    homedir: tmp,
    ...over,
  };
}

/** A home with a local commit, a config file, and a dscc profile. */
function sourceHome() {
  const home = path.join(tmp, 'home');
  makeHome(home);
  commitFile(home, 'local.txt', 'mine\n', 'feat: local work');
  fs.mkdirSync(path.join(tmp, 'cfg'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'cfg', 'config.json'),
    JSON.stringify({ addDir: true })
  );
  fs.writeFileSync(path.join(tmp, 'cfg', 'dscc.env'), 'KEY=secret\n');
  return home;
}

/**
 * @param {string} folder
 * @returns {any}
 */
const manifestOf = (folder) =>
  JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf-8'));

describe('backupHome', () => {
  test('should write memory, config, home.json, bundle, and a manifest', () => {
    sourceHome();

    const code = backupHome(backupInput());

    const folder = path.join(tmp, 'kyoten-backup-20261122-090507');
    const manifest = manifestOf(folder);
    expect(code).toBe(0);
    expect(out).toEqual([folder]);
    expect(
      manifest.files.map((/** @type {{ name: string }} */ f) => f.name)
    ).toEqual(['memory.tar.gz', 'config.json', 'home.json', 'local.bundle']);
    expect(manifest.kyotenVersion).toBe('0.2.0');
    expect(manifest.createdAt).toBe(
      new Date(2026, 10, 22, 9, 5, 7).toISOString()
    );
    expect(manifest.home).toBe(path.join(tmp, 'home'));
    const memory = manifest.files[0];
    expect(memory.bytes).toBe(7);
    expect(memory.sha256).toBe(
      crypto.createHash('sha256').update('TARBALL').digest('hex')
    );
    expect(fs.existsSync(path.join(folder, 'dscc.env'))).toBe(false);
    expect(pnpm[0].args.slice(0, 5)).toEqual([
      'memory',
      'export',
      '--include',
      'memory,personalization,tasks,resources',
      '--out',
    ]);
    expect(pnpm[0].cwd).toBe(path.join(tmp, 'home'));
    expect(
      git(
        path.join(tmp, 'home'),
        'bundle',
        'verify',
        path.join(folder, 'local.bundle')
      )
    ).toBeDefined();
    expect(err.join('\n')).toContain('holds personal data');
    expect(err.join('\n')).toContain('--include-key');
    if (POSIX) {
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(folder, 'config.json')).mode & 0o777).toBe(
        0o600
      );
    }
  });

  test('should include the dscc profile only with --include-key', () => {
    sourceHome();
    const dir = path.join(tmp, 'bk');

    backupHome(backupInput({ dir, includeKey: true }));

    expect(fs.readFileSync(path.join(dir, 'dscc.env'), 'utf-8')).toBe(
      'KEY=secret\n'
    );
    expect(
      manifestOf(dir).files.map((/** @type {{ name: string }} */ f) => f.name)
    ).toContain('dscc.env');
    expect(err.join('\n')).toContain('your DeepSeek key');
    if (POSIX)
      expect(fs.statSync(path.join(dir, 'dscc.env')).mode & 0o777).toBe(0o600);
  });

  test('should say so when --include-key finds no profile', () => {
    sourceHome();
    fs.rmSync(path.join(tmp, 'cfg', 'dscc.env'));

    backupHome(backupInput({ dir: 'bk', includeKey: true }));

    expect(err.join('\n')).toContain('no dscc profile');
  });

  test('should skip the bundle without local commits and a missing config', () => {
    const home = path.join(tmp, 'home');
    makeHome(home);

    backupHome(backupInput({ dir: '~/bk' }));

    expect(
      manifestOf(path.join(tmp, 'bk')).files.map(
        (/** @type {{ name: string }} */ f) => f.name
      )
    ).toEqual(['memory.tar.gz', 'home.json']);
    expect(err.join('\n')).toContain('no config file');
  });

  test('should skip the bundle when kyoten/upstream is missing', () => {
    const home = path.join(tmp, 'home');
    makeHome(home);
    git(home, 'branch', '-D', 'kyoten/upstream');

    backupHome(backupInput({ dir: 'bk' }));

    expect(err.join('\n')).toContain('local commits not included');
  });

  test('should not bundle a clone', () => {
    makeHome(path.join(tmp, 'home'), { managed: false });

    backupHome(backupInput({ dir: 'bk' }));

    expect(
      manifestOf(path.join(tmp, 'bk')).files.map(
        (/** @type {{ name: string }} */ f) => f.name
      )
    ).toEqual(['memory.tar.gz']);
    expect(err.join('\n')).toContain('is a clone');
  });

  test('should accept an existing empty folder', () => {
    sourceHome();
    fs.mkdirSync(path.join(tmp, 'empty'));

    backupHome(backupInput({ dir: 'empty' }));

    expect(fs.existsSync(path.join(tmp, 'empty', 'manifest.json'))).toBe(true);
  });

  test.each(['full', 'file'])('should refuse a %s existing target', (kind) => {
    sourceHome();
    const target = path.join(tmp, 'bk');
    if (kind === 'full') {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'x'), '1');
    } else {
      fs.writeFileSync(target, '1');
    }

    expect(() => backupHome(backupInput({ dir: 'bk' }))).toThrow(
      /already exists and is not empty/
    );
  });

  test('should refuse a home that is not a workspace', () => {
    expect(() => backupHome(backupInput())).toThrow(/no kyoten home/);
  });

  test.each([false, true])(
    'should remove the folder when the export fails (existed: %s)',
    (existed) => {
      sourceHome();
      const target = path.join(tmp, 'bk');
      if (existed) fs.mkdirSync(target);

      expect(() =>
        backupHome(
          backupInput({ dir: 'bk', run: makeRun({ exportStatus: 1 }) })
        )
      ).toThrow(/no export[\s\S]*Fix:/);

      expect(fs.existsSync(target)).toBe(existed);
    }
  );

  test('should report a command that did not start', () => {
    sourceHome();
    /** @type {import('../../spawn.js').Spawn} */
    const run = () => ({ status: null, error: new Error('ENOENT') });

    expect(() => backupHome(backupInput({ dir: 'bk', run }))).toThrow(/ENOENT/);
  });

  test('should report a failed bundle', () => {
    sourceHome();
    const real = makeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const run = (bin, args, options) =>
      args.includes('bundle') ? { status: 1 } : real(bin, args, options);

    expect(() => backupHome(backupInput({ dir: 'bk', run }))).toThrow(/exit 1/);
  });
});

/**
 * Write a backup folder by hand (a correct manifest unless `skewed`).
 *
 * @param {Record<string, string | Buffer>} files
 * @param {(manifest: any) => void} [tweak]
 */
function writeFolder(files, tweak = () => {}) {
  const folder = path.join(
    tmp,
    `folder-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(folder);
  const manifest = {
    kyotenVersion: '0.2.0',
    createdAt: 'then',
    home: '/x',
    files: Object.entries(files).map(([name, data]) => {
      fs.writeFileSync(path.join(folder, name), data);
      const buffer = Buffer.from(data);
      return {
        name,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
      };
    }),
  };
  tweak(manifest);
  fs.writeFileSync(
    path.join(folder, 'manifest.json'),
    JSON.stringify(manifest)
  );
  return folder;
}

describe('readManifest', () => {
  test('should return the checked files', () => {
    const folder = writeFolder({ 'config.json': '{}' });

    const { manifest, files } = readManifest(folder);

    expect(manifest.kyotenVersion).toBe('0.2.0');
    expect([...files.keys()]).toEqual(['config.json']);
    expect(BACKUP_FILES).toContain('config.json');
  });

  test('should refuse a missing manifest', () => {
    const folder = path.join(tmp, 'empty');
    fs.mkdirSync(folder);

    expect(() => readManifest(folder)).toThrow(/manifest\.json is missing/);
  });

  test('should refuse invalid JSON', () => {
    const folder = writeFolder({});
    fs.writeFileSync(path.join(folder, 'manifest.json'), '{');

    expect(() => readManifest(folder)).toThrow(/not valid JSON/);
  });

  test.each([['null'], ['"x"'], ['{"kyotenVersion":"1"}'], ['{"files":[]}']])(
    'should refuse the manifest %s',
    (text) => {
      const folder = writeFolder({});
      fs.writeFileSync(path.join(folder, 'manifest.json'), text);

      expect(() => readManifest(folder)).toThrow(
        /not a kyoten backup manifest/
      );
    }
  );

  test.each([['../evil'], ['sub/config.json'], ['other.txt'], [7]])(
    'should refuse the file name %j',
    (name) => {
      const folder = writeFolder({ 'config.json': '{}' }, (m) => {
        m.files[0].name = name;
      });

      expect(() => readManifest(folder)).toThrow(/unknown file/);
    }
  );

  test('should refuse a duplicate entry', () => {
    const folder = writeFolder({ 'config.json': '{}' }, (m) => {
      m.files.push(m.files[0]);
    });

    expect(() => readManifest(folder)).toThrow(/twice/);
  });

  test.each([
    ['a bad sha256', (/** @type {any} */ e) => (e.sha256 = 'abc')],
    ['a bad size', (/** @type {any} */ e) => (e.bytes = '2')],
    ['no entry fields', (/** @type {any} */ e) => delete e.sha256],
  ])('should refuse %s', (_label, mutate) => {
    const folder = writeFolder({ 'config.json': '{}' }, (m) =>
      mutate(m.files[0])
    );

    expect(() => readManifest(folder)).toThrow(/malformed entry/);
  });

  test('should refuse an entry that is null', () => {
    const folder = writeFolder({ 'config.json': '{}' }, (m) => {
      m.files[0] = null;
    });

    expect(() => readManifest(folder)).toThrow(/unknown file/);
  });

  test('should refuse a listed file that is missing', () => {
    const folder = writeFolder({ 'config.json': '{}' });
    fs.rmSync(path.join(folder, 'config.json'));

    expect(() => readManifest(folder)).toThrow(/config\.json is missing/);
  });

  test('should refuse a changed file', () => {
    const folder = writeFolder({ 'config.json': '{}' });
    fs.writeFileSync(path.join(folder, 'config.json'), '{"x":1}');

    expect(() => readManifest(folder)).toThrow(/checksum/);
  });

  test('should refuse a same-size changed file', () => {
    const folder = writeFolder({ 'config.json': '{"a":1}' });
    fs.writeFileSync(path.join(folder, 'config.json'), '{"a":2}');

    expect(() => readManifest(folder)).toThrow(/checksum/);
  });

  test.skipIf(!POSIX)('should refuse a link instead of a file', () => {
    const folder = writeFolder({ 'config.json': '{}' });
    fs.rmSync(path.join(folder, 'config.json'));
    fs.writeFileSync(path.join(tmp, 'outside'), '{}');
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(folder, 'config.json'));

    expect(() => readManifest(folder)).toThrow(/not a regular file/);
  });
});

/** @param {object} [over] */
function restoreInput(over = {}) {
  return {
    dir: 'bk',
    yes: true,
    interactive: false,
    ask: async () => 'y',
    home: path.join(tmp, 'new-home'),
    createHome: () =>
      makeHome(path.join(tmp, 'new-home'), { message: 'snapshot B' }),
    configFile: path.join(tmp, 'cfg2', 'config.json'),
    profileFile: path.join(tmp, 'cfg2', 'dscc.env'),
    run: makeRun(),
    env: GIT_ENV,
    out: (/** @type {string} */ t) => out.push(t),
    err: (/** @type {string} */ t) => err.push(t),
    cwd: tmp,
    homedir: tmp,
    ...over,
  };
}

/**
 * Back up the source home into tmp/bk (with the key).
 *
 * @param {object} [config]  the source config file's content
 */
function makeBackup(config) {
  sourceHome();
  if (config) {
    fs.writeFileSync(
      path.join(tmp, 'cfg', 'config.json'),
      JSON.stringify(config)
    );
  }
  backupHome(backupInput({ dir: 'bk', includeKey: true }));
  pnpm = [];
  err = [];
  out = [];
}

describe('restoreBackup', () => {
  test('should restore commits, memory, config, and key into a fresh home', async () => {
    makeBackup();

    const code = await restoreBackup(restoreInput());

    const home = path.join(tmp, 'new-home');
    expect(code).toBe(0);
    expect(out).toEqual([home]);
    expect(fs.readFileSync(path.join(home, 'local.txt'), 'utf-8')).toBe(
      'mine\n'
    );
    expect(git(home, 'log', '--format=%s', '--no-merges')).toContain(
      'feat: local work'
    );
    expect(git(home, 'status', '--porcelain')).toBe('');
    expect(pnpm.map((c) => c.args.at(-1))).toEqual([
      '--dry-run',
      path.join(tmp, 'bk', 'memory.tar.gz'),
    ]);
    expect(pnpm.every((c) => c.cwd === home)).toBe(true);
    expect(pnpm.some((c) => c.args.includes('--replace'))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmp, 'cfg2', 'config.json'), 'utf-8')
      )
    ).toEqual({ addDir: true });
    expect(fs.readFileSync(path.join(tmp, 'cfg2', 'dscc.env'), 'utf-8')).toBe(
      'KEY=secret\n'
    );
    if (POSIX)
      expect(fs.statSync(path.join(tmp, 'cfg2', 'dscc.env')).mode & 0o777).toBe(
        0o600
      );
  });

  test('should drop a home from another place from the restored config', async () => {
    makeBackup({ home: path.join(tmp, 'elsewhere'), addDir: true });

    await restoreBackup(restoreInput());

    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmp, 'cfg2', 'config.json'), 'utf-8')
      )
    ).toEqual({ addDir: true });
    expect(err).toContain(
      `kyoten: the backup's config named the home ${path.join(tmp, 'elsewhere')}; restored without it (this home is ${path.join(tmp, 'new-home')})`
    );
  });

  test.skipIf(!POSIX)(
    'should replace a dangling link at the config path, not write through it',
    async () => {
      makeBackup();
      const target = path.join(tmp, 'elsewhere.json');
      fs.mkdirSync(path.join(tmp, 'cfg2'), { recursive: true });
      fs.symlinkSync(target, path.join(tmp, 'cfg2', 'config.json'));

      await restoreBackup(restoreInput());

      expect(fs.existsSync(target)).toBe(false);
      expect(fs.lstatSync(path.join(tmp, 'cfg2', 'config.json')).isFile()).toBe(
        true
      );
    }
  );

  test('should keep a home in the restored config that names this home', async () => {
    makeBackup({ home: path.join(tmp, 'new-home') });

    await restoreBackup(restoreInput());

    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmp, 'cfg2', 'config.json'), 'utf-8')
      )
    ).toEqual({ home: path.join(tmp, 'new-home') });
  });

  test('should merge once when the home shares the old snapshot', async () => {
    const home = path.join(tmp, 'home');
    makeHome(home);
    git(tmp, 'clone', '-q', home, path.join(tmp, 'new-home'));
    git(path.join(tmp, 'new-home'), 'branch', 'kyoten/upstream');
    commitFile(home, 'local.txt', 'mine\n', 'feat: local work');
    backupHome(backupInput({ dir: 'bk' }));

    await restoreInput();
    await restoreBackup(restoreInput());

    const target = path.join(tmp, 'new-home');
    expect(fs.existsSync(path.join(target, 'local.txt'))).toBe(true);
    expect(git(target, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  });

  test('should say the commits are already there on a second restore', async () => {
    makeBackup();
    await restoreBackup(restoreInput());
    err = [];

    await restoreBackup(restoreInput());

    expect(err.join('\n')).toContain('already in main');
  });

  test('should keep a current config and profile', async () => {
    makeBackup();
    fs.mkdirSync(path.join(tmp, 'cfg2'));
    fs.writeFileSync(path.join(tmp, 'cfg2', 'config.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'cfg2', 'dscc.env'), 'MINE=1\n');

    await restoreBackup(restoreInput());

    expect(
      fs.readFileSync(path.join(tmp, 'cfg2', 'config.json'), 'utf-8')
    ).toBe('{}');
    expect(fs.readFileSync(path.join(tmp, 'cfg2', 'dscc.env'), 'utf-8')).toBe(
      'MINE=1\n'
    );
    expect(err.join('\n')).toContain('kept the current');
  });

  test('should work on an existing workspace without creating a home', async () => {
    makeBackup();
    makeHome(path.join(tmp, 'new-home'), { message: 'snapshot B' });
    const createHome = vi.fn();

    await restoreBackup(restoreInput({ createHome }));

    expect(createHome).not.toHaveBeenCalled();
  });

  test('should restore a backup without local commits', async () => {
    const home = path.join(tmp, 'home');
    makeHome(home);
    backupHome(backupInput({ dir: 'bk' }));

    await restoreBackup(restoreInput());

    expect(err.join('\n')).toContain('no local commits');
  });

  test('should show the dry run and ask in a terminal', async () => {
    makeBackup();
    /** @type {string[]} */
    const questions = [];

    await restoreBackup(
      restoreInput({
        yes: false,
        interactive: true,
        ask: async (/** @type {string} */ q) => {
          questions.push(q);
          return 'yes';
        },
      })
    );

    expect(questions[0]).toContain('[y/N]');
    expect(pnpm).toHaveLength(2);
  });

  test('should list the backup commits and keep them aside when the merge is declined', async () => {
    makeBackup();
    /** @type {string[]} */
    const questions = [];

    const code = await restoreBackup(
      restoreInput({
        yes: false,
        interactive: true,
        ask: async (/** @type {string} */ q) => {
          questions.push(q);
          return q.startsWith('Merge') ? 'n' : 'y';
        },
      })
    );

    const home = path.join(tmp, 'new-home');
    expect(code).toBe(0);
    expect(questions[0]).toBe(`Merge 1 commit into main of ${home}? [y/N] `);
    expect(err.join('\n')).toMatch(
      /kyoten: the backup has 1 commit of yours:\n  [0-9a-f]+ feat: local work/
    );
    expect(fs.existsSync(path.join(home, 'local.txt'))).toBe(false);
    expect(err).toContain(
      `kyoten: commits not merged; they stay in refs/kyoten/restored (git -C "${home}" merge refs/kyoten/restored)`
    );
  });

  test('should warn when the backup commits change files that run code', async () => {
    const source = sourceHome();
    fs.mkdirSync(path.join(source, '.githooks'));
    commitFile(source, '.githooks/pre-commit', 'echo hi\n', 'chore: hook');
    backupHome(backupInput({ dir: 'bk' }));
    err = [];

    await restoreBackup(restoreInput());

    expect(err).toContain(
      'kyoten: they change files that run code or configure the agents: .githooks/pre-commit; restore only a backup you made yourself'
    );
    expect(err.join('\n')).toContain('the backup has 2 commits of yours');
  });

  test('should skip the memory import when the answer is no', async () => {
    makeBackup();

    const code = await restoreBackup(
      restoreInput({ yes: false, interactive: true, ask: async () => '' })
    );

    expect(code).toBe(0);
    expect(pnpm).toHaveLength(1);
    expect(err.join('\n')).toContain('memory not imported');
  });

  test('should require --yes without a terminal before changing anything', async () => {
    makeBackup();

    await expect(restoreBackup(restoreInput({ yes: false }))).rejects.toThrow(
      /asks before it merges commits or imports memory[\s\S]*restore <dir> --yes/
    );
    expect(fs.existsSync(path.join(tmp, 'new-home'))).toBe(false);
  });

  test('should refuse a folder that fails its checksums', async () => {
    makeBackup();
    fs.appendFileSync(path.join(tmp, 'bk', 'memory.tar.gz'), 'x');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(/checksum/);
    expect(fs.existsSync(path.join(tmp, 'new-home'))).toBe(false);
  });

  test('should refuse a home that is not a workspace', async () => {
    makeBackup();
    fs.mkdirSync(path.join(tmp, 'new-home'));
    fs.writeFileSync(path.join(tmp, 'new-home', 'x'), '1');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /not a kyoten workspace/
    );
  });

  test('should refuse a home with uncommitted changes to tracked files', async () => {
    makeBackup();
    makeHome(path.join(tmp, 'new-home'), { message: 'snapshot B' });
    fs.appendFileSync(path.join(tmp, 'new-home', 'a.txt'), 'dirty\n');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /uncommitted changes/
    );
    expect(fs.existsSync(path.join(tmp, 'new-home', 'local.txt'))).toBe(false);
  });

  test('should refuse a home in the middle of a merge', async () => {
    makeBackup();
    const target = path.join(tmp, 'new-home');
    makeHome(target, { message: 'snapshot B' });
    fs.writeFileSync(path.join(target, '.git', 'MERGE_HEAD'), 'x');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /merge is in progress/
    );
  });

  test('should refuse a home that is not a git repository', async () => {
    makeBackup();
    const target = path.join(tmp, 'new-home');
    makeHome(target, { message: 'snapshot B' });
    fs.rmSync(path.join(target, '.git'), { recursive: true });

    await expect(restoreBackup(restoreInput())).rejects.toThrow(/cannot read/);
  });

  test('should refuse a home that is not on main', async () => {
    makeBackup();
    const target = path.join(tmp, 'new-home');
    makeHome(target, { message: 'snapshot B' });
    git(target, 'switch', '-q', '-c', 'side');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /not on its main branch/
    );
  });

  test('should refuse a detached HEAD', async () => {
    makeBackup();
    const target = path.join(tmp, 'new-home');
    makeHome(target, { message: 'snapshot B' });
    git(target, 'checkout', '-q', '--detach');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /not on its main branch/
    );
  });

  test('should leave a conflict as an ordinary git conflict with a Fix line', async () => {
    const home = path.join(tmp, 'home');
    makeHome(home);
    git(tmp, 'clone', '-q', home, path.join(tmp, 'new-home'));
    git(path.join(tmp, 'new-home'), 'branch', 'kyoten/upstream');
    commitFile(home, 'a.txt', 'one\nMINE\nthree\n', 'feat: mine');
    backupHome(backupInput({ dir: 'bk' }));
    const target = path.join(tmp, 'new-home');
    commitFile(target, 'a.txt', 'one\nTHEIRS\nthree\n', 'feat: theirs');

    await expect(restoreBackup(restoreInput())).rejects.toThrow(
      /did not finish[\s\S]*Fix:/
    );
    expect(fs.existsSync(path.join(target, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  test('should report an unreadable bundle', async () => {
    const folder = writeFolder({ 'local.bundle': 'not a bundle' });
    makeHome(path.join(tmp, 'new-home'));

    await expect(restoreBackup(restoreInput({ dir: folder }))).rejects.toThrow(
      /bundle in the backup could not be read/
    );
  });

  test('should report a failed linking merge', async () => {
    makeBackup();
    const real = makeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const run = (bin, args, options) =>
      args.includes('--allow-unrelated-histories')
        ? { status: 1 }
        : real(bin, args, options);

    await expect(restoreBackup(restoreInput({ run }))).rejects.toThrow(
      /linking the old snapshot did not finish/
    );
  });

  test.each([
    ['dry run', { dryStatus: 1 }],
    ['import', { importStatus: 1 }],
  ])('should report a failed memory %s', async (_label, fail) => {
    makeBackup();

    await expect(
      restoreBackup(restoreInput({ run: makeRun(fail) }))
    ).rejects.toThrow(/no import[\s\S]*Fix:/);
  });

  test('should refuse an unusable config in the backup', async () => {
    const folder = writeFolder({ 'config.json': '{"nope":1}' });
    makeHome(path.join(tmp, 'new-home'));

    await expect(restoreBackup(restoreInput({ dir: folder }))).rejects.toThrow(
      /config in the backup cannot be used/
    );
  });
});

describe('backup folder', () => {
  test('should ignore itself in any git work tree', () => {
    sourceHome();

    backupHome(backupInput({ dir: 'bk' }));

    expect(fs.readFileSync(path.join(tmp, 'bk', '.gitignore'), 'utf-8')).toBe(
      '*\n'
    );
  });
});

describe('pnpm children', () => {
  test('should not see a repository-picking GIT_* variable', async () => {
    sourceHome();
    const env = { ...GIT_ENV, GIT_DIR: path.join(tmp, 'other.git') };

    backupHome(backupInput({ dir: 'bk', env }));
    await restoreBackup(restoreInput({ env }));

    expect(pnpm.length).toBeGreaterThan(1);
    expect(pnpm.every((call) => call.env && !('GIT_DIR' in call.env))).toBe(
      true
    );
  });
});

describe('restoreSummary', () => {
  test('should shorten long lists', () => {
    const commits = Array.from({ length: 12 }, (_, i) => `c${i} feat: ${i}`);
    const risky = Array.from({ length: 11 }, (_, i) => `utils/f${i}.js`);

    const lines = restoreSummary({ commits, risky });

    expect(lines[0]).toBe('kyoten: the backup has 12 commits of yours:');
    expect(lines).toContain('  … and 2 more');
    expect(lines.at(-1)).toContain('utils/f9.js and 1 more; restore only');
  });

  test('should say nothing about code without such files', () => {
    expect(restoreSummary({ commits: ['a x'], risky: [] })).toEqual([
      'kyoten: the backup has 1 commit of yours:',
      '  a x',
    ]);
  });
});
