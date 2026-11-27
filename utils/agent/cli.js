#!/usr/bin/env node
/**
 * `pnpm agent ask --agent claude|codex|dsh "<prompt>"` — one headless turn of
 * another coding agent: a second opinion, a review, or a delegated question.
 *
 * Read-only by default (claude plan mode, codex read-only sandbox, dsh
 * read-only preset); `--write` uses the same write-mode commands as
 * `pnpm loop`. The prompt goes on stdin and nothing runs through a shell. The
 * answer is printed and saved as a markdown record under the task's tmp/.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCommand, runAgent } from '../loop/adapters.js';
import { isLinkedWorktree } from '../loop/worktree.js';
import { dsccEnv, profilePath } from '../kyoten/dscc.js';
import { runIfMain } from '../module-runner.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import { formatLocal } from '../task/markdown.js';
import { currentTask, resolveTaskName, tasksRoot } from '../task/store.js';
import { commandFor } from '../tools/registry.js';
import { ROOT_DIR } from '../workspace-config.js';
import { relPosix } from '../paths.js';

export const DEFAULT_TIMEOUT_MIN = 10;
/**
 * Agents callable via `pnpm agent ask`. `agy` is excluded: Google Antigravity
 * Terms of Service prohibit invoking `agy` from other agentic CLIs
 * (`agy -> others` is allowed; `others -> agy` is blocked). `dscc` runs the
 * `claude` CLI against the DeepSeek profile, so an Antigravity session can ask
 * it for a cross-model review without an Anthropic login.
 */
export const ASK_AGENTS = /** @type {const} */ ([
  'claude',
  'codex',
  'dsh',
  'dscc',
]);

export const HELP = `Usage: pnpm agent ask --agent ${ASK_AGENTS.join('|')} [options] "<prompt>" | -

Runs one headless turn of another coding agent in this repository and prints
its answer: a second opinion, a review, or a delegated question. Which agents
are installed here: pnpm tools list
Note: agy is intentionally excluded (Google Antigravity ToS forbids calling agy
from other agent harnesses; agy may call other agents, never the reverse).
dscc runs the claude CLI against the DeepSeek profile (Fix if missing:
kyoten dscc --set-key), so no Anthropic login is needed.

Options
  --agent <name>       ${ASK_AGENTS.join(' | ')} (required)
  --write              Let the agent edit files (default: read-only). Prefer a
                       git worktree; in the main checkout it edits your tree
  --timeout-min <n>    Stop the agent after n minutes (default ${DEFAULT_TIMEOUT_MIN})
  --bin "<cmd>"        Executable, split on spaces (no shell); default: the
                       tool registry entry, else <agent>
  --out <file>         Save the record here instead of the default
  --task <name>        Save under tasks/<name>/tmp/ (default: the active task;
                       with no active task, logs/<YYYYMMDD>/)
  --json               Print a JSON result instead of the answer
  --help, -h           Show this help (also pnpm agent help)

The prompt is the rest of the command line, or stdin when it is "-".
Exit code: the agent's exit code (1 when it was stopped by the timeout).`;

/**
 * @typedef {{
 *   command?: string, agent?: string, write: boolean, timeoutMin: number,
 *   bin?: string, out?: string, task?: string, json: boolean, help: boolean,
 *   prompt: string[],
 * }} AgentOptions
 */

const VALUE_FLAGS = {
  '--agent': 'agent',
  '--timeout-min': 'timeoutMin',
  '--bin': 'bin',
  '--out': 'out',
  '--task': 'task',
};
const BOOLEAN_FLAGS = {
  '--write': 'write',
  '--json': 'json',
  '--help': 'help',
  '-h': 'help',
};

