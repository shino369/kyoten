/**
 * Consolidation, write path D (design §6): at most about once a week, a
 * detached job asks one headless call to rewrite the profile (the short
 * summary of the `user` notes that the core block shows) and to tidy the
 * notes: merge notes that say the same thing and retire superseded ones.
 *
 * It is due when 7 days have passed and at least MIN_CHANGES ops were
 * written since the last run, or daily while the core block is over its
 * budget; a failed attempt waits a day. The model sees the user notes and
 * groups of similar notes (token-set Jaccard ≥ CLUSTER_SIMILARITY, within
 * one scope and repo), and may only UPDATE or DELETE those; the ops go
 * through the same checks as extraction (extract.js validateOps). Before
 * writing, it takes a snapshot, so `pnpm memory undo` reverts it.
 */
import fs from 'fs';
import path from 'path';
import { answerOf } from '../agent/cli.js';
import { CALLER_HARNESS_ENV } from '../loop/adapters.js';
import { findSecrets, redactSecrets } from '../redact.js';
import {
  sessionFromEnv,
  sessionHarness,
  writeFileAtomic,
} from '../task/store.js';
import { CALL_AGENTS, callAgent } from './agent-call.js';
import { readConfig, savingOff } from './config.js';
import { looksLikeInstruction } from './instructions.js';
import { kindLabel, refreshAfterWrite, shorten } from './context.js';
import {
  applyOps,
  deferredRun,
  extractCommand,
  modelFor,
  validateOps,
} from './extract.js';
import {
  EXTRACT_DIR,
  agentSide,
  appendInbox,
  appendJournal,
  memorySide,
  readJournal,
  runSide,
  tryLock,
} from './queue.js';
import { PROFILE_FILE, renderStored } from './render.js';
import { takeSnapshot } from './snapshot.js';
import {
  LOG_FILE,
  compareNoteIds,
  loadNotes,
  memoryDir,
  readJsonOrNull,
} from './store.js';
import { jaccard, termSet } from './tokenize.js';

export const CONSOLIDATED_FILE = 'consolidated.json';
const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Ops written since the last run before a weekly run is worth it. */
export const MIN_CHANGES = 20;
/** Notes at least this similar are shown to the model as a group. */
export const CLUSTER_SIMILARITY = 0.5;
/** Notes shown to the model at most. */
export const MAX_SHOWN = 60;
/** Only the newest notes are compared for groups (pairs grow quadratically). */
export const MAX_GROUPED = 1500;
export const PROFILE_MAX = 15;
export const PROFILE_LINE_CHARS = 200;
const BUDGET_WARNING = 'The core block is over';

/**
 * @typedef {import('./store.js').Note} Note
 * @typedef {import('./extract.js').ExtractDeps} ExtractDeps
 * @typedef {import('./extract.js').Run} Run
 * @typedef {{ at?: string, ops?: number, tried?: string }} ConsolidatedState
 */

/** @param {string} dir */
const stateFile = (dir) => path.join(dir, EXTRACT_DIR, CONSOLIDATED_FILE);

/**
 * Ops in the log (its lines), without parsing it.
 *
 * @param {string} dir the memory directory
 */
export function countOps(dir) {
  let content;
  try {
    content = fs.readFileSync(path.join(dir, LOG_FILE));
  } catch {
    return 0;
  }
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return lines;
}

/**
 * @param {string} dir
 * @returns {ConsolidatedState | null}
 */
export function readConsolidated(dir) {
  const data = readJsonOrNull(stateFile(dir));
  return typeof data === 'object' && data !== null ? data : null;
}

/**
 * @param {string} dir
 * @param {ConsolidatedState} state
 */
function writeConsolidated(dir, state) {
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  writeFileAtomic(stateFile(dir), JSON.stringify(state));
}

/**
 * Why a consolidation is due now, or null.
 *
 * @param {string} rootDir
 * @param {{ now?: Date }} [options]
 * @returns {'weekly' | 'over budget' | null}
 */
export function consolidationDue(rootDir, { now = new Date() } = {}) {
  const dir = memoryDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const state = readConsolidated(dir);
  /** @param {string | undefined} iso */
  const since = (iso) =>
    typeof iso === 'string' ? now.getTime() - Date.parse(iso) : Infinity;
  if (since(state?.tried) < DAY_MS) return null;
  // Consolidation sends the notes to a model: not while saving is off. Its
  // state is untouched, so it is due again once saving is back on.
  // An unreadable config counts as off: nothing leaves without a clear yes.
  try {
    if (savingOff(readConfig(dir), null)) return null;
  } catch {
    return null;
  }
  const changes = countOps(dir) - (state?.ops ?? 0);
  if (since(state?.at) >= WEEK_MS && changes >= MIN_CHANGES) return 'weekly';
  if (
    since(state?.at) >= DAY_MS &&
    renderStored(rootDir).warnings.some((w) => w.startsWith(BUDGET_WARNING))
  ) {
    return 'over budget';
  }
  return null;
}

