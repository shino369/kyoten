import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { freshQuality } from '../quality.js';
import {
  DIFF_CONTEXT_LINES,
  FINDINGS_HEADER,
  FOLDER_BASE,
  MAX_DIFF_FILE_BYTES,
  MAX_DIFF_TOTAL_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  SEVERITY_RUBRIC,
  STATIC_PROTECTED_EXCLUDES,
  PACK_MAX_TOTAL_BYTES,
  buildReviewPack,
  buildTriagePack,
  classifyDiffFile,
  sortReviewFiles,
  defaultRunGit,
  defaultRunGitStatus,
  diffStats,
  findingsTemplate,
  fingerprint,
  formatReviewBrief,
  generateIncrementalDiff,
  generateReviewDiff,
  isSecretFile,
  listSnapshotFiles,
  listSnapshotScope,
  listSnapshotSkipped,
  openRound,
  parseFindings,
  previousSnapshotDir,
  recordFindings,
  defaultBranch,
  hasProductCode,
  productFiles,
  reviewBase,
  reviewFiles,
  reviewPreflight,
  reviewScope,
  roundBase,
  saveSnapshot,
  scopeRoot,
  snapshotDirFor,
  splitRow,
  taskFolderNotes,
  taskReviewScope,
} from '../review.js';
import { createState, makeSteps } from '../state.js';

const NAME = 'demo-261117';
const GREEN = {
  at: '2026-11-18T00:00:00.000Z',
  ok: true,
  failed: null,
  summary: 'ok',
};

test('should review production before config, tests, and docs with tiered context', () => {
  const files = [
    'README.md',
    'a.test.js',
    '.claude/agents/reviewer.md',
    'z.js',
    'a.yml',
  ];
  expect(sortReviewFiles(files)).toEqual([
    'z.js',
    '.claude/agents/reviewer.md',
    'a.yml',
    'a.test.js',
    'README.md',
  ]);
  expect(files.map((file) => classifyDiffFile(file).contextLines)).toEqual([
    3, 3, 5, 8, 5,
  ]);
});

test('should build a capped round 2 review pack from incremental evidence and the plan', () => {
  const input = {
    state: codeState(),
    round: 2,
    repoDir: '/unused',
    scope: { base: 'main', since: 'base', files: ['app.js', 'docs/note.md'] },
    planText:
      'Goal: Fix this\nAcceptance: new test passes\n\n## Notes\nPrivate history\n',
    diff: 'FULL ONLY',
    incrementalDiff:
      'diff --git a/app.js b/app.js\n@@ -1 +1 @@\n+incremental proof\ndiff --git a/docs/note.md b/docs/note.md\n+' +
      'あ'.repeat(PACK_MAX_TOTAL_BYTES),
  };
  const pack = buildReviewPack(input);
  expect(pack).toContain('BEGIN FINDINGS');
  expect(pack).toContain('new test passes');
  expect(pack).toContain('incremental proof');
  expect(pack).not.toContain('FULL ONLY');
  expect(pack).not.toContain('Private history');
  expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(PACK_MAX_TOTAL_BYTES);
});

test('should inline safe task code and deduplicate triage windows', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pack-'));
  try {
    fs.writeFileSync(
      path.join(repoDir, 'app.js'),
      'export const evidence = 42;\n'
    );
    fs.writeFileSync(
      path.join(repoDir, 'credentials.json'),
      'protected payload'
    );
    const input = {
      state: codeState(),
      round: 1,
      repoDir,
      scope: { base: null, since: null, files: ['app.js', 'credentials.json'] },
      planText: 'Acceptance: Evidence appears.',
    };
    const review = buildReviewPack(input);
    expect(review).toContain('export const evidence = 42;');
    expect(review).not.toContain('protected payload');
    const rows = [
      '| | app.js:1 | high | claim | scenario | | |',
      '| | app.js:1 | medium | second claim | second scenario | | |',
      '| | ../outside.js:1 | high | outside | scenario | | |',
    ];
    const triage = buildTriagePack({ ...input, rows });
    expect(triage).toContain('Evidence appears.');
    expect(triage.match(/export const evidence/g)).toHaveLength(1);
    expect(triage).toContain('second claim');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

/** @param {Partial<import('../state.js').TaskState>} [overrides] */
function codeState(overrides = {}) {
  return {
    ...createState({
      name: NAME,
      goal: 'Ship it',
      steps: makeSteps(['Build']).map((step) => ({
        ...step,
        status: /** @type {const} */ ('done'),
      })),
      verify: ['pnpm test'],
      kind: 'code',
    }),
    lastVerify: GREEN,
    ...overrides,
  };
}

/**
 * @param {Partial<import('../quality.js').Finding>} [overrides]
 * @returns {import('../quality.js').Finding}
 */
function finding(overrides = {}) {
  return {
    id: 'r1-1',
    round: 1,
    file: 'app/a.js',
    line: 3,
    severity: 'high',
    claim: 'Loses writes',
    scenario: 'Two saves at once → one is lost',
    verdict: 'CONFIRMED',
    reason: 'No lock around save',
    step: null,
    ...overrides,
  };
}

const table = (/** @type {string[]} */ ...rows) =>
  [
    '# Review',
    '',
    `| ${FINDINGS_HEADER.join(' | ')} |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Trailing text',
  ].join('\n');

/**
 * @param {string} dir
 * @param {...string} files empty files to create, relative to `dir`
 */
function touch(dir, ...files) {
  for (const rel of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
}

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reviewFiles', () => {
  test('should name the brief, findings, and diff files by round', () => {
    expect(reviewFiles(NAME, 2)).toEqual({
      brief: `reviews/BRIEF_${NAME}-r2.md`,
      findings: `reviews/REVIEW_${NAME}-r2.md`,
      diff: `reviews/DIFF_${NAME}-r2.patch`,
      pack: `reviews/PACK_${NAME}-r2.md`,
      runLog: `reviews/RUN_${NAME}-r2.md`,
      incrementalDiff: `reviews/DIFF_${NAME}-r1-to-r2.patch`,
    });
    expect(reviewFiles(NAME, 1)).toEqual({
      brief: `reviews/BRIEF_${NAME}-r1.md`,
      findings: `reviews/REVIEW_${NAME}-r1.md`,
      diff: `reviews/DIFF_${NAME}-r1.patch`,
      pack: `reviews/PACK_${NAME}-r1.md`,
      runLog: `reviews/RUN_${NAME}-r1.md`,
    });
  });

  test('should cap diffs with the documented sizes', () => {
    expect(DIFF_CONTEXT_LINES).toBe(8);
    expect(MAX_DIFF_FILE_BYTES).toBe(40 * 1024);
    expect(MAX_DIFF_TOTAL_BYTES).toBe(200 * 1024);
    expect(SNAPSHOT_MAX_FILE_BYTES).toBe(256 * 1024);
  });
});

describe('defaultBranch', () => {
  test('should read origin/HEAD as the remote ref', () => {
    const runGit = vi.fn(() => 'origin/develop');
    expect(defaultBranch(runGit, '/r')).toBe('origin/develop');
    expect(runGit).toHaveBeenCalledWith(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      '/r'
    );
  });

  test('should fall back to main without origin/HEAD', () => {
    expect(defaultBranch(() => null, '/r')).toBe('main');
    expect(defaultBranch(() => 'upstream/trunk', '/r')).toBe('main');
  });
});

describe('reviewBase', () => {
  const taskDir = () => path.join(root, 'tasks', NAME);
  const withCode = () => {
    fs.mkdirSync(path.join(taskDir(), 'app'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'app', 'a.js'), '');
  };

  test("should keep the open round's base", () => {
    const quality = {
      ...freshQuality(),
      phase: /** @type {const} */ ('review'),
      base: 'dev',
    };
    expect(reviewBase({ quality, taskDir: taskDir(), base: 'main' })).toBe(
      'dev'
    );
    expect(
      reviewBase({
        quality: { ...quality, base: undefined },
        taskDir: taskDir(),
      })
    ).toBeNull();
  });

  test('should prefer --base, then the base an earlier round used', () => {
    withCode();
    const recorded = {
      ...freshQuality(),
      phase: /** @type {const} */ ('fix'),
      reviewRounds: 1,
      base: 'dev',
    };
    expect(
      reviewBase({ quality: recorded, taskDir: taskDir(), base: 'x' })
    ).toBe('x');
    expect(reviewBase({ quality: recorded, taskDir: taskDir() })).toBe('dev');
  });

  test('should default to the task folder for code, else main', () => {
    fs.mkdirSync(taskDir(), { recursive: true });
    const quality = { ...freshQuality(), base: null };
    expect(reviewBase({ quality, taskDir: taskDir() })).toBe('main');
    withCode();
    expect(reviewBase({ quality, taskDir: taskDir() })).toBeNull();
  });

  test('should stay on the task folder once a round chose it with --folder', () => {
    const stored = { ...freshQuality(), reviewRounds: 1, base: FOLDER_BASE };
    expect(
      reviewBase({ quality: { ...stored, phase: 'fix' }, taskDir: taskDir() })
    ).toBeNull();
    expect(
      reviewBase({
        quality: { ...stored, phase: 'review' },
        taskDir: taskDir(),
      })
    ).toBeNull();
    expect(reviewBase({ quality: stored, taskDir: taskDir(), base: 'x' })).toBe(
      'x'
    );
  });

  test('should review a page in docs/ from the task folder, but not a design doc', () => {
    touch(taskDir(), 'docs/design.md', 'docs/shot.png', 'data.json');
    expect(reviewBase({ quality: freshQuality(), taskDir: taskDir() })).toBe(
      'main'
    );
    touch(taskDir(), 'docs/index.html');
    expect(
      reviewBase({ quality: freshQuality(), taskDir: taskDir() })
    ).toBeNull();
  });

  test('should not count task scripts as the code under review', () => {
    fs.mkdirSync(path.join(taskDir(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'scripts', 'build.mjs'), '');
    expect(reviewBase({ quality: freshQuality(), taskDir: taskDir() })).toBe(
      'main'
    );
  });

  test('should review the repository of a repo task, even with task code', () => {
    withCode();
    expect(
      reviewBase({
        quality: freshQuality(),
        taskDir: taskDir(),
        repo: '/work/other',
      })
    ).toBe('main');
  });
});

describe('productFiles', () => {
  test('should list nothing for a missing task folder', () => {
    expect(productFiles(path.join(root, 'missing'))).toEqual([]);
    expect(hasProductCode(path.join(root, 'missing'))).toBe(false);
  });

  test('should count code in any language as product code, not config, docs, or data', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'data.json', 'app/config.yaml', 'docs/design.md');
    expect(hasProductCode(taskDir)).toBe(false);
    touch(taskDir, 'app/main.py');
    expect(hasProductCode(taskDir)).toBe(true);
  });

  test('should list task code and its config outside scripts/, docs/ included', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(
      taskDir,
      'scripts/x.mjs',
      'app/a.js',
      'app/main.py',
      'app/config.yaml',
      'docs/index.html',
      'docs/notes.md'
    );
    expect(productFiles(taskDir)).toEqual([
      'app/a.js',
      'app/config.yaml',
      'app/main.py',
      'docs/index.html',
    ]);
  });
});

describe('taskReviewScope', () => {
  test("should fall back to a task's scripts when they are its only work", () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'scripts', 'x.mjs'), '');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/scripts/x.mjs`],
    });
  });

  test('should fall back to helper scripts in any language, with their data', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'scripts/clean.py', 'data.json');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/data.json`, `tasks/${NAME}/scripts/clean.py`],
    });
  });

  test('should keep the task folder that --folder chose, beside git changes', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'scripts/clean.py');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abc' : args[0] === 'diff' ? 'utils/x.js' : ''
    );
    const state = codeState({
      quality: {
        ...freshQuality(),
        phase: 'complete',
        reviewRounds: 1,
        base: FOLDER_BASE,
      },
    });

    expect(taskReviewScope({ rootDir: root, taskDir, state, runGit })).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/scripts/clean.py`],
    });
  });

  test('should keep an empty git scope when the task folder has no code', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({ base: 'main', since: 'abc', files: [] });
  });

  test('should keep an empty git scope when an explicit base was given', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'scripts', 'x.mjs'), '');
    const runGit = vi.fn(() => 'abc');

    expect(
      taskReviewScope({
        rootDir: root,
        taskDir,
        state: codeState(),
        base: 'dev',
        runGit: (args) =>
          args[0] === 'diff' || args[0] === 'ls-files' ? '' : runGit(),
      }).files
    ).toEqual([]);
  });
});

