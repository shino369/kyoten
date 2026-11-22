#!/usr/bin/env node
/**
 * kyoten — start a coding agent in a kyoten workspace (the "home").
 *
 *   kyoten [--home <dir>] [<agent>] [agent args…]     agent: claude (default), codex, dsh, dscc, agy
 *   kyoten [--home <dir>] <command> [options]         init, update, doctor, run, where, help, version
 *
 * Only the front of the command line is kyoten's: its options, then one word
 * that picks the agent or the command. Everything after that goes to the
 * agent unchanged. User guide: docs/kyoten.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { runIfMain } from '../module-runner.js';
import { crossSpawn } from '../spawn.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  dsccEnv,
  profilePath,
  readFirstLine,
  readHidden,
  setKey,
  showProfile,
} from './dscc.js';
import {
  dshWebCheck,
  dshWebPort,
  formatCheck,
  runChecks,
  workspaceCheck,
} from './doctor.js';
import {
  AGENTS,
  configDir,
  configFile,
  expandHome,
  homeState,
  readConfig,
  readHomeInfo,
  resolveHome,
  writeConfig,
} from './home.js';
import { backupHome, restoreBackup } from './backup.js';
import { runConfig } from './config-cmd.js';
import { initHome } from './init.js';
import { pauseSaving } from './memory.js';
import {
  DSH_DEFAULT_PROFILE,
  buildEnv,
  dshProfile,
  exitCode,
  outsideRepo,
  prepareLaunch,
  spawnInteractive,
} from './launch.js';
import { compareVersions } from './repo.js';
import { resetHome } from './reset.js';
import { snapshotSource } from './snapshot.js';
import { updateHome } from './update.js';

/** Asked once, when kyoten creates a new home in a terminal. */
export const MEMORY_QUESTION =
  'kyoten: save memory automatically? Each session end then runs one background agent call on your plan. [y/N] ';

export const COMMANDS = /** @type {const} */ ([
  'init',
  'update',
  'doctor',
  'run',
  'where',
  'config',
  'reset',
  'backup',
  'restore',
  'help',
  'version',
]);

/**
 * @typedef {import('./home.js').AgentName} AgentName
 * @typedef {typeof COMMANDS[number]} CommandName
 * @typedef {{ home?: string, addDir: boolean, help: boolean, version: boolean, agent?: AgentName, command?: CommandName, args: string[] }} KyotenArgs
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   platform: NodeJS.Platform,
 *   homedir: string,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   stdin: import('./dscc.js').KeyInput & AsyncIterable<string | Buffer>,
 *   tty: import('./dscc.js').KeyOutput,
 *   spawn?: import('./launch.js').InteractiveSpawn,
 *   signals?: import('./launch.js').SignalTarget,
 *   canRun?: (file: string) => boolean,
 *   registry?: (home: string, name: string) => string[] | null,
 *   run: import('../spawn.js').Spawn,
 *   ask: (question: string) => Promise<string>,
 *   now: () => Date,
 *   root: string,
 *   connect?: (port: number) => Promise<boolean>,
 * }} KyotenDeps
 */

/**
 * @param {string[]} argv
 * @returns {KyotenArgs}
 */
export function parseArgs(argv) {
  /** @type {KyotenArgs} */
  const parsed = { help: false, version: false, addDir: true, args: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' || arg.startsWith('--home=')) {
      const value =
        arg === '--home' ? argv[(i += 1)] : arg.slice('--home='.length);
      if (!value) {
        throw new Error(
          '--home needs a directory.\nFix: kyoten --home <dir> …'
        );
      }
      parsed.home = value;
    } else if (arg === '--no-add-dir') {
      parsed.addDir = false;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version') {
      parsed.version = true;
    } else {
      break;
    }
  }
  const word = argv[i];
  const name = word?.startsWith('--') ? word.slice(2) : word;
  if (AGENTS.includes(/** @type {AgentName} */ (name))) {
    parsed.agent = /** @type {AgentName} */ (name);
    parsed.args = argv.slice(i + 1);
  } else if (COMMANDS.includes(/** @type {CommandName} */ (word))) {
    parsed.command = /** @type {CommandName} */ (word);
    parsed.args = argv.slice(i + 1);
  } else {
    parsed.agent = 'claude';
    parsed.args = argv.slice(i);
  }
  return parsed;
}

