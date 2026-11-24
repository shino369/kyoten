#!/usr/bin/env node
/**
 * Install opt-in third-party skills via skills.sh without dirtying tracked
 * skills-lock.json.
 *
 * By default, project-scoped `skills add` writes newly installed skills into
 * tracked `skills-lock.json`. This wrapper snapshots `skills-lock.json`, runs
 * `skills add`, records the added skill metadata in git-ignored
 * `skills-lock.local.json`, restores `skills-lock.json`, and refreshes harness
 * links via `skills:link`.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './module-runner.js';
import { SAFE_NAME, SAFE_SOURCE, buildInstallArgs } from './skills-install.js';
import { PROBLEM_STATUSES, formatResult, linkSkills } from './skills-link.js';
import {
  DEFAULT_LOCK_FILE,
  LOCAL_LOCK_FILE,
  readOptionalSkillsLock,
  restoreFileSnapshot,
  writeSkillsLock,
} from './skills-lock.js';
import { readIfExists } from './task/store.js';
import { DEFAULT_LINK_TARGETS } from './workspace-config.js';

const HELP = `Usage: pnpm skills:add <source> --skill <name>... [options]

Install opt-in third-party skills locally without modifying skills-lock.json.
Installed entries are saved to git-ignored skills-lock.local.json, and harness
links are refreshed automatically.

Options
  --skill, -s <name...>  Skill name(s) to install (space/comma-separated, repeatable)
  --tracked              Keep the new entries in tracked skills-lock.json instead
  --target <dir>         Extra skill link directory (repeatable)
  --help, -h             Show this help

Examples
  pnpm skills:add shino369/kyoten-skills --skill transparent-background
  pnpm skills:add shino369/kyoten-skills --skill transparent-background game-image-extraction`;

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * Split a comma-separated skill token into trimmed non-empty names.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function splitNames(raw) {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Parse CLI arguments for `pnpm skills:add`.
 *
 * @param {string[]} argv
 * @returns {{ source: string, skills: string[], tracked: boolean, targets: string[], help: boolean }}
 */
