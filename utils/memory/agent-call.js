/**
 * One headless agent call for a memory job: extraction, consolidation, and
 * the persona compaction and audit. The agent runs read-only, with its tools
 * isolated in a temporary folder (no
 * project instructions or hooks there), with EXTRACT_ENV set so memory hooks
 * stay silent and the session is never queued, and the inner loop off.
 */
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';
import {
  CODEX_ISOLATION_ARGS,
  buildCommand,
  foreignHarnessForAgy,
} from '../loop/adapters.js';
import { writePrivate } from '../kyoten/dscc.js';
import { prepareAgentExecution, scrubSecrets } from '../loop/dscc.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import { commandFor } from '../tools/registry.js';
import { CALL_AGENTS } from './config.js';
import { EXTRACT_ENV } from './queue.js';

export { CALL_AGENTS };
export const AGENT_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const ERROR_TAIL = 300;
/** The settings file callAgent writes into the job's folder for claude and agy. */
export const SETTINGS_FILE = 'memory-job-settings.json';
const CODEX_EMPTY_MCP_LIST =
  'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.';
/**
 * @typedef {typeof CALL_AGENTS[number]} CallAgent
 * @typedef {import('../loop/adapters.js').AgentCommand & { provider?: 'dscc' }} MemoryCommand
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
 * @returns {MemoryCommand}
 */
export function headlessCommand({ agent, model = null, rootDir }) {
  if (!CALL_AGENTS.includes(/** @type {CallAgent} */ (agent))) {
    throw new Error(
      `Memory jobs run on ${CALL_AGENTS.join(', ')} (got ${agent}).\n${CALL_AGENTS.map((name) => `Fix: use --agent ${name}`).join('\n')}`
    );
  }
  const adapter = agent === 'dscc' ? 'claude' : agent;
  const command = buildCommand({
    agent: adapter,
    argv: commandFor(rootDir, adapter),
    mode: 'oneshot',
    model,
  });
  return agent === 'dscc' ? { ...command, provider: 'dscc' } : command;
}

/**
 * The Fix text for an agent that cannot run a memory job: another agent.
 *
 * @param {string} job
 * @param {string} agent
 * @returns {string}
 */
function switchFix(job, agent) {
  const others = CALL_AGENTS.filter((name) => name !== agent);
  return job.startsWith('persona')
    ? others.map((name) => `Fix: use --agent ${name}`).join('\n')
    : others
        .map((name) => `Fix: pnpm memory set --extract-agent ${name}`)
        .join('\n');
}

/**
 * Claude and Antigravity take `--settings <file-or-json>`: pass the JSON as a
 * file in the job's folder using its relative name, so the command line holds
 * neither a double quote nor temp-path characters (`!`, `%`) that Windows .cmd
 * shims refuse.
 *
 * @param {import('../loop/adapters.js').AgentCommand} command
 * @param {string} cwd
 * @returns {import('../loop/adapters.js').AgentCommand}
 */
function settingsAsFile(command, cwd) {
  const at = command.args.lastIndexOf('--settings');
  if ((command.agent !== 'claude' && command.agent !== 'agy') || at === -1)
    return command;
  if (!command.args[at + 1]?.trimStart().startsWith('{')) return command;
  writePrivate(path.join(cwd, SETTINGS_FILE), command.args[at + 1]);
  const args = [...command.args];
  args[at + 1] = SETTINGS_FILE;
  return { ...command, args };
}

/**
 * One call in an empty folder, removed afterwards. Throws when the agent
 * fails, naming the job ("the extraction agent exited with code 1: …").
 * When `cancel` returns true right before dispatching the prompt (after any
 * pre-flight probe), no prompt is sent and `{ cancelled: true }` is returned.
 *
 * @param {CallDeps} deps
 * @param {MemoryCommand} command
 * @param {string} prompt
 * @param {{ job?: string, timeoutMs?: number, cancel?: () => boolean }} [options]
 * @returns {import('../loop/adapters.js').AgentResult & { cancelled?: boolean }}
 */
export function callAgent(
  deps,
  command,
  prompt,
  { job = 'extraction', timeoutMs = AGENT_CALL_TIMEOUT_MS, cancel } = {}
) {
  if (command.agent === 'agy') {
    const caller = foreignHarnessForAgy(deps.env);
    if (caller) {
      throw new Error(
        `Refusing to run the ${job} job on agy from another agent harness (${caller}): Google Antigravity Terms of Service prohibit invoking agy (headless or agy acp) from third-party agentic CLIs.\n${switchFix(job, 'agy')}`
      );
    }
  }
  const execution = prepareAgentExecution({
    agent: command.provider ?? command.agent,
    command,
    env: deps.env,
  });
  const cwd = fs.mkdtempSync(path.join(deps.tmpdir(), `memory-${job}-`));
  const env = { ...execution.env, [EXTRACT_ENV]: '1', [INNER_LOOP_ENV]: 'off' };
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
          `Cannot verify Codex persona isolation. The MCP check must report zero configured servers.\n${switchFix(job, 'codex')}`
        );
      }
    }
    if (cancel?.()) {
      return {
        code: 0,
        signal: null,
        output: '',
        stdout: '',
        durationMs: 0,
        cancelled: true,
      };
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
      error.message += `\n${switchFix(job, command.provider ?? command.agent)}`;
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
      `the ${job} agent ${how}: ${scrubSecrets(stripVTControlCharacters(result.output), execution.secrets).trim().slice(-ERROR_TAIL)}`
    );
  }
  // Successful structured answers still go through their original validators.
  // Reject an echoed literal credential even when its format is unknown.
  const answer = result.stdout.trim() ? result.stdout : result.output;
  if (execution.secrets.some((secret) => answer.includes(secret))) {
    throw new Error(
      `the ${job} agent returned a credential; its answer was discarded`
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