/**
 * @param {string[]} argv
 * @returns {AgentOptions}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Record<string, boolean>} */
  const flags = { write: false, json: false, help: false };
  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) {
        throw new Error(`${flag} needs a value.\nFix: pnpm agent help`);
      }
      values[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]] =
        value;
    } else if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      flags[BOOLEAN_FLAGS[/** @type {keyof typeof BOOLEAN_FLAGS} */ (flag)]] =
        true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg}\nFix: pnpm agent help`);
    } else {
      positionals.push(arg);
    }
  }

  let timeoutMin = DEFAULT_TIMEOUT_MIN;
  if (values.timeoutMin !== undefined) {
    timeoutMin = Number(values.timeoutMin);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
      throw new Error(
        `--timeout-min must be a positive number (got "${values.timeoutMin}").\nFix: --timeout-min ${DEFAULT_TIMEOUT_MIN}`
      );
    }
  }

  const [command, ...prompt] = positionals;
  return {
    command,
    agent: values.agent,
    write: flags.write,
    timeoutMin,
    bin: values.bin,
    out: values.out,
    task: values.task,
    json: flags.json,
    help: flags.help,
    prompt,
  };
}

/**
 * A code fence longer than any backtick run in the text, so the record stays
 * valid markdown whatever the agent printed.
 *
 * @param {string} text
 * @returns {string}
 */
export function fence(text) {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * @param {Date} date
 * @returns {string} yyyymmddhhmmss in local time
 */
function stamp(date) {
  /** @param {number} n */
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * Where the record goes: --out, else the task's tmp/, else logs/<date>/.
 *
 * @param {{ rootDir: string, agent: string, out?: string, task?: string, now: Date }} input
 * @returns {string}
 */
export function recordPath({ rootDir, agent, out, task, now }) {
  if (out) return path.resolve(rootDir, out);
  const name = task ? resolveTaskName(rootDir, task) : currentTask(rootDir);
  const id = stamp(now);
  if (name) {
    return path.join(
      tasksRoot(rootDir),
      name,
      'tmp',
      `agent-${agent}-${id}.md`
    );
  }
  return path.join(
    rootDir,
    'logs',
    id.slice(0, 8),
    `agent-${agent}-${id.slice(8)}.md`
  );
}

/**
 * The agent's answer: stdout when it printed one (codex and dsh log progress
 * to stderr), else the full output.
 *
 * @param {import('../loop/adapters.js').AgentResult} result
 * @returns {string}
 */
export function answerOf(result) {
  return result.stdout.trim() ? result.stdout : result.output;
}

/**
 * @param {{ command: import('../loop/adapters.js').AgentCommand, agent?: string, mode: string, cwd: string, at: Date, prompt: string, result: import('../loop/adapters.js').AgentResult }} input
 * @returns {string}
 */
export function formatRecord({
  command,
  agent = command.agent,
  mode,
  cwd,
  at,
  prompt,
  result,
}) {
  const answer = answerOf(result);
  const exit = result.signal
    ? `stopped by ${result.signal}`
    : `exit ${result.code}`;
  return [
    `# Agent call — ${agent} (${mode})`,
    '',
    `- When: ${formatLocal(at, { withTime: true })}`,
    `- Command: \`${[command.bin, ...command.args].join(' ')}\` (prompt on stdin)`,
    `- Cwd: ${cwd}`,
    `- Result: ${exit} in ${Math.round(result.durationMs / 1000)}s`,
    '',
    '## Prompt',
    '',
    fence(prompt),
    prompt,
    fence(prompt),
    '',
    '## Answer (stdout)',
    '',
    fence(answer),
    answer,
    fence(answer),
    '',
    '## Full output (stdout + stderr)',
    '',
    fence(result.output),
    result.output,
    fence(result.output),
    '',
  ].join('\n');
}

/**
 * `base` without the names `drop` removes (`NAME*` drops by prefix; Windows
 * env names are case-insensitive), then `set` applied.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {{ drop: string[], set: Record<string, string> }} profile
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function profileEnv(base, profile, platform = process.platform) {
  const folded = (/** @type {string} */ name) =>
    platform === 'win32' ? name.toUpperCase() : name;
  const names = new Set(
    profile.drop.filter((name) => !name.endsWith('*')).map(folded)
  );
  const prefixes = profile.drop
    .filter((name) => name.endsWith('*'))
    .map((name) => folded(name.slice(0, -1)));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = folded(name);
    if (names.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    out[name] = value;
  }
  for (const [name, value] of Object.entries(profile.set)) {
    for (const existing of Object.keys(out)) {
      if (folded(existing) === folded(name)) delete out[existing];
    }
    out[name] = value;
  }
  return out;
}

/**
 * @typedef {{
 *   rootDir: string,
 *   env: NodeJS.ProcessEnv,
 *   homedir: () => string,
 *   platform: NodeJS.Platform,
 *   log: (message: string) => void,
 *   warn: (message: string) => void,
 *   now: () => Date,
 *   spawn: import('../loop/worktree.js').Spawn,
 *   runAgent: typeof runAgent,
 *   readStdin: () => string,
 * }} AgentDeps
 */

/**
 * @param {Partial<AgentDeps>} [overrides]
 * @returns {AgentDeps}
 */
export function defaultAgentDeps(overrides = {}) {
  return {
    rootDir: ROOT_DIR,
    env: process.env,
    homedir: () => os.homedir(),
    platform: process.platform,
    log: console.log,
    warn: console.error,
    now: () => new Date(),
    spawn: /** @type {import('../loop/worktree.js').Spawn} */ (spawnSync),
    runAgent,
    /* c8 ignore next - reads the real stdin; tests inject readStdin */
    readStdin: () => fs.readFileSync(0, 'utf-8'),
    ...overrides,
  };
}

