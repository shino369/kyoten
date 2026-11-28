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
import { CALLER_HARNESS_ENV, foreignHarnessForAgy } from '../loop/adapters.js';
import { findSecrets, redactSecrets } from '../redact.js';
import {
  readIfExists,
  sessionFromEnv,
  sessionHarnesses,
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
  DSCC_AGENT,
  EXTRACT_DIR,
  agentSide,
  appendInbox,
  appendJournal,
  readJournal,
  runSide,
  tryLock,
} from './queue.js';
import { PROFILE_FILE, renderStored } from './render.js';
import { takeSnapshot } from './snapshot.js';
import { namesRepo, repoName } from './repo.js';
import {
  LOG_FILE,
  canArchive,
  loadNotes,
  memoryDir,
  parseLog,
  readJsonOrNull,
  readUsage,
  replay,
} from './store.js';
import { jaccard, termSet } from './tokenize.js';

export const CONSOLIDATED_FILE = 'consolidated.json';
const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Ops written since the last run before a weekly run is worth it. */
export const MIN_CHANGES = 20;
/** Notes at least this similar are shown to the model as a group. */
export const CLUSTER_SIMILARITY = 0.3;
/** Notes shown to the model at most. */
export const MAX_SHOWN = 60;
const MAX_USER_NOTES = 30;
/** Only the newest notes are compared for groups (pairs grow quadratically). */
export const MAX_GROUPED = 1500;
export const PROFILE_MAX = 15;
export const PROFILE_LINE_CHARS = 200;
const BUDGET_WARNING = 'The core block is over';

/**
 * @typedef {import('./store.js').Note} Note
 * @typedef {import('./extract.js').ExtractDeps} ExtractDeps
 * @typedef {import('./extract.js').Run} Run
 * @typedef {{ at?: string, ops?: number, tried?: string, cursor?: number }} ConsolidatedState
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
  if (since(state?.at) >= WEEK_MS && (changes >= MIN_CHANGES || state?.cursor))
    return 'weekly';
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
const idNumber = (/** @type {string} */ id) => Number(id.slice(1));

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
  const tags = pool.map(
    (note) => new Set(note.tags.flatMap((tag) => [...termSet(tag)]))
  );
  /** @type {number[]} */
  const parent = pool.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pool[i].scope === pool[j].scope && pool[i].repo === pool[j].repo) {
        const text = jaccard(terms[i], terms[j]);
        const tag = jaccard(tags[i], tags[j]);
        if (
          text >= CLUSTER_SIMILARITY ||
          (text >= 0.2 && 0.7 * text + 0.3 * tag >= CLUSTER_SIMILARITY)
        ) {
          parent[find(j)] = find(i);
        }
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
    idNumber(a.id) - idNumber(b.id);
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort(byId).map((note) => note.id));
}

/**
 * Reserve half the prompt for upkeep. The cursor is the last reviewed unit's
 * numeric id, so archiving or merging a note cannot shift the next page.
 *
 * @param {Note[]} notes
 * @param {{ cursor?: number, now?: Date, usage?: Record<string, import('./store.js').Usage>, repo?: string | null }} [options]
 */
