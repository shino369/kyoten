#!/usr/bin/env node
/**
 * Install third-party skills from skills-lock.json (and optional
 * skills-lock.local.json) with skills.sh.
 *
 * skills.sh's default layout puts the canonical copy in .agents/skills/<name>
 * (read directly by Codex and other agents) and links it into each agent's
 * directory (.claude/skills/<name> for Claude Code). Installed third-party
 * skills are git-ignored. utils/skills-link.js repairs links afterwards,
 * including a junction fallback on Windows.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './module-runner.js';
import {
  DEFAULT_LOCK_FILE,
  LOCAL_LOCK_FILE,
  readMergedSkillsLock,
  restoreFileSnapshot,
} from './skills-lock.js';
import { readIfExists } from './task/store.js';

const HELP = `Usage: pnpm skills:install [options]

Install third-party skills listed in skills-lock.json (and skills-lock.local.json if present).

Options
  --only <names>  Install only these skill names (comma-separated, repeatable)
  --skip <names>  Exclude these skill names (comma-separated, repeatable)
  --help, -h     Show this help`;

/** skills.sh agent ids to install for. Codex reads .agents/skills directly. */
export const INSTALL_AGENTS = ['claude-code', 'codex'];

/** Lock values reach a shell on Windows, so only plain identifiers pass. */
export const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

/**
 * @param {{ source?: string }} entry
 * @param {string | string[]} names
 * @returns {string[]}
 */
export function buildInstallArgs(entry, names) {
  const skillNames = Array.isArray(names) ? names : [names];
  return [
    'dlx',
    'skills',
    'add',
    entry.source ?? '',
    '--skill',
    ...skillNames,
    '--agent',
    ...INSTALL_AGENTS,
    '-y',
  ];
}

/**
 * Parse `--skip a,b` / `--skip=a,b` and `--only a,b` / `--only=a,b`.
 *
 * @param {string[]} argv
 * @returns {{ skip: string[], only: string[] }}
 */
export function parseArgs(argv) {
  /** @type {{ skip: string[], only: string[] }} */
  const result = { skip: [], only: [] };

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    if (flag !== '--skip' && flag !== '--only') continue;

    const value = inline ?? argv[++i] ?? '';
    const names = value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);

    if (flag === '--skip') result.skip.push(...names);
    else result.only.push(...names);
  }

  return result;
}

/**
 * @param {{ rootDir?: string, lockPath?: string, localLockPath?: string | null, skip?: string[], only?: string[], spawn?: Function, log?: (message: string) => void, platform?: string }} [options]
 * @returns {Promise<number>}
 */
export async function installSkills({
  rootDir = ROOT_DIR,
  lockPath = path.join(rootDir, DEFAULT_LOCK_FILE),
  localLockPath = path.join(path.dirname(lockPath), LOCAL_LOCK_FILE),
  skip = [],
  only = [],
  spawn = spawnSync,
  log = console.log,
  platform = process.platform,
} = {}) {
  const lock = await readMergedSkillsLock({ lockPath, localLockPath });
  const names = Object.keys(lock.skills).filter((name) => {
    if (only.length > 0 && !only.includes(name)) return false;
    return !skip.includes(name);
  });

  if (names.length === 0) {
    log('No skills to install.');
    return 0;
  }

  let failures = 0;
  /** @type {Map<string, string[]>} */
  const bySource = new Map();

  for (const name of names) {
    const entry = lock.skills[name];
    if (!entry.source) {
      log(`✗ ${name} (no source in skills-lock.json)`);
      failures++;
      continue;
    }

    if (!SAFE_SOURCE.test(entry.source) || !SAFE_NAME.test(name)) {
      log(`✗ ${name} (unsafe source or name in skills-lock.json; refusing)`);
      failures++;
      continue;
    }

    const group = bySource.get(entry.source) ?? [];
    group.push(name);
    bySource.set(entry.source, group);
  }

  const originalLockRaw = readIfExists(lockPath);
  try {
    for (const [source, group] of bySource) {
      log(`Installing ${group.join(', ')} (${source})...`);
      // pnpm is a .cmd shim on Windows, which Node only runs through a shell;
      // the values above are validated, so no shell is used elsewhere.
      const result = spawn('pnpm', buildInstallArgs({ source }, group), {
        cwd: rootDir,
        stdio: 'inherit',
        shell: platform === 'win32',
      });

      if (result.status !== 0) {
        for (const name of group) {
          log(`✗ ${name} failed (exit ${result.status ?? 'unknown'})`);
          failures++;
        }
      } else {
        for (const name of group) {
          log(`✓ ${name}`);
        }
      }
    }
  } finally {
    // Installing local-lock entries via skills.sh writes them into tracked
    // skills-lock.json; restore the tracked snapshot so git stays clean.
    restoreFileSnapshot(lockPath, originalLockRaw);
  }

  log(
    failures === 0
      ? `Installed ${names.length} skill(s).`
      : `${failures} of ${names.length} skill(s) failed.`
  );

  return failures === 0 ? 0 : 1;
}

/**
 * @param {{ argv?: string[], rootDir?: string, lockPath?: string, localLockPath?: string | null, spawn?: Function, log?: (message: string) => void }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  rootDir = ROOT_DIR,
  lockPath = path.join(rootDir, DEFAULT_LOCK_FILE),
  localLockPath = path.join(path.dirname(lockPath), LOCAL_LOCK_FILE),
  spawn = spawnSync,
  log = console.log,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(HELP);
    return 0;
  }
  const { skip, only } = parseArgs(argv);
  return installSkills({
    rootDir,
    lockPath,
    localLockPath,
    skip,
    only,
    spawn,
    log,
  });
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, async () => {
  try {
    process.exit(await main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
