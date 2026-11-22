/**
 * `kyoten backup` and `kyoten restore`: a folder (not an archive) that holds
 * what is personal in a home:
 *
 *   memory.tar.gz   `pnpm memory export` of everything it can hold: notes,
 *                   personalization, tasks, and resources/
 *   config.json     kyoten's config file
 *   home.json       `.kyoten/home.json` (managed homes)
 *   local.bundle    `git bundle` of main and kyoten/upstream (managed homes
 *                   with commits of their own)
 *   dscc.env        the DeepSeek profile, only with --include-key
 *   manifest.json   kyoten version, time, and a sha256 for every file above
 *
 * Restore checks every checksum before it uses a file, merges the bundle into
 * `main` (the old snapshot is the merge base, so it behaves like an update),
 * merges the memory export (never replaces), and copies config and profile
 * only where none exist. Nothing is overwritten or deleted.
 *
 * The bundle carries `kyoten/upstream` as well as `main`: a fresh home has its
 * own snapshot commit, so a bundle that only had `main ^kyoten/upstream`
 * would name a prerequisite commit the new home does not have.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writePrivate } from './dscc.js';
import {
  expandHome,
  homeState,
  readHomeInfo,
  validateConfig,
  HOME_INFO,
} from './home.js';
import { UPSTREAM, mergeEnv } from './repo.js';
import { stamp } from './reset.js';

/** @typedef {import('../spawn.js').Spawn} Spawn */

/** Every part `pnpm memory export` can hold: a backup is the whole personal state. */
export const BACKUP_PARTS = 'memory,personalization,tasks,resources';
export const MANIFEST = 'manifest.json';
/** The only file names a backup may hold besides the manifest. */
export const BACKUP_FILES = [
  'memory.tar.gz',
  'config.json',
  'home.json',
  'local.bundle',
  'dscc.env',
];
const RESTORED = 'refs/kyoten/restored';
const RESTORED_UPSTREAM = 'refs/kyoten/restored-upstream';

/** @param {Buffer} data */
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** @param {string} file */
function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Run a command; a failure becomes an Error with the command's own message.
 *
 * @param {Spawn} run
 * @param {string} bin
 * @param {string[]} args
 * @param {object} options
 * @param {string} fix
 */