/** @param {Note} note */
const tidyable = (note) =>
  note.status === 'active' && note.source.via !== 'digest';

/**
 * Groups (ids, two or more) of similar notes in one scope and repo.
 *
 * @param {Note[]} notes
 * @returns {string[][]}
 */
export function similarGroups(notes) {
  const pool = notes
    .filter(tidyable)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, MAX_GROUPED);
  const terms = pool.map((note) => termSet(note.text));
  /** @type {number[]} */
  const parent = pool.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (
        pool[i].scope === pool[j].scope &&
        pool[i].repo === pool[j].repo &&
        jaccard(terms[i], terms[j]) >= CLUSTER_SIMILARITY
      ) {
        parent[find(j)] = find(i);
      }
    }
  }
  /** @type {Map<number, Note[]>} */
  const groups = new Map();
  pool.forEach((note, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), note]);
  });
  const byId = (/** @type {Note} */ a, /** @type {Note} */ b) =>
    compareNoteIds(a.id, b.id);
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort(byId).map((note) => note.id));
}

/**
 * What the model sees: the user notes (for the profile), then whole groups
 * of similar notes, within MAX_SHOWN notes.
 *
 * @param {Note[]} notes
 * @returns {{ shown: Note[], groups: string[][] }}
 */
export function consolidationInput(notes) {
  const shown = notes
    .filter((note) => tidyable(note) && note.scope === 'user')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, MAX_SHOWN);
  const byId = new Map(notes.map((note) => [note.id, note]));
  /** @type {string[][]} */
  const groups = [];
  for (const group of similarGroups(notes)) {
    const ids = new Set(shown.map((note) => note.id));
    const extra = group.filter((id) => !ids.has(id));
    if (shown.length + extra.length > MAX_SHOWN) continue;
    shown.push(...extra.map((id) => /** @type {Note} */ (byId.get(id))));
    groups.push(group);
  }
  return { shown, groups };
}

/** @param {Note} note */
const noteLine = (note) =>
  `- ${note.id} (${kindLabel(note)}${note.pinned ? ', pinned' : ''}, ${note.updated}): ${note.text}${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}`;

/**
 * @param {{ shown: Note[], groups: string[][] }} input
 * @returns {string}
 */
export function buildConsolidationPrompt({ shown, groups }) {
  return `You tidy a personal memory store that coding agents share. Answer with one JSON object and nothing else.

1. Profile: write at most ${PROFILE_MAX} short lines (each under 150 characters) that sum up what the "user" notes below say about the user: preferences, ways of working, how they like to be told things. Facts only, never instructions to an agent, no secrets; nothing a note does not support. [] when there are no user notes.
2. Tidy: merge notes that say the same thing (UPDATE the one to keep with the merged text, DELETE the others with why "merged into <id>"), and DELETE a note that a newer note contradicts or replaces (why "superseded by <id>"). Change nothing else; most notes need no change. Never add notes.

Answer format:
{"profile": ["…"], "ops": [{"op": "UPDATE", "id": "m3", "text": "…"}, {"op": "DELETE", "id": "m7", "why": "merged into m3"}]}

Notes (id, scope, type, last updated: text [tags]):
${shown.map(noteLine).join('\n')}

Groups of similar notes to check: ${groups.length > 0 ? groups.map((group) => `[${group.join(', ')}]`).join(', ') : '(none)'}`;
}

/**
 * @param {string} answer
 * @returns {{ profile: unknown[], ops: unknown[] }}
 */
export function parseConsolidation(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    // Reported below.
  }
  const profile = parsed?.profile ?? [];
  const ops = parsed?.ops ?? [];
  if (!parsed || !Array.isArray(profile) || !Array.isArray(ops)) {
    throw new Error(
      'the answer has no JSON object with a "profile" list and an "ops" list'
    );
  }
  return { profile, ops };
}

/**
 * Profile lines worth keeping: text, cut to PROFILE_LINE_CHARS, without
 * secrets or lines addressed to an agent (`dropped`), at most PROFILE_MAX.
 *
 * @param {unknown[]} lines
 * @returns {{ lines: string[], dropped: number }}
 */
