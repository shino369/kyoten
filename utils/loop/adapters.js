/**
 * Headless harness adapters for `pnpm loop`. Each adapter is a fixed argument
 * array; the prompt always goes on stdin and nothing runs through a shell, so
 * task text can never become a command.
 *
 * The `write` mode (the default, used by `pnpm loop`) configures agents
 * for work in a worktree:
 * - claude: `acceptEdits` auto-approves file edits; Bash still follows the
 *   project allow/deny lists (anything else is denied in -p mode).
 * - codex: the `workspace-write` sandbox.
 * - dsh: the `workspace-write` preset with `--approval-policy never`
 *   (headless has no approval channel; calls that need one are rejected).
 * - agy: `stream-json` I/O with `--mode accept-edits` and `--settings`
 *   containing worktree command grants and deny rules.
 * `read` (the default for `pnpm agent ask`) selects claude `plan` mode,
 * codex `read-only` sandbox, dsh `read-only` preset, or agy `--settings`
 * with `write_file(*)` and protected-path deny rules and inspection grants.
 * `oneshot` disables tools for self-contained prompts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { writePrivate } from '../kyoten/dscc.js';
import { EXTRACT_ENV } from '../memory/extract-env.js';
import { crossSpawn } from '../spawn.js';
import { HARNESS_SESSION_VARS } from '../task/store.js';

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh', 'agy']);
/** Set on child processes/workers so they know which harness spawned them. */
export const CALLER_HARNESS_ENV = 'KYOTEN_CALLER_HARNESS';

/**
 * The foreign (non-Antigravity) agentic CLI running the caller, or null when
 * invoked from Antigravity itself or from a plain terminal.
 *
 * Intentionally checks foreign markers even when `ANTIGRAVITY_CONVERSATION_ID`
 * is also set, so another harness cannot bypass the guard by setting it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function foreignHarnessForAgy(env = {}) {
  const caller = env[CALLER_HARNESS_ENV]?.trim();
  if (caller && caller !== 'agy') return caller;
  const kyotenAgent = env.KYOTEN_AGENT?.trim();
  if (kyotenAgent && kyotenAgent !== 'agy') return kyotenAgent;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.DSH_SESSION_ID) return 'dsh';
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE === '1') return 'claude';
  if (env.OPENCODE === '1') return 'opencode';
  return null;
}

/** Windows shim extensions that resolve to the same executable. */
const AGY_EXE_EXT = /\.(?:exe|cmd|bat|ps1)$/i;

/**
 * Whether a `--bin` value or executable path names the Antigravity CLI,
 * however the caller spells it (`agy`, `AGY`, `agy.cmd`, `C:\tools\agy.exe`,
 * `agy acp`). A wrapper (`npx agy`) is not detectable from the name alone.
 *
 * @param {string} [bin]
 * @returns {boolean}
 */
export function isAgyBinary(bin) {
  const text = String(bin ?? '').trim();
  if (!text) return false;
  // The CLI splits --bin on whitespace (no shell), while a registry argv entry
  // stays whole, so check both the full value and its first word.
  return [text, text.split(/\s+/)[0]].some((value) => {
    const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
    return base.replace(AGY_EXE_EXT, '').toLowerCase() === 'agy';
  });
}

/**
 * Refuse invoking `agy` (headless or `agy acp`) from another agentic CLI.
 * Google Antigravity Terms of Service prohibit accessing Antigravity from
 * third-party agent harnesses (`agy -> others` is allowed; `others -> agy` is
 * blocked). `bin` catches a `--bin` override that names the agy executable
 * while the declared agent is another harness.
 *
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [via]
 * @param {string} [bin]
 */