describe('reviewPreflight', () => {
  /** @param {string[]} files @param {string | null} [base] */
  const scope = (files, base = 'main') => ({
    base,
    since: base === null ? null : 'abc123',
    files,
  });
  const taskDir = () => path.join(root, 'tasks', NAME);
  const quality = (
    /** @type {Partial<import('../quality.js').Quality>} */ overrides
  ) => ({
    ...freshQuality(),
    ...overrides,
  });

  test('should be eligible for a non-empty scope and fingerprint its files', () => {
    fs.writeFileSync(path.join(root, 'a.js'), 'a\n');

    const result = reviewPreflight({
      rootDir: root,
      taskDir: taskDir(),
      state: codeState(),
      scope: scope(['a.js']),
    });

    expect(result).toMatchObject({
      eligible: true,
      paths: ['a.js'],
      incremental: null,
    });
    expect(result.fingerprint).toBe(fingerprint(root, ['a.js']));
  });

  test('should keep an open round eligible without files', () => {
    const result = reviewPreflight({
      rootDir: root,
      taskDir: taskDir(),
      state: codeState({
        quality: quality({ phase: 'review', reviewRounds: 1 }),
      }),
      scope: scope([]),
    });

    expect(result).toMatchObject({
      eligible: true,
      paths: [],
      incremental: null,
    });
    expect(result.fingerprint).toBe(fingerprint(root, []));
  });

  test('should fall back to the previous snapshot when the git scope empties', () => {
    fs.writeFileSync(path.join(root, 'only.js'), 'gone\n');
    saveSnapshot({
      repoDir: root,
      dir: path.join(taskDir(), 'reviews', '.snapshot-r1'),
      files: ['only.js'],
    });
    fs.rmSync(path.join(root, 'only.js'));
    const state = codeState({
      quality: quality({
        phase: 'fix',
        reviewRounds: 1,
        reviewedDiff: fingerprint(root, ['only.js']),
      }),
    });

    const result = reviewPreflight({
      rootDir: root,
      taskDir: taskDir(),
      state,
      scope: scope([]),
      runGitStatus: defaultRunGitStatus,
    });

    expect(result.eligible).toBe(true);
    expect(result.paths).toEqual(['only.js']);
    expect(result.incremental).toContain('deleted file mode');
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}-[0-9a-f]{16}$/);
    expect(result.fingerprint).not.toBe(state.quality?.reviewedDiff);
  });

  test('should be ineligible for a genuinely empty first round', () => {
    expect(
      reviewPreflight({
        rootDir: root,
        taskDir: taskDir(),
        state: codeState(),
        scope: scope([]),
      })
    ).toEqual({
      eligible: false,
      paths: [],
      fingerprint: null,
      incremental: null,
    });
  });

  test('should be ineligible when the previous snapshot shows no change', () => {
    fs.writeFileSync(path.join(root, 'same.js'), 'same\n');
    saveSnapshot({
      repoDir: root,
      dir: path.join(taskDir(), 'reviews', '.snapshot-r1'),
      files: ['same.js'],
    });

    expect(
      reviewPreflight({
        rootDir: root,
        taskDir: taskDir(),
        state: codeState({
          quality: quality({ phase: 'fix', reviewRounds: 1 }),
        }),
        scope: scope([]),
        runGitStatus: defaultRunGitStatus,
      })
    ).toEqual({
      eligible: false,
      paths: [],
      fingerprint: null,
      incremental: null,
    });
  });
});

describe('roundBase', () => {
  const folderScope = { base: null, since: null, files: ['a.js'] };

  test("should record a git scope's base as it is", () => {
    const scope = { base: 'main', since: 'abc', files: [] };
    expect(roundBase(scope, freshQuality(), true)).toBe('main');
  });

  test('should record a folder chosen now or by an earlier round', () => {
    expect(roundBase(folderScope, freshQuality(), true)).toBe(FOLDER_BASE);
    expect(
      roundBase(folderScope, { ...freshQuality(), base: FOLDER_BASE })
    ).toBe(FOLDER_BASE);
  });

  test('should leave an automatic folder scope unrecorded', () => {
    expect(roundBase(folderScope, freshQuality())).toBeNull();
  });
});

describe('taskFolderNotes', () => {
  const taskDir = () => path.join(root, 'tasks', NAME);
  const at = (/** @type {string} */ file) => `tasks/${NAME}/${file}`;

  test('should mark scope files pnpm task check skips and list the scripts left out', () => {
    touch(taskDir(), 'app/a.js', 'app/main.py', 'docs/index.html');
    touch(taskDir(), 'scripts/gen.sh');
    const scope = reviewScope({
      rootDir: root,
      taskDir: taskDir(),
      base: null,
    });

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({
      unchecked: [at('app/main.py'), at('docs/index.html')],
      aside: [at('scripts/gen.sh')],
    });
  });

  test('should list the folder code beside a git scope, without marks', () => {
    touch(taskDir(), 'scripts/gen.py', 'docs/notes.md');
    const scope = { base: 'main', since: 'abc', files: ['utils/a.js'] };

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({ unchecked: [], aside: [at('scripts/gen.py')] });
  });

  test('should say nothing for a missing task folder', () => {
    const scope = { base: 'main', since: 'abc', files: [] };

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({ unchecked: [], aside: [] });
  });
});

describe('scopeRoot', () => {
  test("should read task code from the workspace and git scopes from the task's repo", () => {
    const state = { ...codeState(), repo: '/work/other' };
    expect(scopeRoot(root, state, { base: null, since: null, files: [] })).toBe(
      root
    );
    expect(
      scopeRoot(root, state, { base: 'main', since: 'a', files: [] })
    ).toBe('/work/other');
    expect(
      scopeRoot(root, codeState(), { base: 'main', since: 'a', files: [] })
    ).toBe(root);
  });
});

describe('reviewScope with real git', () => {
  /** @type {string} */
  let repo;
  /** @param {string[]} args */
  const git = (args) =>
    String(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'core.hooksPath=',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo, encoding: 'utf-8' }
      ).stdout
    ).trim();
  /** @param {string} file */
  const commit = (file) => {
    fs.writeFileSync(path.join(repo, file), file);
    git(['add', file]);
    git(['commit', '-q', '-m', file]);
    return git(['rev-parse', 'HEAD']);
  };
  /** @param {string | null} startCommit */
  const scope = (startCommit) =>
    reviewScope({
      rootDir: root,
      taskDir: path.join(root, 'tasks', NAME),
      base: 'main',
      startCommit,
      repoDir: repo,
    });

  beforeEach(() => {
    repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'scope-git-'))
    );
    git(['init', '-q', '-b', 'main']);
    commit('base.js');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("should start at the task's first commit on a branch that carries other work", () => {
    git(['switch', '-q', '-c', 'feat/shared']);
    commit('other-task.js');
    const start = git(['rev-parse', 'HEAD']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: start,
      since: start,
      files: ['this-task.js'],
    });
  });

  test('should use the branch point when the task started before it', () => {
    const start = git(['rev-parse', 'HEAD']);
    commit('merged-elsewhere.js');
    git(['switch', '-q', '-c', 'feat/late']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: 'main',
      files: ['this-task.js'],
    });
  });

  test('should use the branch point when the start commit is not in history', () => {
    git(['switch', '-q', '-c', 'feat/abandoned']);
    const start = commit('abandoned.js');
    git(['switch', '-q', 'main']);
    git(['switch', '-q', '-c', 'feat/fresh']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: 'main',
      files: ['this-task.js'],
    });
  });

  test('should keep a repo folder named tasks/ in the scope', () => {
    fs.mkdirSync(path.join(repo, 'tasks'));
    git(['switch', '-q', '-c', 'feat/x']);
    commit(path.join('tasks', 'job.js'));

    expect(scope(null).files).toEqual(['tasks/job.js']);
  });
});