export function consolidationInput(
  notes,
  { cursor = 0, now = new Date(), usage = {}, repo = null } = {}
) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const archive = new Set(
    notes
      .filter((note) => canArchive(note, now, usage[note.id]))
      .map((note) => note.id)
  );
  const repos = [
    ...new Set(
      [repo, ...notes.map((note) => note.repo)].filter((name) => name !== null)
    ),
  ];
  const scopes = new Map(
    notes
      .filter((note) => tidyable(note) && note.scope === 'machine')
      .flatMap((note) => {
        const matches = repos.filter((name) => namesRepo(note.text, name));
        return matches.length === 1 ? [[note.id, matches[0]]] : [];
      })
  );
  const units = similarGroups(notes).flatMap((group) => {
    const [anchor, ...rest] = group;
    const pages = [];
    for (let i = 0; i < rest.length; i += MAX_USER_NOTES - 1) {
      pages.push([anchor, ...rest.slice(i, i + MAX_USER_NOTES - 1)]);
    }
    return pages;
  });
  const grouped = new Set(units.flat());
  for (const id of new Set([...archive, ...scopes.keys()])) {
    if (!grouped.has(id)) units.push([id]);
  }
  const end = (/** @type {string[]} */ unit) => idNumber(unit[unit.length - 1]);
  units.sort((a, b) => end(a) - end(b));
  const remaining = units.filter((unit) => end(unit) > cursor);
  const page = remaining.length > 0 ? remaining : units;
  const selected = new Set();
  /** @type {string[][]} */
  const groups = [];
  let nextCursor = 0;
  for (const [i, unit] of page.entries()) {
    const extra = unit.filter((id) => !selected.has(id));
    if (selected.size + extra.length > MAX_SHOWN - MAX_USER_NOTES) break;
    unit.forEach((id) => selected.add(id));
    if (unit.length > 1) groups.push(unit);
    nextCursor = i === page.length - 1 ? 0 : end(unit);
  }
  const upkeep = [...selected].map((id) => /** @type {Note} */ (byId.get(id)));
  const userSlots =
    MAX_USER_NOTES - upkeep.filter((note) => note.scope === 'user').length;
  const users = notes
    .filter(
      (note) =>
        tidyable(note) && note.scope === 'user' && !selected.has(note.id)
    )
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, userSlots);
  return {
    shown: [...users, ...upkeep],
    groups,
    cursor: nextCursor,
    archiveIds: [...archive].filter((id) => selected.has(id)),
    scopeHints: [...scopes].filter(([id]) => selected.has(id)),
  };
}

/** @param {Note} note */
const noteLine = (note) =>
  `- ${note.id} (${kindLabel(note)}${note.pinned ? ', pinned' : ''}, ${note.updated}): ${note.text}${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}`;

/**
 * @param {{ shown: Note[], groups: string[][], archiveIds?: string[], scopeHints?: [string, string][] }} input
 * @returns {string}
 */
