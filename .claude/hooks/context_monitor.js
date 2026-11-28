#!/usr/bin/env node
/**
 * Context window monitor hook.
 *
 * Fires on UserPromptSubmit. Reads the session transcript to calculate actual
 * token usage from the API response metadata, then injects an additionalContext
 * warning so Claude can proactively manage context.
 *
 * Thresholds (fraction of the configured context window):
 *   <20%   — silent
 *   20-40% — informational note
 *   40-60% — save-progress warning
 *   60%+   — urgent, context likely degraded
 *
 * The window defaults to 1M tokens; set CLAUDE_CONTEXT_WINDOW to override.
 * Codex records the model's window in its rollout, and that wins. DSH gives
 * hooks no transcript, so there the monitor stays silent.
 */
import fs from 'fs';
import path from 'path';
import {
  agyInjectOutput,
  normalizeHookInput,
  parseHarness,
  transcriptUsage,
} from '#utils/harness/input.js';
import { runIfMain } from '#utils/module-runner.js';
import {
  SESSION_ID_RE,
  ensurePrivateDir,
  readIfExists,
  sessionContextDir,
  sessionTask,
  writeFileAtomic,
} from '#utils/task/store.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const THRESHOLDS = {
  note: 0.2,
  warn: 0.4,
  urgent: 0.6,
};
const TIERS = ['none', 'note', 'warn', 'urgent'];

/** @param {number} usage */
function contextTier(usage) {
  if (usage >= THRESHOLDS.urgent) return 'urgent';
  if (usage >= THRESHOLDS.warn) return 'warn';
  return usage >= THRESHOLDS.note ? 'note' : 'none';
}

/**
 * Record decreases silently so the same threshold can be raised again.
 * @param {string} rootDir
 * @param {unknown} session
 * @param {string} tier
 */
