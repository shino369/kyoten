/**
 * Review rounds for code tasks: `pnpm task review` opens a round and writes
 * the brief a clean-context reviewer works from; `pnpm task review record`
 * reads the triaged findings table and turns CONFIRMED must-fix/high
 * findings into `fix:` steps.
 *
 * Scope: for a task that works in another repository (`--repo`), the git
 * changes there. Otherwise the task's own code in its folder (code in any
 * language and its config, `docs/` included, minus the `scripts/` helpers; no
 * git: the folder is git-ignored) when it has any, else the git changes in
 * the workspace, else the task's scripts. The brief marks scope files `pnpm
 * task check` does not check and lists the folder's code the scope leaves
 * out (helpers, or the folder beside a git scope). Git changes are counted
 * from the task's start commit when the task started on HEAD's line after
 * the branch point (or on the default branch itself), else from the branch
 * point with the default branch (`origin/HEAD` as fetched, else `main`); an
 * explicit `--base` is used as given.
 */
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isSourceFile, listCodeFiles, listReviewFiles } from './check.js';
import { git } from './git.js';
import { writePrivate } from '../kyoten/dscc.js';
import { SEVERITIES, VERDICTS, freshQuality, toFix } from './quality.js';
import { addStep } from './state.js';
import { ensurePrivateDir, taskRepoDir } from './store.js';
import { relPosix } from '../paths.js';
import { containsSecret, redactSecrets } from '../redact.js';

/** Fallback base when the repository has no `origin/HEAD`. */
export const DEFAULT_BASE = 'main';
/**
 * The base a round records when `--folder` chose the task folder, so later
 * rounds and the Stop hook stay on it. Never a git ref: refs cannot hold ':'.
 */
export const FOLDER_BASE = ':task-folder';
/** Context lines around each hunk in a round's pre-computed diff patch. */
export const DIFF_CONTEXT_LINES = 8;
/** Per-file cap of a diff patch; a longer file diff is truncated. */
export const MAX_DIFF_FILE_BYTES = 40 * 1024;
/** Total cap of a diff patch; the files left out are listed with their stats. */
export const MAX_DIFF_TOTAL_BYTES = 200 * 1024;
/** Text files larger than this are left out of a round's snapshot. */
export const SNAPSHOT_MAX_FILE_BYTES = 256 * 1024;
export const STANDARDS = [
  'AGENTS.md',
  '.claude/rules/working-with-script.md',
  '.claude/rules/testing.md',
];
export const FINDINGS_HEADER = [
  'id',
  'file:line',
  'severity',
  'claim',
  'failure scenario',
  'verdict',
  'reason',
];

export const SEVERITY_RUBRIC = `- must-fix: wrong behavior, data loss, a security hole, or an acceptance criterion not met
- high: a design or architecture problem that will cause bugs or blocks the goal
- medium: a real but local problem (recorded, not fixed this task)
- low: cleanup, naming, style (recorded, not fixed this task)`;

/**
 * @typedef {import('./state.js').TaskState} TaskState
 * @typedef {import('./quality.js').Finding} Finding
 * @typedef {(args: string[], cwd: string) => string | null} RunGit
 * @typedef {(args: string[], cwd: string) => { status: number | null, stdout: string }} RunGitStatus
 * @typedef {{ added: number, deleted: number, binary?: boolean, untracked?: boolean }} FileStat
 * @typedef {{ base: string | null, since: string | null, files: string[] }} Scope
 *   `since` is the commit the git diff starts from (null for task code).
 * @typedef {{ unchecked: string[], aside: string[] }} FolderNotes
 *   see `taskFolderNotes`
 */

/** @type {RunGit} */
export const defaultRunGit = (args, cwd) =>
  git(
    /** @type {import('./git.js').Spawn} */ (
      /** @type {unknown} */ (spawnSync)
    ),
    cwd,
    args
  );

/**
 * Like `defaultRunGit`, but keeps stdout for exit code 1: `git diff
 * --no-index` exits 1 when the files differ, which is a success here.
 *
 * @type {RunGitStatus}
 */
export const defaultRunGitStatus = (args, cwd) => {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: result.status, stdout: String(result.stdout ?? '') };
  } catch {
    return { status: null, stdout: '' };
  }
};

/**
 * @param {string} name
 * @param {number} round
 */
export const reviewFiles = (name, round) => ({
  brief: path.posix.join('reviews', `BRIEF_${name}-r${round}.md`),
  findings: path.posix.join('reviews', `REVIEW_${name}-r${round}.md`),
  diff: path.posix.join('reviews', `DIFF_${name}-r${round}.patch`),
  ...(round > 1
    ? {
        incrementalDiff: path.posix.join(
          'reviews',
          `DIFF_${name}-r${round - 1}-to-r${round}.patch`
        ),
      }
    : {}),
});

/**
 * The repository's default branch (what PRs merge into) as last fetched:
 * `origin/HEAD` as a remote ref such as `origin/main`, so a stale or missing
 * local branch does not change the scope; else `main`.
 *
 * @param {RunGit} runGit
 * @param {string} rootDir
 * @returns {string}
 */
export function defaultBranch(runGit, rootDir) {
  const ref = runGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    rootDir
  );
  return ref?.startsWith('origin/') ? ref : DEFAULT_BASE;
}

/**
 * The task's own code in its folder: code in any language and its config
 * (`listReviewFiles`, `docs/` included), minus `scripts/` (task-only helpers,
 * such as one-off generators). A helper script must not turn the review away
 * from the work it supports.
 *
 * @param {string} taskDir
 * @returns {string[]} POSIX paths relative to the task folder
 */
export function productFiles(taskDir) {
  if (!fs.existsSync(taskDir)) return [];
  return listReviewFiles(taskDir).filter(
    (file) => !file.startsWith('scripts/')
  );
}

/**
 * Whether the task folder holds product code: a source file in any language
 * (`isSourceFile`) outside `scripts/`, `docs/` included. Config, prose, and
 * data never count, so a design doc or a fixture does not move a workspace
 * task's review off its git changes.
 *
 * @param {string} taskDir
 * @returns {boolean}
 */
export function hasProductCode(taskDir) {
  return productFiles(taskDir).some(isSourceFile);
}

/**
 * Whether the task folder holds code in any language, `scripts/` included.
 *
 * @param {string} taskDir
 * @returns {boolean}
 */
const hasFolderCode = (taskDir) =>
  fs.existsSync(taskDir) && listReviewFiles(taskDir).some(isSourceFile);

/**
 * The base a round reviews against (null: the task folder, no git): an open
 * round keeps its own; otherwise `--base` (null for `--folder`), else the
 * base an earlier round recorded (so the Stop hook and the next round compare
 * the same files; FOLDER_BASE is the folder), else the default branch for a
 * task in another repository, else none for a task with product code in its
 * folder (its folder is the scope; git is not used), else the default branch
 * (see `reviewScope` for where the changes are counted from).
 *
 * @param {{ quality: import('./quality.js').Quality, taskDir: string, base?: string | null, defaultBase?: string, repo?: string | null }} options
 * @returns {string | null}
 */
export function reviewBase({
  quality,
  taskDir,
  base,
  defaultBase = DEFAULT_BASE,
  repo = null,
}) {
  const recorded = quality.base === FOLDER_BASE ? null : quality.base;
  if (quality.phase === 'review') return recorded ?? null;
  if (base !== undefined) return base;
  if (quality.base) return recorded ?? null;
  if (repo) return defaultBase;
  return hasProductCode(taskDir) ? null : defaultBase;
}