function must(run, bin, args, options, fix) {
  const result = run(bin, args, { encoding: 'utf-8', ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.message
      : String(result.stderr ?? '').trim() || `exit ${result.status}`;
    throw new Error(`${bin} ${args.join(' ')} failed: ${detail}\nFix: ${fix}`);
  }
  return String(result.stdout ?? '');
}

/**
 * @param {{ home: string, dir?: string, includeKey: boolean, configFile: string, profileFile: string, version: string, run: Spawn, env: NodeJS.ProcessEnv, out: (text: string) => void, err: (text: string) => void, now: () => Date, cwd: string, homedir: string }} input
 * @returns {number}
 */
export function backupHome({
  home,
  dir,
  includeKey,
  configFile,
  profileFile,
  version,
  run,
  env,
  out,
  err,
  now,
  cwd,
  homedir,
}) {
  if (homeState(home) !== 'workspace') {
    throw new Error(
      `there is no kyoten home at ${home} to back up.\nFix: kyoten --home <dir> backup, or kyoten init`
    );
  }
  const date = now();
  const target = path.resolve(
    cwd,
    dir ? expandHome(dir, homedir) : `kyoten-backup-${stamp(date)}`
  );
  const existed = fs.existsSync(target);
  if (
    existed &&
    (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length > 0)
  ) {
    throw new Error(
      `${target} already exists and is not empty.\nFix: kyoten backup <a new folder>`
    );
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(target, 0o700);
  } catch {
    // Windows has no POSIX modes; the profile folder is the user's own.
  }
  try {
    return writeBackup({
      home,
      target,
      includeKey,
      configFile,
      profileFile,
      version,
      run,
      env,
      out,
      err,
      date,
    });
  } catch (error) {
    // The folder is ours: nothing in it is worth keeping after a failure.
    fs.rmSync(target, { recursive: true, force: true });
    if (existed) fs.mkdirSync(target);
    throw error;
  }
}

/**
 * @param {{ home: string, target: string, includeKey: boolean, configFile: string, profileFile: string, version: string, run: Spawn, env: NodeJS.ProcessEnv, out: (text: string) => void, err: (text: string) => void, date: Date }} input
 */
function writeBackup({
  home,
  target,
  includeKey,
  configFile,
  profileFile,
  version,
  run,
  env,
  out,
  err,
  date,
}) {
  /** @type {{ name: string, sha256: string, bytes: number }[]} */
  const files = [];
  /** @param {string} name */
  const record = (name) => {
    const file = path.join(target, name);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX modes.
    }
    const data = fs.readFileSync(file);
    files.push({ name, sha256: sha256(data), bytes: data.length });
  };
  /**
   * @param {string} name
   * @param {Buffer | string} data
   */
  const put = (name, data) => {
    writePrivate(path.join(target, name), data);
    record(name);
  };

  must(
    run,
    'pnpm',
    [
      'memory',
      'export',
      '--include',
      BACKUP_PARTS,
      '--out',
      path.join(target, 'memory.tar.gz'),
    ],
    { cwd: home, env },
    `fix what pnpm memory export reports in ${home} (run: pnpm memory export), then run kyoten backup again`
  );
  record('memory.tar.gz');

  const config = readIfExists(configFile);
  if (config) put('config.json', config);
  else err(`kyoten: no config file at ${configFile}; not included`);

  const info = readHomeInfo(home);
  if (info) {
    put('home.json', fs.readFileSync(path.join(home, HOME_INFO)));
    const local = localCommits({ home, run, env });
    if (local === null) {
      err(`kyoten: ${UPSTREAM} or main is missing; local commits not included`);
    } else if (local > 0) {
      must(
        run,
        'git',
        [
          '-C',
          home,
          'bundle',
          'create',
          '-q',
          path.join(target, 'local.bundle'),
          'main',
          UPSTREAM,
        ],
        { env },
        'fix what git reports, then run kyoten backup again'
      );
      record('local.bundle');
    }
  } else {
    err(
      'kyoten: this home is a clone; its commits are not bundled (push them)'
    );
  }

  const profile = readIfExists(profileFile);
  if (includeKey && profile) put('dscc.env', profile);
  else if (includeKey)
    err(`kyoten: no dscc profile at ${profileFile}; not included`);
  else if (profile)
    err(
      'kyoten: the dscc profile (your key) is not included; add --include-key to include it'
    );

  writePrivate(
    path.join(target, MANIFEST),
    `${JSON.stringify({ kyotenVersion: version, createdAt: date.toISOString(), home, files }, null, 2)}\n`
  );
  out(target);
  for (const file of files) {
    err(`kyoten: wrote ${file.name} (${file.bytes} bytes)`);
  }
  err(`kyoten: wrote ${MANIFEST}`);
  err(
    `kyoten: ${target} holds personal data (notes, settings${includeKey && profile ? ', your DeepSeek key' : ''}). Keep it private; restore it with: kyoten restore "${target}"`
  );
  return 0;
}

/**
 * Commits on `main` that are not on kyoten/upstream, or null when git cannot say.
 *
 * @param {{ home: string, run: Spawn, env: NodeJS.ProcessEnv }} input
 */
function localCommits({ home, run, env }) {
  const result = run(
    'git',
    ['-C', home, 'rev-list', '--count', `${UPSTREAM}..main`],
    { encoding: 'utf-8', env }
  );
  return result.error || result.status !== 0
    ? null
    : Number(String(result.stdout).trim());
}

/**
 * The manifest of a backup folder, with every file checked: only known plain
 * file names, no links, and the recorded size and sha256.
 *
 * @param {string} folder
 * @returns {{ manifest: { kyotenVersion: string, createdAt: string, home: string }, files: Map<string, string> }}
 *   the checked files, by name, as absolute paths
 */