export function assertAgyAllowed(agent, env = {}, via = 'headless agy', bin) {
  if (agent !== 'agy' && !isAgyBinary(bin)) return;
  const caller = foreignHarnessForAgy(env);
  if (!caller) return;
  const what = agent === 'agy' ? via : `agy via --bin ${bin}`;
  throw new Error(
    `Refusing to run ${what} from another agent harness (${caller}): Google Antigravity Terms of Service prohibit invoking agy (headless or agy acp) from third-party agentic CLIs.\nFix: use --agent claude|codex|dsh, or run agy directly from your own terminal`
  );
}
/** Argument characters that cannot chain, redirect, or run subshells/PowerShell `(expr)`. */
const AGY_SAFE_ARGS = '[^;&|<>`$()\\r\\n]*';
/**
 * Safe tokens for commands whose quoted arguments legitimately contain `(...)`
 * (e.g. `git commit -m "feat(agy): ..."` or `pnpm task ... -m "..."`):
 * forbids `\`, `$`, `` ` `` inside quotes and `(` / `)` outside quotes.
 */
const AGY_QUOTED_SAFE =
  '("[^;&|<>`$\\\\\\r\\n"]*"|\'[^;&|<>`$\\r\\n\']*\'|[^;&|<>`$()\\r\\n\\s"\']+)';
/** PNPM options that can consume a separate value before a script name. */
const AGY_PNPM_VALUE_FLAGS =
  '(-F|--(store-dir|state-dir|npmrc-auth-file|userconfig|workspace-packages|registry|' +
  'https?-proxy|no-proxy|reporter|loglevel|filter(-prod)?|test-pattern|' +
  'changed-files-ignore-pattern|workspace-concurrency))';
const AGY_PNPM_SWITCHES =
  '(-[hrswy]+|--(aggregate-output|color|dry-run|help|if-present|ignore-workspace|' +
  'json|no-color|no-progress|parallel|recursive|reverse|sequential|silent|' +
  'stream|use-stderr|workspace-root|yes|(no-)?(fail-if-no-match|include-workspace-root|sort)))';
const AGY_PNPM_OPTION_VALUE = `("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"']+)`;
const AGY_PNPM_OPTIONS = `((--|${AGY_PNPM_SWITCHES}|--[\\w.-]+=${AGY_PNPM_OPTION_VALUE}|${AGY_PNPM_VALUE_FLAGS}\\s+${AGY_PNPM_OPTION_VALUE})\\s+)*`;
/** Relative JS path inside repo dirs with no `..` traversal or shell meta. */
const AGY_SCRIPT_PATH =
  '[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*(\\.[A-Za-z0-9_-]+)*\\.m?js';
/** Relative path that cannot start with `-`, `/`, `~`, drive, or contain `..`. */
const AGY_REL_PATH =
  '\\.?[A-Za-z0-9_][A-Za-z0-9_-]*(/\\.?[A-Za-z0-9_][A-Za-z0-9_-]*)*(\\.[A-Za-z0-9_-]+)*';
/**
 * Antigravity `read_file(...)` matches exact paths and directory prefixes (not
 * globs); denying `read_file` also blocks `write_file` on those paths.
 */