/**
 * The files a review round covers, as sorted POSIX paths: relative to the
 * workspace for task code (`base` null), else relative to `repoDir`, the
 * repository the task works in (see `scopeRoot`).
 *
 * A git scope counts the changes from the task's start commit (recorded by
 * `pnpm task new` / `init` / `set --repo`) when that commit is in HEAD's
 * history and either after the branch point (the task started on a branch
 * that already carried other work: that work is not this task's) or the work
 * is on the base branch itself (HEAD is the branch, or the merge base is
 * HEAD: the diff would be empty or only the unpushed commits). Otherwise it
 * counts from the branch point. The returned `base` says which.
 *
 * @param {{ rootDir: string, taskDir: string, base: string | null, runGit?: RunGit, startCommit?: string | null, repoDir?: string }} options
 * @returns {Scope}
 */
export function reviewScope({
  rootDir,
  taskDir,
  base,
  runGit = defaultRunGit,
  startCommit = null,
  repoDir = rootDir,
}) {
  if (base === null) {
    const prefix = relPosix(rootDir, taskDir);
    const product = productFiles(taskDir);
    // No product code: the scripts are the work, with the data beside them.
    const files = product.some(isSourceFile)
      ? product
      : listReviewFiles(taskDir);
    return {
      base: null,
      since: null,
      files: files.map((file) => `${prefix}/${file}`),
    };
  }
  if (base.startsWith('-')) {
    throw new Error(
      `${base} is not a git ref: git would read it as an option.\nFix: pass a branch or commit: pnpm task review --base <ref>`
    );
  }
  const mergeBase = runGit(['merge-base', 'HEAD', base], repoDir);
  if (!mergeBase) {
    throw new Error(
      `Cannot find the merge base of HEAD and ${base}.\nFix: pass an existing branch or commit: pnpm task review --base <ref>`
    );
  }
  const isAncestor = (/** @type {string} */ a, /** @type {string} */ b) =>
    runGit(['merge-base', '--is-ancestor', a, b], repoDir) !== null;
  const fromStart =
    startCommit !== null &&
    startCommit !== mergeBase &&
    isAncestor(startCommit, 'HEAD') &&
    (isAncestor(mergeBase, startCommit) ||
      mergeBase === runGit(['rev-parse', 'HEAD'], repoDir) ||
      runGit(['branch', '--show-current'], repoDir) ===
        base.replace(/^origin\//, ''));
  const since = fromStart ? startCommit : mergeBase;
  const rawTracked = splitGitPaths(
    runGit(['diff', '--name-only', '--no-renames', '-z', since], repoDir)
  );
  const rawUntracked = splitGitPaths(
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoDir)
  );
  const protectedTracked = rawTracked.filter(isSecretFile);
  const eligibleTracked = rawTracked.filter((file) => !isSecretFile(file));
  const eligibleSet = new Set(eligibleTracked);
  const resolvedTracked =
    eligibleTracked.length === 0
      ? []
      : splitGitPaths(
          runGit(
            diffArgs(['--name-only', '-M', '-z'], since, eligibleTracked, [
              ...protectedTracked,
              ...rawUntracked.filter(isSecretFile),
            ]),
            repoDir
          )
        ).filter((file) => eligibleSet.has(file));
  const trackedFiles =
    resolvedTracked.length > 0 ? resolvedTracked : eligibleTracked;
  const files = new Set([
    ...trackedFiles,
    ...protectedTracked,
    ...rawUntracked,
  ]);
  // tasks/ is this workspace's git-ignored task folder; another repository's
  // tasks/ is code like any other.
  const inWorkspace = repoDir === rootDir;
  return {
    base: fromStart ? startCommit : base,
    since,
    files: [...files]
      .filter((file) => !inWorkspace || !file.startsWith('tasks/'))
      .sort(),
  };
}

/**
 * The folder a scope's paths are relative to (and `fingerprint` reads them
 * from): the workspace for task code, else the task's repository.
 *
 * @param {string} rootDir
 * @param {TaskState} state
 * @param {Scope} scope
 * @returns {string}
 */
export function scopeRoot(rootDir, state, scope) {
  return scope.base === null ? rootDir : taskRepoDir(rootDir, state);
}

/**
 * The base to record for a round over `scope`: a git scope's own base;
 * FOLDER_BASE when the folder was chosen (`folder`: `--folder` now, or an
 * earlier round's FOLDER_BASE); else null (the folder, chosen automatically,
 * which the next round chooses again).
 *
 * @param {Scope} scope
 * @param {import('./quality.js').Quality} quality
 * @param {boolean} [folder] `--folder` was given
 * @returns {string | null}
 */
export function roundBase(scope, quality, folder = false) {
  if (scope.base !== null) return scope.base;
  return folder || quality.base === FOLDER_BASE ? FOLDER_BASE : null;
}

/**
 * The scope of a task's next (or open) round: `reviewBase`, then
 * `reviewScope`. An explicit `--base` is used as given (null: `--folder`);
 * only the default base falls back to the task's start commit.
 *
 * @param {{ rootDir: string, taskDir: string, state: TaskState, base?: string | null, runGit?: RunGit }} options
 * @returns {Scope}
 */
export function taskReviewScope({
  rootDir,
  taskDir,
  state,
  base,
  runGit = defaultRunGit,
}) {
  const quality = state.quality ?? freshQuality();
  const repoDir = taskRepoDir(rootDir, state);
  const scope = reviewScope({
    rootDir,
    taskDir,
    base: reviewBase({
      quality,
      taskDir,
      base,
      defaultBase: defaultBranch(runGit, repoDir),
      repo: state.repo,
    }),
    runGit,
    startCommit: base === undefined ? (state.startCommit ?? null) : null,
    repoDir,
  });
  // A workspace task whose only code is its scripts (any language) and that
  // changed nothing in git: the scripts are its work.
  const chosen =
    base === undefined &&
    quality.phase !== 'review' &&
    !quality.base &&
    !state.repo;
  if (
    chosen &&
    scope.base !== null &&
    scope.files.length === 0 &&
    hasFolderCode(taskDir)
  ) {
    return reviewScope({ rootDir, taskDir, base: null, runGit });
  }
  return scope;
}

/**
 * Whether a review round can open now, and what identifies what it would
 * review. Shared by `pnpm task review` and the automated review (the Stop
 * hook's quality loop and `pnpm loop --review`) so both agree.
 *
 * A non-empty git scope is eligible. An empty scope is still eligible when a
 * round is already open (reopening it), or when the previous round left a
 * snapshot with changes against the working tree: deleting the only oversized
 * untracked file from round 1, or restoring the only deleted tracked file,
 * makes the git scope empty, but the round-2 fix is exactly that change. A
 * genuinely empty first round is not eligible. The empty-scope fingerprint
 * folds in the incremental diff, so the quality loop sees the change instead
 * of comparing the constant empty-scope hash with round 1's fingerprint.
 *
 * @param {{ rootDir: string, taskDir: string, state: TaskState, scope: Scope, runGitStatus?: RunGitStatus }} options
 * @returns {{ eligible: boolean, paths: string[], fingerprint: string | null, incremental: string | null }}
 */
export function reviewPreflight({
  rootDir,
  taskDir,
  state,
  scope,
  runGitStatus = defaultRunGitStatus,
}) {
  const quality = state.quality ?? freshQuality();
  const dir = scopeRoot(rootDir, state, scope);
  if (scope.files.length > 0) {
    return {
      eligible: true,
      paths: [...scope.files],
      fingerprint: fingerprint(dir, scope.files),
      incremental: null,
    };
  }
  if (quality.phase === 'review') {
    return {
      eligible: true,
      paths: [],
      fingerprint: fingerprint(dir, []),
      incremental: null,
    };
  }
  if (quality.reviewRounds > 0) {
    const reviewsDir = path.join(taskDir, 'reviews');
    const priorSnapshot = previousSnapshotDir(reviewsDir, quality.reviewRounds);
    const priorFiles =
      priorSnapshot === null ? [] : listSnapshotScope(priorSnapshot);
    if (priorSnapshot !== null && priorFiles.length > 0) {
      const incremental = generateIncrementalDiff({
        repoDir: dir,
        snapshotDir: priorSnapshot,
        files: priorFiles,
        runGitStatus,
      });
      if (incremental !== null) {
        const digest = crypto
          .createHash('sha256')
          .update(incremental)
          .digest('hex')
          .slice(0, 16);
        return {
          eligible: true,
          paths: priorFiles,
          fingerprint: `${fingerprint(dir, [])}-${digest}`,
          incremental,
        };
      }
    }
  }
  return { eligible: false, paths: [], fingerprint: null, incremental: null };
}

/**
 * What the brief adds about the task folder, as workspace-relative paths:
 * `unchecked`, the scope's folder files `pnpm task check` does not look at
 * (other languages, `docs/`), so the reviewer checks their style by hand;
 * and `aside`, the folder's code the scope leaves out (helper scripts, or the
 * whole folder beside a git scope), so the reviewer knows it is there. Only
 * what `listReviewFiles` finds is listed: dot-folders, dependency and build
 * folders, other kinds of file, and config named like credentials are not.
 *
 * @param {{ rootDir: string, taskDir: string, scope: Scope }} options
 * @returns {FolderNotes}
 */
export function taskFolderNotes({ rootDir, taskDir, scope }) {
  if (!fs.existsSync(taskDir)) return { unchecked: [], aside: [] };
  const prefix = relPosix(rootDir, taskDir);
  const fromRoot = (/** @type {string} */ file) => `${prefix}/${file}`;
  const checked = new Set(listCodeFiles(taskDir).map(fromRoot));
  const inScope = new Set(scope.files);
  return {
    unchecked:
      scope.base === null
        ? scope.files.filter((file) => !checked.has(file))
        : [],
    aside: listReviewFiles(taskDir)
      .filter(isSourceFile)
      .map(fromRoot)
      .filter((file) => !inScope.has(file)),
  };
}

/**
 * Content hash of the files in scope; changes whenever reviewed code does.
 *
 * @param {string} rootDir
 * @param {string[]} files root-relative paths
 * @returns {string}
 */
export function fingerprint(rootDir, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(`${file}\0`);
    const entry = inspectWorkingFile(rootDir, file);
    if (entry.kind === 'file') {
      hash.update(fs.readFileSync(entry.full));
    } else if (entry.kind === 'symlink') {
      try {
        hash.update(`\0symlink:${fs.readlinkSync(entry.full)}`);
      } catch {
        hash.update('\0symlink');
      }
    } else if (entry.kind === 'secret') {
      hash.update('\0secret');
    } else {
      hash.update('\0deleted');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The lines a text holds, not counting a final newline.
 *
 * @param {string} text
 * @returns {number}
 */
const countLines = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
};

/**
 * Whether a buffer looks binary: a NUL byte in its first 8 KB.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

/**
 * A `git diff`-style patch for a file the base commit did not have.
 *
 * @param {string} file repo-relative POSIX path
 * @param {Buffer} buffer
 * @returns {string}
 */
function newFileDiff(file, buffer) {
  const header = [`diff --git a/${file} b/${file}`, 'new file mode 100644'];
  if (isBinary(buffer)) {
    return [...header, `Binary file (new, ${buffer.length} bytes)`, ''].join(
      '\n'
    );
  }
  const lines = buffer.toString('utf-8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return [...header, ''].join('\n');
  return [
    ...header,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

/**
 * A `git diff`-style patch for a snapshotted file the working tree no longer
 * has.
 *
 * @param {string} file repo-relative POSIX path
 * @param {Buffer} buffer
 * @returns {string}
 */
function deletedFileDiff(file, buffer) {
  const header = [`diff --git a/${file} b/${file}`, 'deleted file mode 100644'];
  if (isBinary(buffer)) {
    return [
      ...header,
      `Binary file (deleted, ${buffer.length} bytes)`,
      '',
    ].join('\n');
  }
  const lines = buffer.toString('utf-8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return [...header, ''].join('\n');
  return [
    ...header,
    `--- a/${file}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
    '',
  ].join('\n');
}

/**
 * Cap one file's diff on a line boundary and say how much was left out.
 *
 * @param {string} text
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string}
 */
function capFileDiff(text, file, maxBytes) {
  if (text.length <= maxBytes) return text;
  const cut = text.lastIndexOf('\n', maxBytes);
  const kept = text.slice(0, cut === -1 ? maxBytes : cut);
  const omitted = text
    .slice(kept.length)
    .split('\n')
    .filter((line) => line !== '').length;
  return `${kept}\n... [truncated: omitted ${omitted} more line(s) of ${file}; inspect targeted line ranges with read_file]\n`;
}

/**
 * Split raw NUL-delimited (`-z`) git path output, falling back to newlines for
 * simple line-based mocks.
 *
 * @param {string | null} text
 * @returns {string[]}
 */
function splitGitPaths(text) {
  if (!text) return [];
  return (text.includes('\0') ? text.split('\0') : text.split('\n')).filter(
    Boolean
  );
}

/**
 * Parse `git diff --name-status -M -z` (or newline fallback) into the set of
 * tracked destination paths and a map `newPath -> oldPath` for renames/copies.
 *
 * @param {string | null} text
 * @returns {{ tracked: Set<string>, renames: Map<string, string> }}
 */
function parseNameStatus(text) {
  /** @type {Set<string>} */
  const tracked = new Set();
  /** @type {Map<string, string>} */
  const renames = new Map();
  if (!text) return { tracked, renames };
  if (text.includes('\0')) {
    const tokens = text.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i];
      if (!status) continue;
      if (status[0] === 'R' || status[0] === 'C') {
        const oldPath = tokens[++i];
        const newPath = tokens[++i];
        if (newPath) {
          tracked.add(newPath);
          if (oldPath) renames.set(newPath, oldPath);
        }
      } else {
        const file = tokens[++i];
        if (file) tracked.add(file);
      }
    }
    return { tracked, renames };
  }
  for (const line of text.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length === 1) {
      tracked.add(parts[0]);
    } else if (
      (parts[0][0] === 'R' || parts[0][0] === 'C') &&
      parts.length >= 3
    ) {
      tracked.add(parts[2]);
      renames.set(parts[2], parts[1]);
    } else if (parts[1]) {
      tracked.add(parts[1]);
    }
  }
  return { tracked, renames };
}

/**
 * Parse `git diff --numstat -z` (or newline fallback) into per-file line stats.
 *
 * @param {string | null} text
 * @returns {Map<string, FileStat>}
 */
function parseNumstat(text) {
  /** @type {Map<string, FileStat>} */
  const stats = new Map();
  if (!text) return stats;
  /** @param {string} added @param {string} deleted @returns {FileStat} */
  const toStat = (added, deleted) =>
    added === '-' || deleted === '-'
      ? { added: 0, deleted: 0, binary: true }
      : { added: Number(added), deleted: Number(deleted) };
  if (text.includes('\0')) {
    const tokens = text.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry) continue;
      const [added, deleted, ...rest] = entry.split('\t');
      let file = rest.join('\t');
      if (file === '') {
        // Rename/copy record: "<added>\t<deleted>\t\0<old>\0<new>\0"
        i += 1;
        file = tokens[++i] ?? '';
      }
      if (file) stats.set(file, toStat(added, deleted));
    }
    return stats;
  }
  for (const line of text.split('\n').filter(Boolean)) {
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (file) stats.set(file, toStat(added, deleted));
  }
  return stats;
}

const SECRET_DIR_NAMES = new Set(['secrets', '.ssh', '.aws', '.gnupg']);
const SECRET_BASENAMES = new Set([
  'credentials.json',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SECRET_KEY_EXT_RE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|ovpn)$/i;
const SECRET_CONFIG_EXT = new Set([
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.txt',
  '.secret',
  '.secrets',
]);
const SECRET_CONFIG_NAME_RE =
  /(^|[._-])(credentials?|secrets?|service[-_]?account|api[-_]?keys?|private[-_]?key|tokens?|passwords?)([._-]|$)/i;
const ENV_TEMPLATE_RE = /\.(?:example|sample|template)$/i;

/**
 * Whether `file` is a secret or credential path that review artifacts must
 * never read or copy (AGENTS.md §1: `.env*`, `*.env`, `secrets/`, `.ssh/`,
 * `.aws/`, `*.pem`, `*.key`, `credentials.json`, and credential-named config
 * files).
 *
 * @param {string} file repo-relative POSIX path
 * @returns {boolean}
 */
export function isSecretFile(file) {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  const base = parts.at(-1) ?? '';
  const lower = base.toLowerCase();
  if (
    parts
      .slice(0, -1)
      .some((segment) => SECRET_DIR_NAMES.has(segment.toLowerCase()))
  ) {
    return true;
  }
  if (
    (/^\.env(?:\..+)?$/i.test(base) || /\.env$/i.test(base)) &&
    !ENV_TEMPLATE_RE.test(base)
  ) {
    return true;
  }
  if (SECRET_KEY_EXT_RE.test(base) || SECRET_BASENAMES.has(lower)) {
    return true;
  }
  const ext = path.posix.extname(base).toLowerCase();
  return (
    SECRET_CONFIG_EXT.has(ext) &&
    SECRET_CONFIG_NAME_RE.test(base) &&
    !ENV_TEMPLATE_RE.test(base)
  );
}

/**
 * Whether `rel` (a `path.relative` result) points outside its base: exactly
 * `..`, or a path that starts with `../` / `..\\`. A legal filename that merely
 * starts with two dots (`..notes.txt`, `dir/..config.js`) is inside.
 *
 * @param {string} rel
 * @returns {boolean}
 */
const isOutsideRel = (rel) =>
  rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../');

/**
 * Resolve `relPath` strictly inside `baseDir`, returning null on traversal,
 * absolute paths, or NUL bytes.
 *
 * @param {string} baseDir
 * @param {string} relPath
 * @returns {string | null}
 */
function resolveInside(baseDir, relPath) {
  if (!relPath || relPath.includes('\0')) return null;
  const normalized = relPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relPath)) {
    return null;
  }
  if (normalized.split('/').some((segment) => segment === '..')) return null;
  const resolvedBase = path.resolve(baseDir);
  const full = path.resolve(resolvedBase, relPath);
  const rel = path.relative(resolvedBase, full);
  if (!rel || isOutsideRel(rel) || path.isAbsolute(rel)) return null;
  return full;
}

/**
 * Whether `full` resolves (through symlinks) to a regular file inside `root`.
 *
 * @param {string} root
 * @param {string} full
 * @returns {boolean}
 */
function realFileInside(root, full) {
  try {
    if (!fs.lstatSync(full).isFile()) return false;
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(full));
    return Boolean(rel) && !isOutsideRel(rel) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Static pathspec exclusions for the credential locations AGENTS.md §1
 * protects. Every git content query receives these beside the literal
 * exclusions of the paths in scope.
 */
export const STATIC_PROTECTED_EXCLUDES = [
  ':(exclude,glob)**/secrets/**',
  ':(exclude,glob)**/.ssh/**',
  ':(exclude,glob)**/.aws/**',
  ':(exclude,glob)**/.gnupg/**',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/credentials.json',
];

/**
 * A `git diff` query over literal paths, never an external diff driver or a
 * textconv filter: review artifacts show the repository bytes. Each allowed
 * path is prefixed with `:(literal)`, so glob characters stay literal, and
 * each protected path is an explicit `:(exclude,literal)` pathspec, so a
 * file-to-directory transition (`config` -> `config/`) cannot select a
 * protected descendant. `--literal-pathspecs` must not be passed: it disables
 * the `:(exclude,...)` magic.
 *
 * @param {string[]} options diff subcommand options (e.g. `['--numstat', '-z']`)
 * @param {string} since
 * @param {string[]} allowedPaths eligible repo-relative POSIX paths
 * @param {string[]} [excludedPaths] protected repo-relative POSIX paths
 * @returns {string[]}
 */
function diffArgs(options, since, allowedPaths, excludedPaths = []) {
  return [
    '-c',
    'core.quotePath=false',
    'diff',
    ...options,
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    since,
    '--',
    ...allowedPaths.map((file) => `:(literal)${file}`),
    ...excludedPaths.map((file) => `:(exclude,literal)${file}`),
    ...STATIC_PROTECTED_EXCLUDES,
  ];
}

/**
 * @typedef {{ untracked: Set<string>, allowed: string[], excluded: string[] }} GitSelection
 */

/**
 * How a git scope maps onto git content queries: the paths a query may receive
 * (`allowed`), the protected ones it must never receive (`excluded`), and the
 * paths confirmed untracked (the only ones a review renders as new files).
 * `diffArgs` passes `excluded` as `:(exclude,literal)` pathspecs, and Git
 * filters pathspecs before rename detection, so a protected file is never
 * paired with an ordinary one: `git mv .env config.txt` shows `config.txt` as
 * a new file and no line of `.env`. A path removed from the index but kept on
 * disk is tracked (a deletion, as `--numstat` reports it), not untracked.
 *
 * @param {{ repoDir: string, scope: Scope, runGit: RunGit }} options
 * @returns {GitSelection}
 */
function selectGitChanges({ repoDir, scope, runGit }) {
  const since = /** @type {string} */ (scope.since);
  const tracked = splitGitPaths(
    runGit(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        since,
      ],
      repoDir
    )
  );
  const trackedSet = new Set(tracked);
  const untrackedList = splitGitPaths(
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoDir)
  );
  const candidates = new Set([...scope.files, ...tracked, ...untrackedList]);
  return {
    untracked: new Set(untrackedList.filter((file) => !trackedSet.has(file))),
    allowed: [...new Set([...scope.files, ...tracked])]
      .filter((file) => !isSecretFile(file))
      .sort(),
    excluded: [...candidates].filter(isSecretFile).sort(),
  };
}

/**
 * Inspect a repo-relative path without ever following symlinks or reading
 * files outside `repoDir` or secret targets.
 *
 * @param {string} repoDir
 * @param {string} file
 * @returns {{ kind: 'secret' | 'unsafe' | 'missing' | 'other' } | { kind: 'symlink', full: string } | { kind: 'file', full: string, size: number }}
 */
function inspectWorkingFile(repoDir, file) {
  if (isSecretFile(file)) return { kind: 'secret' };
  const full = resolveInside(repoDir, file);
  if (!full) return { kind: 'unsafe' };
  let st;
  try {
    st = fs.lstatSync(full);
  } catch {
    return { kind: 'missing' };
  }
  if (st.isSymbolicLink()) return { kind: 'symlink', full };
  if (!st.isFile()) return { kind: 'other' };
  try {
    const realRepo = fs.realpathSync(repoDir);
    const realFull = fs.realpathSync(full);
    const rel = path.relative(realRepo, realFull);
    if (!rel || isOutsideRel(rel) || path.isAbsolute(rel)) {
      return { kind: 'unsafe' };
    }
    if (isSecretFile(rel.split(path.sep).join('/'))) {
      return { kind: 'secret' };
    }
  } catch {
    return { kind: 'unsafe' };
  }
  return { kind: 'file', full, size: st.size };
}

/**
 * `+X/-Y` (or `binary`, or `unknown`) for a file's stats.
 *
 * @param {FileStat | undefined} stat
 * @returns {string}
 */
const statLabel = (stat) =>
  stat === undefined
    ? 'unknown'
    : stat.binary
      ? 'binary'
      : stat.untracked
        ? `+${stat.added}/-0, new`
        : `+${stat.added}/-${stat.deleted}`;

/**
 * Added and deleted line counts for the files in scope, for the brief. A git
 * scope uses `git diff --numstat -z`; untracked files are counted from disk and
 * flagged `untracked`. Protected paths are never read or counted. A
 * task-folder scope has no base and returns nothing.
 *
 * @param {{ repoDir: string, scope: Scope, runGit?: RunGit }} options
 * @returns {Map<string, FileStat>}
 */
export function diffStats({ repoDir, scope, runGit = defaultRunGit }) {
  /** @type {Map<string, FileStat>} */
  const stats = new Map();
  if (scope.base === null || scope.since === null) return stats;
  const inScope = new Set(scope.files);
  const selection = selectGitChanges({ repoDir, scope, runGit });
  const excluded = new Set(selection.excluded);
  if (selection.allowed.length > 0) {
    for (const [file, stat] of parseNumstat(
      runGit(
        diffArgs(
          ['--numstat', '-M', '-z'],
          scope.since,
          selection.allowed,
          selection.excluded
        ),
        repoDir
      )
    )) {
      if (inScope.has(file) && !excluded.has(file) && !isSecretFile(file)) {
        stats.set(file, stat);
      }
    }
  }
  for (const file of selection.untracked) {
    if (!inScope.has(file) || stats.has(file)) continue;
    if (excluded.has(file) || isSecretFile(file)) continue;
    const entry = inspectWorkingFile(repoDir, file);
    if (entry.kind !== 'file') continue;
    let buffer;
    try {
      buffer = fs.readFileSync(entry.full);
    } catch {
      continue;
    }
    if (isBinary(buffer)) {
      stats.set(file, { added: 0, deleted: 0, binary: true, untracked: true });
      continue;
    }
    stats.set(file, {
      added: countLines(buffer.toString('utf-8')),
      deleted: 0,
      untracked: true,
    });
  }
  return stats;
}

/**
 * The patch a reviewer reads first: a unified diff of the files in scope
 * (`-U8` for surrounding context), with new/untracked files rendered as
 * standard new-file diffs and renames diffed across both sides. Secrets are
 * redacted and secret paths are omitted; a huge file is truncated and a total
 * cap lists the remaining files with their stats. Null for a task-folder scope
 * (no base) or nothing to show.
 *
 * @param {{ repoDir: string, scope: Scope, runGit?: RunGit, maxFileBytes?: number, maxTotalBytes?: number }} options
 * @returns {string | null}
 */
export function generateReviewDiff({
  repoDir,
  scope,
  runGit = defaultRunGit,
  maxFileBytes = MAX_DIFF_FILE_BYTES,
  maxTotalBytes = MAX_DIFF_TOTAL_BYTES,
}) {
  if (scope.base === null || scope.since === null || scope.files.length === 0) {
    return null;
  }
  const selection = selectGitChanges({ repoDir, scope, runGit });
  const statusText =
    selection.allowed.length === 0
      ? ''
      : runGit(
          diffArgs(
            ['--name-status', '-M', '-z'],
            scope.since,
            selection.allowed,
            selection.excluded
          ),
          repoDir
        );
  // null is a failed bulk query, '' an empty result. Only a path confirmed by
  // `ls-files --others` is rendered as a new file; when the bulk query failed,
  // the tracked paths are listed as unavailable instead of guessed.
  const { tracked, renames } =
    statusText === null
      ? { tracked: new Set(), renames: new Map() }
      : parseNameStatus(statusText);
  const renamedFrom = new Set(renames.values());
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  const omitted = [];
  /** @type {string[]} */
  const unavailable = [];
  let total = 0;
  for (const file of [...scope.files].sort()) {
    if (isSecretFile(file)) {
      chunks.push(
        `diff --git a/${file} b/${file}\n... [omitted: protected secret path]\n`
      );
      total += chunks.at(-1)?.length ?? 0;
      continue;
    }
    // The old side of a rename is shown with its destination's patch.
    if (renamedFrom.has(file)) continue;
    /** @type {string | null} */
    let text = null;
    if (selection.untracked.has(file)) {
      const entry = inspectWorkingFile(repoDir, file);
      if (entry.kind === 'symlink' || entry.kind === 'unsafe') {
        text = `diff --git a/${file} b/${file}\n... [omitted: symlink or protected path]\n`;
      } else if (entry.kind === 'file') {
        try {
          text = newFileDiff(file, fs.readFileSync(entry.full));
        } catch {
          text = null;
        }
      }
    } else {
      if (!tracked.has(file)) {
        // In scope but neither tracked nor confirmed untracked (or the bulk
        // query failed): report it rather than inventing a new file.
        unavailable.push(file);
        continue;
      }
      const oldPath = renames.get(file);
      const diff = runGit(
        diffArgs(
          ['-M', `--unified=${DIFF_CONTEXT_LINES}`],
          scope.since,
          oldPath ? [oldPath, file] : [file],
          selection.excluded
        ),
        repoDir
      );
      if (diff === null) {
        unavailable.push(file);
        continue;
      }
      if (diff) text = `${diff}\n`;
    }
    if (text === null) continue;
    text = capFileDiff(redactSecrets(text), file, maxFileBytes);
    if (chunks.length > 0 && total + text.length > maxTotalBytes) {
      omitted.push(file);
      continue;
    }
    chunks.push(text);
    total += text.length;
  }
  if (chunks.length === 0 && unavailable.length === 0) return null;
  if (omitted.length === 0 && unavailable.length === 0) return chunks.join('');
  const stats = diffStats({ repoDir, scope, runGit });
  const notes = [
    ...(omitted.length > 0
      ? [
          `... [truncated: total patch cap of ${maxTotalBytes} bytes reached; ${omitted.length} more file(s) not shown — inspect targeted line ranges directly if needed]`,
          ...omitted.map((file) => `  ${file} (${statLabel(stats.get(file))})`),
        ]
      : []),
    ...(unavailable.length > 0
      ? [
          `... [omitted: git diff unavailable for ${unavailable.length} file(s) (too large or failed) — inspect targeted line ranges directly]`,
          ...unavailable.map(
            (file) => `  ${file} (${statLabel(stats.get(file))})`
          ),
        ]
      : []),
  ];
  const prefix = chunks.length > 0 ? `${chunks.join('')}\n` : '';
  return `${prefix}${notes.join('\n')}\n`;
}

/** Metadata file of a snapshot, beside the mirrored `files/`. */
const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
/** Mirrored reviewed files live under this folder, so metadata never collides. */
const SNAPSHOT_FILES_DIR = 'files';
/** Manifest schema version. */
const SNAPSHOT_MANIFEST_VERSION = 1;

/**
 * @typedef {{ version: number, scope: string[], skipped: string[] }} SnapshotManifest
 * @typedef {{ manifest: SnapshotManifest, filesRoot: string }} SnapshotLayout
 */

/**
 * The directory a round's snapshot is saved in: `reviews/.snapshot-r<N>/`.
 *
 * @param {string} reviewsDir
 * @param {number} round
 * @returns {string}
 */
export function snapshotDirFor(reviewsDir, round) {
  return path.join(reviewsDir, `.snapshot-r${round}`);
}

/**
 * The snapshot directory of an earlier round, or null when it does not exist.
 *
 * @param {string} reviewsDir
 * @param {number} round
 * @returns {string | null}
 */
export function previousSnapshotDir(reviewsDir, round) {
  const dir = snapshotDirFor(reviewsDir, round);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Whether `full` is a real directory, never a symlink.
 *
 * @param {string} full
 * @returns {boolean}
 */
function realDirectory(full) {
  const st = fs.lstatSync(full, { throwIfNoEntry: false });
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
}

/**
 * A snapshot path exactly as recorded: relative, POSIX-separated, already
 * normalized. Null for anything else (absolute, `..`, `./x`, backslashes).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizedRelPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (value.includes('\\') || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  return normalized === value && value !== '.' && !value.startsWith('../')
    ? value
    : null;
}

/**
 * A saved snapshot's manifest and mirrored-files folder, or null when the
 * snapshot is unusable: the folder or its `files/` is missing or a symlink, or
 * `manifest.json` is missing, malformed, or lists a path that is not a
 * normalized relative path. A caller treats null as "no previous snapshot".
 *
 * @param {string} dir
 * @returns {SnapshotLayout | null}
 */
function snapshotLayout(dir) {
  const filesRoot = path.join(dir, SNAPSHOT_FILES_DIR);
  if (!realDirectory(dir) || !realDirectory(filesRoot)) return null;
  const manifestFile = path.join(dir, SNAPSHOT_MANIFEST_FILE);
  if (!realFileInside(dir, manifestFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    const valid = (/** @type {unknown} */ list) =>
      Array.isArray(list) &&
      list.every((value) => normalizedRelPath(value) !== null);
    if (
      parsed?.version !== SNAPSHOT_MANIFEST_VERSION ||
      !valid(parsed.scope) ||
      !valid(parsed.skipped)
    ) {
      return null;
    }
    return {
      manifest: {
        version: SNAPSHOT_MANIFEST_VERSION,
        scope: parsed.scope,
        skipped: parsed.skipped,
      },
      filesRoot,
    };
  } catch {
    return null;
  }
}

/**
 * The mirrored copy of `file` in a snapshot, or null when it holds none
 * (never following a symlink out of `files/`).
 *
 * @param {SnapshotLayout} layout
 * @param {string} file
 * @returns {string | null}
 */
function snapshotCopy(layout, file) {
  const full = resolveInside(layout.filesRoot, file);
  return full !== null && realFileInside(layout.filesRoot, full) ? full : null;
}

/**
 * Save the working-tree versions of `files` under `dir/files/<path>` so a
 * later round can diff against them, with `manifest.json` holding
 * `{ version: 1, scope, skipped }`. Binary, oversized, symlink, secret paths,
 * and files containing secret patterns are recorded as skipped instead of
 * mirrored, so no credentials are copied into review artifacts and a later
 * round does not mistake them for newly added files. `scope` is the complete
 * path inventory, including paths absent from the working tree (deleted
 * tracked files). Returns the number of files saved.
 *
 * @param {{ repoDir: string, dir: string, files: string[] }} options
 * @returns {number}
 */
export function saveSnapshot({ repoDir, dir, files }) {
  fs.rmSync(dir, { recursive: true, force: true });
  const filesRoot = path.join(dir, SNAPSHOT_FILES_DIR);
  ensurePrivateDir(filesRoot);
  let saved = 0;
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const inventory = [];
  for (const raw of [...new Set(files)].sort()) {
    const file = normalizedRelPath(raw);
    const target = file === null ? null : resolveInside(filesRoot, file);
    if (file === null || target === null) continue;
    inventory.push(file);
    const entry = inspectWorkingFile(repoDir, file);
    if (entry.kind === 'secret') {
      const full = resolveInside(repoDir, file);
      if (full && fs.lstatSync(full, { throwIfNoEntry: false })) {
        skipped.push(file);
      }
      continue;
    }
    if (entry.kind === 'symlink') {
      skipped.push(file);
      continue;
    }
    if (entry.kind !== 'file') continue;
    if (entry.size > SNAPSHOT_MAX_FILE_BYTES) {
      skipped.push(file);
      continue;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(entry.full);
    } catch {
      continue;
    }
    if (isBinary(buffer) || containsSecret(buffer.toString('utf-8'))) {
      skipped.push(file);
      continue;
    }
    ensurePrivateDir(path.dirname(target));
    writePrivate(target, buffer);
    saved++;
  }
  writePrivate(
    path.join(dir, SNAPSHOT_MANIFEST_FILE),
    JSON.stringify({
      version: SNAPSHOT_MANIFEST_VERSION,
      scope: inventory,
      skipped: [...new Set(skipped)].sort(),
    })
  );
  return saved;
}

/**
 * Files recorded as skipped (binary, oversized, symlink, or secret) in a saved
 * snapshot, as sorted POSIX paths; empty for an unusable snapshot.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSnapshotSkipped(dir) {
  const layout = snapshotLayout(dir);
  return layout ? [...new Set(layout.manifest.skipped)].sort() : [];
}

/**
 * The complete path inventory recorded for a snapshot round (saved, skipped,
 * and absent files), as sorted POSIX paths; empty for an unusable snapshot.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSnapshotScope(dir) {
  const layout = snapshotLayout(dir);
  if (!layout) return [];
  return [
    ...new Set([...layout.manifest.scope, ...layout.manifest.skipped]),
  ].sort();
}

/**
 * The files a saved snapshot holds, as sorted POSIX paths.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSnapshotFiles(dir) {
  const layout = snapshotLayout(dir);
  if (!layout) return [];
  const skipped = new Set(layout.manifest.skipped);
  return layout.manifest.scope
    .filter((file) => !skipped.has(file) && snapshotCopy(layout, file))
    .sort();
}

/**
 * Whether a previous round's snapshot exists but cannot be used, so the brief
 * can say the incremental patch is unavailable.
 *
 * @param {string | null} dir
 * @returns {boolean}
 */
export function snapshotUnusable(dir) {
  return dir !== null && snapshotLayout(dir) === null;
}

/**
 * Rewrite `git diff --no-index`'s two absolute paths to the repo-relative
 * `a/<file>` / `b/<file>` form reviewers expect.
 *
 * @param {string} patch
 * @param {string} file
 * @returns {string}
 */
function rewriteNoIndexHeaders(patch, file) {
  return patch
    .replace(/^diff --git .*$/m, () => `diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/m, () => `--- a/${file}`)
    .replace(/^\+\+\+ .*$/m, () => `+++ b/${file}`);
}

/**
 * What changed since the previous round: the saved snapshot against the
 * current working tree, as a unified diff with repo-relative paths. `files`
 * should be the union of the current scope and `listSnapshotScope(snapshotDir)`,
 * so a file that appeared, disappeared, or was restored still shows. Null when
 * nothing changed or the snapshot is unusable (see `snapshotLayout`).
 *
 * @param {{ repoDir: string, snapshotDir: string, files: string[], runGitStatus?: RunGitStatus, maxFileBytes?: number, maxTotalBytes?: number }} options
 * @returns {string | null}
 */
export function generateIncrementalDiff({
  repoDir,
  snapshotDir,
  files,
  runGitStatus = defaultRunGitStatus,
  maxFileBytes = MAX_DIFF_FILE_BYTES,
  maxTotalBytes = MAX_DIFF_TOTAL_BYTES,
}) {
  const layout = snapshotLayout(snapshotDir);
  if (layout === null) return null;
  const skippedInSnapshot = new Set(layout.manifest.skipped);
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  const omitted = [];
  let total = 0;
  for (const file of [...files].sort()) {
    const currentPath = resolveInside(repoDir, file);
    if (!currentPath) continue;
    if (isSecretFile(file)) {
      let exists = false;
      try {
        fs.lstatSync(currentPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists && !skippedInSnapshot.has(file)) continue;
      chunks.push(
        [
          `diff --git a/${file} b/${file}`,
          exists
            ? '... [omitted: protected secret path]'
            : 'deleted file (protected secret path)',
          '',
        ].join('\n')
      );
      total += chunks.at(-1)?.length ?? 0;
      continue;
    }
    const snapshotPath = snapshotCopy(layout, file);
    /** @type {Buffer | null} */
    let snapshot = null;
    if (snapshotPath !== null) {
      try {
        snapshot = fs.readFileSync(snapshotPath);
      } catch {
        snapshot = null;
      }
    }
    const snapshotFile = snapshot === null ? null : snapshotPath;
    const current = inspectWorkingFile(repoDir, file);
    /** @type {string | null} */
    let text = null;
    if (
      current.kind === 'secret' ||
      current.kind === 'symlink' ||
      current.kind === 'unsafe'
    ) {
      text = [
        `diff --git a/${file} b/${file}`,
        current.kind === 'secret'
          ? '... [omitted: protected secret path]'
          : '... [omitted: symlink or protected path]',
        '',
      ].join('\n');
    } else if (snapshot === null && skippedInSnapshot.has(file)) {
      text = [
        `diff --git a/${file} b/${file}`,
        current.kind !== 'missing'
          ? `... [omitted from previous round snapshot (binary, >${SNAPSHOT_MAX_FILE_BYTES} bytes, or secret); inspect the full DIFF patch or targeted line ranges]`
          : `deleted file (was omitted from previous round snapshot as binary, >${SNAPSHOT_MAX_FILE_BYTES} bytes, or secret)`,
        '',
      ].join('\n');
    } else if (snapshot === null) {
      if (current.kind === 'file') {
        try {
          text = newFileDiff(file, fs.readFileSync(current.full));
        } catch {
          text = null;
        }
      }
    } else if (current.kind === 'missing') {
      text = deletedFileDiff(file, snapshot);
    } else if (current.kind === 'file' && snapshotFile !== null) {
      const result = runGitStatus(
        [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-index',
          `--unified=${DIFF_CONTEXT_LINES}`,
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--',
          snapshotFile,
          current.full,
        ],
        repoDir
      );
      if ((result.status === 0 || result.status === 1) && result.stdout) {
        text = rewriteNoIndexHeaders(result.stdout, file);
        if (!text.endsWith('\n')) text += '\n';
      }
    }
    if (text === null) continue;
    text = capFileDiff(redactSecrets(text), file, maxFileBytes);
    if (chunks.length > 0 && total + text.length > maxTotalBytes) {
      omitted.push(file);
      continue;
    }
    chunks.push(text);
    total += text.length;
  }
  if (chunks.length === 0) return null;
  if (omitted.length === 0) return chunks.join('');
  return `${chunks.join('')}${[
    '',
    `... [truncated: total patch cap of ${maxTotalBytes} bytes reached; ${omitted.length} more file(s) not shown — inspect targeted line ranges directly if needed]`,
    ...omitted.map((file) => `  ${file}`),
    '',
  ].join('\n')}`;
}

/**
 * Open the next review round, or return the open one unchanged.
 *
 * @param {TaskState} state
 * @param {{ fingerprint: string, base: string | null, force?: boolean }} options
 * @returns {{ state: TaskState, round: number, reopened: boolean }}
 */
export function openRound(state, { fingerprint: print, base, force = false }) {
  if (state.kind !== 'code') {
    throw new Error(
      `${state.name} is not a code task, so it has no review loop.\nFix: pnpm task set --kind code`
    );
  }
  const quality = state.quality ?? freshQuality();
  if (quality.phase === 'review') {
    return { state, round: quality.reviewRounds, reopened: true };
  }
  if (quality.reviewRounds >= quality.maxRounds) {
    throw new Error(
      `${state.name} already had ${quality.reviewRounds}/${quality.maxRounds} review rounds (the limit). Do not review again: list what is left as Open.\nFix: pnpm task note --done "…" --next "…" --open "<remaining medium/low findings>"`
    );
  }
  const done = new Set(
    state.steps.filter((s) => s.status === 'done').map((s) => s.id)
  );
  const open = toFix(quality).filter((f) => !f.step || !done.has(f.step));
  if (open.length > 0) {
    throw new Error(
      `Fix the findings from round ${quality.reviewRounds} before the next review: ${open.map((f) => f.step ?? f.id).join(', ')}.\nFix: pnpm task next`
    );
  }
  const unfinished = state.steps.filter(
    (s) =>
      s.status !== 'done' &&
      // A plain wait does not hold back a review of finished work; a gate does.
      (s.status !== 'waiting' || s.gate === true) &&
      !s.title.startsWith('fix: ')
  );
  if (!force && unfinished.length > 0) {
    throw new Error(
      `Review finished work: ${unfinished.map((s) => s.id).join(', ')} not done yet.\nFix: finish the steps (pnpm task next), or pnpm task review --force for an early review`
    );
  }
  if (!force && !state.lastVerify?.ok) {
    throw new Error(
      `Review green code: the last verify ${state.lastVerify ? 'failed' : 'has not run'}.\nFix: pnpm task verify (or pnpm task review --force if the user agrees)`
    );
  }
  const round = quality.reviewRounds + 1;
  return {
    state: {
      ...state,
      quality: {
        ...quality,
        phase: 'review',
        reviewRounds: round,
        reviewedDiff: print,
        base,
      },
    },
    round,
    reopened: false,
  };
}

/**
 * @param {Finding} f
 * @returns {string}
 */
const where = (f) => `${f.file}${f.line ? `:${f.line}` : ''}`;

/**
 * The brief a clean-context reviewer works from.
 *
 * @param {{ state: TaskState, round: number, scope: Scope, taskRel: string, folder?: FolderNotes, diffPath?: string | null, incrementalDiffPath?: string | null, incrementalUnavailable?: boolean, stats?: Map<string, FileStat> }} options
 *   `incrementalUnavailable`: the previous round's snapshot exists but is unusable
 * @returns {string}
 */
export function formatReviewBrief({
  state,
  round,
  scope,
  taskRel,
  folder = { unchecked: [], aside: [] },
  diffPath = null,
  incrementalDiffPath = null,
  incrementalUnavailable = false,
  stats = new Map(),
}) {
  const unchecked = new Set(folder.unchecked);
  const quality = state.quality ?? freshQuality();
  const files = reviewFiles(state.name, round);
  const since = String(scope.since).slice(0, 12);
  const repo = scope.base !== null && state.repo ? state.repo : null;
  const scopeLine =
    scope.base === null
      ? `the task's code under ${taskRel}/`
      : `changes since ${scope.base} (commit ${since}; see them with: git${repo ? ` -C ${repo}` : ''} diff ${since} -- <file>)`;
  const earlier = quality.findings.filter((f) => f.round < round);
  const refuted = earlier.filter((f) => f.verdict === 'REFUTED');
  const fixed = earlier.filter((f) => f.verdict === 'CONFIRMED' && f.step);
  const lines = [
    `# Review brief — ${state.name}, round ${round}/${quality.maxRounds}`,
    '',
    'You review in a clean context (role: .claude/agents/reviewer.md): judge the code',
    "against the plan and the standards, not the author's intentions. Read the files;",
    'edit nothing but the findings table named under Output.',
    '',
    `Goal: ${state.goal}`,
    ...(repo
      ? [
          `Repository: ${repo} (its own git repository; the files below are relative to it, and the plan is in this workspace)`,
        ]
      : []),
    `Plan (acceptance, steps, decisions): ${taskRel}/plan.md`,
    `Standards: ${STANDARDS.join('; ')}`,
    `E2E: ${state.e2e ?? 'no'}`,
    ...(diffPath
      ? [
          `Diff: ${diffPath} (read this first; use bounded line-range reads only when surrounding source context is needed)`,
        ]
      : []),
    ...(incrementalDiffPath
      ? [
          `Changes since round ${round - 1}: ${incrementalDiffPath} (start here for round ${round} fixes and regressions)`,
        ]
      : incrementalUnavailable
        ? [
            `Changes since round ${round - 1}: unavailable (the round ${round - 1} snapshot is missing its manifest or files/; review the full Diff)`,
          ]
        : []),
    '',
    `## Scope — ${scope.files.length} file(s), ${scopeLine}`,
    '',
    ...(scope.files.length > 0
      ? scope.files.map(
          (file) =>
            `- ${file}${statLabel(stats.get(file)) === 'unknown' ? '' : ` (${statLabel(stats.get(file))})`}${unchecked.has(file) ? ' — pnpm task check does not lint or format it' : ''}`
        )
      : ['- (no files: nothing changed)']),
    '',
    ...(diffPath || incrementalDiffPath
      ? [
          '## Reading budget',
          '',
          diffPath
            ? `Start with the pre-computed \`Diff:\` patch file${round > 1 ? ` and \`Changes since round ${round - 1}\`` : ''}. Only read specific line ranges (\`StartLine\`/\`EndLine\`) of source files when a hunk needs surrounding context. Avoid reading entire large test files unless a specific assertion needs full-file context.`
            : `Start with the pre-computed \`Changes since round ${round - 1}\` patch file. Only read specific line ranges (\`StartLine\`/\`EndLine\`) of source files when a hunk needs surrounding context.`,
          '',
        ]
      : []),
    ...(folder.aside.length > 0
      ? [
          '## Also in the task folder (not in scope)',
          '',
          'Code the scope leaves out: helper scripts, or the task folder beside a git scope.',
          'When the plan makes it part of the work, review it too.',
          '',
          ...folder.aside.map((file) => `- ${file}`),
          '',
        ]
      : []),
    '## Look for',
    '',
    '- spec gaps: acceptance criteria not met, plan steps missing or half done',
    '- bugs: wrong output, crashes, races, unhandled errors, wrong edge cases',
    '- security: injection, path traversal, secrets, unsafe input handling',
    '- design: wrong boundaries, duplication, hard-to-test structure, dead code',
    '- tests: missing branches, weakened or tautological assertions, untested failure paths',
    '- standards: anything AGENTS.md or the rules files forbid',
    '',
    '## Severity',
    '',
    SEVERITY_RUBRIC,
    '',
    'Every finding needs a concrete failure scenario (inputs or state → wrong result). No',
    'scenario, no finding. Do not pad: zero findings is a valid review.',
    '',
  ];
  if (refuted.length > 0 || fixed.length > 0) {
    lines.push('## Earlier rounds', '');
    for (const f of refuted) {
      lines.push(
        `- refuted ${f.id} (${where(f)}): ${f.claim} — ${f.reason}. Do not report it again without new evidence.`
      );
    }
    for (const f of fixed) {
      lines.push(
        `- fixed ${f.id} (${where(f)}): ${f.claim}. Check that the fix holds.`
      );
    }
    lines.push('');
  }
  lines.push(
    '## Output',
    '',
    `1. Review: add one row per finding to the table in ${taskRel}/${files.findings}.`,
    '   Leave verdict and reason empty. Escape a | inside a cell as \\|.',
    '2. Triage (a different clean-context agent): for each row, try to refute it by reading',
    '   the code. CONFIRMED only when the failure scenario really happens; REFUTED when it does',
    '   not or you are not sure. Write the verdict and a one-line reason.',
    '3. Record: pnpm task review record',
    '',
    "Cross-model option (keeps the primary model's quota free): `pnpm agent ask --agent dscc - < <this brief>` runs read-only on DeepSeek (or `--agent dsh`) — paste its Markdown rows into the findings table before `pnpm task review record`; a lighter model (an Antigravity flash subagent, or a flash-configured reviewer) is fine for the triage."
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The findings file for a round, with an empty table.
 *
 * @param {{ name: string, round: number, brief: string }} options
 * @returns {string}
 */
export function findingsTemplate({ name, round, brief }) {
  return [
    `# Review round ${round} — ${name}`,
    '',
    `Brief: ${brief}`,
    '',
    'Reviewer: one row per finding; leave verdict and reason empty.',
    'Triage: set verdict to CONFIRMED or REFUTED (REFUTED when unsure) and give the reason.',
    'severity: must-fix | high | medium | low. file:line: path relative to the repo root.',
    '',
    `| ${FINDINGS_HEADER.join(' | ')} |`,
    `| ${FINDINGS_HEADER.map(() => '---').join(' | ')} |`,
    '',
  ].join('\n');
}

/**
 * Split a Markdown table row into trimmed cells (`\|` is a literal pipe).
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * Parse the findings table of a round.
 *
 * @param {string} markdown
 * @param {{ round: number, takenIds: Set<string> }} options
 * @returns {{ findings: Finding[], errors: string[] }}
 */
export function parseFindings(markdown, { round, takenIds }) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line) =>
      line.trim().startsWith('|') &&
      splitRow(line).join('|').toLowerCase() === FINDINGS_HEADER.join('|')
  );
  if (start === -1) {
    return {
      findings: [],
      errors: [
        `no findings table: the header must be | ${FINDINGS_HEADER.join(' | ')} |`,
      ],
    };
  }
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const errors = [];
  const ids = new Set(takenIds);
  let next = 1;
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    if (cells.every((cell) => cell === '')) continue;
    const label = `row ${i - start - 1}`;
    if (cells.length !== FINDINGS_HEADER.length) {
      errors.push(
        `${label}: ${cells.length} cells, expected ${FINDINGS_HEADER.length} (escape | inside a cell as \\|)`
      );
      continue;
    }
    const [rawId, location, severity, claim, scenario, verdict, reason] = cells;
    const problems = [];
    if (!SEVERITIES.includes(severity.toLowerCase())) {
      problems.push(
        `severity "${severity}" is not one of ${SEVERITIES.join(', ')}`
      );
    }
    if (!verdict) problems.push('no verdict yet — run the triage first');
    else if (!VERDICTS.includes(verdict.toUpperCase())) {
      problems.push(`verdict "${verdict}" is not CONFIRMED or REFUTED`);
    }
    if (verdict && !reason) problems.push('the verdict needs a reason');
    if (!claim) problems.push('claim is empty');
    if (!scenario) problems.push('failure scenario is empty');
    const loc = location.replace(/`/g, '').match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
    if (!loc) problems.push('file:line is empty');
    let id = rawId.replace(/`/g, '');
    if (!id) {
      while (ids.has(`r${round}-${next}`)) next++;
      id = `r${round}-${next}`;
    } else if (ids.has(id)) {
      problems.push(`id ${id} is already used`);
    }
    if (problems.length > 0) {
      errors.push(
        `${label}${rawId ? ` (${rawId})` : ''}: ${problems.join('; ')}`
      );
      continue;
    }
    ids.add(id);
    const match = /** @type {RegExpMatchArray} */ (loc);
    findings.push({
      id,
      round,
      file: match[1].trim(),
      line: match[2] ? Number(match[2]) : null,
      severity: /** @type {Finding['severity']} */ (severity.toLowerCase()),
      claim,
      scenario,
      verdict: /** @type {Finding['verdict']} */ (verdict.toUpperCase()),
      reason,
      step: null,
    });
  }
  return { findings, errors };
}

/**
 * Close the open round with its findings: CONFIRMED must-fix/high get a
 * `fix:` step each; the phase moves to `fix`, or `complete` when nothing
 * needs fixing.
 *
 * @param {TaskState} state
 * @param {Finding[]} findings
 * @returns {{ state: TaskState, fixSteps: import('./state.js').Step[] }}
 */
export function recordFindings(state, findings) {
  const quality = state.quality ?? freshQuality();
  if (quality.phase !== 'review') {
    throw new Error(
      `${state.name} has no open review round (phase ${quality.phase}).\nFix: pnpm task review`
    );
  }
  let next = state;
  /** @type {import('./state.js').Step[]} */
  const fixSteps = [];
  const recorded = findings.map((finding) => {
    if (toFix({ ...quality, findings: [finding] }).length === 0) return finding;
    const result = addStep(next, {
      title: `fix: ${finding.claim} (${where(finding)}; ${finding.id})`,
    });
    next = result.state;
    fixSteps.push(result.step);
    return { ...finding, step: result.step.id };
  });
  return {
    state: {
      ...next,
      quality: {
        ...quality,
        phase: fixSteps.length > 0 ? 'fix' : 'complete',
        findings: [...quality.findings, ...recorded],
      },
    },
    fixSteps,
  };
}
