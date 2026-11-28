#!/usr/bin/env node
/**
 * Memory hook: one script for Claude Code (`.claude/settings.json`) and
 * Codex (`.codex/hooks.json`), run as `node utils/memory/hook.js --harness
 * claude|codex` (design §7, §8). It reads the hook's JSON on stdin and may
 * print `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`:
 *
 * - SessionStart: Codex gets the core block (it does not load
 *   AGENTS.local.md natively); Claude Code only when CLAUDE.local.md is
 *   missing. Both hear when saving is off. /clear and compaction forget what
 *   this session was shown.
 * - UserPromptSubmit: a one-line persona reminder when personalization is
 *   set (the core block loads once; this keeps it near each turn), then the
 *   notes recalled for the prompt and the task's goal (not for slash
 *   commands or background-task notifications).
 * - PreToolUse: notes whose triggers are in the command (no scoring).
 * - PostToolUseFailure (Claude) or PostToolUse with a non-zero exit (Codex):
 *   notes recalled for the command and its error output.
 * - Extraction (path B, harnesses with a transcript adapter: Claude Code
 *   and Codex; DSH has no SessionEnd and gives hooks no transcript):
 *   SessionStart records the session as open, queues sessions that ended
 *   without a SessionEnd, and starts the worker (also when consolidation is
 *   due); SessionEnd queues the
 *   session and starts the worker (detached, so nothing waits). SessionStart
 *   also announces what extraction saved since the last session.
 *
 * Silence is the default: nothing is printed when nothing matches, before
 * memory is set up, for the reviewer and verifier roles (clean-context
 * reviews), for the extraction agent (EXTRACT_ENV), or on any error (fail
 * open). A note is injected once per session. Reads only the caches on the
 * warm path, so it stays fast.
 */
import fs from 'fs';
import path from 'path';
import {
  HARNESSES,
  agyInjectOutput,
  normalizeHookInput,
} from '../harness/input.js';
import { CALLER_HARNESS_ENV, foreignHarnessForAgy } from '../loop/adapters.js';
import { runIfMain } from '../module-runner.js';
import {
  SESSION_ID_RE,
  readIfExists,
  withLock,
  writeFileAtomic,
} from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { CALL_AGENTS } from './agent-call.js';
import { memoryPolicyKey, readConfig, savingOff } from './config.js';
import {
  consolidationAgent,
  consolidationDue,
  consolidationPolicyKey,
} from './consolidate.js';
import { taskContext } from './context.js';
import { announcement, deferredRun } from './extract.js';
import { quietRun } from './extract-env.js';
import {
  catchUp,
  enqueue,
  kickWorker,
  readQueue,
  registerOpen,
  workerRunning,
} from './queue.js';
import {
  RECALL_LIMIT,
  formatRecall,
  loadIndex,
  matchTriggers,
  recall,
} from './recall.js';
import {
  AGENTS_LOCAL_FILE,
  CLAUDE_LOCAL_FILE,
  CORE_END,
  CORE_START,
  renderStored,
} from './render.js';
import {
  AGENT_ENV,
  agentPersonalization,
  personaKeyFor,
  readPersonalization,
  renderPersonalization,
} from './personalize.js';
import { mainCheckout } from './repo.js';
import {
  CACHE_DIR,
  loadNotes,
  memoryDir,
  readJsonOrNull,
  readUsage,
  recordHits,
} from './store.js';
import { recentAgyFailures } from './transcript.js';