export function buildConsolidationPrompt({
  shown,
  groups,
  archiveIds = [],
  scopeHints = [],
}) {
  return `You tidy a personal memory store that coding agents share. Answer with one JSON object and nothing else.

1. Profile: write at most ${PROFILE_MAX} short lines (each under 150 characters) that sum up what the "user" notes below say about the user: preferences, ways of working, how they like to be told things. Facts only, never instructions to an agent, no secrets; nothing a note does not support. [] when there are no user notes.
2. Tidy: merge notes that say the same thing (UPDATE the one to keep with the merged text, DELETE the others with why "merged into <id>"), and DELETE a note that a newer note contradicts or replaces (why "superseded by <id>"). Change nothing else; most notes need no change. Never add notes.
3. Archive inactive material only if it is still useful as history: {"op":"ARCHIVE","id":"t1"}. Only these ids are eligible: ${archiveIds.join(', ') || '(none)'}.
4. Consider these machine notes that name a repository: ${scopeHints.map(([id, name]) => `${id} → ${name}`).join(', ') || '(none)'}. If a note describes the repo itself, return {"op":"RESCOPE","id":"m1"} for human review. Leave genuinely machine-specific facts in machine scope.

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

/** @param {string} dir */
const readNoteOps = (dir) =>
  parseLog(readIfExists(path.join(dir, LOG_FILE)) ?? '').ops;

/** @param {string} at @param {string} session @param {string} id */
const extractionKey = (at, session, id) => JSON.stringify([at, session, id]);

/**
 * Provider sides that require per-run consent for agy or dscc. Also check the
 * prompt notes' add/edit history: an unrelated extraction run cannot establish
 * where those notes came from. Manual, imported and unmatched writes are unknown.
 *
 * @param {string} dir
 * @param {string} side
 * @param {import('./store.js').Op[]} noteOps
 * @param {Note[]} shown
 * @returns {string[]}
 */
function foreignSides(dir, side, noteOps, shown) {
  const sides = new Set();
  const extracted = new Map();
  const consolidated = new Map();
  for (const run of readJournal(dir)) {
    if (typeof run.at !== 'string') continue;
    if (run.status === 'consolidated' && run.job === 'consolidation') {
      consolidated.set(run.at, [
        runSide(run),
        ...(Array.isArray(run.crossSide) ? run.crossSide : ['unknown']),
      ]);
    } else if (
      run.status === 'applied' &&
      typeof run.session === 'string' &&
      Array.isArray(run.changes)
    ) {
      for (const change of run.changes) {
        if (typeof change?.id === 'string') {
          extracted.set(
            extractionKey(run.at, run.session, change.id),
            runSide(run)
          );
        }
      }
    }
  }
  const ids = new Set(shown.map((note) => note.id));
  for (const op of noteOps) {
    if (op.op !== 'add' && op.op !== 'update') continue;
    const id = op.op === 'add' ? op.note?.id : op.id;
    if (typeof id !== 'string' || !ids.has(id)) continue;
    const source = /** @type {import('./store.js').Source | undefined} */ (
      op.op === 'add' ? op.note?.source : op.source
    );
    if (source?.via === 'extract' && typeof source.session === 'string') {
      sides.add(
        extracted.get(extractionKey(op.at, source.session, id)) ?? 'unknown'
      );
    } else if (source?.via === 'consolidate') {
      for (const origin of consolidated.get(op.at) ?? ['unknown'])
        sides.add(origin);
    } else {
      sides.add('unknown');
    }
  }
  sides.delete(side);
  return [...sides];
}

/**
 * Select the candidate prompt and check its provenance from the same log.
 * Status uses this too so it reports the consent the next run will need.
 *
 * @param {string} rootDir
 * @param {string} side
 * @param {Date} now
 */
export function prepareConsolidation(rootDir, side, now) {
  const dir = memoryDir(rootDir);
  const noteOps = side === 'normal' ? null : readNoteOps(dir);
  const notes = noteOps ? replay(noteOps).notes : loadNotes(dir).notes;
  const input = consolidationInput(notes, {
    cursor: readConsolidated(dir)?.cursor,
    now,
    usage: readUsage(dir),
    repo: repoName(rootDir),
  });
  const foreign = noteOps ? foreignSides(dir, side, noteOps, input.shown) : [];
  return { input, foreign };
}

/**
 * The CLI that runs consolidation in this environment: `--extract-agent`,
 * else `KYOTEN_CALLER_HARNESS` (set by hooks so an inner harness beats
 * inherited outer session IDs), else this session's harness or `claude`.
 * Conflicting session IDs without a caller marker require an explicit choice.
 *
 * @param {{ extractAgent?: string | null }} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function consolidationAgent(config, env) {
  if (config.extractAgent) return config.extractAgent;
  const caller = env[CALLER_HARNESS_ENV]?.trim();
  if (caller && CALL_AGENTS.includes(/** @type {any} */ (caller))) {
    return caller;
  }
  if (env.KYOTEN_AGENT === DSCC_AGENT) return 'claude';
  const sessions = sessionHarnesses(env);
  if (sessions.length > 1) return null;
  return sessions[0] ?? 'claude';
}

/**
 * The auto-consolidation policy key for `agent` in `env`: `dscc` when the
 * `claude` CLI runs under the dscc profile, otherwise the agent name itself.
 *
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./config.js').ConsolidateAgent}
 */
export function consolidationPolicyKey(agent, env) {
  return agent === 'claude' && env.KYOTEN_AGENT === DSCC_AGENT
    ? 'dscc'
    : /** @type {import('./config.js').ConsolidateAgent} */ (agent);
}

/**
 * Validate an explicit `--agent` override for manual consolidation, refusing
 * foreign agent harnesses targeting `agy` (Google Antigravity ToS).
 *
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} env
 */
export function validateConsolidateAgent(agent, env) {
  if (!CALL_AGENTS.includes(/** @type {any} */ (agent))) {
    throw new Error(
      `Invalid --agent ${JSON.stringify(agent)}: use ${CALL_AGENTS.join(', ')}.`
    );
  }
  if (agent === 'agy') {
    const caller = foreignHarnessForAgy(env);
    if (caller) {
      throw new Error(
        `Refusing to run consolidation on agy from another agent harness (${caller}): Google Antigravity Terms of Service prohibit invoking agy (headless or agy acp) from third-party agentic CLIs.\nFix: run pnpm memory consolidate --agent agy from your own terminal, or use --agent claude|codex|dsh`
      );
    }
  }
}

/**
 * Run one consolidation (the caller holds the worker lock). Throws when the
 * agent fails.
 *
 * @param {ExtractDeps} deps
 * @returns {Run}
 */
export function consolidate(deps) {
  if (deps.agent !== undefined) {
    validateConsolidateAgent(deps.agent, deps.env);
  }
  const dir = memoryDir(deps.rootDir);
  const now = deps.now();
  const at = now.toISOString();
  const base = { at, job: 'consolidation', session: 'consolidation' };
  const config = readConfig(dir);
  const session = sessionFromEnv(deps.env);
  // The session's own agent, unless --agent or --extract-agent assigns one:
  // one CLI and one provider per session, so a prior run's agent never routes
  // a session to another CLI. It still supplies the model when agent and side
  // match.
  const agent = deps.agent ?? consolidationAgent(config, deps.env);
  if (agent === null) {
    return { ...base, status: 'deferred', policy: 'ambiguous-harness' };
  }
  const side = agentSide(agent, deps.env) ?? 'normal';
  if (!deps.dryRun && !deps.force && savingOff(config, session)) {
    const run = { ...base, status: 'off', side };
    appendJournal(dir, run);
    return run;
  }
  if (agent === 'agy') {
    const tos = deferredRun(agent, null, deps.env, base);
    if (tos) return tos;
  }
  const { input, foreign } = prepareConsolidation(deps.rootDir, side, now);
  const policyAgent = consolidationPolicyKey(agent, deps.env);
  const autoAllowed = config.autoConsolidate[policyAgent];
  const { shown, cursor, archiveIds, scopeHints } = input;
  // Per-agent automatic consolidation policy: claude, codex, dsh, and agy
  // default on (consolidating mixed notes automatically); dscc defaults off
  // (opt-in via `pnpm memory set --auto-consolidate dscc=on` or one-shot
  // `--allow-cross-side` / `--force`). `--dry-run` sends nothing so it is
  // always allowed to preview the prompt.
  if (!deps.dryRun && !autoAllowed && !deps.allowCrossSide && !deps.force) {
    return {
      ...base,
      status: 'deferred',
      side,
      policy: 'disabled',
      policyAgent,
      ...(foreign.length > 0 ? { foreign } : {}),
    };
  }
  if (shown.length === 0) {
    const run = { ...base, status: 'nothing', side };
    if (deps.dryRun) return run;
    writeConsolidated(dir, { at, ops: countOps(dir) });
    appendJournal(dir, run);
    return run;
  }
  const crossSideVia =
    foreign.length > 0 && !autoAllowed && (deps.allowCrossSide || deps.force)
      ? deps.allowCrossSide
        ? '--allow-cross-side'
        : '--force'
      : null;
  const crossSideAuto =
    foreign.length > 0 && autoAllowed && !deps.allowCrossSide;
  const prompt = buildConsolidationPrompt(input);
  const last = lastRun(dir);
  const model = modelFor({
    agent,
    configured: config.extractAgent,
    extractModel: config.extractModel,
    // A model name only fits the provider it ran on: never from the other side.
    ownModel: last?.agent === agent && last.side === side ? last.model : null,
  });
  if (deps.dryRun) {
    return {
      ...base,
      status: 'dry-run',
      side,
      agent,
      model,
      prompt,
      ...(foreign.length > 0 && (deps.allowCrossSide || crossSideVia)
        ? { crossSide: foreign, ...(crossSideVia ? { crossSideVia } : {}) }
        : {}),
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
  const checked = validateOps(ops, {
    related: shown,
    repo: null,
    source,
    archiveIds,
    scopeHints,
  });
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
  writeConsolidated(dir, {
    at,
    ops: countOps(dir),
    ...(cursor ? { cursor } : {}),
  });
  const warnings = writes ? refreshAfterWrite(deps.rootDir) : [];
  const run = {
    ...base,
    status: 'consolidated',
    agent,
    model,
    side,
    ...(side !== 'normal' ? { crossSide: foreign } : {}),
    ...(crossSideVia ? { crossSideVia } : {}),
    ...(crossSideAuto ? { crossSideAuto: true } : {}),
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
    let failedAgent = deps.agent ?? consolidationAgent({}, deps.env);
    if (deps.agent === undefined) {
      try {
        failedAgent = consolidationAgent(readConfig(dir), deps.env);
      } catch {
        // Keep the env-derived agent when config itself failed to load.
      }
    }
    const run = {
      at,
      job: 'consolidation',
      session: 'consolidation',
      status: 'failed',
      side: failedAgent
        ? (agentSide(failedAgent, deps.env) ?? 'normal')
        : 'unknown',
      error: message,
    };
    appendJournal(dir, run);
    return run;
  } finally {
    lock.release();
  }
}