/** @param {string} [root] */
export function packageVersion(root = ROOT_DIR) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
  );
  return String(pkg.version);
}

/**
 * The help. It names no machine path, so the generated CLI reference
 * (pnpm docs:cli) is the same on every machine.
 *
 * @param {string} version
 */
export function helpText(version) {
  return `Usage: kyoten [--home <dir>] [--no-add-dir] [<agent>] [agent args…]
       kyoten [--home <dir>] <command> [options]

kyoten ${version} — start a coding agent in your kyoten workspace (the home)

Agents (the first word, default claude; --<agent> works too)
  claude    Claude Code
  codex     OpenAI Codex CLI
  dsh       DeepSeek harness: dsh <profile> --patch .dsh/workspace.patch.yml
            (profile: the first argument if it is not an option; default web)
  dscc      Claude Code on the DeepSeek API
  agy       Antigravity CLI

Everything after the agent goes to it unchanged; kyoten adds no permission
flags. Started inside a git repository outside the home, claude, dscc, and
codex also get --add-dir=<repository>, so they can edit it (--no-add-dir, or
"addDir": false in the config, turns that off). To give Claude a word that
is a kyoten command: kyoten claude <word>

Commands
  init [<dir>] [--no-setup] [--memory on|off]
            Create a home (default ~/.kyoten) and install it; with <dir>,
            also make it the default home (an existing kyoten workspace
            is kept as it is). --no-setup: skip pnpm install and setup.
            --memory: automatic memory saving in the new home (asked in a
            terminal; default off)
  update [--no-setup]
            Merge a newer kyoten snapshot into a home kyoten created
  doctor    Check prerequisites, agents, and the home
  run <script> [args…]
            Run a workspace script in the home from any folder
            (pnpm <script> there): kyoten run task status
  where     Print the home (the rule that chose it goes to stderr)
  config [path | get <key> | set <key> <value…> | unset <key>]
            Show or change the config file. Keys: home (a kyoten
            workspace), args.<agent> (every word after the key is one
            argument), addDir (true|false)
  reset [--yes] [--all]
            Move a home kyoten created aside (renamed to
            <home>.removed-<time>, never deleted; the undo is printed).
            Shows what is in it first. --all also moves the config folder
  backup [<dir>] [--include-key]
            Write a new folder (default ./kyoten-backup-<time>) with the
            memory export, config, and your local commits; personal data.
            --include-key adds the DeepSeek key file
  restore <dir> [--yes]
            Check a backup folder, then merge its commits and memory into the
            home (created first if missing) and copy config files that are
            not there yet
  help      This help
  version   kyoten's version

dscc profile (DeepSeek API key and model mapping)
  kyoten dscc --set-key   Save the key (hidden prompt, or one line on stdin)
  kyoten dscc --show      Print the profile, the key masked

The home is the first of: --home, $KYOTEN_HOME, the clone kyoten runs from
(pnpm kyoten inside it), "home" in the config, ~/.kyoten.
Config: config.json in %APPDATA%\\kyoten (Windows), else in
$XDG_CONFIG_HOME/kyoten or ~/.config/kyoten:
  {"home": "/abs/path", "addDir": false, "args": {"dscc": ["--dangerously-skip-permissions"]}}`;
}

/**
 * `kyoten dscc --set-key` / `--show`.
 *
 * @param {string} flag
 * @param {KyotenDeps} deps
 * @returns {Promise<number>}
 */
async function dsccProfileCommand(flag, deps) {
  const file = profilePath(deps);
  if (flag === '--show') {
    for (const line of showProfile(file)) deps.out(line);
    return 0;
  }
  const key = deps.stdin.isTTY
    ? await readHidden({
        input: deps.stdin,
        output: deps.tty,
        prompt: 'DeepSeek API key (hidden): ',
      })
    : await readFirstLine(deps.stdin);
  const { created } = setKey({ file, key });
  deps.err(`kyoten: key saved to ${file}${created ? ' (new profile)' : ''}`);
  return 0;
}