export function readManifest(folder) {
  /** @param {string} what */
  const bad = (what) =>
    new Error(
      `${folder}: ${what}.\nFix: use a folder made by kyoten backup, unchanged`
    );
  const text = readIfExists(path.join(folder, MANIFEST));
  if (!text) throw bad(`${MANIFEST} is missing`);
  let manifest;
  try {
    manifest = JSON.parse(text.toString('utf-8'));
  } catch {
    throw bad(`${MANIFEST} is not valid JSON`);
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.kyotenVersion !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    throw bad(`${MANIFEST} is not a kyoten backup manifest`);
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const entry of manifest.files) {
    const name = entry?.name;
    if (typeof name !== 'string' || !BACKUP_FILES.includes(name)) {
      throw bad(`${MANIFEST} lists an unknown file (${JSON.stringify(name)})`);
    }
    if (files.has(name)) throw bad(`${MANIFEST} lists ${name} twice`);
    if (
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isInteger(entry.bytes)
    ) {
      throw bad(`${MANIFEST} has a malformed entry for ${name}`);
    }
    const file = path.join(folder, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw bad(`${name} is missing`);
    }
    if (!stat.isFile()) throw bad(`${name} is not a regular file`);
    const data = fs.readFileSync(file);
    if (data.length !== entry.bytes || sha256(data) !== entry.sha256) {
      throw bad(`${name} does not match its checksum (it was changed)`);
    }
    files.set(name, file);
  }
  return { manifest, files };
}

/**
 * Why `home` cannot take a merge now, or null.
 *
 * @param {{ home: string, run: Spawn, env: NodeJS.ProcessEnv }} input
 * @returns {string | null}
 */