describe('reviewScope', () => {
  test("should use the task's code files without a base", () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'app', 'a.js'), '');
    fs.writeFileSync(path.join(taskDir, 'plan.md'), '');

    expect(reviewScope({ rootDir: root, taskDir, base: null })).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/app/a.js`],
    });
  });

  test('should use changed and untracked files since the merge base, minus tasks/', () => {
    /** @type {import('../review.js').RunGit} */
    const runGit = vi.fn((args) => {
      if (args[0] === 'merge-base') return 'abc123';
      if (args.includes('diff')) return 'utils/b.js\nutils/a.js';
      return 'utils/new.js\ntasks/x/n.js\n';
    });

    expect(
      reviewScope({ rootDir: root, taskDir: root, base: 'main', runGit })
    ).toEqual({
      base: 'main',
      since: 'abc123',
      files: ['utils/a.js', 'utils/b.js', 'utils/new.js'],
    });
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'main'], root);
    expect(runGit).toHaveBeenCalledWith(
      ['diff', '--name-only', '--no-renames', '-z', 'abc123'],
      root
    );
  });

  test('should treat failed listings as no files', () => {
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abc' : null
    );

    expect(
      reviewScope({ rootDir: root, taskDir: root, base: 'main', runGit }).files
    ).toEqual([]);
  });

  test('should refuse a base that git would read as an option', () => {
    const runGit = vi.fn(() => 'abc');

    expect(() =>
      reviewScope({ rootDir: root, taskDir: root, base: '--all', runGit })
    ).toThrow(/--all is not a git ref[^]*--base <ref>/);
    expect(runGit).not.toHaveBeenCalled();
  });

  test('should explain a base ref git cannot resolve', () => {
    expect(() =>
      reviewScope({
        rootDir: root,
        taskDir: root,
        base: 'nope',
        runGit: () => null,
      })
    ).toThrow(/merge base of HEAD and nope[^]*--base <ref>/);
  });
});

describe('defaultRunGit', () => {
  test('should return trimmed output, or null outside a repository', () => {
    expect(defaultRunGit(['--version'], root)).toMatch(/^git version/);
    expect(defaultRunGit(['rev-parse', 'HEAD'], root)).toBeNull();
  });
});

describe('fingerprint', () => {
  test('should change with content and mark deleted files', () => {
    fs.writeFileSync(path.join(root, 'a.js'), 'one');
    const first = fingerprint(root, ['a.js', 'gone.js']);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(root, ['gone.js', 'a.js'])).toBe(first);

    fs.writeFileSync(path.join(root, 'a.js'), 'two');
    expect(fingerprint(root, ['a.js', 'gone.js'])).not.toBe(first);
  });
});

describe('openRound', () => {
  const open = (
    /** @type {import('../state.js').TaskState} */ state,
    force = false
  ) => openRound(state, { fingerprint: 'fp', base: null, force });

  test('should open round 1 with the fingerprint', () => {
    const { state, round, reopened } = open(codeState());

    expect(round).toBe(1);
    expect(reopened).toBe(false);
    expect(state.quality).toMatchObject({
      phase: 'review',
      reviewRounds: 1,
      reviewedDiff: 'fp',
      base: null,
    });
  });

  test('should return an open round unchanged', () => {
    const state = codeState({
      quality: { ...freshQuality(), phase: 'review', reviewRounds: 1 },
    });

    expect(open(state)).toEqual({ state, round: 1, reopened: true });
  });

  test('should refuse a task that is not a code task', () => {
    const state = { ...codeState(), kind: /** @type {const} */ ('general') };

    expect(() => open(state)).toThrow(/not a code task[^]*--kind code/);
  });

  test('should start from a fresh quality state when the task has none', () => {
    const { quality: _q, ...state } = codeState();

    expect(open(state).round).toBe(1);
  });

  test('should refuse a third round', () => {
    const state = codeState({
      quality: { ...freshQuality(), phase: 'complete', reviewRounds: 2 },
    });

    expect(() => open(state)).toThrow(
      /2\/2 review rounds \(the limit\)[^]*--open/
    );
  });

  test('should refuse while confirmed must-fix/high findings are open', () => {
    const state = codeState({
      steps: [
        ...makeSteps(['Build']),
        { id: 's2', title: 'fix', status: 'done', deps: [], owner: null },
        { id: 's3', title: 'fix', status: 'todo', deps: [], owner: null },
      ],
      quality: {
        ...freshQuality(),
        phase: 'fix',
        reviewRounds: 1,
        findings: [
          finding({ id: 'a', step: 's2' }),
          finding({ id: 'b', step: 's3' }),
          finding({ id: 'c', step: null }),
        ],
      },
    });

    expect(() => open(state)).toThrow(/before the next review: s3, c/);
  });

  test('should open the next round once the fixes are done', () => {
    const state = codeState({
      steps: [
        { id: 's1', title: 'fix', status: 'done', deps: [], owner: null },
      ],
      quality: {
        ...freshQuality(),
        phase: 'fix',
        reviewRounds: 1,
        findings: [finding({ step: 's1' })],
      },
    });

    expect(open(state).round).toBe(2);
  });

  test('should require a green verify unless forced', () => {
    expect(() => open(codeState({ lastVerify: null }))).toThrow(
      /has not run[^]*--force/
    );
    expect(() =>
      open(codeState({ lastVerify: { ...GREEN, ok: false, failed: 'x' } }))
    ).toThrow(/last verify failed/);
    expect(open(codeState({ lastVerify: null }), true).round).toBe(1);
  });

  test('should refuse open steps unless forced, but not count fix steps', () => {
    const todo = codeState({ steps: makeSteps(['Build', 'Polish']) });
    expect(() => open(todo)).toThrow(
      /s1, s2 not done yet\.\nFix: .*pnpm task review --force/
    );
    expect(open(todo, true).round).toBe(1);
    const fixOpen = codeState({
      steps: [...codeState().steps, { ...makeSteps(['fix: x'])[0], id: 's2' }],
    });
    expect(open(fixOpen).round).toBe(1);
  });

  test('should not wait for steps that wait on someone else', () => {
    const waiting = codeState({
      steps: [
        ...codeState().steps,
        { ...makeSteps(['Upload'])[0], id: 's2', status: 'waiting' },
      ],
    });
    expect(open(waiting).round).toBe(1);
  });

  test('should wait for a gate step unless forced', () => {
    const gated = codeState({
      steps: [
        ...codeState().steps,
        {
          ...makeSteps(['Approve the design'])[0],
          id: 's2',
          status: 'waiting',
          gate: true,
        },
      ],
    });
    expect(() => open(gated)).toThrow('Review finished work: s2 not done yet.');
    expect(open(gated, true).round).toBe(1);
  });
});

describe('formatReviewBrief', () => {
  const scope = { base: null, since: null, files: [`tasks/${NAME}/a.js`] };

  test('should give the goal, plan, standards, scope, rubric, and output steps', () => {
    const text = formatReviewBrief({
      state: codeState({ e2e: 'required' }),
      round: 1,
      scope,
      taskRel: `tasks/${NAME}`,
    });

    expect(text).toContain(`# Review brief — ${NAME}, round 1/2`);
    expect(text).toContain('Goal: Ship it');
    expect(text).toContain(
      `Plan (acceptance, steps, decisions): tasks/${NAME}/plan.md`
    );
    expect(text).toContain('Standards: AGENTS.md;');
    expect(text).toContain('E2E: required');
    expect(text).toContain(
      `## Scope — 1 file(s), the task's code under tasks/${NAME}/`
    );
    expect(text).toContain(`- tasks/${NAME}/a.js`);
    expect(text).toContain(SEVERITY_RUBRIC);
    expect(text).toContain(`tasks/${NAME}/reviews/REVIEW_${NAME}-r1.md`);
    expect(text).toContain('3. Record: pnpm task review record');
    expect(text).toContain('Cross-model option');
    expect(text).not.toContain('## Earlier rounds');
    expect(text).not.toContain('pnpm task check does not');
    expect(text).not.toContain('## Also in the task folder');
  });

  test('should mark files pnpm task check skips and list code left out of scope', () => {
    const text = formatReviewBrief({
      state: codeState(),
      round: 1,
      scope: {
        base: null,
        since: null,
        files: [`tasks/${NAME}/a.js`, `tasks/${NAME}/main.py`],
      },
      taskRel: `tasks/${NAME}`,
      folder: {
        unchecked: [`tasks/${NAME}/main.py`],
        aside: [`tasks/${NAME}/scripts/gen.sh`],
      },
    });

    expect(text).toContain(`- tasks/${NAME}/a.js\n`);
    expect(text).toContain(
      `- tasks/${NAME}/main.py — pnpm task check does not lint or format it`
    );
    expect(text).toContain(
      `## Also in the task folder (not in scope)\n\nCode the scope leaves out`
    );
    expect(text).toContain(`- tasks/${NAME}/scripts/gen.sh\n`);
  });

  test('should describe a git scope and an empty one', () => {
    const { quality: _q, e2e: _e, ...state } = codeState();
    const text = formatReviewBrief({
      state,
      round: 1,
      scope: { base: 'main', since: '0123456789abcdef', files: [] },
      taskRel: `tasks/${NAME}`,
    });

    expect(text).toContain(
      'changes since main (commit 0123456789ab; see them with: git diff 0123456789ab -- <file>)'
    );
    expect(text).toContain('- (no files: nothing changed)');
    expect(text).toContain('E2E: no');
  });

  test('should point at the pre-computed diffs and the line counts', () => {
    const text = formatReviewBrief({
      state: codeState(),
      round: 2,
      scope: {
        base: 'main',
        since: '0123456789abcdef',
        files: ['app/a.js', 'app/new.js', 'app/blob.bin'],
      },
      taskRel: `tasks/${NAME}`,
      diffPath: `tasks/${NAME}/reviews/DIFF_${NAME}-r2.patch`,
      incrementalDiffPath: `tasks/${NAME}/reviews/DIFF_${NAME}-r1-to-r2.patch`,
      stats: new Map([
        ['app/a.js', { added: 10, deleted: 2 }],
        ['app/new.js', { added: 7, deleted: 0, untracked: true }],
        ['app/blob.bin', { added: 0, deleted: 0, binary: true }],
      ]),
    });

    expect(text).toContain(
      `Diff: tasks/${NAME}/reviews/DIFF_${NAME}-r2.patch (read this first; use bounded line-range reads only when surrounding source context is needed)`
    );
    expect(text).toContain(
      `Changes since round 1: tasks/${NAME}/reviews/DIFF_${NAME}-r1-to-r2.patch (start here for round 2 fixes and regressions)`
    );
    expect(text).toContain('- app/a.js (+10/-2)\n');
    expect(text).toContain('- app/new.js (+7/-0, new)\n');
    expect(text).toContain('- app/blob.bin (binary)\n');
    expect(text).toContain('## Reading budget');
  });

  test('should omit the diff lines and the reading budget for a task-folder scope', () => {
    const text = formatReviewBrief({
      state: codeState(),
      round: 1,
      scope: { base: null, since: null, files: ['a.js'] },
      taskRel: 't',
    });

    expect(text).not.toContain('Diff:');
    expect(text).not.toContain('## Reading budget');
  });

  test('should list refuted and fixed findings from earlier rounds', () => {
    const state = codeState({
      quality: {
        ...freshQuality(),
        reviewRounds: 2,
        findings: [
          finding({
            id: 'r1-1',
            verdict: 'REFUTED',
            reason: 'Guarded by lock',
          }),
          finding({ id: 'r1-2', step: 's1', line: null }),
          finding({ id: 'r1-3', severity: 'low' }),
          finding({ id: 'r2-1', round: 2, verdict: 'REFUTED' }),
        ],
      },
    });

    const text = formatReviewBrief({ state, round: 2, scope, taskRel: 't' });

    expect(text).toContain(
      '- refuted r1-1 (app/a.js:3): Loses writes — Guarded by lock. Do not report it again without new evidence.'
    );
    expect(text).toContain(
      '- fixed r1-2 (app/a.js): Loses writes. Check that the fix holds.'
    );
    expect(text).not.toContain('r1-3');
    expect(text).not.toContain('r2-1');
  });
});

