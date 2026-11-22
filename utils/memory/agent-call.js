/**
 * One headless agent call for a memory job: extraction, consolidation, and
 * the persona compaction and audit. The agent runs read-only, with its tools
 * isolated in a temporary folder (no
 * project instructions or hooks there), with EXTRACT_ENV set so memory hooks
 * stay silent and the session is never queued, and the inner loop off.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripVTControlCharacters } from 'util';
import { DSH_PATCH, buildCommand } from '../loop/adapters.js';
import { redactSecrets } from '../redact.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import { commandFor } from '../tools/registry.js';
import { EXTRACT_ENV } from './queue.js';

export const AGENT_CALL_TIMEOUT_MS = 5 * 60 * 1000;
/** The agents a memory job can call. */
export const CALL_AGENTS = /** @type {const} */ ([
  'claude',
  'codex',
  'dsh',
  'agy',
]);
const ERROR_TAIL = 300;
const AGY_ISOLATION_SETTINGS = JSON.stringify({
  toolPermission: 'strict',
  permissions: {
    deny: [
      'command(*)',
      'write_file(*)',
      'read_file(*)',
      'read_url(*)',
      'execute_url(*)',
      'mcp(*)',
    ],
  },
});
const DSH_PERSONA_PATCH = fileURLToPath(
  new URL('./dsh-persona.patch.yml', import.meta.url)
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
const CODEX_ISOLATION_ARGS = [
  '-c',
  'default_permissions=memory-persona',
  '-c',
  "permissions.memory-persona.filesystem={':root'='deny'}",
  '-c',
  'web_search=disabled',
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
];
const CLAUDE_ISOLATION_SETTINGS = JSON.stringify({ disableAllHooks: true });
/** The settings file callAgent writes into the job's folder for claude. */
export const CLAUDE_SETTINGS_FILE = 'memory-job-settings.json';
const CODEX_EMPTY_MCP_LIST =
  'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.';
/**
 * @typedef {typeof CALL_AGENTS[number]} CallAgent
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   runAgent: typeof import('../loop/adapters.js').runAgent,
 *   tmpdir: () => string,
 * }} CallDeps
 */

/**
 * The headless command for a memory job: read-only, no tools, and the model
 * when one is given.
 *
 * @param {{ agent: string, model?: string | null, rootDir: string }} input
 * @returns {import('../loop/adapters.js').AgentCommand}
 */
export function headlessCommand({ agent, model = null, rootDir }) {
  if (!CALL_AGENTS.includes(/** @type {CallAgent} */ (agent))) {
    throw new Error(
      `Memory jobs run on ${CALL_AGENTS.join(', ')} (got ${agent}).\nFix: use --agent ${CALL_AGENTS.join('|')}`
    );
  }
  const command = buildCommand({
    agent,
    argv: commandFor(rootDir, agent),
    mode: 'read',
  });
  // Codex starts outside a checkout. DSH needs its overlay before app flags.
  const args = [...command.args];
  switch (command.agent) {
    case 'claude':
      args.push(
        '--strict-mcp-config',
        '--settings',
        CLAUDE_ISOLATION_SETTINGS,
        '--tools',
        ''
      );
      break;
    case 'codex':
      // A legacy --sandbox flag would override the named permissions.
      args.splice(args.lastIndexOf('exec') + 1, 2);
      args.splice(
        -1,
        0,
        '--skip-git-repo-check',
        '--ignore-user-config',
        ...CODEX_ISOLATION_ARGS
      );
      break;
    case 'dsh':
      args.splice(args.lastIndexOf(DSH_PATCH) - 1, 2);
      args.splice(
        args.lastIndexOf('--permission-mode'),
        0,
        '--patch',
        DSH_PERSONA_PATCH
      );
      break;
    case 'agy':
      args.splice(
        args.lastIndexOf('--settings'),
        2,
        '--settings',
        AGY_ISOLATION_SETTINGS
      );
      break;
  }
  return {
    ...command,
    args: [...args, ...(model ? ['--model', model] : [])],
  };
}

/**
 * The Fix text for an agent that cannot run a memory job: another agent.
 *
 * @param {string} job
 * @param {string} agent
 * @returns {string}
 */
function switchFix(job, agent) {
  const others = CALL_AGENTS.filter((name) => name !== agent).join('|');
  return job.startsWith('persona')
    ? `use --agent ${others}`
    : `pnpm memory set --extract-agent ${others}`;
}

/**
 * Claude takes `--settings <file-or-json>`: pass the JSON as a file in the
 * job's folder, so the command line holds no double quote (Windows .cmd
 * shims refuse one).
 *
 * @param {import('../loop/adapters.js').AgentCommand} command
 * @param {string} cwd
 * @returns {import('../loop/adapters.js').AgentCommand}
 */
function settingsAsFile(command, cwd) {
  const at = command.args.indexOf('--settings');
  if (command.agent !== 'claude' || at === -1) return command;
  const file = path.join(cwd, CLAUDE_SETTINGS_FILE);
  fs.writeFileSync(file, command.args[at + 1]);
  const args = [...command.args];
  args[at + 1] = file;
  return { ...command, args };
}

/**
 * One call in an empty folder, removed afterwards. Throws when the agent
 * fails, naming the job ("the extraction agent exited with code 1: …").
 *
 * @param {CallDeps} deps
 * @param {import('../loop/adapters.js').AgentCommand} command
 * @param {string} prompt
 * @param {{ job?: string, timeoutMs?: number }} [options]
 */
export function callAgent(
  deps,
  command,
  prompt,
  { job = 'extraction', timeoutMs = AGENT_CALL_TIMEOUT_MS } = {}
) {
  const cwd = fs.mkdtempSync(path.join(deps.tmpdir(), `memory-${job}-`));
  const env = { ...deps.env, [EXTRACT_ENV]: '1', [INNER_LOOP_ENV]: 'off' };
  let result;
  try {
    if (command.agent === 'codex') {
      // An empty CLI MCP table merges with configuration rather than clearing
      // it. Probe the configured servers with an empty stdin before the job.
      const prefix = command.args.slice(0, command.args.lastIndexOf('exec'));
      const probe = deps.runAgent({
        command: {
          ...command,
          args: [...prefix, ...CODEX_ISOLATION_ARGS, 'mcp', 'list'],
        },
        cwd,
        env,
        prompt: '',
        timeoutMs,
      });
      if (probe.code !== 0 || probe.stdout.trim() !== CODEX_EMPTY_MCP_LIST) {
        throw new Error(
          `Cannot verify Codex persona isolation. The MCP check must report zero configured servers.\nFix: ${switchFix(job, 'codex')}`
        );
      }
    }
    result = deps.runAgent({
      command: settingsAsFile(command, cwd),
      cwd,
      prompt,
      timeoutMs,
      env,
    });
  } catch (error) {
    // The adapter's "was not found" error has its own install Fix line.
    if (
      error instanceof Error &&
      /was not found \(agent /.test(error.message)
    ) {
      error.message += `\nFix: ${switchFix(job, command.agent)}`;
    }
    // agy takes its isolation settings as JSON, which a .cmd shim cannot carry.
    if (
      error instanceof Error &&
      command.agent === 'agy' &&
      /cannot be passed safely to a Windows/.test(error.message)
    ) {
      error.message += `\nFix: ${switchFix(job, 'agy')} (agy runs only through a native agy.exe, not a .cmd shim)`;
    }
    throw error;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (result.code !== 0) {
    const how = result.signal
      ? `was stopped by ${result.signal}`
      : `exited with code ${result.code}`;
    throw new Error(
      `the ${job} agent ${how}: ${redactSecrets(stripVTControlCharacters(result.output)).trim().slice(-ERROR_TAIL)}`
    );
  }
  return result;
}

/**
 * The first JSON object in an agent's answer (models often wrap it in
 * prose or a code fence), or null.
 *
 * @param {string} answer
 * @returns {Record<string, unknown> | null}
 */
export function jsonObjectOf(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
}