function mergeBlocker({ home, run, env }) {
  if (fs.existsSync(path.join(home, '.git', 'MERGE_HEAD'))) {
    return `a merge is in progress in ${home}.\nFix: finish it (or git merge --abort), then run kyoten restore again`;
  }
  const status = run(
    'git',
    ['-C', home, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf-8', env }
  );
  if (status.error || status.status !== 0) {
    return `git cannot read ${home}.\nFix: make sure it is a git repository (git -C "${home}" status)`;
  }
  if (String(status.stdout).trim()) {
    return `${home} has uncommitted changes to tracked files.\nFix: commit or stash them, then run kyoten restore again`;
  }
  return null;
}

/**
 * @param {{ folder: string, home: string, run: Spawn, env: NodeJS.ProcessEnv, bundle: string, err: (text: string) => void }} input
 */
function restoreBundle({ folder, home, run, env, bundle, err }) {
  const branch = run(
    'git',
    ['-C', home, 'symbolic-ref', '-q', '--short', 'HEAD'],
    {
      encoding: 'utf-8',
      env,
    }
  );
  if (branch.status !== 0 || String(branch.stdout).trim() !== 'main') {
    throw new Error(
      `${home} is not on its main branch.\nFix: git -C "${home}" switch main, then run kyoten restore "${folder}" again`
    );
  }
  must(
    run,
    'git',
    [
      '-C',
      home,
      'fetch',
      '-q',
      bundle,
      `+refs/heads/main:${RESTORED}`,
      `+refs/heads/${UPSTREAM}:${RESTORED_UPSTREAM}`,
    ],
    { env },
    'the bundle in the backup could not be read; restore the rest by hand (git bundle verify)'
  );
  /** @param {string[]} args */
  const git = (args) =>
    run('git', ['-C', home, ...args], { encoding: 'utf-8', env }).status;
  if (git(['merge-base', '--is-ancestor', RESTORED, 'HEAD']) === 0) {
    err('kyoten: your commits from the backup are already in main');
    return;
  }
  const mergeFix = `in ${home}, resolve the conflicts and git commit (or git merge --abort), then your commits are in refs/kyoten/restored`;
  /** @param {string[]} args @param {string} what */
  const merge = (args, what) => {
    const result = run('git', ['-C', home, 'merge', '--no-edit', ...args], {
      stdio: 'inherit',
      env: mergeEnv({ run, home, env }),
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${what} did not finish (see git's message above).\nFix: ${mergeFix}`
      );
    }
  };
  if (git(['merge-base', 'HEAD', RESTORED]) !== 0) {
    // A fresh home has its own snapshot commit. Connect it to the old one
    // (keeping this tree), so the old snapshot is the merge base below.
    merge(
      ['--allow-unrelated-histories', '-s', 'ours', RESTORED_UPSTREAM],
      'linking the old snapshot'
    );
  }
  merge([RESTORED], 'the merge of your commits from the backup');
  err('kyoten: your commits from the backup are merged into main');
}

/**
 * @param {Buffer} data
 * @param {string} source  for messages
 */
function checkConfig(data, source) {
  try {
    validateConfig(JSON.parse(data.toString('utf-8')), source);
  } catch (error) {
    throw new Error(
      `the config in the backup cannot be used: ${/** @type {Error} */ (error).message}\nFix: restore the rest by hand and copy the config file yourself`
    );
  }
}

/**
 * @param {{ dir: string, yes: boolean, interactive: boolean, ask: (question: string) => Promise<string>, home: string, createHome: () => void, configFile: string, profileFile: string, run: Spawn, env: NodeJS.ProcessEnv, out: (text: string) => void, err: (text: string) => void, cwd: string, homedir: string }} input
 * @returns {Promise<number>}
 */
export async function restoreBackup({
  dir,
  yes,
  interactive,
  ask,
  home,
  createHome,
  configFile,
  profileFile,
  run,
  env,
  out,
  err,
  cwd,
  homedir,
}) {
  const folder = path.resolve(cwd, expandHome(dir, homedir));
  const { files } = readManifest(folder);
  if (files.has('memory.tar.gz') && !yes && !interactive) {
    throw new Error(
      'kyoten restore asks before it imports memory and there is no terminal.\nFix: kyoten restore <dir> --yes'
    );
  }
  const state = homeState(home);
  if (state === 'other') {
    throw new Error(
      `${home} is not empty and is not a kyoten workspace.\nFix: kyoten --home <new dir> restore "${folder}"`
    );
  }
  if (state !== 'workspace') createHome();
  const blocker = mergeBlocker({ home, run, env });
  if (blocker) throw new Error(blocker);

  const bundle = files.get('local.bundle');
  if (bundle) restoreBundle({ folder, home, run, env, bundle, err });
  else err('kyoten: no local commits in this backup');

  const memory = files.get('memory.tar.gz');
  if (memory) {
    const base = ['memory', 'import', memory];
    const fix = `fix what pnpm memory import reports, then run kyoten restore "${folder}" again`;
    must(
      run,
      'pnpm',
      [...base, '--dry-run'],
      { cwd: home, env, stdio: 'inherit' },
      fix
    );
    const answer = yes
      ? 'y'
      : await ask(`Import these memory notes into ${home}? [y/N] `);
    if (/^(y|yes)$/i.test(answer.trim())) {
      must(run, 'pnpm', base, { cwd: home, env, stdio: 'inherit' }, fix);
    } else {
      err('kyoten: memory not imported');
    }
  }

  for (const [name, dest, priv] of /** @type {[string, string, boolean][]} */ ([
    ['config.json', configFile, false],
    ['dscc.env', profileFile, true],
  ])) {
    const source = files.get(name);
    if (!source) continue;
    if (fs.existsSync(dest)) {
      err(
        `kyoten: kept the current ${dest}; the backup's ${name} was not used`
      );
      continue;
    }
    const data = fs.readFileSync(source);
    if (name === 'config.json') checkConfig(data, source);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (priv) writePrivate(dest, data);
    else fs.writeFileSync(dest, data);
    err(`kyoten: restored ${dest}`);
  }
  out(home);
  return 0;
}