const AGY_SECRET_DENY = [
  'read_file(.env)',
  'read_file(.env.local)',
  'read_file(.env.development)',
  'read_file(.env.production)',
  'read_file(.env.test)',
  'read_file(.env.staging)',
  'read_file(secrets/)',
  'read_file(credentials.json)',
  'read_file(~/.ssh)',
  'read_file(~/.aws)',
];
/** Antigravity headless write-mode settings and command grants. */
export const AGY_WRITE_SETTINGS = JSON.stringify({
  permissions: {
    allow: [
      `command(regex:^pnpm (check|test|test:coverage|test:e2e|lint|lint:fix|typecheck|format|format:check|docs:cli|skills:check|skills:link|harness|workspace:check|tools|install|add|remove)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^pnpm task( ${AGY_QUOTED_SAFE})*$)`,
      `command(regex:^git (status|diff|log|show|branch|rev-parse|add|switch|checkout)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^git commit( ${AGY_QUOTED_SAFE})*$)`,
      `command(regex:^node (utils|\\.claude/hooks|\\.agents/skills)/${AGY_SCRIPT_PATH}( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^(ls|dir|cd|echo)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^mkdir( -p)?( ${AGY_REL_PATH})+$)`,
      'command(pwd)',
    ],
    deny: [
      ...AGY_SECRET_DENY,
      'write_file(.git/)',
      `command(regex:^pnpm\\s+${AGY_PNPM_OPTIONS}(run(?:-script)?\\s+${AGY_PNPM_OPTIONS})?["']?(workspace:setup|memory)["']?(\\s+.*)?$)`,
      'command(regex:^node utils/(?i:workspace-setup|memory/cli)\\.js( |$))',
      'command(regex:^pnpm\\b.*(\\s-[a-zA-Z]*[gC]|--global\\b|--dir\\b|--workspace-root\\b).*)',
      'command(regex:^git branch\\b.*(\\s-[a-zA-Z]*[dD]|--delete).*)',
      'command(regex:^git commit\\b.*(--no-verify|\\s-[a-zA-Z]*n[a-zA-Z]*\\b).*)',
      'command(regex:^git add\\b.*(\\s-[a-zA-Z]*f[a-zA-Z]*\\b|--force).*)',
      'command(regex:^git .*(--output|--ext-diff|--textconv|--no-index).*)',
    ],
  },
});
/** Antigravity headless read-mode settings. Checkout scripts run in write mode. */
export const AGY_READ_SETTINGS = JSON.stringify({
  permissions: {
    allow: [
      `command(regex:^git (status|diff|log|show|rev-parse)( ${AGY_SAFE_ARGS})?$)`,
      'command(regex:^git branch( (--show-current|--list|-a|-r|-v|--all|--remotes))?$)',
      `command(regex:^(ls|dir)( ${AGY_SAFE_ARGS})?$)`,
      'command(pwd)',
      'command(regex:^node (-v|--version)$)',
    ],
    deny: [
      'write_file(*)',
      ...AGY_SECRET_DENY,
      'command(regex:.*(--output|--fix|--write|--update|--no-index|--ext-diff|--textconv|\\s-[oO]|\\s-[wWu]\\b).*)',
    ],
  },
});
/** The DSH overlay that enables the workspace's hooks (utils/harness/cli.js). */
export const DSH_PATCH = '.dsh/workspace.patch.yml';
/**
 * How to install DSH's Claude hooks bridge into a profile: with the two
 * peers it imports and the profile lacks, at the version `dsh --version`
 * prints (`latest` lags behind the runtime).
 */
export const DSH_BRIDGE_INSTALL =
  'dsh plugin --profile <profile> add @deepseek-ai/dsh-hooks-claude-code@<version> @deepseek-ai/dsh-hook-protocol@<version> @deepseek-ai/dsh-llm@<version>';

/**
 * Why DSH cannot run the workspace's hooks from `dir`, or null. The bridge
 * writes the launch dir into `node "<dir>/<script>"` (utils/harness/hooks.js),
 * where bash and pwsh read `$` and a backtick, `"` ends the path, and bash
 * also reads `\`. The hook would not run (DSH hooks fail open, so the guard
 * would be off) or would run part of the path.
 *
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string | null}
 */
export function dshDirProblem(dir, platform = process.platform) {
  const unsafe = platform === 'win32' ? /[$`"\n]/ : /[$`"\\\n]/;
  if (!unsafe.test(dir)) return null;
  return `DSH cannot run this workspace's hooks from ${dir}: the hook commands carry the path, and the shell reads its ${platform === 'win32' ? '$, `, or "' : '$, `, ", or \\'} as syntax, so the guard would not run.\nFix: move the checkout to a path without them`;
}

/** @typedef {typeof AGENTS[number]} AgentName */

export const MODES = /** @type {const} */ (['write', 'read', 'oneshot']);
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** @typedef {typeof MODES[number]} Mode */

export const AGY_ISOLATION_SETTINGS = JSON.stringify({
  toolPermission: 'strict',
  permissions: {
    deny: [
      'command(*)',
      'write_file(*)',
      'edit_file(*)',
      'read_file(*)',
      'view_file(*)',
      'read_url(*)',
      'execute_url(*)',
      'search_web(*)',
      'invoke_subagent(*)',
      'mcp(*)',
    ],
  },
});
export const DSH_ONESHOT_PATCH = fileURLToPath(
  new URL('../memory/dsh-persona.patch.yml', import.meta.url)
);
const CODEX_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'hooks',
  'in_app_browser',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'view_image',
];
// No double quote in any argument: Windows .cmd shims cannot pass one (spawn.js
// quoteCmdArg). Codex parses a -c value as TOML and keeps it as a raw string
// when that fails, so bare words work, and TOML literal strings use single
// quotes. Checked against codex 0.170: a wrong value still fails to load.
export const CODEX_ISOLATION_ARGS = [
  '-c',
  'default_permissions=memory-persona',
  '-c',
  "permissions.memory-persona.filesystem={':root'='deny'}",
  '-c',
  'web_search=disabled',
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
];
export const CLAUDE_ISOLATION_SETTINGS = JSON.stringify({
  disableAllHooks: true,
});

