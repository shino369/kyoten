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
import {
  TOKEN_KEYS,
  dsccEnv,
  profilePath,
  writePrivate,
} from '../kyoten/dscc.js';
import { runIfMain } from '../module-runner.js';
import { REDACTED, isSecretKey, redactSecrets } from '../redact.js';
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

/** Profile fields the launcher accepts as credentials, whatever their value. */
const PROFILE_CREDENTIAL_KEYS = new Set([
  ...TOKEN_KEYS,
  'ANTHROPIC_CUSTOM_HEADERS',
]);
/**
 * Credential variable names in an inherited environment, token-bounded so
 * `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_NAME` (which merely contain `AUTH`) never
 * match.
 */
const ENV_SECRET_NAME_RE =
  /(?:^|[_-])(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN|AUTH_KEY|AUTH_HEADER|CUSTOM_HEADERS|AUTHORIZATION|CREDENTIALS?)(?:$|[_-])/i;
/**
 * Explicit full-name credential query parameters; anchored, so `invite`,
 * `author`, `keyboard`, or `public_key_id` never match.
 */
const URL_SECRET_PARAM_RE =
  /^(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|key|auth|authorization|sig|signature|credentials?)$/i;
const HEADER_SCHEME_RE = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;

/**
 * Add a literal secret (and its unquoted form when wrapped in matching quotes)
 * to `values`.
 *
 * @param {Set<string>} values
 * @param {string} raw
 * @param {{ minLength?: number, literal?: boolean }} [options]
 */