describe('findingsTemplate', () => {
  test('should hold an empty table that parses to no findings', () => {
    const text = findingsTemplate({ name: NAME, round: 1, brief: 'b.md' });

    expect(text).toContain('Brief: b.md');
    expect(parseFindings(text, { round: 1, takenIds: new Set() })).toEqual({
      findings: [],
      errors: [],
    });
  });
});

describe('splitRow', () => {
  test('should split cells and keep escaped pipes', () => {
    expect(splitRow('| a | b \\| c |  |')).toEqual(['a', 'b | c', '']);
  });
});

describe('parseFindings', () => {
  const parse = (/** @type {string} */ text, taken = new Set()) =>
    parseFindings(text, { round: 1, takenIds: taken });

  test('should parse triaged rows and number rows without an id', () => {
    const result = parse(
      table(
        '| r1-1 | `app/a.js:12` | High | Loses writes | two saves → one lost | confirmed | no lock |',
        '|  |  |  |  |  |  |  |',
        '| | app/b.js | low | Typo in name | reading the log | REFUTED | not a typo |',
        '| | app/c.js:4:9 | medium | Slow loop | 10k items → 5 s | CONFIRMED | measured |'
      ),
      new Set(['r1-2'])
    );

    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual([
      finding({
        file: 'app/a.js',
        line: 12,
        scenario: 'two saves → one lost',
        reason: 'no lock',
      }),
      {
        id: 'r1-3',
        round: 1,
        file: 'app/b.js',
        line: null,
        severity: 'low',
        claim: 'Typo in name',
        scenario: 'reading the log',
        verdict: 'REFUTED',
        reason: 'not a typo',
        step: null,
      },
      expect.objectContaining({ id: 'r1-4', file: 'app/c.js', line: 4 }),
    ]);
  });

  test('should explain a missing table', () => {
    expect(parse('# nothing').errors).toEqual([
      `no findings table: the header must be | ${FINDINGS_HEADER.join(' | ')} |`,
    ]);
  });

  test('should report every problem in a row', () => {
    const result = parse(
      table(
        '| a | b |',
        '| r1-1 |  | huge |  |  |  |  |',
        '| r1-2 | a.js | high | c | s | MAYBE | r |',
        '| r1-3 | a.js | high | c | s | CONFIRMED |  |',
        '| r9 | a.js | high | c | s | CONFIRMED | r |'
      ),
      new Set(['r9'])
    );

    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([
      'row 1: 2 cells, expected 7 (escape | inside a cell as \\|)',
      'row 2 (r1-1): severity "huge" is not one of must-fix, high, medium, low; no verdict yet — run the triage first; claim is empty; failure scenario is empty; file:line is empty',
      'row 3 (r1-2): verdict "MAYBE" is not CONFIRMED or REFUTED',
      'row 4 (r1-3): the verdict needs a reason',
      'row 5 (r9): id r9 is already used',
    ]);
  });

  test('should report a row without an id by its number', () => {
    expect(parse(table('| | a.js | high | c | s |  |  |')).errors).toEqual([
      'row 1: no verdict yet — run the triage first',
    ]);
  });
});

describe('recordFindings', () => {
  const open = () =>
    codeState({
      quality: { ...freshQuality(), phase: 'review', reviewRounds: 1 },
    });

  test('should add a fix step per CONFIRMED must-fix/high finding and move to fix', () => {
    const { state, fixSteps } = recordFindings(open(), [
      finding({ id: 'a', severity: 'must-fix' }),
      finding({ id: 'b', severity: 'medium' }),
      finding({ id: 'c', verdict: 'REFUTED' }),
      finding({ id: 'd', line: null }),
    ]);

    expect(fixSteps.map((s) => s.title)).toEqual([
      'fix: Loses writes (app/a.js:3; a)',
      'fix: Loses writes (app/a.js; d)',
    ]);
    expect(state.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(state.quality?.phase).toBe('fix');
    expect(state.quality?.findings.map((f) => [f.id, f.step])).toEqual([
      ['a', 's2'],
      ['b', null],
      ['c', null],
      ['d', 's3'],
    ]);
  });

  test('should complete the loop when nothing needs fixing', () => {
    const { state, fixSteps } = recordFindings(open(), [
      finding({ severity: 'low' }),
    ]);

    expect(fixSteps).toEqual([]);
    expect(state.quality?.phase).toBe('complete');
  });

  test('should refuse without an open round', () => {
    expect(() => recordFindings(codeState(), [])).toThrow(
      /no open review round \(phase build\)/
    );
    const { quality: _q, ...bare } = codeState();
    expect(() => recordFindings(bare, [])).toThrow(/phase build/);
  });
});

describe('diffStats', () => {
  const gitScope = (/** @type {string[]} */ files) => ({
    base: 'main',
    since: 'abc123',
    files,
  });

  test('should count added and deleted lines for in-scope tracked files', () => {
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args.includes('--numstat')
        ? '10\t2\tutils/a.js\n3\t0\tutils/b.js\n1\t1\toutside.js'
        : ''
    );

    const stats = diffStats({
      repoDir: root,
      scope: gitScope(['utils/a.js', 'utils/b.js']),
      runGit,
    });

    expect(stats.get('utils/a.js')).toEqual({ added: 10, deleted: 2 });
    expect(stats.get('utils/b.js')).toEqual({ added: 3, deleted: 0 });
    expect(stats.has('outside.js')).toBe(false);
    const numstat = runGit.mock.calls.find(([args]) =>
      args.includes('--numstat')
    );
    expect(numstat?.[0]).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '-M',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      'abc123',
      '--',
      ':(literal)utils/a.js',
      ':(literal)utils/b.js',
      ...STATIC_PROTECTED_EXCLUDES,
    ]);
  });

  test('should count untracked files as new lines and flag binaries while skipping secret paths', () => {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/new.js'), 'a\nb\r\nc');
    fs.writeFileSync(path.join(root, 'lib/blob.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      args[0] === 'ls-files'
        ? 'lib/new.js\0lib/blob.bin\0lib/gone.js\0.env\0'
        : '';

    const stats = diffStats({
      repoDir: root,
      scope: gitScope(['lib/new.js', 'lib/blob.bin', 'lib/gone.js', '.env']),
      runGit,
    });

    expect(stats.get('lib/new.js')).toEqual({
      added: 3,
      deleted: 0,
      untracked: true,
    });
    expect(stats.get('lib/blob.bin')).toEqual({
      added: 0,
      deleted: 0,
      binary: true,
      untracked: true,
    });
    expect(stats.has('lib/gone.js')).toBe(false);
    expect(stats.has('.env')).toBe(false);
  });

  test('should not query git for a task-folder scope', () => {
    const runGit = vi.fn();

    const stats = diffStats({
      repoDir: root,
      scope: { base: null, since: null, files: ['app/a.js'] },
      runGit,
    });

    expect(stats.size).toBe(0);
    expect(runGit).not.toHaveBeenCalled();
  });
});