/**
 * Options of `kyoten init` and `kyoten update`.
 *
 * @param {CommandName} command
 * @param {string[]} args
 * @returns {{ dir?: string, setup: boolean, memory?: 'on' | 'off' }}
 */
export function parseCommandArgs(command, args) {
  const usage =
    command === 'init'
      ? 'kyoten init [<dir>] [--no-setup] [--memory on|off]'
      : `kyoten ${command}${command === 'update' ? ' [--no-setup]' : ''}`;
  /** @type {{ dir?: string, setup: boolean, memory?: 'on' | 'off' }} */
  const options = { setup: true };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-setup' && command !== 'doctor') {
      options.setup = false;
    } else if (
      command === 'init' &&
      (arg === '--memory' || arg.startsWith('--memory='))
    ) {
      const value =
        arg === '--memory' ? args[(i += 1)] : arg.slice('--memory='.length);
      if (value !== 'on' && value !== 'off') {
        throw new Error(
          `--memory takes on or off (got ${value ?? 'nothing'})\nFix: ${usage}`
        );
      }
      options.memory = value;
    } else if (
      command === 'init' &&
      !arg.startsWith('-') &&
      options.dir === undefined
    ) {
      options.dir = arg;
    } else {
      throw new Error(
        `unexpected argument for kyoten ${command}: ${arg}\nFix: ${usage}`
      );
    }
  }
  return options;
}

/**
 * Flags and one optional folder of `kyoten reset|backup|restore`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ flags: string[], dir?: 'optional' | 'required' }} spec
 * @returns {{ flags: Set<string>, dir?: string }}
 */
export function parseFlags(command, args, { flags, dir }) {
  const usage = `kyoten ${command}${dir ? ` ${dir === 'required' ? '<dir>' : '[<dir>]'}` : ''}${flags.map((f) => ` [${f}]`).join('')}`;
  /** @type {{ flags: Set<string>, dir?: string }} */
  const parsed = { flags: new Set() };
  for (const arg of args) {
    if (flags.includes(arg)) {
      parsed.flags.add(arg);
    } else if (dir && !arg.startsWith('-') && parsed.dir === undefined) {
      parsed.dir = arg;
    } else {
      throw new Error(
        `unexpected argument for kyoten ${command}: ${arg}\nFix: ${usage}`
      );
    }
  }
  if (dir === 'required' && parsed.dir === undefined) {
    throw new Error(`kyoten ${command} needs a folder.\nFix: ${usage}`);
  }
  return parsed;
}

/**
 * @typedef {{ deps: KyotenDeps, version: string, configPath: string, config: import('./home.js').KyotenConfig, home: import('./home.js').ResolvedHome }} Context
 */

/**
 * Create (or install) a home. A new one gets the memory choice: `memory`
 * when given, else the answer in a terminal ([y/N]), else off.
 *
 * @param {Context} ctx
 * @param {string} dir
 * @param {boolean} setup
 * @param {'on' | 'off'} [memory]
 */