/** @type {Record<AgentName, { bin: string, args: Record<Mode, string[]>, install: string }>} */
const ADAPTERS = {
  claude: {
    bin: 'claude',
    args: {
      write: [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
      read: [
        '-p',
        '--permission-mode',
        'plan',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
      oneshot: [
        '-p',
        '--permission-mode',
        'plan',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--settings',
        CLAUDE_ISOLATION_SETTINGS,
        '--tools',
        '',
      ],
    },
    install: 'https://code.claude.com/docs (then: claude --version)',
  },
  codex: {
    bin: 'codex',
    args: {
      write: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
      read: ['exec', '--sandbox', 'read-only', '--ephemeral', '-'],
      oneshot: [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        ...CODEX_ISOLATION_ARGS,
        '-',
      ],
    },
    install: 'install the Codex CLI (see its docs), or pass --bin <path>',
  },
  dsh: {
    bin: 'dsh',
    args: {
      write: [
        '--profile',
        'headless',
        // The workspace's hooks through the Claude hooks bridge (pnpm harness
        // sync writes it; relative to the cwd, as DSH resolves it). DSH stops
        // reading launcher options at the app's first flag, so --patch must
        // stay before --permission-mode or the app rejects it.
        '--patch',
        DSH_PATCH,
        '--permission-mode',
        'workspace-write',
        '--approval-policy',
        'never',
        '-',
      ],
      read: [
        '--profile',
        'headless',
        // See write: a launcher option after the app flags is an app error.
        '--patch',
        DSH_PATCH,
        '--permission-mode',
        'read-only',
        '--approval-policy',
        'never',
        '-',
      ],
      oneshot: [
        '--profile',
        'headless',
        '--patch',
        DSH_ONESHOT_PATCH,
        '--permission-mode',
        'read-only',
        '--approval-policy',
        'never',
        '-',
      ],
    },
    install: 'pass --bin "npx -y @deepseek-ai/dsh" (Node ^22.19 or >=24)',
  },
  agy: {
    bin: 'agy',
    args: {
      write: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--mode',
        'accept-edits',
        '--settings',
        AGY_WRITE_SETTINGS,
      ],
      read: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--settings',
        AGY_READ_SETTINGS,
      ],
      oneshot: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--settings',
        AGY_ISOLATION_SETTINGS,
      ],
    },
    install:
      'https://antigravity.google/docs/cli/reference (then: agy --version)',
  },
};

/**
 * @typedef {{ agent: AgentName, bin: string, args: string[] }} AgentCommand
 */

/**
 * Build the command for one harness.
 *
 * Executable precedence: `bin` (the `--bin` flag, split on whitespace with no
 * shell, so `npx -y @deepseek-ai/dsh` works) > `argv` (an argv prefix from the
 * tool registry, kept as-is so paths with spaces survive) > the default.
 *
 * @param {{ agent: string, bin?: string, argv?: string[] | null, mode?: string, model?: string | null, effort?: string | null, maxBudgetUsd?: number }} options
 * @returns {AgentCommand}
 */