describe('generateReviewDiff', () => {
  const gitScope = (/** @type {string[]} */ files) => ({
    base: 'main',
    since: 'abc123',
    files,
  });
  const patchOf = (/** @type {string} */ name) =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
  /**
   * The first allowed `:(literal)` path of a diff query (excludes follow it).
   *
   * @param {string[]} args
   * @returns {string | undefined}
   */
  const literalPath = (args) => {
    const separator = args.indexOf('--');
    return args
      .slice(separator + 1)
      .find((arg) => arg.startsWith(':(literal)'))
      ?.slice(':(literal)'.length);
  };
  /**
   * @param {Record<string, string | null>} diffs
   * @param {string[]} tracked
   * @param {string[]} [untracked]
   */
  const runGitFor = (diffs, tracked, untracked = []) =>
    vi.fn((args) => {
      if (args[0] === 'ls-files') return untracked.join('\0');
      if (args.includes('--name-status')) {
        return tracked.map((file) => `M\0${file}\0`).join('');
      }
      if (args.includes('--name-only')) {
        return tracked.join('\0');
      }
      if (args.includes('--numstat')) {
        return tracked.map((file) => `1\t1\t${file}\0`).join('');
      }
      if (args.includes('diff')) {
        const file = literalPath(args);
        return file === undefined ? null : (diffs[file] ?? null);
      }
      return '';
    });

  test('should return null without a git base or without files', () => {
    expect(
      generateReviewDiff({
        repoDir: root,
        scope: { base: null, since: null, files: ['a.js'] },
      })
    ).toBeNull();
    expect(
      generateReviewDiff({ repoDir: root, scope: gitScope([]) })
    ).toBeNull();
  });

  test('should concatenate tracked diffs and synthetic new-file diffs', () => {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/new.js'), 'one\ntwo\n');
    const runGit = runGitFor(
      { 'src/a.js': patchOf('src/a.js') },
      ['src/a.js'],
      ['lib/new.js']
    );

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['lib/new.js', 'src/a.js']),
      runGit,
    });

    expect(patch).toContain(patchOf('src/a.js'));
    expect(patch).toContain('diff --git a/lib/new.js b/lib/new.js');
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two');
    const perFile = runGit.mock.calls.find(([args]) =>
      args.includes('--unified=8')
    );
    expect(perFile?.[0]).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '-M',
      '--unified=8',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      'abc123',
      '--',
      ':(literal)src/a.js',
      ...STATIC_PROTECTED_EXCLUDES,
    ]);
  });

  test('should describe an untracked binary file without inlining it', () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]));
    const runGit = runGitFor({}, [], ['blob.bin']);

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['blob.bin']),
      runGit,
    });

    expect(patch).toContain('diff --git a/blob.bin b/blob.bin');
    expect(patch).toContain('Binary file (new, 3 bytes)');
    expect(patch).not.toContain('\u0000');
  });

  test('should redact secrets from the generated patch', () => {
    const runGit = runGitFor(
      {
        'src/a.js': `${patchOf('src/a.js')}\n+TOKEN=ghp_${'a'.repeat(36)}`,
      },
      ['src/a.js']
    );

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['src/a.js']),
      runGit,
    });

    expect(patch).toContain('[REDACTED]');
    expect(patch).not.toContain('ghp_');
  });

  test('should redact secrets before per-file truncation so split tokens never leak', () => {
    const token = 'sk-proj-' + 'z'.repeat(40);
    const diff = `+${'a'.repeat(15)} ${token} ${'b'.repeat(100)}`;
    const runGit = runGitFor({ 'src/a.js': diff }, ['src/a.js']);

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['src/a.js']),
      runGit,
      maxFileBytes: 40,
      maxTotalBytes: 10_000,
    });

    expect(patch).toContain('[REDACTED]');
    expect(patch).toContain('truncated: omitted');
    expect(patch).not.toContain('sk-proj-');
    expect(patch).not.toContain('zzzzz');
  });

  test('should truncate one huge file and point at targeted line ranges', () => {
    const big = [
      'diff --git a/big.js b/big.js',
      '@@ -1 +1,200 @@',
      ...Array.from({ length: 200 }, () => '+x'),
    ].join('\n');
    const runGit = runGitFor({ 'big.js': big }, ['big.js']);

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['big.js']),
      runGit,
      maxFileBytes: 200,
      maxTotalBytes: 10_000,
    });

    expect(patch).toContain('truncated: omitted');
    expect(patch).toContain(
      'of big.js; inspect targeted line ranges with read_file'
    );
    expect(/** @type {string} */ (patch).length).toBeLessThan(big.length);
  });

  test('should stop at the total cap and list omitted files with their stats', () => {
    const runGit = runGitFor(
      {
        'a.js': patchOf('a.js'),
        'b.js': patchOf('b.js'),
        'c.js': patchOf('c.js'),
      },
      ['a.js', 'b.js', 'c.js']
    );

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['a.js', 'b.js', 'c.js']),
      runGit,
      maxFileBytes: 10_000,
      maxTotalBytes: 80,
    });

    expect(patch).toContain('diff --git a/a.js b/a.js');
    expect(patch).toContain('total patch cap');
    expect(patch).toContain('b.js (+1/-1)');
    expect(patch).toContain('c.js (+1/-1)');
    expect(patch).not.toContain('+++ b/b.js');
    expect(patch).not.toContain('+++ b/c.js');
  });

  test('should report tracked files whose git diff returned null instead of silently dropping them', () => {
    const runGit = runGitFor({ 'huge.js': null }, ['huge.js']);

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['huge.js']),
      runGit,
    });

    expect(patch).toContain('git diff unavailable for 1 file(s)');
    expect(patch).toContain('huge.js (+1/-1)');
  });

  test('should omit protected secret files from review diffs without reading them', () => {
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=plain-secret-value\n');
    const runGit = runGitFor({}, []);

    const patch = generateReviewDiff({
      repoDir: root,
      scope: gitScope(['.env']),
      runGit,
    });

    expect(patch).toContain('diff --git a/.env b/.env');
    expect(patch).toContain('protected secret path');
    expect(patch).not.toContain('plain-secret-value');
  });

  test('should never pass protected paths to git content, stat, or rename queries', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a\n');
    /** @type {string[][]} */
    const calls = [];
    /** @type {import('../review.js').RunGit} */
    const runGit = vi.fn((args) => {
      calls.push(args);
      if (args.includes('--numstat')) return '1\t1\tsrc/a.js\0';
      if (args.includes('--name-status')) return 'M\0src/a.js\0';
      if (args.includes('--name-only')) return 'src/a.js\0';
      if (args.includes('--unified=8')) return patchOf('src/a.js');
      return '';
    });
    const scope = gitScope(['.env', 'secrets/k.txt', 'src/a.js']);

    generateReviewDiff({ repoDir: root, scope, runGit });
    diffStats({ repoDir: root, scope, runGit });

    const queries = calls.filter(
      (args) =>
        args.includes('--numstat') ||
        args.includes('--name-status') ||
        args.includes('--unified=8')
    );
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const args of queries) {
      expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false']);
      expect(args[2]).toBe('diff');
      expect(args).not.toContain('--literal-pathspecs');
      expect(args).toContain('--no-ext-diff');
      expect(args).toContain('--no-textconv');
      const separator = args.indexOf('--');
      expect(separator).toBeGreaterThan(-1);
      const paths = args.slice(separator + 1);
      expect(paths).toContain(':(literal)src/a.js');
      expect(paths).not.toContain(':(literal).env');
      expect(paths).not.toContain(':(literal)secrets/k.txt');
      expect(paths).toContain(':(exclude,literal).env');
      expect(paths).toContain(':(exclude,literal)secrets/k.txt');
      for (const exclude of STATIC_PROTECTED_EXCLUDES) {
        expect(paths).toContain(exclude);
      }
    }
  });

  test('should keep a legal name starting with two dots in scope through stats, patch, and snapshot', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dotdot-'));
    const gitExec = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    try {
      gitExec(['init', '-b', 'main']);
      gitExec(['config', 'user.email', 'test@example.com']);
      gitExec(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'base.js'), 'base\n');
      gitExec(['add', 'base.js']);
      gitExec(['commit', '-m', 'init']);
      const base = gitExec(['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, '..notes.txt'), 'dot dot\n');
      fs.mkdirSync(path.join(repo, 'dir'));
      fs.writeFileSync(path.join(repo, 'dir', '..config.js'), 'config\n');

      const scope = reviewScope({
        rootDir: repo,
        taskDir: path.join(repo, 'tasks', NAME),
        base,
        repoDir: repo,
      });
      expect(scope.files).toEqual(['..notes.txt', 'dir/..config.js']);

      const stats = diffStats({ repoDir: repo, scope });
      expect(stats.get('..notes.txt')).toEqual({
        added: 1,
        deleted: 0,
        untracked: true,
      });

      const patch = generateReviewDiff({ repoDir: repo, scope });
      expect(patch).toContain('diff --git a/..notes.txt b/..notes.txt');
      expect(patch).toContain('+dot dot');
      expect(patch).toContain('diff --git a/dir/..config.js b/dir/..config.js');

      const snapshotDir = path.join(repo, '.snapshot-r1');
      saveSnapshot({ repoDir: repo, dir: snapshotDir, files: scope.files });
      expect(listSnapshotFiles(snapshotDir)).toEqual([
        '..notes.txt',
        'dir/..config.js',
      ]);

      fs.writeFileSync(path.join(repo, '..notes.txt'), 'dot dot changed\n');
      const incremental = generateIncrementalDiff({
        repoDir: repo,
        snapshotDir,
        files: listSnapshotScope(snapshotDir),
        runGitStatus: defaultRunGitStatus,
      });
      expect(incremental).toContain('diff --git a/..notes.txt b/..notes.txt');
      expect(incremental).toContain('-dot dot\n+dot dot changed');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should handle non-ASCII paths and staged renames against a real git repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-git-'));
    const gitExec = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    try {
      gitExec(['init']);
      gitExec(['config', 'user.email', 'test@example.com']);
      gitExec(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'old.js'), 'a\nb\nc\nd\n');
      gitExec(['add', 'old.js']);
      gitExec(['commit', '-m', 'init']);
      const base = gitExec(['rev-parse', 'HEAD']);
      gitExec(['mv', 'old.js', 'new.js']);
      fs.writeFileSync(path.join(repo, 'new.js'), 'a\nB\nc\nd\n');
      fs.writeFileSync(path.join(repo, '設定.txt'), '一行目\n二行目\n');

      const scope = reviewScope({
        rootDir: repo,
        taskDir: path.join(repo, 'tasks', NAME),
        base,
        repoDir: repo,
      });
      expect(scope.files).toEqual(['new.js', '設定.txt']);

      const stats = diffStats({ repoDir: repo, scope });
      expect(stats.get('new.js')).toEqual({ added: 1, deleted: 1 });
      expect(stats.get('設定.txt')).toEqual({
        added: 2,
        deleted: 0,
        untracked: true,
      });

      const patch = generateReviewDiff({ repoDir: repo, scope });
      expect(patch).toContain('rename from old.js');
      expect(patch).toContain('rename to new.js');
      expect(patch).toContain('-b\n+B');
      expect(patch).not.toContain(
        'new file mode 100644\n--- /dev/null\n+++ b/new.js'
      );
      expect(patch).toContain('diff --git a/設定.txt b/設定.txt');
      expect(patch).toContain('+一行目\n+二行目');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should treat per-file pathspecs literally so bracketed names do not match sibling files', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-literal-'));
    const gitExec = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    try {
      gitExec(['init']);
      gitExec(['config', 'user.email', 'test@example.com']);
      gitExec(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'report[1].txt'), 'bracket-old\n');
      fs.writeFileSync(path.join(repo, 'report1.txt'), 'plain-old\n');
      gitExec(['add', 'report[1].txt', 'report1.txt']);
      gitExec(['commit', '-m', 'init']);
      const base = gitExec(['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'report[1].txt'), 'bracket-new\n');
      fs.writeFileSync(path.join(repo, 'report1.txt'), 'plain-new\n');

      const scope = reviewScope({
        rootDir: repo,
        taskDir: path.join(repo, 'tasks', NAME),
        base,
        repoDir: repo,
      });
      const patch = generateReviewDiff({ repoDir: repo, scope }) ?? '';

      expect(patch).toContain('-bracket-old\n+bracket-new');
      expect(patch).toContain('-plain-old\n+plain-new');
      expect(
        patch.match(/diff --git a\/report1\.txt b\/report1\.txt/g)
      ).toHaveLength(1);
      expect(
        patch.match(/diff --git a\/report\[1\]\.txt b\/report\[1\]\.txt/g)
      ).toHaveLength(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should keep protected files out of a file-to-directory transition against real git', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-transition-'));
    const gitExec = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    try {
      gitExec(['init']);
      gitExec(['config', 'user.email', 'test@example.com']);
      gitExec(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'config'), 'old config\n');
      gitExec(['add', 'config']);
      gitExec(['commit', '-m', 'init']);
      const base = gitExec(['rev-parse', 'HEAD']);
      fs.rmSync(path.join(repo, 'config'));
      fs.mkdirSync(path.join(repo, 'config'));
      fs.writeFileSync(path.join(repo, 'config', 'app.js'), 'app\n');
      fs.writeFileSync(
        path.join(repo, 'config', '.env'),
        'MARKER_SHOULD_NOT_LEAK=1\n'
      );
      gitExec(['add', '-A']);

      const scope = reviewScope({
        rootDir: repo,
        taskDir: path.join(repo, 'tasks', NAME),
        base,
        repoDir: repo,
      });
      expect(scope.files).toEqual(['config', 'config/.env', 'config/app.js']);

      const stats = diffStats({ repoDir: repo, scope });
      expect(stats.get('config')).toEqual({ added: 0, deleted: 1 });
      expect(stats.get('config/app.js')).toEqual({ added: 1, deleted: 0 });
      expect(stats.has('config/.env')).toBe(false);

      const patch = generateReviewDiff({ repoDir: repo, scope }) ?? '';
      expect(patch).toContain('diff --git a/config b/config');
      expect(patch).toContain('deleted file mode 100644');
      expect(patch).toContain('diff --git a/config/app.js b/config/app.js');
      expect(patch).toContain('+app');
      expect(patch).toContain('diff --git a/config/.env b/config/.env');
      expect(patch).toContain('protected secret path');
      expect(patch).not.toContain('MARKER_SHOULD_NOT_LEAK');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should never pair protected and ordinary paths as renames against real git', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-crossbound-'));
    const gitExec = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    try {
      gitExec(['init']);
      gitExec(['config', 'user.email', 'test@example.com']);
      gitExec(['config', 'user.name', 'Test']);
      fs.mkdirSync(path.join(repo, 'secrets'));
      fs.writeFileSync(
        path.join(repo, 'secrets', 'sample.txt'),
        'SECRET-ALPHA\n'
      );
      fs.writeFileSync(path.join(repo, 'plain.txt'), 'PLAIN-BETA\n');
      gitExec(['add', '-A']);
      gitExec(['commit', '-m', 'init']);
      const base = gitExec(['rev-parse', 'HEAD']);
      // protected -> ordinary, then ordinary -> protected (both staged)
      gitExec(['mv', 'secrets/sample.txt', 'moved.txt']);
      gitExec(['mv', 'plain.txt', 'secrets/moved.txt']);

      const scope = reviewScope({
        rootDir: repo,
        taskDir: path.join(repo, 'tasks', NAME),
        base,
        repoDir: repo,
      });

      const stats = diffStats({ repoDir: repo, scope });
      expect([...stats.keys()].sort()).toEqual(['moved.txt', 'plain.txt']);

      const patch = generateReviewDiff({ repoDir: repo, scope }) ?? '';
      // Protected paths never pair with ordinary ones: each ordinary side is
      // an addition or a deletion, each protected side an omission.
      expect(patch).not.toContain('rename from');
      expect(patch).toMatch(
        /diff --git a\/moved\.txt b\/moved\.txt\nnew file mode/
      );
      expect(patch).toMatch(
        /diff --git a\/plain\.txt b\/plain\.txt\ndeleted file mode/
      );
      expect(patch).toContain(
        'diff --git a/secrets/moved.txt b/secrets/moved.txt\n... [omitted: protected secret path]'
      );
      expect(patch).toContain(
        'diff --git a/secrets/sample.txt b/secrets/sample.txt\n... [omitted: protected secret path]'
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should report tracked files as unavailable when status recovery also fails', () => {
    fs.writeFileSync(path.join(root, 'edited.js'), 'new\n');
    fs.writeFileSync(path.join(root, 'untracked.js'), 'fresh\n');
    /** @type {import('../review.js').RunGit} */
    const runGit = vi.fn((args) => {
      if (args[0] === 'ls-files') return 'untracked.js\0';
      if (args.includes('--raw')) return null;
      if (args.includes('--name-only')) return 'edited.js\0deleted.js\0';
      if (args.includes('--name-status')) return null;
      return '';
    });

    const patch =
      generateReviewDiff({
        repoDir: root,
        scope: gitScope(['edited.js', 'deleted.js', 'untracked.js']),
        runGit,
      }) ?? '';

    expect(patch).toContain('diff --git a/untracked.js b/untracked.js');
    expect(patch).not.toContain('+++ b/edited.js');
    expect(patch).not.toContain('+++ b/deleted.js');
    expect(patch).toContain('git diff unavailable for 2 file(s)');
    expect(patch).toContain('edited.js (');
    expect(patch).toContain('deleted.js (');
  });

  test('should not read secret files or follow symlinks in fingerprint, diffStats, or diffs', () => {
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=plain-secret\n');
    fs.writeFileSync(path.join(root, 'dscc.env'), 'ANTHROPIC_AUTH_TOKEN=tok\n');
    fs.writeFileSync(path.join(root, 'link.txt'), 'not-a-real-symlink\n');
    const origLstat = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((p, opts) => {
      if (String(p).endsWith('link.txt')) {
        return /** @type {any} */ ({
          isSymbolicLink: () => true,
          isFile: () => false,
          size: 0,
        });
      }
      return origLstat(p, /** @type {any} */ (opts));
    });
    const readlinkSpy = vi
      .spyOn(fs, 'readlinkSync')
      .mockImplementation((p) =>
        String(p).endsWith('link.txt') ? '/etc/passwd' : ''
      );
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const fp = fingerprint(root, ['.env', 'dscc.env', 'link.txt', '../out']);
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      const patch = generateReviewDiff({
        repoDir: root,
        scope: gitScope(['.env', 'dscc.env', 'link.txt', '../out']),
        runGit: runGitFor({}, [], ['link.txt']),
      });
      expect(patch).toContain('diff --git a/dscc.env b/dscc.env');
      expect(patch).toContain('protected secret path');
      expect(patch).toContain('diff --git a/link.txt b/link.txt');
      expect(patch).toContain('symlink or protected path');
      const snapshotDir = path.join(root, '.snapshot-sec');
      expect(
        saveSnapshot({
          repoDir: root,
          dir: snapshotDir,
          files: ['.env', 'dscc.env', 'link.txt', '../out'],
        })
      ).toBe(0);
      expect(listSnapshotSkipped(snapshotDir)).toEqual([
        '.env',
        'dscc.env',
        'link.txt',
      ]);
      const inc = generateIncrementalDiff({
        repoDir: root,
        snapshotDir,
        files: ['.env', 'dscc.env', 'link.txt', '../out'],
      });
      expect(inc).toContain('symlink or protected path');
      expect(inc).not.toContain('plain-secret');
      expect(
        readSpy.mock.calls.some(([p]) => /\.env$|link\.txt$/.test(String(p)))
      ).toBe(false);
    } finally {
      lstatSpy.mockRestore();
      readlinkSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});