async function createHome(ctx, dir, setup, memory) {
  const { deps, version } = ctx;
  const { created } = initHome({
    home: dir,
    source: snapshotSource({
      root: deps.root,
      version,
      run: deps.run,
    }),
    log: (text) => deps.err(`kyoten: ${text}`),
    setup,
    run: deps.run,
    env: deps.env,
  });
  if (!created) return;
  const on = memory
    ? memory === 'on'
    : deps.stdin.isTTY === true &&
      /^(y|yes)$/i.test((await deps.ask(MEMORY_QUESTION)).trim());
  if (on) {
    deps.err(
      'kyoten: memory saving is on; turn it off with: kyoten run memory off'
    );
    return;
  }
  pauseSaving(dir);
  deps.err(
    'kyoten: memory saving is off (recall and pnpm memory add still work); opt in with: kyoten run memory on'
  );
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
async function commandInit(ctx, args) {
  const { deps, configPath, config, home } = ctx;
  const { dir, setup, memory } = parseCommandArgs('init', args);
  const target = dir
    ? path.resolve(deps.cwd, expandHome(dir, deps.homedir))
    : home.dir;
  await createHome(ctx, target, setup, memory);
  if (dir) {
    writeConfig(configPath, { ...config, home: target });
    deps.err(`kyoten: ${target} is now the default home (${configPath})`);
  }
  deps.err('kyoten: start an agent with: kyoten [claude|codex|dsh|dscc|agy]');
  return 0;
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandUpdate(ctx, args) {
  const { deps, version, home } = ctx;
  const { setup } = parseCommandArgs('update', args);
  updateHome({
    home: home.dir,
    source: snapshotSource({
      root: deps.root,
      version,
      run: deps.run,
    }),
    log: (text) => deps.err(`kyoten: ${text}`),
    setup,
    run: deps.run,
    env: deps.env,
  });
  return 0;
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandConfig(ctx, args) {
  const { deps, configPath, config } = ctx;
  return runConfig({
    args,
    file: configPath,
    config,
    cwd: deps.cwd,
    homedir: deps.homedir,
    out: deps.out,
    err: deps.err,
  });
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandReset(ctx, args) {
  const { deps, configPath, config, home } = ctx;
  const { flags } = parseFlags('reset', args, { flags: ['--yes', '--all'] });
  return resetHome({
    home: home.dir,
    config,
    configPath,
    configDir: configDir(deps),
    all: flags.has('--all'),
    yes: flags.has('--yes'),
    interactive: Boolean(deps.stdin.isTTY),
    ask: deps.ask,
    run: deps.run,
    env: deps.env,
    out: deps.out,
    err: (text) => deps.err(text),
    platform: deps.platform,
    now: deps.now,
  });
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandBackup(ctx, args) {
  const { deps, version, home } = ctx;
  const { flags, dir } = parseFlags('backup', args, {
    flags: ['--include-key'],
    dir: 'optional',
  });
  return backupHome({
    home: home.dir,
    dir,
    includeKey: flags.has('--include-key'),
    configFile: ctx.configPath,
    profileFile: profilePath(deps),
    version,
    run: deps.run,
    env: deps.env,
    out: deps.out,
    err: deps.err,
    now: deps.now,
    cwd: deps.cwd,
    homedir: deps.homedir,
  });
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandRestore(ctx, args) {
  const { deps, home } = ctx;
  const { flags, dir } = parseFlags('restore', args, {
    flags: ['--yes'],
    dir: 'required',
  });
  return restoreBackup({
    dir: /** @type {string} */ (dir),
    yes: flags.has('--yes'),
    interactive: Boolean(deps.stdin.isTTY),
    ask: deps.ask,
    home: home.dir,
    createHome: () => createHome(ctx, home.dir, true),
    configFile: ctx.configPath,
    profileFile: profilePath(deps),
    run: deps.run,
    env: deps.env,
    out: deps.out,
    err: deps.err,
    cwd: deps.cwd,
    homedir: deps.homedir,
  });
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
async function commandDoctor(ctx, args) {
  const { deps, version, config, home } = ctx;
  parseCommandArgs('doctor', args);
  const checks = runChecks({
    home: home.dir,
    homeSource: home.source,
    version,
    profile: profilePath(deps),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir,
    run: deps.run,
    canRun: deps.canRun,
    registry: deps.registry,
  });
  for (const check of checks) deps.out(formatCheck(check));
  if (checks.some((check) => check.id === 'dsh' && check.status === 'ok')) {
    const check = await dshWebCheck({
      port: dshWebPort(config.args?.dsh),
      connect: deps.connect,
    });
    checks.push(check);
    deps.out(formatCheck(check));
  }
  if (homeState(home.dir) === 'workspace') {
    const check = workspaceCheck({
      home: home.dir,
      run: deps.run,
      env: deps.env,
    });
    checks.push(check);
    deps.out(formatCheck(check));
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  deps.out(
    failed
      ? `${failed} problem(s) need a fix (see the Fix lines).`
      : 'kyoten is ready.'
  );
  return failed ? 1 : 0;
}

/**
 * The home must already be a kyoten workspace (no offer to create one).
 *
 * @param {Context} ctx
 */
function requireWorkspace(ctx) {
  const { home } = ctx;
  const state = homeState(home.dir);
  if (state === 'missing') {
    throw new Error(`no kyoten home at ${home.dir} yet.\nFix: kyoten init`);
  }
  if (state === 'other') {
    throw new Error(
      `${home.dir} (${home.source}) is not a kyoten workspace.\nFix: kyoten --home <dir> …, or kyoten init <new dir>`
    );
  }
}

/**
 * `kyoten run <script> [args…]`: `pnpm <script> [args…]` in the home, with
 * the terminal and the caller's environment; without a script, the usage
 * and the home's scripts.
 *
 * @param {Context} ctx
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function commandRun(ctx, args) {
  const { deps, home } = ctx;
  requireWorkspace(ctx);
  const [script, ...rest] = args;
  if (script === undefined || script === '--help' || script === '-h') {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(home.dir, 'package.json'), 'utf-8')
    );
    const names = Object.keys(pkg.scripts ?? {}).sort();
    deps.out(
      [
        'Usage: kyoten run <script> [args…]',
        '',
        `Runs pnpm <script> [args…] in ${home.dir}. Scripts:`,
        ...(names.length ? names.map((name) => `  ${name}`) : ['  (none)']),
      ].join('\n')
    );
    return 0;
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(deps.env)) {
    if (value !== undefined) env[name] = value;
  }
  const status = await spawnInteractive({
    argv: ['pnpm', script, ...rest],
    cwd: home.dir,
    env,
    platform: deps.platform,
    spawn: deps.spawn,
    signals: deps.signals,
  });
  return exitCode(status);
}

/**
 * Make sure the home exists before a launch: in a terminal, offer to create
 * it ([Y/n]); otherwise explain `kyoten init`.
 *
 * @param {Context} ctx
 * @returns {Promise<boolean>}  false when the user declined
 */
async function ensureHome(ctx) {
  const { deps, home } = ctx;
  const state = homeState(home.dir);
  if (state === 'workspace') return true;
  // Throws for a folder that holds something else, or outside a terminal.
  if (state === 'other' || !deps.stdin.isTTY) requireWorkspace(ctx);
  const answer = await deps.ask(
    `kyoten: no kyoten home at ${home.dir} yet. Create it now? [Y/n] `
  );
  if (!/^(y|yes)?$/i.test(answer.trim())) {
    deps.err('kyoten: nothing created; run kyoten init when you are ready');
    return false;
  }
  await createHome(ctx, home.dir, true);
  return true;
}

/**
 * The version hint for a home kyoten created.
 *
 * @param {Context} ctx
 */
function versionHint(ctx) {
  const { deps, version, home } = ctx;
  const info = readHomeInfo(home.dir);
  const order = info ? compareVersions(version, info.version) : 0;
  if (info && order > 0) {
    deps.err(
      `kyoten: kyoten ${version} is available for this home (it has ${info.version}): kyoten update`
    );
  } else if (info && order < 0) {
    deps.err(
      `kyoten: this home has kyoten ${info.version}, newer than this kyoten ${version}: npx kyoten@latest`
    );
  }
}

/**
 * @param {Context} ctx
 * @param {AgentName} agent
 * @param {string[]} args
 * @param {boolean} addDirFlag  false with --no-add-dir
 * @returns {Promise<number>}
 */
async function launch(ctx, agent, args, addDirFlag) {
  const { deps, config, home } = ctx;
  const addDirEnabled = addDirFlag && config.addDir !== false;
  if (!(await ensureHome(ctx))) return 1;
  versionHint(ctx);
  const profile = agent === 'dscc' ? dsccEnv(profilePath(deps)) : null;
  for (const warning of profile?.warnings ?? [])
    deps.err(`kyoten: dscc profile ${warning}`);
  const addDir = outsideRepo({
    agent,
    cwd: deps.cwd,
    home: home.dir,
    enabled: addDirEnabled,
  });
  const argv = prepareLaunch({
    agent,
    args,
    home: home.dir,
    env: deps.env,
    platform: deps.platform,
    defaults: config.args?.[agent],
    addDir,
    canRun: deps.canRun,
    registry: deps.registry,
  });
  deps.err(
    `kyoten: ${agent} in ${home.dir} (${home.source})${addDir ? `; --add-dir=${addDir}` : ''}`
  );
  if (agent === 'dsh' && dshProfile(args).profile === DSH_DEFAULT_PROFILE) {
    deps.err(
      `kyoten: in the DSH Web UI, click Choose workspace, add ${home.dir}, and select it; sessions in another workspace still run this home's hooks`
    );
  }
  const status = await spawnInteractive({
    argv,
    cwd: home.dir,
    env: buildEnv({
      env: deps.env,
      home: home.dir,
      cwd: deps.cwd,
      platform: deps.platform,
      // An inherited KYOTEN_ADD_DIR (kyoten inside kyoten) is not this launch's.
      drop: [...(profile?.drop ?? []), 'KYOTEN_ADD_DIR'],
      set: { ...profile?.set, ...(addDir ? { KYOTEN_ADD_DIR: addDir } : {}) },
    }),
    platform: deps.platform,
    spawn: deps.spawn,
    signals: deps.signals,
  });
  return exitCode(status);
}

/**
 * @param {KyotenArgs} parsed
 * @param {KyotenDeps} deps
 * @returns {Promise<number>}
 */
async function run(parsed, deps) {
  const version = packageVersion(deps.root);
  if (parsed.help || parsed.command === 'help') {
    deps.out(helpText(version));
    return 0;
  }
  if (parsed.version || parsed.command === 'version') {
    deps.out(version);
    return 0;
  }
  const flag = parsed.args[0];
  if (parsed.agent === 'dscc' && (flag === '--set-key' || flag === '--show')) {
    return dsccProfileCommand(flag, deps);
  }
  const configPath = configFile(deps);
  const config = readConfig(configPath);
  const home = resolveHome({ ...deps, flag: parsed.home, config, configPath });
  /** @type {Context} */
  const ctx = { deps, version, configPath, config, home };
  switch (parsed.command) {
    case 'where':
      deps.out(home.dir);
      deps.err(`kyoten: chosen by ${home.source}`);
      return 0;
    case 'init':
      return commandInit(ctx, parsed.args);
    case 'update':
      return commandUpdate(ctx, parsed.args);
    case 'config':
      return commandConfig(ctx, parsed.args);
    case 'reset':
      return commandReset(ctx, parsed.args);
    case 'backup':
      return commandBackup(ctx, parsed.args);
    case 'restore':
      return commandRestore(ctx, parsed.args);
    case 'doctor':
      return commandDoctor(ctx, parsed.args);
    case 'run':
      return commandRun(ctx, parsed.args);
    default:
      return launch(
        ctx,
        /** @type {AgentName} */ (parsed.agent),
        parsed.args,
        parsed.addDir
      );
  }
}

/**
 * @param {string[]} argv
 * @param {KyotenDeps} [deps]
 * @returns {Promise<number>}  the exit code
 */
export async function main(argv, deps = defaultDeps()) {
  try {
    return await run(parseArgs(argv), deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split('\n')) deps.err(`kyoten: ${line}`);
    return 1;
  }
}

/** @returns {KyotenDeps} */
export function defaultDeps() {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: os.homedir(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdin: /** @type {KyotenDeps['stdin']} */ (
      /** @type {unknown} */ (process.stdin)
    ),
    tty: process.stderr,
    run: crossSpawn(),
    root: ROOT_DIR,
    now: () => new Date(),
    ask: (question) =>
      askLine({ input: process.stdin, output: process.stderr, question }),
  };
}

/**
 * One answer from `input`; the terminal echoes it (no raw mode).
 *
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string }} io
 */
export async function askLine({ input, output, question }) {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/* c8 ignore next 3 - CLI entry point; main() is tested directly */
runIfMain(import.meta.url, async () => {
  process.exit(await main(process.argv.slice(2)));
});
