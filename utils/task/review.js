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
import { SEVERITIES, VERDICTS, freshQuality, toFix } from './quality.js';
import { addStep } from './state.js';
import { taskRepoDir } from './store.js';
import { relPosix } from '../paths.js';
import { redactSecrets } from '../redact.js';

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
  const lines = (/** @type {string | null} */ text) =>
    (text ?? '').split('\n').filter(Boolean);
  const files = new Set([
    ...lines(runGit(['diff', '--name-only', since], repoDir)),
    ...lines(runGit(['ls-files', '--others', '--exclude-standard'], repoDir)),
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
    const full = path.join(rootDir, file);
    hash.update(fs.existsSync(full) ? fs.readFileSync(full) : '\0deleted');
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
 * scope uses `git diff --numstat`; untracked files are counted from disk and
 * flagged `untracked`. A task-folder scope has no base and returns nothing.
 *
 * @param {{ repoDir: string, scope: Scope, runGit?: RunGit }} options
 * @returns {Map<string, FileStat>}
 */
export function diffStats({ repoDir, scope, runGit = defaultRunGit }) {
  /** @type {Map<string, FileStat>} */
  const stats = new Map();
  if (scope.base === null || scope.since === null) return stats;
  const lines = (/** @type {string | null} */ text) =>
    (text ?? '').split('\n').filter(Boolean);
  const inScope = new Set(scope.files);
  for (const line of lines(
    runGit(['diff', '--numstat', scope.since], repoDir)
  )) {
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file || !inScope.has(file)) continue;
    stats.set(
      file,
      added === '-' || deleted === '-'
        ? { added: 0, deleted: 0, binary: true }
        : { added: Number(added), deleted: Number(deleted) }
    );
  }
  for (const file of lines(
    runGit(['ls-files', '--others', '--exclude-standard'], repoDir)
  )) {
    if (!inScope.has(file) || stats.has(file)) continue;
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(repoDir, file));
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
 * standard new-file diffs. Secrets are redacted; a huge file is truncated and
 * a total cap lists the remaining files with their stats. Null for a
 * task-folder scope (no base) or nothing to show.
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
  const tracked = new Set(
    (runGit(['diff', '--name-only', scope.since], repoDir) ?? '')
      .split('\n')
      .filter(Boolean)
  );
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  const omitted = [];
  let total = 0;
  for (const file of [...scope.files].sort()) {
    /** @type {string | null} */
    let text = null;
    if (tracked.has(file)) {
      const diff = runGit(
        [
          'diff',
          `--unified=${DIFF_CONTEXT_LINES}`,
          '--no-ext-diff',
          '--no-color',
          scope.since,
          '--',
          file,
        ],
        repoDir
      );
      if (diff) text = `${diff}\n`;
    } else {
      try {
        text = newFileDiff(file, fs.readFileSync(path.join(repoDir, file)));
      } catch {
        text = null;
      }
    }
    if (text === null) continue;
    text = redactSecrets(capFileDiff(text, file, maxFileBytes));
    if (chunks.length > 0 && total + text.length > maxTotalBytes) {
      omitted.push(file);
      continue;
    }
    chunks.push(text);
    total += text.length;
  }
  if (chunks.length === 0) return null;
  if (omitted.length === 0) return chunks.join('');
  const stats = diffStats({ repoDir, scope, runGit });
  return `${chunks.join('')}${[
    '',
    `... [truncated: total patch cap of ${maxTotalBytes} bytes reached; ${omitted.length} more file(s) not shown — inspect targeted line ranges directly if needed]`,
    ...omitted.map((file) => `  ${file} (${statLabel(stats.get(file))})`),
    '',
  ].join('\n')}`;
}

/**
 * Save the working-tree versions of `files` under `dir` (relative paths
 * mirrored) so a later round can diff against them. Binary and oversized
 * files are left out. Returns the number of files saved.
 *
 * @param {{ repoDir: string, dir: string, files: string[] }} options
 * @returns {number}
 */
export function saveSnapshot({ repoDir, dir, files }) {
  fs.rmSync(dir, { recursive: true, force: true });
  let saved = 0;
  for (const file of files) {
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(repoDir, file));
    } catch {
      continue;
    }
    if (buffer.length > SNAPSHOT_MAX_FILE_BYTES || isBinary(buffer)) continue;
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    saved++;
  }
  return saved;
}

/**
 * The files a saved snapshot holds, as sorted POSIX paths.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSnapshotFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} current
   * @param {string} prefix
   */
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
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
    .replace(/^diff --git .*$/m, `diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/m, `--- a/${file}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${file}`);
}

/**
 * What changed since the previous round: the saved snapshot against the
 * current working tree, as a unified diff with repo-relative paths. `files`
 * should be the union of the current scope and the snapshot's files, so a
 * file that appeared or disappeared still shows. Null when nothing changed.
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
  /** @type {string[]} */
  const chunks = [];
  /** @type {string[]} */
  const omitted = [];
  let total = 0;
  for (const file of [...files].sort()) {
    const snapshotFile = path.join(snapshotDir, file);
    const currentFile = path.join(repoDir, file);
    /** @type {Buffer | null} */
    let snapshot = null;
    try {
      snapshot = fs.readFileSync(snapshotFile);
    } catch {
      snapshot = null;
    }
    /** @type {string | null} */
    let text = null;
    if (snapshot === null) {
      try {
        text = newFileDiff(file, fs.readFileSync(currentFile));
      } catch {
        text = null;
      }
    } else if (!fs.existsSync(currentFile)) {
      text = deletedFileDiff(file, snapshot);
    } else {
      const result = runGitStatus(
        [
          'diff',
          '--no-index',
          '--unified=8',
          '--no-ext-diff',
          '--no-color',
          snapshotFile,
          currentFile,
        ],
        repoDir
      );
      if ((result.status === 0 || result.status === 1) && result.stdout) {
        text = rewriteNoIndexHeaders(result.stdout, file);
        if (!text.endsWith('\n')) text += '\n';
      }
    }
    if (text === null) continue;
    text = redactSecrets(capFileDiff(text, file, maxFileBytes));
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
 * @param {{ state: TaskState, round: number, scope: Scope, taskRel: string, folder?: FolderNotes, diffPath?: string | null, incrementalDiffPath?: string | null, stats?: Map<string, FileStat> }} options
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
    ...(diffPath
      ? [
          '## Reading budget',
          '',
          `Start with the pre-computed \`Diff:\` patch file${round > 1 ? ` and \`Changes since round ${round - 1}\`` : ''}. Only read specific line ranges (\`StartLine\`/\`EndLine\`) of source files when a hunk needs surrounding context. Avoid reading entire large test files unless a specific assertion needs full-file context.`,
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
    "Cross-model option (keeps the primary model's quota free): `pnpm agent ask --agent dscc - < <this brief>` runs the review on DeepSeek, or `--agent dsh`; a lighter model (an Antigravity flash subagent, or a flash-configured reviewer) is fine for the triage."
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