describe('protected paths against real git', () => {
  /** @type {string} */
  let repo;
  /** @param {string[]} args */
  const git = (args) => {
    const res = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'core.hooksPath=',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf-8' }
    );
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
    return res.stdout.trim();
  };
  /** @param {string} file @param {string} text */
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const review = () => {
    const scope = reviewScope({
      rootDir: repo,
      taskDir: path.join(repo, 'tasks', NAME),
      base: 'main',
      repoDir: repo,
    });
    return {
      scope,
      stats: diffStats({ repoDir: repo, scope }),
      patch: generateReviewDiff({ repoDir: repo, scope }) ?? '',
    };
  };

  beforeEach(() => {
    repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'review-protected-'))
    );
    git(['init', '-q', '-b', 'main']);
    write('src/app.js', 'export const a = 1;\n');
    write('old.js', 'export const old = 1;\n');
    write('design-tokens.json', '{"color":"red"}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    git(['switch', '-q', '-c', 'feat']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('should keep ordinary edits visible when a protected tracked file is deleted', () => {
    write('src/app.js', 'export const a = 2;\n');
    write('src/new.js', 'export const n = 1;\n');
    git(['rm', '-q', 'design-tokens.json']);

    const { scope, stats, patch } = review();

    expect(scope.files).toEqual([
      'design-tokens.json',
      'src/app.js',
      'src/new.js',
    ]);
    expect(stats.get('src/app.js')).toEqual({ added: 1, deleted: 1 });
    expect(stats.get('src/new.js')).toMatchObject({ added: 1 });
    expect(patch).toContain('+export const a = 2;');
    expect(patch).toContain('+export const n = 1;');
    expect(patch.match(/omitted: protected secret path/g)).toHaveLength(1);
    expect(patch).not.toContain('"color"');
  });

  test('should keep an ordinary deletion visible beside an untracked protected file', () => {
    git(['rm', '-q', 'old.js']);
    write('api-keys.yaml', 'k: v\n');

    const { stats, patch } = review();

    expect(stats.get('old.js')).toEqual({ added: 0, deleted: 1 });
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('-export const old = 1;');
    expect(patch).toContain(
      'diff --git a/api-keys.yaml b/api-keys.yaml\n... [omitted: protected secret path]'
    );
    expect(patch).not.toContain('k: v');
  });

  test('should never pair a protected rename source, so its deleted lines stay out', () => {
    git(['switch', '-q', 'main']);
    write(
      '.env.local',
      [
        'API_KEY=never-shown-value',
        ...Array.from({ length: 30 }, (_, i) => `L${i}`),
      ].join('\n') + '\n'
    );
    git(['add', '-f', '.env.local']);
    git(['commit', '-q', '-m', 'env']);
    git(['switch', '-q', '-C', 'feat']);
    git(['mv', '.env.local', 'config.txt']);
    write(
      'config.txt',
      Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n') + '\n'
    );

    const { stats, patch } = review();

    expect(patch).not.toContain('never-shown-value');
    expect(patch).not.toContain('rename from');
    expect(patch).toContain(
      'diff --git a/.env.local b/.env.local\n... [omitted: protected secret path]'
    );
    expect(patch).toMatch(
      /diff --git a\/config\.txt b\/config\.txt\nnew file mode/
    );
    expect(stats.get('config.txt')).toEqual({ added: 30, deleted: 0 });
    expect(stats.has('.env.local')).toBe(false);
  });

  test('should show a file removed from the index but kept on disk as a deletion in both patch and stats', () => {
    git(['rm', '-q', '--cached', 'old.js']);

    const { stats, patch } = review();

    expect(stats.get('old.js')).toEqual({ added: 0, deleted: 1 });
    expect(patch).toContain('diff --git a/old.js b/old.js\ndeleted file mode');
    expect(patch).not.toContain('new file mode');
  });
});