export const SESSIONS_DIR = 'sessions';
/** Session records older than this are pruned at SessionStart. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Characters of a failed command's output used in the query. */
export const ERROR_CHARS = 600;
const EXIT_CODE_RE = /\bexit code:?\s*(-?\d+)/i;
const NOTE_ID_RE = /^- ([mt][1-9]\d*) \(/;
const BLOCKING_HARNESSES = new Set(['claude', 'codex']);
/** Repeated at every typed prompt, so progress notes keep the persona. */
export const PERSONA_REMINDER =
  '[Persona] Every message to the user, progress notes between tool calls included, follows the Personalization section.';
const PERSONALIZATION_OFF =
  '[Persona] Workspace memory personalization is off. Disregard the memory-generated Personalization section and its persona reminders.';
const PERSONALIZATION_EMPTY =
  '[Persona] No workspace memory personalization settings are saved. Use the session’s usual response style.';
/** Per-agent persona (kyoten): names the agent in the per-prompt line. */
const agentReminder = (/** @type {string} */ agent) =>
  `[Persona] Every message to the user, progress notes between tool calls included, follows this session's ${agent} persona from the session start context.`;
const agentOverride = (/** @type {string} */ agent) =>
  `[Persona] This ${agent} session has its own persona: apply the personalization below instead of the Personalization section.`;
/** The harness each KYOTEN_AGENT value runs in. */
const AGENT_HARNESS = /** @type {Record<string, Harness>} */ ({
  claude: 'claude',
  dscc: 'claude',
  codex: 'codex',
  dsh: 'dsh',
  agy: 'agy',
});

/**
 * The agent whose persona file this session uses: KYOTEN_AGENT when it names
 * an agent of this harness, else the harness itself. Codex hooks run in the
 * shared app-server daemon's environment, so KYOTEN_AGENT can be missing, and
 * a child agent can inherit its parent's value.
 *
 * @param {string | undefined} agent the KYOTEN_AGENT value
 * @param {Harness} harness
 * @returns {string}
 */
export function sessionAgent(agent, harness) {
  const name = agent?.trim();
  return name &&
    Object.hasOwn(AGENT_HARNESS, name) &&
    AGENT_HARNESS[name] === harness
    ? name
    : harness;
}
/** Characters of the language setting quoted in the reminder. */
export const REMINDER_LANGUAGE_CHARS = 200;

/**
 * @typedef {import('../harness/input.js').Harness} Harness
 * @typedef {Record<string, any>} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: string, additionalContext?: string, permissionDecision?: 'deny', permissionDecisionReason?: string }, systemMessage?: string }} StandardHookOutput
 * @typedef {StandardHookOutput | import('../harness/input.js').AgyInjectOutput} HookOutput
 * @typedef {{ harness?: Harness, rootDir?: string, now?: Date, env?: NodeJS.ProcessEnv, kick?: typeof kickWorker }} HookOptions
 * @typedef {{ dir: string, session: string | null, now: Date }} HookStore
 * @typedef {{ injected: Set<string>, blocked: Set<string> }} SessionMemory
 */

/**
 * @param {string[]} argv
 * @returns {Harness}
 */
export function parseHarness(argv) {
  const value = argv[argv.indexOf('--harness') + 1];
  return HARNESSES.find((name) => name === value) ?? 'claude';
}

/**
 * @param {string} dir the memory directory
 * @param {string} session
 */
export const sessionFile = (dir, session) =>
  path.join(dir, CACHE_DIR, SESSIONS_DIR, `${session}.json`);

/**
 * The note ids this session was already shown.
 *
 * @param {string} dir
 * @param {string | null} session
 * @returns {Set<string>}
 */
export function readInjected(dir, session) {
  return readSession(dir, session).injected;
}

/**
 * @param {string} dir
 * @param {string | null} session
 * @returns {SessionMemory}
 */
function readSession(dir, session) {
  const data = /** @type {any} */ (
    session && readJsonOrNull(sessionFile(dir, session))
  );
  return {
    injected: new Set(Array.isArray(data?.injected) ? data.injected : []),
    blocked: new Set(Array.isArray(data?.blocked) ? data.blocked : []),
  };
}

/**
 * @template T
 * @param {HookStore} store
 * @param {(state: SessionMemory) => T} change
 * @returns {T}
 */
function updateSession({ dir, session }, change) {
  if (!session) return change(readSession(dir, session));
  const file = sessionFile(dir, session);
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true });
  return withLock(
    folder,
    () => {
      const state = readSession(dir, session);
      const before = state.injected.size + state.blocked.size;
      const result = change(state);
      if (before !== state.injected.size + state.blocked.size) {
        writeFileAtomic(
          file,
          JSON.stringify({
            injected: [...state.injected],
            blocked: [...state.blocked],
          })
        );
      }
      return result;
    },
    { timeoutMs: 1000, label: 'Memory session' }
  );
}

