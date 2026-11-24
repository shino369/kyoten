import fs from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { addSkills, main, parseArgs } from '../skills-add.js';
import { LOCAL_LOCK_FILE } from '../skills-lock.js';

/** @type {string[]} */
let tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-add-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {Record<string, Record<string, unknown>>} skills
 */
async function writeTrackedLock(root, skills) {
  const lockPath = path.join(root, 'skills-lock.json');
  const content = JSON.stringify({ version: 2, skills }, null, 2) + '\n';
  await writeFile(lockPath, content);
  return { lockPath, content };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

describe('parseArgs', () => {
  test('should parse source with space- and comma-separated skills', () => {
    expect(
      parseArgs([
        'shino369/kyoten-skills',
        '--skill',
        'transparent-background',
        'game-image-extraction,transparent-background',
      ])
    ).toEqual({
      source: 'shino369/kyoten-skills',
      skills: ['transparent-background', 'game-image-extraction'],
      tracked: false,
      targets: ['.claude\\skills'.replace('\\', path.sep)],
      help: false,
    });
  });

  test('should parse short flags, inline values, and --skill before source', () => {
    expect(
      parseArgs([
        '-s',
        'alpha,beta',
        'owner/repo',
        '--tracked',
        '--target=.dsh/skills',
        '--target',
        '.custom/skills',
      ])
    ).toEqual({
      source: 'owner/repo',
      skills: ['alpha', 'beta'],
      tracked: true,
      targets: [
        path.join('.claude', 'skills'),
        '.dsh/skills',
        '.custom/skills',
      ],
      help: false,
    });
  });

  test('should parse inline --skill= and repeatable -s', () => {
    expect(
      parseArgs(['owner/repo', '--skill=alpha', '-s=beta', '--skill', 'gamma'])
    ).toMatchObject({
      source: 'owner/repo',
      skills: ['alpha', 'beta', 'gamma'],
    });
  });

  test.each([[['--help']], [['-h']], [['owner/repo', '--help']]])(
    'should detect help flag in %j',
    (argv) => {
      expect(parseArgs(argv).help).toBe(true);
    }
  );

  test('should reject missing or empty --skill value', () => {
    expect(() => parseArgs(['owner/repo', '--skill'])).toThrow(
      /--skill needs at least one skill name/
    );
    expect(() => parseArgs(['owner/repo', '--skill='])).toThrow(
      /--skill needs at least one skill name/
    );
    expect(() => parseArgs(['owner/repo', '--skill', '--tracked'])).toThrow(
      /--skill needs at least one skill name/
    );
    expect(() => parseArgs(['owner/repo', '--skill', ','])).toThrow(
      /--skill needs at least one skill name/
    );
  });

  test('should reject inline values on boolean --tracked flag', () => {
    expect(() =>
      parseArgs(['owner/repo', '--skill', 'a', '--tracked=false'])
    ).toThrow(/Unknown option: --tracked=false/);
  });

  test('should reject missing --target value', () => {
    expect(() => parseArgs(['owner/repo', '--skill', 'a', '--target'])).toThrow(
      /--target needs a directory/
    );
  });

  test('should reject unknown flags', () => {
    expect(() => parseArgs(['owner/repo', '--skill', 'a', '--bogus'])).toThrow(
      /Unknown option: --bogus/
    );
  });

  test('should reject unexpected extra positional arguments', () => {
    expect(() => parseArgs(['owner/a', 'owner/b', '--skill', 'alpha'])).toThrow(
      /Unexpected argument: owner\/b/
    );
  });

  test('should reject missing source or missing skills when not asking for help', () => {
    expect(() => parseArgs(['--skill', 'alpha'])).toThrow(
      /Missing skill source/
    );
    expect(() => parseArgs(['owner/repo'])).toThrow(/Missing --skill/);
  });
});

describe('addSkills', () => {
  test('should install opt-in skills, record metadata in skills-lock.local.json, restore skills-lock.json, and link', async () => {
    const root = await makeTempDir();
    const { lockPath, content: originalRaw } = await writeTrackedLock(root, {
      'dependency-update': {
        source: 'shino369/kyoten-skills',
        sourceType: 'github',
        skillPath: 'skills/dependencies/dependency-update/SKILL.md',
        computedHash: 'dep-hash',
      },
    });
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);
    /** @type {Array<{ cmd: string, args: string[], opts: object }>} */
    const spawnCalls = [];
    const spawn = (
      /** @type {string} */ cmd,
      /** @type {string[]} */ args,
      /** @type {object} */ opts
    ) => {
      spawnCalls.push({ cmd, args, opts });
      // Simulate skills.sh writing the new opt-in skill into tracked skills-lock.json.
      fs.writeFileSync(
        lockPath,
        JSON.stringify(
          {
            version: 2,
            skills: {
              'dependency-update': {
                source: 'shino369/kyoten-skills',
                sourceType: 'github',
                skillPath: 'skills/dependencies/dependency-update/SKILL.md',
                computedHash: 'dep-hash',
              },
              'transparent-background': {
                source: 'shino369/kyoten-skills',
                sourceType: 'github',
                skillPath: 'skills/creative/transparent-background/SKILL.md',
                computedHash: 'tb-hash',
              },
            },
          },
          null,
          2
        ) + '\n'
      );
      return { status: 0 };
    };
    const linkMock = vi.fn(
      () =>
        /** @type {import('../skills-link.js').LinkResult[]} */ ([
          { target: '.claude/skills', name: 'dependency-update', status: 'ok' },
          {
            target: '.claude/skills',
            name: 'transparent-background',
            status: 'linked',
            detail: 'symlink',
          },
        ])
    );
    /** @type {string[]} */
    const lines = [];

    const code = await addSkills({
      source: 'shino369/kyoten-skills',
      skills: ['transparent-background'],
      rootDir: root,
      lockPath,
      localLockPath,
      spawn,
      link: linkMock,
      log: (line) => lines.push(line),
      platform: 'linux',
    });

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('pnpm');
    expect(spawnCalls[0].args).toEqual([
      'dlx',
      'skills',
      'add',
      'shino369/kyoten-skills',
      '--skill',
      'transparent-background',
      '--agent',
      'claude-code',
      'codex',
      '-y',
    ]);
    expect(spawnCalls[0].opts).toMatchObject({ cwd: root, shell: false });
    expect(await readFile(lockPath, 'utf8')).toBe(originalRaw);
    expect(JSON.parse(await readFile(localLockPath, 'utf8'))).toEqual({
      version: 2,
      skills: {
        'transparent-background': {
          source: 'shino369/kyoten-skills',
          sourceType: 'github',
          skillPath: 'skills/creative/transparent-background/SKILL.md',
          computedHash: 'tb-hash',
        },
      },
    });
    expect(linkMock).toHaveBeenCalledWith({
      rootDir: root,
      targets: [path.join('.claude', 'skills')],
      platform: 'linux',
    });
    expect(lines.some((l) => l.includes('skills-lock.local.json'))).toBe(true);
  });

  test('should preserve existing skills-lock.local.json entries and fall back to source when skills.sh omits lock entry', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);
    await writeFile(
      localLockPath,
      JSON.stringify({
        version: 2,
        skills: { existing: { source: 'owner/existing' } },
      })
    );

    const code = await addSkills({
      source: 'owner/new',
      skills: ['fresh-skill'],
      rootDir: root,
      lockPath,
      localLockPath,
      spawn: () => ({ status: 0 }),
      link: () => [],
      log: () => {},
      platform: 'win32',
    });

    expect(code).toBe(0);
    expect(JSON.parse(await readFile(localLockPath, 'utf8'))).toEqual({
      version: 2,
      skills: {
        existing: { source: 'owner/existing' },
        'fresh-skill': { source: 'owner/new' },
      },
    });
  });

  test('should not duplicate a skill into skills-lock.local.json if it is already in skills-lock.json', async () => {
    const root = await makeTempDir();
    const { lockPath, content: originalRaw } = await writeTrackedLock(root, {
      alpha: { source: 'owner/repo', computedHash: 'a' },
    });
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);
    /** @type {string[]} */
    const lines = [];

    const code = await addSkills({
      source: 'owner/repo',
      skills: ['alpha'],
      rootDir: root,
      lockPath,
      localLockPath,
      spawn: () => ({ status: 0 }),
      link: () => [],
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(await readFile(lockPath, 'utf8')).toBe(originalRaw);
    expect(fs.existsSync(localLockPath)).toBe(false);
    expect(lines.some((l) => l.includes('already tracked'))).toBe(true);
  });

  test('should restore tracked skills-lock.json and skip local lock update when skills add fails', async () => {
    const root = await makeTempDir();
    const { lockPath, content: originalRaw } = await writeTrackedLock(root, {
      alpha: { source: 'owner/a' },
    });
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);
    const linkMock = vi.fn();
    /** @type {string[]} */
    const lines = [];

    const code = await addSkills({
      source: 'owner/b',
      skills: ['broken'],
      rootDir: root,
      lockPath,
      localLockPath,
      spawn: () => {
        fs.writeFileSync(lockPath, '{"version":2,"skills":{"dirty":{}}}\n');
        return { status: 1 };
      },
      link: linkMock,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(await readFile(lockPath, 'utf8')).toBe(originalRaw);
    expect(fs.existsSync(localLockPath)).toBe(false);
    expect(linkMock).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('exit 1'))).toBe(true);
  });

  test('should remove newly created skills-lock.json when none existed before', async () => {
    const root = await makeTempDir();
    const lockPath = path.join(root, 'skills-lock.json');
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);

    const code = await addSkills({
      source: 'owner/repo',
      skills: ['opt'],
      rootDir: root,
      lockPath,
      localLockPath,
      spawn: () => {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            version: 2,
            skills: { opt: { source: 'owner/repo' } },
          })
        );
        return { status: 0 };
      },
      link: () => [],
      log: () => {},
    });

    expect(code).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      JSON.parse(await readFile(localLockPath, 'utf8')).skills.opt
    ).toEqual({
      source: 'owner/repo',
    });
  });

  test('should keep skills-lock.json changes and skip local lock when --tracked is set', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);

    const code = await addSkills({
      source: 'owner/repo',
      skills: ['promoted'],
      tracked: true,
      rootDir: root,
      lockPath,
      localLockPath,
      spawn: () => {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            version: 2,
            skills: { promoted: { source: 'owner/repo' } },
          })
        );
        return { status: 0 };
      },
      link: () => [],
      log: () => {},
    });

    expect(code).toBe(0);
    expect(
      JSON.parse(await readFile(lockPath, 'utf8')).skills.promoted
    ).toEqual({
      source: 'owner/repo',
    });
    expect(fs.existsSync(localLockPath)).toBe(false);
  });

  test('should refuse unsafe source or skill names before spawning', async () => {
    const root = await makeTempDir();
    const spawn = vi.fn();
    /** @type {string[]} */
    const lines = [];

    expect(
      await addSkills({
        source: 'owner/repo & calc',
        skills: ['alpha'],
        rootDir: root,
        spawn,
        link: () => [],
        log: (line) => lines.push(line),
      })
    ).toBe(1);
    expect(
      await addSkills({
        source: 'owner/repo',
        skills: ['Bad Name'],
        rootDir: root,
        spawn,
        link: () => [],
        log: (line) => lines.push(line),
      })
    ).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should return 1 when skills:link reports problems', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    /** @type {string[]} */
    const lines = [];

    const code = await addSkills({
      source: 'owner/repo',
      skills: ['alpha'],
      rootDir: root,
      lockPath,
      localLockPath: path.join(root, LOCAL_LOCK_FILE),
      spawn: () => ({ status: 0 }),
      link: () => [
        {
          target: '.claude/skills',
          name: 'alpha',
          status: 'conflict',
          detail: 'shadowed',
        },
      ],
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes('conflict'))).toBe(true);
  });

  test('should fail fast before spawning when skills-lock.local.json is malformed', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    const localLockPath = path.join(root, LOCAL_LOCK_FILE);
    await writeFile(localLockPath, 'not-valid-json');
    const spawn = vi.fn();

    await expect(
      addSkills({
        source: 'owner/repo',
        skills: ['alpha'],
        rootDir: root,
        lockPath,
        localLockPath,
        spawn,
        link: () => [],
        log: () => {},
      })
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should handle unknown exit status from spawn', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    /** @type {string[]} */
    const lines = [];

    const code = await addSkills({
      source: 'owner/repo',
      skills: ['alpha'],
      rootDir: root,
      lockPath,
      localLockPath: path.join(root, LOCAL_LOCK_FILE),
      spawn: () => ({ status: null }),
      link: () => [],
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes('exit unknown'))).toBe(true);
  });
});

describe('main', () => {
  test.each([[['--help']], [['-h']]])(
    'should print usage for %j without spawning',
    async (argv) => {
      const log = vi.fn();
      const spawn = vi.fn();

      expect(await main({ argv, log, spawn })).toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: pnpm skills:add')
      );
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  test('should run addSkills with parsed CLI arguments', async () => {
    const root = await makeTempDir();
    const { lockPath } = await writeTrackedLock(root, {});
    const spawn = vi.fn(() => ({ status: 0 }));

    const code = await main({
      argv: ['owner/repo', '--skill', 'alpha'],
      rootDir: root,
      lockPath,
      localLockPath: path.join(root, LOCAL_LOCK_FILE),
      spawn,
      link: () => [],
      log: () => {},
    });

    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