describe('saveSnapshot and listSnapshotFiles', () => {
  test('should mirror text files and skip binaries, oversized, and secret files', () => {
    fs.writeFileSync(path.join(root, 'a.js'), 'one\n');
    fs.writeFileSync(
      path.join(root, 'big.js'),
      'x'.repeat(SNAPSHOT_MAX_FILE_BYTES + 1)
    );
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0]));
    fs.writeFileSync(path.join(root, '.env'), 'FOO=bar\n');
    fs.writeFileSync(
      path.join(root, 'has-token.js'),
      `const t = 'ghp_${'a'.repeat(36)}';\n`
    );
    const dir = path.join(root, '.snapshot-r1');

    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('.env.example')).toBe(false);
    expect(isSecretFile('dscc.env')).toBe(true);
    expect(isSecretFile('dscc.env.example')).toBe(false);
    expect(isSecretFile('.envrc')).toBe(true);
    expect(isSecretFile('.ssh/id_rsa')).toBe(true);
    expect(isSecretFile('secrets/key.txt')).toBe(true);
    expect(isSecretFile('secrets\\key.txt')).toBe(true);
    expect(isSecretFile('certs/app.pem')).toBe(true);
    expect(isSecretFile('certs/app.p12')).toBe(true);
    expect(isSecretFile('config/credentials.json')).toBe(true);
    expect(isSecretFile('config/api_key.txt')).toBe(true);
    expect(isSecretFile('src/token.js')).toBe(false);
    expect(
      saveSnapshot({
        repoDir: root,
        dir,
        files: [
          'a.js',
          'big.js',
          'blob.bin',
          '.env',
          'has-token.js',
          'missing.js',
        ],
      })
    ).toBe(1);
    expect(listSnapshotFiles(dir)).toEqual(['a.js']);
    expect(listSnapshotSkipped(dir)).toEqual([
      '.env',
      'big.js',
      'blob.bin',
      'has-token.js',
    ]);
    expect(listSnapshotScope(dir)).toEqual([
      '.env',
      'a.js',
      'big.js',
      'blob.bin',
      'has-token.js',
      'missing.js',
    ]);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'has-token.js'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'files', 'a.js'), 'utf-8')).toBe(
      'one\n'
    );
  });

  test('should replace an existing snapshot and list nested files', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'new\n');
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'old.js'), 'old\n');

    saveSnapshot({ repoDir: root, dir, files: ['src/a.js'] });

    expect(listSnapshotFiles(dir)).toEqual(['src/a.js']);
    expect(fs.existsSync(path.join(dir, 'src', 'old.js'))).toBe(false);
  });

  test('should list nothing without a snapshot folder', () => {
    expect(listSnapshotFiles(path.join(root, 'missing'))).toEqual([]);
  });

  test('should keep one versioned manifest beside the mirrored files', () => {
    fs.writeFileSync(path.join(root, 'a.js'), 'one\n');
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0]));
    fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
    const dir = path.join(root, '.snapshot-r1');

    saveSnapshot({
      repoDir: root,
      dir,
      files: ['a.js', 'blob.bin', '.env', 'gone.js'],
    });

    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
    ).toEqual({
      version: 1,
      scope: ['.env', 'a.js', 'blob.bin', 'gone.js'],
      skipped: ['.env', 'blob.bin'],
    });
    expect(fs.existsSync(path.join(dir, 'files', 'a.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'files', 'blob.bin'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'files')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777).toBe(
        0o600
      );
      expect(fs.statSync(path.join(dir, 'files', 'a.js')).mode & 0o777).toBe(
        0o600
      );
    }
  });

  test('should not confuse reviewed files named like snapshot metadata', () => {
    const names = [
      'manifest.json',
      '.snapshot-skipped.json',
      '.snapshot-scope.json',
      'src/manifest.json',
    ];
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), `old:${name}\n`);
    }
    const dir = path.join(root, '.snapshot-r1');

    expect(saveSnapshot({ repoDir: root, dir, files: names })).toBe(4);
    expect(listSnapshotFiles(dir)).toEqual([...names].sort());
    expect(listSnapshotScope(dir)).toEqual([...names].sort());
    expect(listSnapshotSkipped(dir)).toEqual([]);

    for (const name of names) {
      fs.writeFileSync(path.join(root, name), `new:${name}\n`);
    }
    const incremental = generateIncrementalDiff({
      repoDir: root,
      snapshotDir: dir,
      files: listSnapshotScope(dir),
      runGitStatus: defaultRunGitStatus,
    });
    for (const name of names) {
      expect(incremental).toContain(`diff --git a/${name} b/${name}`);
      expect(incremental).toContain(`-old:${name}`);
      expect(incremental).toContain(`+new:${name}`);
    }
  });

  test('should read a v2 manifest only when every recorded path is valid', () => {
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'ok.js'), 'x\n');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        scope: ['..notes.txt', 'ok.js', 'src/a.js'],
        skipped: ['..notes.txt'],
      })
    );

    expect(listSnapshotFiles(dir)).toEqual(['ok.js']);
    expect(listSnapshotScope(dir)).toEqual([
      '..notes.txt',
      'ok.js',
      'src/a.js',
    ]);
    expect(listSnapshotSkipped(dir)).toEqual(['..notes.txt']);
  });

  test('should reject a whole manifest when any recorded path is invalid', () => {
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'ok.js'), 'x\n');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        scope: ['../out', '/abs', './x', 'a\\b', '..notes.txt', 'ok.js'],
        skipped: ['../out', '..notes.txt'],
      })
    );

    expect(listSnapshotFiles(dir)).toEqual([]);
    expect(listSnapshotScope(dir)).toEqual([]);
    expect(listSnapshotSkipped(dir)).toEqual([]);
  });

  test('should reject a manifest with a non-string or unnormalized entry', () => {
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'ok.js'), 'x\n');
    for (const scope of [['ok.js', 7], ['a/./b.js']]) {
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ version: 1, scope, skipped: [] })
      );
      expect(listSnapshotFiles(dir)).toEqual([]);
      expect(listSnapshotScope(dir)).toEqual([]);
    }
  });

  test('should name round snapshots and find an earlier one only when it exists', () => {
    const reviews = path.join(root, 'reviews');

    expect(snapshotDirFor(reviews, 2)).toBe(path.join(reviews, '.snapshot-r2'));
    expect(previousSnapshotDir(reviews, 1)).toBeNull();
    fs.mkdirSync(snapshotDirFor(reviews, 1), { recursive: true });
    expect(previousSnapshotDir(reviews, 1)).toBe(
      path.join(reviews, '.snapshot-r1')
    );
  });

  test('should record a protected path under a former directory without throwing', () => {
    fs.writeFileSync(path.join(root, 'config'), 'now a file\n');
    const dir = path.join(root, '.snapshot-r1');

    expect(
      saveSnapshot({ repoDir: root, dir, files: ['config/.env', 'config'] })
    ).toBe(1);
    expect(listSnapshotScope(dir)).toEqual(['config', 'config/.env']);
    expect(listSnapshotSkipped(dir)).toEqual([]);
  });

  test('should reject a manifest that lists a bare parent path', () => {
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, scope: ['..', 'ok.js'], skipped: [] })
    );

    expect(listSnapshotScope(dir)).toEqual([]);
  });

  test('should ignore an invalid manifest', () => {
    const dir = path.join(root, '.snapshot-r1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'a.js'), 'x\n');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json');

    expect(listSnapshotFiles(dir)).toEqual([]);
    expect(listSnapshotScope(dir)).toEqual([]);
    expect(listSnapshotSkipped(dir)).toEqual([]);
  });

  test('should reject a symlinked snapshot root before reading any content', () => {
    const reviews = path.join(root, 'reviews');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'files'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'files', 'sneaky.js'), 'sneaky\n');
    fs.writeFileSync(
      path.join(outside, 'manifest.json'),
      JSON.stringify({ version: 1, scope: ['sneaky.js'], skipped: [] })
    );
    fs.mkdirSync(reviews, { recursive: true });
    const dir = snapshotDirFor(reviews, 1);
    fs.symlinkSync(outside, dir, 'junction');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      expect(listSnapshotFiles(dir)).toEqual([]);
      expect(listSnapshotScope(dir)).toEqual([]);
      expect(listSnapshotSkipped(dir)).toEqual([]);
      expect(
        generateIncrementalDiff({
          repoDir: root,
          snapshotDir: dir,
          files: ['sneaky.js'],
          runGitStatus: defaultRunGitStatus,
        })
      ).toBeNull();
      expect(
        readSpy.mock.calls.some(([file]) => String(file).includes('sneaky'))
      ).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('should reject a symlinked files/ directory before reading any content', () => {
    const dir = path.join(root, '.snapshot-r1');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sneaky.js'), 'sneaky\n');
    fs.symlinkSync(outside, path.join(dir, 'files'), 'junction');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, scope: ['sneaky.js'], skipped: [] })
    );
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      expect(listSnapshotFiles(dir)).toEqual([]);
      expect(listSnapshotScope(dir)).toEqual([]);
      expect(
        generateIncrementalDiff({
          repoDir: root,
          snapshotDir: dir,
          files: ['sneaky.js'],
          runGitStatus: defaultRunGitStatus,
        })
      ).toBeNull();
      expect(
        readSpy.mock.calls.some(([file]) => String(file).includes('sneaky'))
      ).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('should reject an invalid or partial manifest before reading mirrored content', () => {
    for (const manifest of [
      { version: 1, scope: ['sneaky.js'] },
      { version: 1, scope: ['sneaky.js'], skipped: 'x' },
      { version: 2, scope: ['sneaky.js'], skipped: [] },
    ]) {
      const dir = path.join(root, '.snapshot-r1');
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'files', 'sneaky.js'), 'sneaky\n');
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify(manifest)
      );
      const readSpy = vi.spyOn(fs, 'readFileSync');
      try {
        expect(listSnapshotFiles(dir)).toEqual([]);
        expect(listSnapshotScope(dir)).toEqual([]);
        expect(
          generateIncrementalDiff({
            repoDir: root,
            snapshotDir: dir,
            files: ['sneaky.js'],
            runGitStatus: defaultRunGitStatus,
          })
        ).toBeNull();
        expect(
          readSpy.mock.calls.some(([file]) => String(file).includes('sneaky'))
        ).toBe(false);
      } finally {
        readSpy.mockRestore();
      }
    }
  });
});