/**
 * Remove the records of sessions untouched for SESSION_MAX_AGE_MS.
 *
 * @param {string} dir
 * @param {Date} now
 */
function pruneSessions(dir, now) {
  const sessions = path.join(dir, CACHE_DIR, SESSIONS_DIR);
  if (!fs.existsSync(sessions)) return;
  for (const name of fs.readdirSync(sessions)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(sessions, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && now.getTime() - stat.mtimeMs > SESSION_MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * @param {string} event
 * @param {string | null} text
 * @param {Harness} harness
 * @returns {HookOutput | null}
 */
function contextOutput(event, text, harness) {
  if (!text) return null;
  if (harness === 'agy') return agyInjectOutput(text);
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  };
}

/**
 * The shell command of a tool event, as one string.
 *
 * @param {HookInput} input
 */
function commandOf(input) {
  const command = input.tool_input?.command;
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

/**
 * The error output of a failed command (at most ERROR_CHARS), or null when
 * the event is not a failure. Claude Code reports failures as
 * PostToolUseFailure with an `error`; Codex as PostToolUse, whose response
 * holds the exit code (a field, or an "Exit code: N" line).
 *
 * @param {HookInput} input
 * @returns {string | null}
 */
export function failureText(input) {
  if (input.hook_event_name === 'PostToolUseFailure') {
    return String(input.error ?? '').slice(0, ERROR_CHARS);
  }
  const response = input.tool_response;
  const text =
    typeof response === 'string'
      ? response
      : ['stderr', 'stdout', 'output']
          .map((key) => response?.[key])
          .filter((value) => typeof value === 'string')
          .join('\n');
  const field = response?.exit_code ?? response?.exitCode;
  const exit =
    typeof field === 'number'
      ? field
      : Number(EXIT_CODE_RE.exec(text)?.[1] ?? 0);
  return exit === 0 ? null : text.slice(0, ERROR_CHARS);
}

/**
 * The persona reminder for the user's settings, or '' without any (or with
 * a broken settings file: the reminder is optional, recall must still run).
 *
 * @param {string} dir the memory directory
 * @param {string} agent the session's agent (sessionAgent)
 */
function personaReminder(dir, agent) {
  let settings;
  let reminder = PERSONA_REMINDER;
  try {
    if (!readConfig(dir).personalizationEnabled) return PERSONALIZATION_OFF;
    const own = agentPersonalization(dir, personaKeyFor(agent));
    if (own) reminder = agentReminder(agent);
    settings = own ?? readPersonalization(dir);
  } catch {
    return '';
  }
  // Only rendered settings have a Personalization section to point at (the
  // language guard alone renders none).
  if (!renderPersonalization(settings)) return '';
  if (!settings.language) return reminder;
  const language = settings.language.replace(/\s+/g, ' ');
  return `${reminder} Language: ${
    language.length > REMINDER_LANGUAGE_CHARS
      ? `${language.slice(0, REMINDER_LANGUAGE_CHARS)}…`
      : language
  }`;
}

/**
 * Supply the core when the harness did not load a local file. A linked
 * worktree can hold an older copy, so supply just its current personalization.
 *
 * @param {string} rootDir
 * @param {string} home
 * @param {Harness} harness
 * @param {import('./config.js').MemoryConfig} config
 * @param {string} agent the session's agent (sessionAgent)
 */
function startupMemory(rootDir, home, harness, config, agent) {
  const localFile = harness === 'dsh' ? AGENTS_LOCAL_FILE : CLAUDE_LOCAL_FILE;
  // The agent's own persona (memory/persona.<key>.md); personalization off wins.
  const own = config.personalizationEnabled
    ? agentPersonalization(memoryDir(home), personaKeyFor(agent))
    : null;
  if (
    harness === 'codex' ||
    harness === 'agy' ||
    !fs.existsSync(path.join(rootDir, localFile))
  ) {
    return renderStored(home, config, own).block;
  }
  const local = readIfExists(path.join(rootDir, AGENTS_LOCAL_FILE)) ?? '';
  const start = local.indexOf(CORE_START);
  if (own) {
    // The core block loads natively: add this agent's personalization on top.
    if (rootDir !== home && start < 0) {
      return renderStored(home, config, own).block;
    }
    return `${agentOverride(agent)}\n\n${renderPersonalization(own)}`;
  }
  if (rootDir === home) return '';

  if (start < 0) return renderStored(home, config).block;
  if (!config.personalizationEnabled) return '';

  const block = local.slice(start, local.indexOf(CORE_END, start));
  const { personalization } = renderStored(home, config);
  const current = renderPersonalization(personalization);
  if (current) {
    return block.includes(current)
      ? ''
      : `[Persona] Apply the current workspace memory personalization below.\n\n${current}`;
  }
  return block.includes('\n## Personalization\n') ? PERSONALIZATION_EMPTY : '';
}

/**
 * Recall for `query`, skipping what the session was shown; record the
 * injection (usage and the session's record).
 *
 * @param {HookStore} store
 * @param {(notes: import('./store.js').Note[], index: import('./recall.js').Index) => import('./recall.js').RecallResult[] | { note: import('./store.js').Note }[]} pick
 * @returns {string | null}
 */
function injectText(store, pick) {
  const { notes, index } = loadIndex(store.dir);
  return updateSession(store, ({ injected }) => {
    const text = formatRecall(
      pick(
        notes.filter((note) => !injected.has(note.id)),
        index
      ),
      { now: store.now }
    );
    if (!text) return null;
    recordInjection(store, injected, text);
    return text;
  });
}

/** @param {HookStore} store @param {Set<string>} injected @param {string} text @returns {string[]} the ids shown */
function recordInjection({ dir, now }, injected, text) {
  const ids = text
    .split('\n')
    .map((line) => NOTE_ID_RE.exec(line)?.[1])
    .filter((id) => id !== undefined);
  recordHits(dir, ids, now);
  ids.forEach((id) => injected.add(id));
  return ids;
}

/**
 * @param {HookStore} store
 * @param {Harness} harness
 * @param {import('./store.js').Note[]} matches
 * @returns {HookOutput | null}
 */
function triggerOutput(store, harness, matches) {
  if (matches.length === 0) return null;
  const canBlock = store.session !== null && BLOCKING_HARNESSES.has(harness);
  return updateSession(store, ({ injected, blocked }) => {
    const blockers = canBlock
      ? matches.filter(
          (note) =>
            note.triggerMode === 'block' &&
            note.checked !== null &&
            !blocked.has(note.id)
        )
      : [];
    const fresh = matches.filter(
      (note) => !injected.has(note.id) && !blocked.has(note.id)
    );
    const text = formatRecall(
      (blockers.length > 0 ? blockers : fresh)
        .slice(0, RECALL_LIMIT)
        .map((note) => ({ note })),
      { now: store.now }
    );
    if (!text) return null;
    const shown = recordInjection(store, injected, text);
    if (blockers.length === 0)
      return contextOutput('PreToolUse', text, harness);
    // Only notes the reason shows count as delivered; the rest block next time.
    shown.forEach((id) => blocked.add(id));
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: text,
      },
    };
  });
}

/**
 * One-line warning when consolidation is due but cannot run automatically from
 * this session (either blocked by Antigravity ToS or turned off for this agent).
 *
 * @param {'weekly' | 'over budget' | null} due
 * @param {import('./config.js').MemoryConfig} config
 * @param {NodeJS.ProcessEnv} workerEnv
 * @returns {string | null}
 */
function consolidationNotice(due, config, workerEnv) {
  if (!due) return null;
  const agent = consolidationAgent(config, workerEnv);
  if (agent === null) return null;
  if (agent === 'agy') {
    const caller = foreignHarnessForAgy(workerEnv);
    if (caller) {
      const alt =
        CALL_AGENTS.includes(/** @type {any} */ (caller)) && caller !== 'agy'
          ? caller
          : 'claude';
      return `[Memory] Consolidation is due (${due}), but it is configured for agy and cannot run from ${caller} (Antigravity ToS). Fix: pnpm memory set --extract-agent ${alt} — or run from an agy session or plain terminal.`;
    }
  }
  const policyKey = consolidationPolicyKey(agent, workerEnv);
  if (!config.autoConsolidate[policyKey]) {
    return `[Memory] Consolidation is due (${due}), but auto-consolidation is off for ${policyKey}. Fix: pnpm memory set --auto-consolidate ${policyKey}=on — or run once: pnpm memory consolidate --allow-cross-side`;
  }
  return null;
}

/**
 * @template {Harness} [H='claude']
 * @param {HookInput} input
 * @param {{ harness?: H, rootDir?: string, now?: Date, env?: NodeJS.ProcessEnv, kick?: typeof kickWorker }} [options]
 * @returns {(H extends 'agy' ? import('../harness/input.js').AgyInjectOutput : StandardHookOutput) | null}
 */
export function handleHook(
  input,
  {
    harness = /** @type {H} */ ('claude'),
    rootDir = ROOT_DIR,
    now = new Date(),
    env = process.env,
    kick = kickWorker,
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const event = normalized.hook_event_name;
  if (quietRun(env, normalized.agent_type)) {
    return null;
  }
  const home = mainCheckout(rootDir);
  const dir = memoryDir(home);
  if (!fs.existsSync(dir)) return null;
  const session =
    typeof normalized.session_id === 'string' &&
    SESSION_ID_RE.test(normalized.session_id)
      ? normalized.session_id
      : null;
  const store = { dir, session, now };
  const context = () =>
    taskContext({
      rootDir,
      session,
      cwd: typeof normalized.cwd === 'string' ? normalized.cwd : rootDir,
    });

  const entry = {
    session,
    harness,
    transcript: normalized.transcript_path,
    cwd: normalized.cwd,
    at: now.toISOString(),
    kyotenAgent: env[AGENT_ENV] ?? null,
  };
  const workerEnv = { ...env, [CALLER_HARNESS_ENV]: harness };
  const startWorker = (
    /** @type {import('./config.js').MemoryConfig} */ config,
    /** @type {boolean} */ shouldConsolidate
  ) => {
    const work =
      shouldConsolidate ||
      readQueue(dir).some((queued) => {
        const agent = config.extractAgent ?? queued.harness;
        return (
          config.autoExtract[memoryPolicyKey(agent, workerEnv)] &&
          (savingOff(config, queued.session) ||
            !deferredRun(agent, queued.kyotenAgent, workerEnv, {}))
        );
      });
    if (work && !workerRunning(dir)) {
      kick({
        rootDir: home,
        env: workerEnv,
      });
    }
  };

  if (event === 'SessionEnd') {
    // Headless runs (--no-session-persistence) leave no transcript to read.
    const saved =
      typeof entry.transcript === 'string' && fs.existsSync(entry.transcript);
    if (saved && enqueue(dir, entry)) {
      const config = readConfig(dir);
      const due = consolidationDue(home, { now });
      startWorker(
        config,
        due !== null &&
          !savingOff(config, session) &&
          consolidationAgent(config, workerEnv) !== null &&
          consolidationNotice(due, config, workerEnv) === null
      );
    }
    return null;
  }
  if (event === 'SessionStart') {
    if (normalized.source !== 'resume') {
      updateSession(store, ({ injected, blocked }) => {
        injected.clear();
        if (normalized.source !== 'compact') blocked.clear();
      });
    }
    pruneSessions(dir, now);
    registerOpen(dir, entry);
    catchUp(dir, { current: session, now });
    const due = consolidationDue(home, { now });
    const config = readConfig(dir);
    const notice = consolidationNotice(due, config, workerEnv);
    startWorker(
      config,
      due !== null &&
        notice === null &&
        !savingOff(config, session) &&
        consolidationAgent(config, workerEnv) !== null
    );
    const news = announcement(dir);
    const off = savingOff(config, session);
    const parts = [
      startupMemory(
        rootDir,
        home,
        harness,
        config,
        sessionAgent(env[AGENT_ENV], harness)
      ),
      config.personalizationEnabled ? '' : PERSONALIZATION_OFF,
      ...(off
        ? [
            `[Memory] Saving to memory is off ${off === 'global' ? 'everywhere' : 'for this session'}: do not save notes (pnpm memory add) unless the user asks; recall still works.`,
          ]
        : []),
      // Claude Code shows the user a UI message; Codex and Antigravity rely on
      // the agent (agy 1.5.14 panics when systemMessage.metadata is non-empty).
      ...(news
        ? [
            harness === 'claude'
              ? news
              : `${news}\nMention this memory update to the user in one line.`,
          ]
        : []),
      ...(notice
        ? [
            harness === 'claude'
              ? notice
              : `${notice}\nMention this to the user in one line.`,
          ]
        : []),
    ].filter(Boolean);
    const output = contextOutput(event, parts.join('\n\n'), harness);
    const claudeMessage = [news, notice].filter(Boolean).join('\n\n');
    return /** @type {any} */ (
      output && claudeMessage && harness === 'claude'
        ? { ...output, systemMessage: claudeMessage }
        : output
    );
  }
  if (
    event === 'UserPromptSubmit' ||
    (harness === 'agy' && event === 'PreInvocation')
  ) {
    if (
      harness === 'agy' &&
      typeof normalized.invocationNum === 'number' &&
      normalized.invocationNum !== 0
    ) {
      return null;
    }
    const prompt =
      typeof normalized.prompt === 'string' ? normalized.prompt.trim() : '';
    // Slash commands, and queued background-task notifications (not typed).
    if (
      !prompt ||
      prompt.startsWith('/') ||
      prompt.startsWith('<task-notification>')
    ) {
      return null;
    }
    const { goal, repo } = context();
    const query = [prompt, goal].filter(Boolean).join('\n');
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, { index, repo, usage: readUsage(dir), now })
    );
    return /** @type {any} */ (
      contextOutput(
        event,
        [personaReminder(dir, sessionAgent(env[AGENT_ENV], harness)), recalled]
          .filter(Boolean)
          .join('\n\n'),
        harness
      )
    );
  }
  if (harness === 'agy' && event === 'PostInvocation') {
    const failures = recentAgyFailures(
      normalized.transcript_path,
      normalized.initialNumSteps
    );
    const query = failures
      .map((f) => `${f.command}\n${f.error.slice(0, ERROR_CHARS)}`)
      .join('\n')
      .trim();
    if (!query) return null;
    const { repo } = context();
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, {
        index,
        repo,
        failure: true,
        usage: readUsage(dir),
        now,
      })
    );
    return /** @type {any} */ (contextOutput(event, recalled, harness));
  }
  if (event === 'PreToolUse') {
    const command = commandOf(normalized);
    if (!command) return null;
    const matches = matchTriggers(loadNotes(dir).notes, command);
    const repo = matches.some((note) => note.scope === 'repo')
      ? context().repo
      : null;
    return /** @type {any} */ (
      triggerOutput(
        store,
        harness,
        matches.filter((note) => note.scope !== 'repo' || note.repo === repo)
      )
    );
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const error = failureText(normalized);
    const query = [commandOf(normalized), error ?? ''].join('\n').trim();
    if (error === null || !query) return null;
    const { repo } = context();
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, {
        index,
        repo,
        failure: true,
        usage: readUsage(dir),
        now,
      })
    );
    return /** @type {any} */ (contextOutput(event, recalled, harness));
  }
  return null;
}

/**
 * Parse the hook's stdin and answer it; '' (or '{}' for Antigravity) when
 * there is nothing to say or anything goes wrong (a hook must never break the
 * session).
 *
 * @param {string} raw stdin
 * @param {HookOptions} [options]
 * @returns {string}
 */
export function runHook(raw, options = {}) {
  const empty = options.harness === 'agy' ? '{}' : '';
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = handleHook(input, options);
    return output ? JSON.stringify(output) : empty;
  } catch {
    return empty;
  }
}

/* c8 ignore start - stdin/stdout wiring; the logic is tested through runHook */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  const failOpen = () => {
    if (harness === 'agy') process.stdout.write('{}', () => process.exit(0));
    else process.exit(0);
  };
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    const out = runHook(data, { harness });
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
  process.stdin.on('error', failOpen);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
