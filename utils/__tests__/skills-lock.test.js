import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  LOCAL_LOCK_FILE,
  checkSkills,
  readMergedSkillsLock,
  readOptionalSkillsLock,
  readSkillsLock,
  restoreFileSnapshot,
  writeSkillsLock,
} from '../skills-lock.js';

/** @type {string[]} */
let tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-lock-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string | null} [frontmatterName]
 */
async function writeSkill(root, name, frontmatterName = name) {
  const dir = path.join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  const body =
    frontmatterName === null
      ? 'no frontmatter\n'
      : `---\nname: ${frontmatterName}\ndescription: test\n---\n`;
  await writeFile(path.join(dir, 'SKILL.md'), body);
}

/**
 * @param {string} root
 * @param {Record<string, { computedHash?: string }>} skills
 * @returns {Promise<string>}
 */
async function writeLock(root, skills) {
  const lockPath = path.join(root, 'skills-lock.json');
  await writeFile(lockPath, JSON.stringify({ version: 1, skills }));
  return lockPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

describe('readSkillsLock', () => {
  test('reads a valid lock', async () => {
    const dir = await makeTempDir();
    const lockPath = await writeLock(dir, {
      alpha: { computedHash: 'abc' },
    });

    await expect(readSkillsLock(lockPath)).resolves.toEqual({
      version: 1,
      skills: { alpha: { computedHash: 'abc' } },
    });
  });

  test.each([
    ['null', 'null'],
    ['missing skills', '{}'],
    ['non-object skills', JSON.stringify({ skills: 'nope' })],
    ['array skills', JSON.stringify({ skills: [] })],
  ])('rejects %s', async (_name, content) => {
    const dir = await makeTempDir();
    const lockPath = path.join(dir, 'skills-lock.json');
    await writeFile(lockPath, content);

    await expect(readSkillsLock(lockPath)).rejects.toThrow(
      'Invalid skills lock'
    );
  });
});

describe('checkSkills', () => {
  test('reports a matching skill', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha');
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      { name: 'alpha', ok: true, actualName: 'alpha' },
    ]);
  });

  test('reports a missing skill', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      { name: 'alpha', ok: false, missing: true, actualName: null },
    ]);
  });

  test('reports a frontmatter name mismatch', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha', 'beta');
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: 'beta',
      },
    ]);
  });

  test('reports a missing frontmatter name', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha', null);
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: null,
      },
    ]);
  });

  test('reports a frontmatter block without a name', async () => {
    const root = await makeTempDir();
    const skillDir = path.join(root, '.agents', 'skills', 'alpha');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: test\n---\n'
    );
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: null,
      },
    ]);
  });

  test('rethrows unexpected filesystem errors', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.agents', 'skills', 'alpha', 'SKILL.md'), {
      recursive: true,
    });
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).rejects.toThrow();
  });

  test('checks skills listed in skills-lock.local.json alongside skills-lock.json', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha');
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });
    await writeFile(
      path.join(root, LOCAL_LOCK_FILE),
      JSON.stringify({
        version: 2,
        skills: { beta: { source: 'owner/opt-in', computedHash: 'local' } },
      })
    );

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      { name: 'alpha', ok: true, actualName: 'alpha' },
      { name: 'beta', ok: false, missing: true, actualName: null },
    ]);
  });
});

describe('readOptionalSkillsLock', () => {
  test('returns null when the lock file does not exist', async () => {
    const dir = await makeTempDir();

    await expect(
      readOptionalSkillsLock(path.join(dir, LOCAL_LOCK_FILE))
    ).resolves.toBeNull();
  });

  test('reads an existing lock file', async () => {
    const dir = await makeTempDir();
    const localPath = path.join(dir, LOCAL_LOCK_FILE);
    await writeFile(
      localPath,
      JSON.stringify({ version: 2, skills: { opt: { source: 'owner/repo' } } })
    );

    await expect(readOptionalSkillsLock(localPath)).resolves.toEqual({
      version: 2,
      skills: { opt: { source: 'owner/repo' } },
    });
  });

  test('rethrows unexpected filesystem or validation errors', async () => {
    const dir = await makeTempDir();
    const badPath = path.join(dir, LOCAL_LOCK_FILE);
    await writeFile(badPath, 'not-json');

    await expect(readOptionalSkillsLock(badPath)).rejects.toThrow();
  });
});

describe('readMergedSkillsLock', () => {
  test('merges tracked and local locks with tracked entries taking precedence', async () => {
    const dir = await makeTempDir();
    const lockPath = await writeLock(dir, {
      shared: { computedHash: 'tracked' },
      trackedOnly: { computedHash: 'base' },
    });
    const localLockPath = path.join(dir, LOCAL_LOCK_FILE);
    await writeFile(
      localLockPath,
      JSON.stringify({
        version: 2,
        skills: {
          shared: { computedHash: 'local-shadow' },
          localOnly: { computedHash: 'local' },
        },
      })
    );

    const merged = await readMergedSkillsLock({ lockPath, localLockPath });

    expect(merged.skills).toEqual({
      localOnly: { computedHash: 'local' },
      shared: { computedHash: 'tracked' },
      trackedOnly: { computedHash: 'base' },
    });
  });

  test('returns the base lock when no local lock exists', async () => {
    const dir = await makeTempDir();
    const lockPath = await writeLock(dir, { alpha: { computedHash: 'a' } });

    const merged = await readMergedSkillsLock({ lockPath });

    expect(merged).toEqual({
      version: 1,
      skills: { alpha: { computedHash: 'a' } },
    });
  });
  test('skips the local lock when localLockPath is null', async () => {
    const dir = await makeTempDir();
    const lockPath = await writeLock(dir, { alpha: { computedHash: 'a' } });
    await writeFile(
      path.join(dir, LOCAL_LOCK_FILE),
      JSON.stringify({ version: 2, skills: { beta: { computedHash: 'b' } } })
    );

    const merged = await readMergedSkillsLock({
      lockPath,
      localLockPath: null,
    });

    expect(merged.skills).toEqual({ alpha: { computedHash: 'a' } });
  });
});

describe('restoreFileSnapshot', () => {
  test('is a no-op when removing a file that does not exist', async () => {
    const dir = await makeTempDir();
    expect(() =>
      restoreFileSnapshot(path.join(dir, 'missing.json'), null)
    ).not.toThrow();
  });

  test('rethrows non-ENOENT unlink errors', async () => {
    const dir = await makeTempDir();
    expect(() => restoreFileSnapshot(dir, null)).toThrow();
  });
});

describe('writeSkillsLock', () => {
  test('writes skills sorted by key with a trailing newline', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, LOCAL_LOCK_FILE);

    writeSkillsLock(file, {
      skills: {
        zeta: { source: 'owner/z' },
        alpha: { source: 'owner/a' },
      },
    });

    const raw = await readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).version).toBe(2);
    expect(Object.keys(JSON.parse(raw).skills)).toEqual(['alpha', 'zeta']);
  });
});