export function parseArgs(argv) {
  let source = '';
  /** @type {string[]} */
  const skills = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let tracked = false;
  /** @type {string[]} */
  const targets = [...DEFAULT_LINK_TARGETS];

  const pushNames = (/** @type {string} */ token) => {
    for (const name of splitNames(token)) {
      if (!seen.has(name)) {
        seen.add(name);
        skills.push(name);
      }
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split('=', 2);

    if (HELP_FLAGS.has(arg)) {
      return {
        source,
        skills,
        tracked,
        targets,
        help: true,
      };
    }

    if (arg === '--tracked') {
      tracked = true;
      continue;
    }

    if (flag === '--target') {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--target needs a directory');
      }
      targets.push(value);
      continue;
    }

    if (flag === '--skill' || flag === '-s') {
      if (inline !== undefined) {
        if (splitNames(inline).length === 0) {
          throw new Error('--skill needs at least one skill name');
        }
        pushNames(inline);
        continue;
      }
      const first = argv[i + 1];
      if (!first || first.startsWith('-') || splitNames(first).length === 0) {
        throw new Error('--skill needs at least one skill name');
      }
      i++;
      pushNames(first);
      // Consume additional space-separated skill names when <source> is already known.
      while (source && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++;
        pushNames(argv[i]);
      }
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg} (see --help)`);
    }

    if (source) {
      throw new Error(`Unexpected argument: ${arg} (see --help)`);
    }
    source = arg;
  }

  if (!source) {
    throw new Error(
      'Missing skill source (e.g. shino369/kyoten-skills). See --help.'
    );
  }
  if (skills.length === 0) {
    throw new Error('Missing --skill <name>. See --help.');
  }

  return {
    source,
    skills,
    tracked,
    targets,
    help: false,
  };
}

/**
 * Install opt-in skills locally, recording them in skills-lock.local.json
 * without modifying tracked skills-lock.json (unless `tracked` is true).
 *
 * @param {{
 *   source: string,
 *   skills: string[],
 *   tracked?: boolean,
 *   targets?: string[],
 *   rootDir?: string,
 *   lockPath?: string,
 *   localLockPath?: string,
 *   spawn?: Function,
 *   link?: typeof linkSkills,
 *   log?: (message: string) => void,
 *   platform?: string,
 * }} options
 * @returns {Promise<number>}
 */
export async function addSkills({
  source,
  skills,
  tracked = false,
  targets = [...DEFAULT_LINK_TARGETS],
  rootDir = ROOT_DIR,
  lockPath = path.join(rootDir, DEFAULT_LOCK_FILE),
  localLockPath = path.join(path.dirname(lockPath), LOCAL_LOCK_FILE),
  spawn = spawnSync,
  link = linkSkills,
  log = console.log,
  platform = process.platform,
}) {
  if (!SAFE_SOURCE.test(source)) {
    log(`✗ unsafe source "${source}"; refusing`);
    return 1;
  }
  for (const name of skills) {
    if (!SAFE_NAME.test(name)) {
      log(`✗ unsafe skill name "${name}"; refusing`);
      return 1;
    }
  }

  const originalRaw = tracked ? null : readIfExists(lockPath);
  const originalLock = tracked ? null : await readOptionalSkillsLock(lockPath);
  // Validate any existing local lock before spawning skills.sh so malformed
  // JSON fails fast without installing files into .agents/skills/.
  const existingLocal = tracked
    ? null
    : await readOptionalSkillsLock(localLockPath);
  /** @type {import('./skills-lock.js').SkillsLock | null} */
  let afterLock = null;
  let spawnStatus = null;

  try {
    log(`Installing ${skills.join(', ')} (${source})...`);
    // pnpm is a .cmd shim on Windows, which Node only runs through a shell;
    // source and skill names are validated above, so no shell sees untrusted input.
    const result = spawn('pnpm', buildInstallArgs({ source }, skills), {
      cwd: rootDir,
      stdio: 'inherit',
      shell: platform === 'win32',
    });
    spawnStatus = result.status;

    if (spawnStatus !== 0) {
      log(
        `✗ skills add failed for ${skills.join(', ')} (exit ${spawnStatus ?? 'unknown'})`
      );
      return 1;
    }

    if (!tracked) {
      afterLock = await readOptionalSkillsLock(lockPath);
    }
  } finally {
    if (!tracked) {
      restoreFileSnapshot(lockPath, originalRaw);
    }
  }

  if (!tracked) {
    const trackedSkills = originalLock?.skills ?? {};
    /** @type {import('./skills-lock.js').SkillsLock} */
    const nextLocal = {
      version: existingLocal?.version ?? afterLock?.version ?? 2,
      skills: { ...(existingLocal?.skills ?? {}) },
    };
    /** @type {string[]} */
    const recorded = [];

    for (const name of skills) {
      if (Object.hasOwn(trackedSkills, name)) {
        log(`✓ ${name} (already tracked in ${DEFAULT_LOCK_FILE})`);
        continue;
      }
      nextLocal.skills[name] = afterLock?.skills?.[name] ?? { source };
      recorded.push(name);
    }

    if (recorded.length > 0) {
      writeSkillsLock(localLockPath, nextLocal);
      log(
        `✓ Recorded ${recorded.join(', ')} in ${path.basename(localLockPath)} (${DEFAULT_LOCK_FILE} unchanged).`
      );
    }
  } else {
    log(`✓ Added ${skills.join(', ')} to ${DEFAULT_LOCK_FILE}.`);
  }

  const linkResults = link({ rootDir, targets, platform });
  const problems = linkResults.filter((r) => PROBLEM_STATUSES.has(r.status));
  for (const result of linkResults) {
    if (result.status !== 'ok') log(formatResult(result));
  }
  if (problems.length > 0) {
    log(
      `${problems.length} link problem(s). Fix: resolve conflicts and run pnpm skills:link`
    );
    return 1;
  }

  return 0;
}

/**
 * @param {{
 *   argv?: string[],
 *   rootDir?: string,
 *   lockPath?: string,
 *   localLockPath?: string,
 *   spawn?: Function,
 *   link?: typeof linkSkills,
 *   log?: (message: string) => void,
 *   platform?: string,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  argv = process.argv.slice(2),
  rootDir = ROOT_DIR,
  lockPath = path.join(rootDir, DEFAULT_LOCK_FILE),
  localLockPath = path.join(path.dirname(lockPath), LOCAL_LOCK_FILE),
  spawn = spawnSync,
  link = linkSkills,
  log = console.log,
  platform = process.platform,
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    log(HELP);
    return 0;
  }
  return addSkills({
    source: parsed.source,
    skills: parsed.skills,
    tracked: parsed.tracked,
    targets: parsed.targets,
    rootDir,
    lockPath,
    localLockPath,
    spawn,
    link,
    log,
    platform,
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