export function buildCommand({
  agent,
  bin,
  argv,
  mode = 'write',
  model,
  effort,
  maxBudgetUsd,
}) {
  if (!AGENTS.includes(/** @type {AgentName} */ (agent))) {
    throw new Error(
      `Unknown agent "${agent}".\nFix: use --agent ${AGENTS.join('|')}`
    );
  }
  if (!MODES.includes(/** @type {Mode} */ (mode))) {
    throw new Error(
      `Unknown mode "${mode}".\nFix: use mode ${MODES.join(' or ')}`
    );
  }
  const name = /** @type {AgentName} */ (agent);
  const adapter = ADAPTERS[name];
  const [exe, ...prefix] = bin?.trim()
    ? bin.trim().split(/\s+/)
    : argv && argv.length > 0
      ? argv
      : [adapter.bin];
  const args = [...prefix, ...adapter.args[/** @type {Mode} */ (mode)]];
  if (maxBudgetUsd !== undefined) {
    if (name !== 'claude') {
      throw new Error(
        `--max-budget-usd is only supported by --agent claude.\nFix: drop --max-budget-usd for ${name}`
      );
    }
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  const selection = [];
  if (model) {
    if (name === 'dsh') {
      throw new Error(
        'DSH selects its model in its profile.\nFix: drop the model flag or select another agent'
      );
    }
    selection.push('--model', model);
  }
  if (effort !== null && effort !== undefined) {
    if (!EFFORTS.includes(effort)) {
      throw new Error(
        `Unknown effort "${effort}".\nFix: use ${EFFORTS.join('|')}`
      );
    }
    if (name === 'codex')
      selection.push('-c', `model_reasoning_effort=${effort}`);
    else if (name === 'agy') selection.push('--effort', effort);
    else
      throw new Error(
        '--effort is only supported by Codex and Antigravity.\nFix: drop the effort flag or select another agent'
      );
  }
  args.splice(
    args.at(-1) === '-' ? args.length - 1 : args.length,
    0,
    ...selection
  );
  return { agent: name, bin: exe, args };
}

/**
 * Install hint for a harness whose executable was not found.
 *
 * @param {AgentName} agent
 * @returns {string}
 */
export function installHint(agent) {
  return ADAPTERS[agent].install;
}

/**
 * @typedef {(bin: string, args: string[], options: object) => { status: number | null, signal?: string | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error & { code?: string } }} AgentSpawn
 * @typedef {{ toolCallsCount: number, inputTokens: number, cachedTokens: number, outputTokens: number, thinkingTokens: number, totalTokens: number, numTurns: number | null, durationSeconds: number | null, cacheHitRate: number | null }} AgentUsage
 * @typedef {{ code: number | null, signal: string | null, output: string, stdout: string, durationMs: number, usage?: AgentUsage }} AgentResult
 *   `output` is everything (stdout, stderr, spawn errors, a timeout note);
 *   `stdout` alone is the final answer for harnesses that log progress to
 *   stderr (codex exec, dsh headless).
 */

/**
 * Parse Antigravity's `--output-format stream-json` NDJSON output: extract the
 * final `result` event's `response` as `stdout`, and flag a non-SUCCESS status
 * or an empty response caused by auto-denied headless tool actions.
 *
 * @param {string} raw
 * @returns {{ stdout: string, failed: boolean, usage?: AgentUsage }}
 */
export function parseAgyStreamJson(raw) {
  const tools = new Set();
  let result;
  for (const entry of raw.split(/\r?\n/)) {
    const line = entry.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed?.event === 'result' &&
      parsed.result &&
      typeof parsed.result === 'object'
    )
      result = parsed.result;
    if (
      parsed?.event === 'step_update' &&
      parsed.step_update?.step_type === 'tool'
    ) {
      const index = parsed.step_index ?? parsed.step_update.step_index;
      if (Number.isInteger(index)) tools.add(index);
    }
  }
  const response = typeof result?.response === 'string' ? result.response : '';
  const denied =
    Array.isArray(result?.denied_actions) && result.denied_actions.length > 0;
  const answer = result
    ? {
        stdout: response,
        failed: result.status !== 'SUCCESS' || (!response && denied),
      }
    : { stdout: raw, failed: false };
  const counts = result?.usage;
  if ((!counts || typeof counts !== 'object') && !tools.size) return answer;
  const number = (/** @type {unknown} */ value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const inputTokens = number(counts?.input_tokens) ?? 0;
  const cachedTokens = number(counts?.cache_read_tokens) ?? 0;
  const promptTotal = inputTokens + cachedTokens;
  return {
    ...answer,
    usage: {
      inputTokens,
      cachedTokens,
      outputTokens: number(counts?.output_tokens) ?? 0,
      thinkingTokens: number(counts?.thinking_tokens) ?? 0,
      totalTokens: number(counts?.total_tokens) ?? 0,
      numTurns: number(result?.num_turns),
      durationSeconds: number(result?.duration_seconds),
      cacheHitRate: promptTotal > 0 ? cachedTokens / promptTotal : null,
      toolCallsCount: tools.size,
    },
  };
}

/**
 * Pass file paths to Windows shims and leave pre-staged settings alone.
 * @param {AgentCommand} command
 * @param {(args: string[]) => ReturnType<AgentSpawn>} spawn
 */
function spawnWithSettings(command, spawn) {
  const at = command.args.lastIndexOf('--settings');
  const settings = at < 0 ? undefined : command.args[at + 1];
  if (
    (command.agent !== 'claude' && command.agent !== 'agy') ||
    !settings?.trimStart().startsWith('{')
  )
    return spawn(command.args);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-agent-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    writePrivate(file, settings);
    const args = [...command.args];
    args[at + 1] = file;
    return spawn(args);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run one headless agent turn with the prompt on stdin. The child gets the
 * caller's env without the harness session ids: a child that inherited them
 * would act as the caller's session in `pnpm task` (`TASK_SESSION`, set on
 * purpose, is kept). It also gets EXTRACT_ENV, so the workspace's memory
 * hooks stay silent in it: nothing is injected from memory and the session
 * is never queued for extraction into it. (A Claude or DSH child in the
 * workspace root still loads AGENTS.local.md natively; loop and swarm
 * worktrees do not have it.)
 *
 * @param {{ command: AgentCommand, cwd: string, prompt: string, timeoutMs: number, env: NodeJS.ProcessEnv, spawn?: AgentSpawn, now?: () => number, platform?: string }} options
 *   DSH refuses a cwd its hook commands cannot carry (dshDirProblem)
 * @returns {AgentResult}
 */
export function runAgent({
  command,
  cwd,
  prompt,
  timeoutMs,
  env,
  // Resolves Windows .cmd shims (e.g. a pnpm-installed codex.cmd) safely.
  spawn = /** @type {AgentSpawn} */ (crossSpawn()),
  now = Date.now,
  platform = process.platform,
}) {
  assertAgyAllowed(command.agent, env, 'headless agy', command.bin);
  if (command.agent === 'dsh') {
    const problem = dshDirProblem(cwd, platform);
    if (problem) throw new Error(problem);
  }
  const input =
    command.agent === 'agy'
      ? `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
      : prompt;
  const started = now();
  const keepKyotenAgent =
    (command.agent === 'agy' && env.KYOTEN_AGENT === 'agy') ||
    (command.agent === 'claude' && env.KYOTEN_AGENT === 'dscc');
  const childEnv = {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !HARNESS_SESSION_VARS.includes(key) &&
          key !== 'CLAUDECODE' &&
          key !== CALLER_HARNESS_ENV &&
          (keepKyotenAgent || key !== 'KYOTEN_AGENT')
      )
    ),
    [EXTRACT_ENV]: '1',
    ...(command.agent !== 'agy' ? { [CALLER_HARNESS_ENV]: command.agent } : {}),
  };
  const result = spawnWithSettings(command, (args) =>
    spawn(command.bin, args, {
      cwd,
      input,
      encoding: 'utf-8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: 64 * 1024 * 1024,
      // A detached caller (the memory worker, queue.js) has no console, so
      // Windows would give every headless child a new, visible console window.
      windowsHide: true,
      env: childEnv,
    })
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command.bin} was not found (agent ${command.agent}).\nFix: ${installHint(command.agent)}`
    );
  }
  const rawStdout = String(result.stdout ?? '');
  const parsed = command.agent === 'agy' ? parseAgyStreamJson(rawStdout) : null;
  const code = parsed?.failed && result.status === 0 ? 1 : result.status;
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .map(String)
    .join('\n');
  return {
    code,
    signal: result.signal ?? null,
    output: result.signal
      ? `${output}\n(stopped by ${result.signal}; timeout ${Math.round(timeoutMs / 1000)}s)`
      : output,
    stdout: parsed ? parsed.stdout : rawStdout,
    durationMs: now() - started,
    ...(parsed?.usage ? { usage: parsed.usage } : {}),
  };
}