/**
 * @param {AgentOptions} options
 * @param {AgentDeps} d
 * @returns {number}
 */
function ask(options, d) {
  if (!options.agent) {
    throw new Error(
      `--agent is required.\nFix: pnpm agent ask --agent ${ASK_AGENTS.join('|')} "<prompt>"`
    );
  }
  if (options.agent === 'agy') {
    throw new Error(
      `Refusing pnpm agent ask --agent agy: Google Antigravity Terms of Service prohibit invoking agy (headless or agy acp) from other agent harnesses (agy -> others is allowed; others -> agy is blocked).\nFix: use --agent ${ASK_AGENTS.join('|')} (inside Antigravity, use native subagents instead)`
    );
  }
  if (!ASK_AGENTS.includes(/** @type {any} */ (options.agent))) {
    throw new Error(
      `Unknown agent "${options.agent}".\nFix: use --agent ${ASK_AGENTS.join('|')}`
    );
  }
  const fromStdin = options.prompt.length === 1 && options.prompt[0] === '-';
  const prompt = (fromStdin ? d.readStdin() : options.prompt.join(' ')).trim();
  if (!prompt) {
    throw new Error(
      `${fromStdin ? 'stdin was empty' : 'No prompt given'}.\nFix: pnpm agent ask --agent ${options.agent} "<prompt>" (or pipe it with -)`
    );
  }

  const mode = options.write ? 'write' : 'read';
  const label = /** @type {string} */ (options.agent);
  // dscc runs the claude CLI with the DeepSeek profile, so the adapter flags
  // (plan mode read-only) are claude's; the record and output keep the dscc
  // label.
  const adapterAgent = label === 'dscc' ? 'claude' : label;
  const command = buildCommand({
    agent: adapterAgent,
    bin: options.bin,
    argv: options.bin ? null : commandFor(d.rootDir, adapterAgent),
    mode,
  });
  /** @type {NodeJS.ProcessEnv} */
  let env = { ...d.env, [INNER_LOOP_ENV]: 'off', TASK_AGENT: label };
  if (label === 'dscc') {
    const profile = dsccEnv(
      profilePath({ env: d.env, homedir: d.homedir(), platform: d.platform })
    );
    for (const warning of profile.warnings) {
      d.warn(`! dscc profile ${warning}`);
    }
    env = profileEnv(env, profile, d.platform);
    env.KYOTEN_AGENT = 'dscc';
    env[INNER_LOOP_ENV] = 'off';
    env.TASK_AGENT = label;
  }
  if (options.write) {
    let linked = false;
    try {
      linked = isLinkedWorktree(d.rootDir, d.spawn);
    } catch {
      // Not a git checkout: treat it like the main checkout and warn.
    }
    if (!linked) {
      d.warn(
        `! --write in the main checkout: ${label} may edit your working tree`
      );
    }
  }

  const at = d.now();
  const file = recordPath({
    rootDir: d.rootDir,
    agent: label,
    out: options.out,
    task: options.task,
    now: at,
  });
  const result = d.runAgent({
    command,
    cwd: d.rootDir,
    prompt,
    timeoutMs: options.timeoutMin * 60 * 1000,
    env,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    formatRecord({
      command,
      agent: label,
      mode,
      cwd: d.rootDir,
      at,
      prompt,
      result,
    }),
    'utf-8'
  );

  const code = result.code === null ? 1 : result.code;
  const record = relPosix(d.rootDir, file);
  if (options.json) {
    d.log(
      JSON.stringify(
        {
          ok: code === 0,
          agent: label,
          mode,
          code: result.code,
          signal: result.signal,
          durationMs: result.durationMs,
          record,
          answer: answerOf(result),
          output: result.output,
        },
        null,
        2
      )
    );
  } else {
    d.log(answerOf(result).trimEnd());
    d.warn(
      `(${label}, ${mode}: ${result.signal ? `stopped by ${result.signal}` : `exit ${result.code}`}; record: ${record})`
    );
  }
  return code;
}

/**
 * @param {{ argv?: string[], deps?: Partial<AgentDeps> }} [options]
 * @returns {number}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const d = defaultAgentDeps(deps);
  const options = parseArgs(argv);
  if (options.help || !options.command || options.command === 'help') {
    d.log(HELP);
    return 0;
  }
  if (options.command !== 'ask') {
    throw new Error(
      `Unknown command "${options.command}".\nFix: pnpm agent ask --agent ${ASK_AGENTS.join('|')} "<prompt>" (see pnpm agent help)`
    );
  }
  return ask(options, d);
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, () => {
  try {
    process.exit(main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