describe('generateIncrementalDiff', () => {
  /**
   * Write a hand-built snapshot's manifest beside its `files/` copies.
   *
   * @param {string} dir
   * @param {string[]} scope
   */
  const seal = (dir, scope) => {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, scope, skipped: [] })
    );
  };
  test('should diff the snapshot against the current tree with repo-relative headers', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['src/a.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(snapshotDir, 'files', 'src', 'a.js'),
      'one\ntwo\n'
    );
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'one\nTWO\n');
    const snapshotFile = path.join(snapshotDir, 'files', 'src', 'a.js');
    const currentFile = path.join(root, 'src', 'a.js');
    /** @type {(args: string[], cwd: string) => { status: number | null, stdout: string }} */
    const runGitStatus = vi.fn(() => ({
      status: 1,
      stdout: [
        `diff --git a/${snapshotFile} b/${currentFile}`,
        'index 111..222 100644',
        `--- a/${snapshotFile}`,
        `+++ b/${currentFile}`,
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        '',
      ].join('\n'),
    }));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['src/a.js'],
      runGitStatus,
    });

    expect(patch).toContain('diff --git a/src/a.js b/src/a.js');
    expect(patch).toContain('--- a/src/a.js');
    expect(patch).toContain('+++ b/src/a.js');
    expect(patch).toContain('-two\n+TWO');
    expect(runGitStatus).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-index',
        '--unified=8',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--',
        snapshotFile,
        currentFile,
      ],
      root
    );
  });

  test('should show new and deleted files against the snapshot', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['added.js', 'removed.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'files', 'removed.js'), 'gone\n');
    fs.writeFileSync(path.join(root, 'added.js'), 'fresh\n');
    const runGitStatus = vi.fn(() => ({ status: 0, stdout: '' }));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['added.js', 'removed.js'],
      runGitStatus,
    });

    expect(patch).toContain('diff --git a/added.js b/added.js');
    expect(patch).toContain('+fresh');
    expect(patch).toContain('diff --git a/removed.js b/removed.js');
    expect(patch).toContain('-gone');
    expect(runGitStatus).not.toHaveBeenCalled();
  });

  test('should skip unchanged files and failed diffs', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['same.js', 'broken.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'files', 'same.js'), 'same\n');
    fs.writeFileSync(path.join(root, 'same.js'), 'same\n');
    fs.writeFileSync(path.join(snapshotDir, 'files', 'broken.js'), 'a\n');
    fs.writeFileSync(path.join(root, 'broken.js'), 'b\n');
    /** @type {(args: string[], cwd: string) => { status: number | null, stdout: string }} */
    const runGitStatus = vi.fn((args) =>
      args.includes(path.join(root, 'broken.js'))
        ? { status: 2, stdout: '' }
        : { status: 0, stdout: '' }
    );

    expect(
      generateIncrementalDiff({
        repoDir: root,
        snapshotDir,
        files: ['same.js', 'broken.js'],
        runGitStatus,
      })
    ).toBeNull();
  });

  test('should cap and redact the incremental patch', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['a.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'files', 'a.js'), 'old\n');
    fs.writeFileSync(path.join(root, 'a.js'), 'new\n');
    /** @type {(args: string[], cwd: string) => { status: number | null, stdout: string }} */
    const runGitStatus = vi.fn(() => ({
      status: 1,
      stdout: `diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-old\n+TOKEN=ghp_${'a'.repeat(36)}\n`,
    }));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['a.js'],
      runGitStatus,
    });

    expect(patch).toContain('[REDACTED]');
    expect(patch).not.toContain('ghp_');
  });

  test('should redact secrets before truncating an incremental file diff', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['a.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'files', 'a.js'), 'old\n');
    fs.writeFileSync(path.join(root, 'a.js'), 'new\n');
    const token = 'sk-proj-' + 'z'.repeat(40);
    /** @type {(args: string[], cwd: string) => { status: number | null, stdout: string }} */
    const runGitStatus = vi.fn(() => ({
      status: 1,
      stdout: `diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1 +1,2 @@\n+${'a'.repeat(15)} ${token}\n+${'b'.repeat(100)}\n`,
    }));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['a.js'],
      runGitStatus,
      maxFileBytes: 100,
      maxTotalBytes: 10_000,
    });

    expect(patch).toContain('[REDACTED]');
    expect(patch).toContain('truncated: omitted');
    expect(patch).not.toContain('sk-proj-');
    expect(patch).not.toContain('zzzzz');
  });

  test('should not render snapshot-skipped binary or oversized files as newly added', () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(
      path.join(root, 'big.json'),
      'x'.repeat(SNAPSHOT_MAX_FILE_BYTES + 1)
    );
    const snapshotDir = path.join(root, '.snapshot-r1');
    saveSnapshot({
      repoDir: root,
      dir: snapshotDir,
      files: ['blob.bin', 'big.json'],
    });
    fs.rmSync(path.join(root, 'blob.bin'));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['blob.bin', 'big.json'],
    });

    expect(patch).toContain('diff --git a/big.json b/big.json');
    expect(patch).toContain('omitted from previous round snapshot');
    expect(patch).not.toContain('new file mode 100644');
    expect(patch).toContain('diff --git a/blob.bin b/blob.bin');
    expect(patch).toContain('deleted file (was omitted from previous round');
  });

  test('should preserve literal dollar signs when rewriting --no-index headers', () => {
    const snapshotDir = path.join(root, '.snapshot-r1');
    seal(snapshotDir, ['routes/$id.js']);
    fs.mkdirSync(path.join(snapshotDir, 'files', 'routes'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(snapshotDir, 'files', 'routes', '$id.js'),
      'a\n'
    );
    fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'routes', '$id.js'), 'b\n');
    /** @type {(args: string[], cwd: string) => { status: number | null, stdout: string }} */
    const runGitStatus = vi.fn(() => ({
      status: 1,
      stdout: 'diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n',
    }));

    const patch = generateIncrementalDiff({
      repoDir: root,
      snapshotDir,
      files: ['routes/$id.js'],
      runGitStatus,
    });

    expect(patch).toContain('diff --git a/routes/$id.js b/routes/$id.js');
    expect(patch).toContain('--- a/routes/$id.js');
    expect(patch).toContain('+++ b/routes/$id.js');
  });
});