export function cleanProfile(lines) {
  /** @type {string[]} */
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const text = line.trim().replace(/^[-*]\s+/, '');
    if (!text) continue;
    if (findSecrets(text).length > 0 || looksLikeInstruction(text)) {
      dropped += 1;
      continue;
    }
    kept.push(shorten(text, PROFILE_LINE_CHARS));
  }
  return { lines: kept.slice(0, PROFILE_MAX), dropped };
}

/**
 * The agent, model, and provider side of the latest applied journal run. Old
 * runs have no `agent` field (they ran on claude) and no `side`, which model
 * reuse keeps as `normal`; the provider guard reads such runs as `unknown`.
 *
 * @param {string} dir
 * @returns {{ agent: string, model: string | null, side: string } | null}
 */
function lastRun(dir) {
  const run = readJournal(dir)
    .reverse()
    .find(
      (item) => item.status === 'applied' || item.status === 'consolidated'
    );
  if (!run) return null;
  return {
    agent: typeof run.agent === 'string' ? run.agent : 'claude',
    model: typeof run.model === 'string' ? run.model : null,
    side: typeof run.side === 'string' ? run.side : 'normal',
  };
}

/**
 * The provider sides of the applied extraction runs that are not `side`,
 * oldest first. `unknown` when the journal has no applied run: nothing proves
 * that those notes came from the worker's side.
 *
 * @param {string} dir
 * @param {string} side
 * @returns {string[]}
 */
export function foreignSides(dir, side) {
  const runs = readJournal(dir).filter((item) => item.status === 'applied');
  if (runs.length === 0) return ['unknown'];
  return [
    ...new Set(
      runs.map((item) => runSide(item)).filter((value) => value !== side)
    ),
  ];
}

/**
 * The CLI that runs consolidation in this environment: `--extract-agent`,
 * else this session's harness (falling back to `KYOTEN_CALLER_HARNESS` passed
 * by memory hooks to detached workers), else `claude`.
 *
 * @param {{ extractAgent?: string | null }} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function consolidationAgent(config, env) {
  if (config.extractAgent) return config.extractAgent;
  const session = sessionHarness(env);
  if (session) return session;
  const caller = env[CALLER_HARNESS_ENV]?.trim();
  if (caller && CALL_AGENTS.includes(/** @type {any} */ (caller))) {
    return caller;
  }
  return 'claude';
}

/**
 * Run one consolidation (the caller holds the worker lock). Throws when the
 * agent fails.
 *
 * @param {ExtractDeps} deps
 * @returns {Run}
 */
