/**
 * `kyoten reset`: move a home kyoten created out of the way so `kyoten init`
 * can start fresh. Nothing is deleted: the home (and with `--all` the config
 * folder) is renamed to `<name>.removed-<YYYYMMDD-HHMMSS>`, and the exact
 * rename that undoes it is printed.
 */
import fs from 'fs';
import path from 'path';
import { homeState, readHomeInfo, samePath, writeConfig } from './home.js';
import { UPSTREAM } from './repo.js';

/** @typedef {import('../spawn.js').Spawn} Spawn */

const SHOWN_SUBJECTS = 5;

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/**
 * Local time as `YYYYMMDD-HHMMSS`.
 *
 * @param {Date} date
 */
export function stamp(date) {
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

/**
 * `<dir>.removed-<stamp>`, with `-2`, `-3`, … when that exists.
 *
 * @param {string} dir
 * @param {Date} date
 */
export function removedPath(dir, date) {
  const base = `${dir}.removed-${stamp(date)}`;
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * What a reset would set aside, read only.
 *
 * @param {{ home: string, run: Spawn, env: NodeJS.ProcessEnv }} input
 * @returns {{ commits: string[] | null, dirty: number | null, tasks: number, notes: number }}
 */
export function inspectHome({ home, run, env }) {
  /** @param {string[]} args */
  const git = (args) => {
    const result = run('git', ['-C', home, ...args], {
      encoding: 'utf-8',
      env,
    });
    return result.error || result.status !== 0
      ? null
      : String(result.stdout)
          .split('\n')
          .filter((line) => line.trim());
  };
  return {
    commits: git(['log', '--format=%s', `${UPSTREAM}..main`]),
    dirty: git(['status', '--porcelain'])?.length ?? null,
    tasks: countOpenTasks(home),
    notes: countNotes(home),
  };
}

/**
 * Tasks whose state.json does not say `done`.
 *
 * @param {string} home
 */
function countOpenTasks(home) {
  const dir = path.join(home, 'tasks');
  let open = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, name, 'state.json'), 'utf-8')
      );
      if (state?.status !== 'done') open += 1;
    } catch {
      // Not a task folder, or an unreadable state: not counted.
    }
  }
  return open;
}

/**
 * Memory notes that are not deleted: `add` ops minus `delete` ops of
 * `memory/log.jsonl` (the journal; see utils/memory/store.js).
 *
 * @param {string} home
 */
function countNotes(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'memory', 'log.jsonl'), 'utf-8');
  } catch {
    return 0;
  }
  const live = new Set();
  for (const line of text.split('\n')) {
    try {
      const op = JSON.parse(line);
      if (op?.op === 'add' && op.note?.id) live.add(op.note.id);
      else if (op?.op === 'delete') live.delete(op.id);
    } catch {
      // A damaged line is skipped.
    }
  }
  return live.size;
}

/**
 * @param {string} from
 * @param {string} to
 */
function rename(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    throw new Error(
      `could not rename ${from} to ${to}: ${/** @type {Error} */ (error).message}.\nFix: close programs that use it (agents, editors, terminals in that folder), then run kyoten reset again`
    );
  }
}

/**
 * The command that moves `removed` back to `original`.
 *
 * @param {string} removed
 * @param {string} original
 * @param {NodeJS.Platform} platform
 */
export function undoCommand(removed, original, platform) {
  return platform === 'win32'
    ? `Move-Item -LiteralPath "${removed}" -Destination "${original}"`
    : `mv "${removed}" "${original}"`;
}

/**
 * @param {{
 *   home: string,
 *   config: import('./home.js').KyotenConfig,
 *   configPath: string,
 *   configDir: string,
 *   all: boolean,
 *   yes: boolean,
 *   interactive: boolean,
 *   ask: (question: string) => Promise<string>,
 *   run: Spawn,
 *   env: NodeJS.ProcessEnv,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   platform: NodeJS.Platform,
 *   now: () => Date,
 * }} input
 * @returns {Promise<number>}  the exit code
 */
export async function resetHome({
  home,
  config,
  configPath,
  configDir,
  all,
  yes,
  interactive,
  ask,
  run,
  env,
  out,
  err,
  platform,
  now,
}) {
  if (!readHomeInfo(home)) {
    if (homeState(home) === 'workspace') {
      throw new Error(
        `${home} was not created by kyoten init (a clone?), so kyoten does not reset it.\nFix: kyoten config unset home (to stop using it as the default home)`
      );
    }
    throw new Error(
      `there is no kyoten home at ${home} to reset.\nFix: kyoten init`
    );
  }
  const found = inspectHome({ home, run, env });
  out(`kyoten reset will move this home aside (nothing is deleted):`);
  out(`  home: ${home}`);
  if (found.commits === null) {
    out(`  local commits: unknown (${UPSTREAM} or main could not be read)`);
  } else {
    out(`  local commits not on ${UPSTREAM}: ${found.commits.length}`);
    for (const subject of found.commits.slice(0, SHOWN_SUBJECTS)) {
      out(`    ${subject}`);
    }
    if (found.commits.length > SHOWN_SUBJECTS) {
      out(`    … and ${found.commits.length - SHOWN_SUBJECTS} more`);
    }
  }
  out(`  uncommitted files: ${found.dirty ?? 'unknown'}`);
  out(`  open tasks: ${found.tasks}`);
  out(`  memory notes: ${found.notes}`);
  if (all) out(`  config folder (config, dscc profile): ${configDir}`);
  out(`Back up first if you want a copy: kyoten backup`);

  if (!yes) {
    if (!interactive) {
      throw new Error(
        'kyoten reset needs a confirmation and there is no terminal.\nFix: kyoten reset --yes'
      );
    }
    const answer = await ask(`Move ${home} aside? [y/N] `);
    if (!/^(y|yes)$/i.test(answer.trim())) {
      err('kyoten: nothing changed');
      return 1;
    }
  }

  const date = now();
  const moves = [[home, removedPath(home, date)]];
  if (all && fs.existsSync(configDir)) {
    moves.push([configDir, removedPath(configDir, date)]);
  }
  const registered = !all && !!config.home && samePath(config.home, home);
  for (const [from, to] of moves) rename(from, to);
  if (registered) {
    const rest = { ...config };
    delete rest.home;
    writeConfig(configPath, rest);
    err(`kyoten: "home" removed from ${configPath}`);
  }
  for (const [from, to] of moves) err(`kyoten: ${from} moved to ${to}`);
  err('kyoten: to undo, run:');
  for (const [from, to] of [...moves].reverse()) {
    err(`  ${undoCommand(to, from, platform)}`);
  }
  if (registered) err(`  kyoten config set home "${home}"`);
  err('kyoten: start again with: kyoten init');
  return 0;
}