function crossedThreshold(rootDir, session, tier) {
  if (typeof session !== 'string' || !SESSION_ID_RE.test(session)) return true;
  const dir = sessionContextDir(rootDir);
  const file = path.join(dir, `${session}.json`);
  try {
    const raw = readIfExists(file);
    const last = raw === null ? 'none' : JSON.parse(raw)?.lastTier;
    if (!TIERS.includes(last)) return true;
    if (last === tier) {
      if (raw !== null) {
        // Pruning uses mtime; keep the state of an active long-lived session.
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
      return false;
    }
    ensurePrivateDir(dir);
    writeFileAtomic(file, JSON.stringify({ lastTier: tier }));
    return TIERS.indexOf(tier) > TIERS.indexOf(last);
  } catch {
    return true;
  }
}

/**
 * Read the context window from the environment, falling back to the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function getContextWindow(env = process.env) {
  const raw = env.CLAUDE_CONTEXT_WINDOW;
  if (!raw) return DEFAULT_CONTEXT_WINDOW;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Format a token count for the warning message (1M, 200K, ...).
 *
 * @param {number} contextWindow
 * @returns {string}
 */
export function formatWindow(contextWindow) {
  if (contextWindow >= 1_000_000) {
    return `${contextWindow / 1_000_000}M`;
  }
  if (contextWindow >= 1_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

/**
 * Cumulative input-token usage from the newest assistant entry of a Claude
 * Code transcript (read from the end; see utils/harness/input.js). Null when
 * the transcript is missing or has no usage data.
 *
 * Approximation: accurate when prompt caching is active. cache_read_input_tokens
 * reflects the full prior context served from cache; input_tokens is only the
 * new non-cached tokens for the turn. In low-cache sessions this undercounts.
 *
 * @param {string | undefined} transcriptPath
 * @returns {{ inputTokens: number } | null}
 */
export function getUsageFromTranscript(transcriptPath) {
  const usage = transcriptUsage(transcriptPath, 'claude');
  return usage ? { inputTokens: usage.tokens } : null;
}

/**
 * The task this session works on (see `sessionTask`), or null when it has
 * none or tasks/ is unreadable.
 *
 * @param {string} [rootDir]
 * @param {string | null} [session] the hook's session id
 * @returns {string | null}
 */
export function getActiveTask(rootDir = ROOT_DIR, session = null) {
  try {
    const found = sessionTask(rootDir, session);
    return found?.engaged ? found.name : null;
  } catch {
    return null;
  }
}

/**
 * The concrete "save your progress" instruction, naming the active task.
 *
 * @param {string | null} activeTask
 * @returns {string}
 */
export function saveInstruction(activeTask) {
  return activeTask
    ? `run \`pnpm task note --done "…" --next "…"\` (appends to tasks/${activeTask}/NOTES.md)`
    : 'no task is active — run `pnpm task switch <name>` (or `pnpm task new <name> --goal "…"`), then `pnpm task note --done "…" --next "…"`; for one-off work, append to tasks/<task-name-yymmdd>/NOTES.md';
}

/**
 * Build the warning text for a usage fraction, or null when below the note level.
 *
 * @param {number} usagePct
 * @param {number} [contextWindow]
 * @param {string | null} [activeTask]
 * @param {import('#utils/harness/input.js').Harness} [harness]
 * @returns {string | null}
 */
export function buildMessage(
  usagePct,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  activeTask = null,
  harness = 'claude'
) {
  if (usagePct < THRESHOLDS.note) return null;

  const pctStr = (usagePct * 100).toFixed(1);
  const windowLabel = formatWindow(contextWindow);

  if (usagePct < THRESHOLDS.warn) {
    return `[Context Monitor] Usage at ${pctStr}% of ${windowLabel} context window. Monitor progress — consider saving notes if this conversation continues to grow.`;
  }

  const guidance =
    harness === 'agy'
      ? 'Finish the current unit or save progress and use /compact or /clear. Avoid launching heavy subagents while the prefix cache is warm; waiting can evict it.'
      : 'Finish the current unit or save progress and use /compact. Avoid inherited-model subagents for routine work.';
  if (usagePct < THRESHOLDS.urgent) {
    return `[Context Monitor][WARNING] Usage at ${pctStr}% of ${windowLabel} context window. ${guidance} To save progress, ${saveInstruction(activeTask)}.`;
  }

  return `[Context Monitor][URGENT] Usage at ${pctStr}% of ${windowLabel} context window — context likely degraded. IMMEDIATE ACTION: save progress — ${saveInstruction(activeTask)} — then urge the user to run /compact, then /clear to restore quality. Do NOT continue in this session for complex tasks.`;
}

/**
 * @typedef {{ hookSpecificOutput: { hookEventName: string, additionalContext: string }, systemMessage?: string }} StandardHookOutput
 * @typedef {StandardHookOutput | import('#utils/harness/input.js').AgyInjectOutput} HookOutput
 */

/**
 * Convert hook input into hook output, or null when no warning is needed.
 *
 * @template {import('#utils/harness/input.js').Harness} [H='claude']
 * @param {{ transcript_path?: string, transcriptPath?: string, session_id?: string, conversationId?: string, invocationNum?: number }} [input]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ activeTask?: (session: string | null) => string | null, harness?: H, rootDir?: string }} [options]
 * @returns {(H extends 'agy' ? import('#utils/harness/input.js').AgyInjectOutput : StandardHookOutput) | null}
 */
export function processHookInput(
  input,
  env = process.env,
  {
    rootDir = ROOT_DIR,
    activeTask = (session) => getActiveTask(rootDir, session),
    harness = /** @type {H} */ ('claude'),
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  if (
    harness === 'agy' &&
    typeof normalized.invocationNum === 'number' &&
    normalized.invocationNum !== 0
  ) {
    return null;
  }
  const usage = transcriptUsage(normalized.transcript_path, harness);
  if (!usage) return null;

  const contextWindow = usage.window ?? getContextWindow(env);
  const usagePct = usage.tokens / contextWindow;
  if (!crossedThreshold(rootDir, normalized.session_id, contextTier(usagePct)))
    return null;
  const message = buildMessage(
    usagePct,
    contextWindow,
    usagePct >= THRESHOLDS.warn
      ? activeTask(normalized.session_id ?? null)
      : null,
    harness
  );
  if (!message) return null;

  if (harness === 'agy') {
    return /** @type {any} */ (agyInjectOutput(message));
  }

  /** @type {StandardHookOutput} */
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
  };

  // Show a visible status line in the UI for WARNING and URGENT levels only.
  if (usagePct >= THRESHOLDS.warn) {
    output.systemMessage = message;
  }

  return /** @type {any} */ (output);
}

/* istanbul ignore next - stdin handling is tested through processHookInput */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let inputData = '';

  if (process.stdin.isTTY) {
    process.exit(0);
  }

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    inputData += chunk;
  });

  const failOpen = () => {
    if (harness === 'agy') {
      process.stdout.write('{}', () => process.exit(0));
      return;
    }
    process.exit(0);
  };
  process.stdin.on('end', () => {
    try {
      const hookInput = JSON.parse(inputData);
      const output = processHookInput(hookInput, process.env, { harness });

      if (output || harness === 'agy') {
        // Wait for stdout to flush before exiting; process.exit() during a
        // pending pipe write can truncate the hook output on Windows.
        process.stdout.write(JSON.stringify(output ?? {}), () =>
          process.exit(0)
        );
        return;
      }

      process.exit(0);
    } catch {
      failOpen();
    }
  });

  process.stdin.on('error', failOpen);
}

runIfMain(import.meta.url, main);