function addSecretValue(values, raw, { minLength = 1, literal = false } = {}) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const unquoted = /^(["']).*\1$/s.test(trimmed)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  for (const candidate of [trimmed, unquoted]) {
    if (
      candidate.length >= minLength &&
      (literal || !/^(?:\$|\[REDACTED|<[^>]*>$)/i.test(candidate))
    ) {
      values.add(candidate);
    }
  }
}

/**
 * Extract header values and scheme tokens from a custom-headers env value
 * (e.g. `ANTHROPIC_CUSTOM_HEADERS="X-Api-Key: secret\nAuthorization: Basic …"`).
 * A configured headers field is trusted whole, so short values count too.
 *
 * @param {Set<string>} values
 * @param {string} raw
 * @param {boolean} [literal] values from an accepted profile are literal
 */
function addHeaderSecrets(values, raw, literal = false) {
  const unquoted = /^(["']).*\1$/s.test(raw.trim())
    ? raw.trim().slice(1, -1)
    : raw;
  for (const line of unquoted.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const headerValue = line.slice(colon + 1).trim();
    if (!headerValue) continue;
    addSecretValue(values, headerValue, { literal });
    const scheme = HEADER_SCHEME_RE.exec(headerValue)?.[1];
    if (scheme) addSecretValue(values, scheme, { literal });
  }
}

/**
 * `decodeURIComponent` that returns the raw value when the encoding is
 * malformed, so a broken escape still gets scrubbed.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeOrRaw(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extract credential components from a URL string: the userinfo (`username`,
 * `password`, and `username:password`, raw and decoded) and secret-named query
 * parameters (raw and decoded).
 *
 * @param {Set<string>} values
 * @param {string} raw
 * @param {boolean} [literal] the URL was accepted in an explicit profile
 */
function addUrlSecrets(values, raw, literal = false) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return; // Not a URL: no userinfo or query parameters to read.
  }
  const user = parsed.username;
  const pass = parsed.password;
  if (user || pass) {
    for (const [username, password] of [
      [user, pass],
      [decodeOrRaw(user), decodeOrRaw(pass)],
    ]) {
      addSecretValue(values, username, { literal });
      addSecretValue(values, password, { literal });
      if (username && password) {
        addSecretValue(values, `${username}:${password}`, { literal });
      }
    }
  }
  const queryOptions = { literal, minLength: literal ? 1 : 4 };
  // Raw (still percent-encoded) query values, which the decoded searchParams
  // would miss.
  for (const pair of parsed.search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = decodeOrRaw(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    if (value && URL_SECRET_PARAM_RE.test(name))
      addSecretValue(values, value, queryOptions);
  }
  for (const [param, val] of parsed.searchParams.entries()) {
    if (URL_SECRET_PARAM_RE.test(param))
      addSecretValue(values, val, queryOptions);
  }
}

/**
 * Literal secret values from a dscc profile (`set`), longest first so
 * scrubbing replaces full tokens before any substring. A credential field the
 * launcher accepts is trusted whole (no minimum length); other profile values
 * only contribute URL userinfo and explicitly named query credentials.
 *
 * @param {Record<string, string>} set
 * @returns {string[]}
 */
export function profileSecrets(set) {
  /** @type {Set<string>} */
  const values = new Set();
  for (const [key, value] of Object.entries(set)) {
    if (!value) continue;
    if (
      PROFILE_CREDENTIAL_KEYS.has(key) ||
      isSecretKey(key) ||
      ENV_SECRET_NAME_RE.test(key)
    ) {
      addSecretValue(values, value, { literal: true });
      if (/HEADERS/i.test(key)) addHeaderSecrets(values, value, true);
    }
    addUrlSecrets(values, value, true);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Literal secret values from a child process environment (e.g. inherited API
 * keys), requiring at least 8 characters so short flags like `1`/`true` never
 * corrupt normal output. Only explicitly named credential variables count:
 * `GIT_AUTHOR_EMAIL` is not one.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function envSecrets(env) {
  /** @type {Set<string>} */
  const values = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (!value || key.toUpperCase() === 'PWD') continue;
    if (ENV_SECRET_NAME_RE.test(key)) {
      addSecretValue(values, value, { minLength: 8 });
      if (/HEADERS/i.test(key)) addHeaderSecrets(values, value);
    }
    addUrlSecrets(values, value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Scrub literal secret values and pattern-matched credentials from text.
 *
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function scrubSecrets(text, secrets = []) {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, REDACTED);
  }
  return redactSecrets(out);
}

/**
 * @param {{ command: import('../loop/adapters.js').AgentCommand, agent?: string, mode: string, cwd: string, at: Date, prompt: string, result: import('../loop/adapters.js').AgentResult, secrets?: string[] }} input
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
  secrets = [],
}) {
  const safeCommand = scrubSecrets(
    [command.bin, ...command.args].join(' '),
    secrets
  );
  const safePrompt = scrubSecrets(prompt, secrets);
  const safeAnswer = scrubSecrets(answerOf(result), secrets);
  const safeOutput = scrubSecrets(result.output, secrets);
  const exit = result.signal
    ? `stopped by ${result.signal}`
    : `exit ${result.code}`;
  return [
    `# Agent call — ${agent} (${mode})`,
    '',
    `- When: ${formatLocal(at, { withTime: true })}`,
    `- Command: \`${safeCommand}\` (prompt on stdin)`,
    `- Cwd: ${cwd}`,
    `- Result: ${exit} in ${Math.round(result.durationMs / 1000)}s`,
    '',
    '## Prompt',
    '',
    fence(safePrompt),
    safePrompt,
    fence(safePrompt),
    '',
    '## Answer (stdout)',
    '',
    fence(safeAnswer),
    safeAnswer,
    fence(safeAnswer),
    '',
    '## Full output (stdout + stderr)',
    '',
    fence(safeOutput),
    safeOutput,
    fence(safeOutput),
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
  /** @type {string[]} */
  let secrets = [];
  if (label === 'dscc') {
    const profile = dsccEnv(
      profilePath({ env: d.env, homedir: d.homedir(), platform: d.platform })
    );
    secrets = profileSecrets(profile.set);
    for (const warning of profile.warnings) {
      d.warn(scrubSecrets(`! dscc profile ${warning}`, secrets));
    }
    env = profileEnv(env, profile, d.platform);
    env.KYOTEN_AGENT = 'dscc';
    env[INNER_LOOP_ENV] = 'off';
    env.TASK_AGENT = label;
  }
  secrets = [...new Set([...secrets, ...envSecrets(env)])].sort(
    (a, b) => b.length - a.length
  );
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
  const rawResult = d.runAgent({
    command,
    cwd: d.rootDir,
    prompt,
    timeoutMs: options.timeoutMin * 60 * 1000,
    env,
  });
  const result = {
    ...rawResult,
    stdout: scrubSecrets(rawResult.stdout, secrets),
    output: scrubSecrets(rawResult.output, secrets),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivate(
    file,
    formatRecord({
      command,
      agent: label,
      mode,
      cwd: d.rootDir,
      at,
      prompt,
      result,
      secrets,
    })
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