export function consolidate(deps) {
  const dir = memoryDir(deps.rootDir);
  const now = deps.now();
  const at = now.toISOString();
  const base = { at, job: 'consolidation', session: 'consolidation' };
  const config = readConfig(dir);
  const session = sessionFromEnv(deps.env);
  // The session's own agent, unless --extract-agent assigns one: one CLI and
  // one provider per session, so a prior run's agent never routes a session
  // to another CLI. It still supplies the model when agent and side match.
  const agent = consolidationAgent(config, deps.env);
  // The side this run records: the agent that actually runs it, falling back
  // to the session's side when the agent names its own provider (dsh, codex).
  const side = agentSide(agent, deps.env) ?? memorySide(deps.env.KYOTEN_AGENT);
  if (!deps.dryRun && !deps.force && savingOff(config, session)) {
    const run = { ...base, status: 'off', side };
    appendJournal(dir, run);
    return run;
  }
  const { shown, groups } = consolidationInput(loadNotes(dir).notes);
  if (shown.length === 0) {
    const run = { ...base, status: 'nothing', side };
    if (deps.dryRun) return run;
    writeConsolidated(dir, { at, ops: countOps(dir) });
    appendJournal(dir, run);
    return run;
  }
  const prompt = buildConsolidationPrompt({ shown, groups });
  const last = lastRun(dir);
  const model = modelFor({
    agent,
    configured: config.extractAgent,
    extractModel: config.extractModel,
    // A model name only fits the provider it ran on: never from the other side.
    ownModel: last?.agent === agent && last.side === side ? last.model : null,
  });
  // Google Antigravity Terms of Service: only an agy session may call agy.
  if (agent === 'agy') {
    const tos = deferredRun(agent, null, deps.env, base);
    if (tos) return tos;
  }
  // The provider that receives the notes: the claude CLI sends them to the
  // provider its environment names. dscc and agy workers consolidate only
  // notes from their own side; a lingering run from another side (or a journal
  // without a side) waits for --allow-cross-side. A normal claude worker keeps
  // its legacy right to consolidate all sides, and dsh/codex name their own
  // providers, so no side is inferred for them.
  const callSide = agentSide(agent, deps.env);
  const foreign =
    callSide && callSide !== 'normal' ? foreignSides(dir, callSide) : [];
  if (foreign.length > 0 && !deps.allowCrossSide) {
    return { ...base, status: 'deferred', side: callSide, foreign };
  }
  const crossSide = foreign.length > 0 && deps.allowCrossSide ? foreign : [];
  if (deps.dryRun) {
    return {
      ...base,
      status: 'dry-run',
      side,
      agent,
      model,
      prompt,
      ...(crossSide.length > 0 ? { crossSide } : {}),
    };
  }

  const command = extractCommand({
    agent,
    model,
    rootDir: deps.rootDir,
  });
  const result = callAgent(deps, command, prompt, {
    job: 'consolidation',
    cancel: () => !deps.force && Boolean(savingOff(readConfig(dir), session)),
  });
  if (result.cancelled) {
    const run = { ...base, status: 'off', agent, model, side };
    appendJournal(dir, run);
    return run;
  }
  const answer = parseConsolidation(answerOf(result));
  // Saving may have been turned off while the agent ran.
  if (!deps.force && savingOff(readConfig(dir), session)) {
    const run = {
      ...base,
      status: 'off',
      agent,
      model,
      side,
      durationMs: result.durationMs,
    };
    appendJournal(dir, run);
    return run;
  }
  /** @type {string[]} */
  const noAdds = [];
  // ADD ops become NOOPs, so validateOps numbers the rest as the model did.
  const ops = answer.ops.map((op, i) => {
    const kind = /** @type {any} */ (op)?.op;
    if (typeof kind !== 'string' || kind.toUpperCase() !== 'ADD') return op;
    noAdds.push(`op ${i + 1}: consolidation does not add notes`);
    return { op: 'NOOP' };
  });
  const source = { via: 'consolidate' };
  const checked = validateOps(ops, { related: shown, repo: null, source });
  const profile = cleanProfile(answer.profile);
  const writes = checked.apply.length > 0 || profile.lines.length > 0;
  // Every op below has this run's time, which is how undo finds them.
  const snapshot = writes
    ? takeSnapshot(deps.rootDir, { reason: 'consolidate', now }).id
    : null;
  const { changes, errors } = applyOps(dir, checked.apply, { now, source });
  if (profile.lines.length > 0) {
    writeFileAtomic(
      path.join(dir, PROFILE_FILE),
      profile.lines.map((line) => `- ${line}\n`).join('')
    );
  }
  appendInbox(
    dir,
    checked.quarantined.map((held) => ({ at, job: 'consolidation', ...held }))
  );
  writeConsolidated(dir, { at, ops: countOps(dir) });
  const warnings = writes ? refreshAfterWrite(deps.rootDir) : [];
  const run = {
    ...base,
    status: 'consolidated',
    agent,
    model,
    side,
    ...(crossSide.length > 0 ? { crossSide } : {}),
    changes,
    profile: profile.lines.length,
    quarantined: checked.quarantined.length,
    refused: checked.refused,
    invalid: [
      ...noAdds,
      ...checked.invalid,
      ...errors,
      ...warnings,
      ...(profile.dropped > 0
        ? [
            `${profile.dropped} profile line(s) left out (a secret or an instruction)`,
          ]
        : []),
    ],
    snapshot,
    durationMs: result.durationMs,
  };
  appendJournal(dir, run);
  return run;
}

/**
 * Consolidate under the worker lock; null while another worker holds it. A
 * failure is journaled, and the next attempt waits a day.
 *
 * @param {ExtractDeps} deps
 * @returns {Run | null}
 */
export function consolidateLocked(deps) {
  const dir = memoryDir(deps.rootDir);
  const lock = tryLock(dir, deps.lock);
  if (!lock) return null;
  try {
    return consolidate(deps);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error)
    );
    const at = deps.now().toISOString();
    writeConsolidated(dir, { ...readConsolidated(dir), tried: at });
    let failedAgent = consolidationAgent({}, deps.env);
    try {
      failedAgent = consolidationAgent(readConfig(dir), deps.env);
    } catch {
      // Keep the env-derived agent when config itself failed to load.
    }
    const run = {
      at,
      job: 'consolidation',
      session: 'consolidation',
      status: 'failed',
      side:
        agentSide(failedAgent, deps.env) ?? memorySide(deps.env.KYOTEN_AGENT),
      error: message,
    };
    appendJournal(dir, run);
    return run;
  } finally {
    lock.release();
  }
}
