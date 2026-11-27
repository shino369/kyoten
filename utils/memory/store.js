/**
 * Memory store: an append-only op log, replayed into notes.
 *
 * - `memory/log.jsonl` holds every change as one JSON line: `add`, `update`,
 *   `delete`, `pin`, `check`. It is the journal (history, undo) and the only
 *   source of truth.
 * - `memory/cache/notes.json` is the replay, stamped with the log's size and
 *   mtime; any change to the log rebuilds it. Rebuildable, never edited.
 * - `memory/cache/usage.json` keeps recall counts outside the log, which they
 *   would flood. Best effort: a lost update only skews ranking.
 *
 * Writes run under `memory/.lock`, validate the note, and refuse secrets
 * (utils/redact.js). Adding a near-duplicate of an active note in the same
 * scope and repo updates that note instead. See
 * tasks/memory-system-261120/docs/DESIGN_memory-system.md §5.
 */
import fs from 'fs';
import path from 'path';
import { findSecrets } from '../redact.js';
import { readIfExists, withLock, writeFileAtomic } from '../task/store.js';
import { jaccard, termSet } from './tokenize.js';

export const MEMORY_DIR = 'memory';
export const LOG_FILE = 'log.jsonl';
export const CACHE_DIR = 'cache';
export const NOTES_CACHE_FILE = 'notes.json';
export const USAGE_FILE = 'usage.json';

export const SCOPES = ['user', 'machine', 'repo'];
export const TYPES = ['preference', 'fact', 'howto', 'episode'];
/** Who wrote a note: an agent in the moment (A), extraction (B), a task digest (C), … */
export const VIAS = [
  'agent',
  'user',
  'extract',
  'digest',
  'consolidate',
  'import',
];
export const LIMITS = {
  text: 1000,
  tags: 30,
  tag: 50,
  cues: 5,
  cue: 80,
  triggers: 10,
  trigger: 120,
};
/** Token-set Jaccard at or above which an added note merges into an old one. */
export const DUPLICATE_SIMILARITY = 0.8;
/** Days after which an unchecked fact or how-to counts as stale. */
export const STALE_DAYS = 90;

const CACHE_VERSION = 1;
const DAY_MS = 86_400_000;
const ID_RE = /^[mt][1-9]\d*$/;
const OPS = ['add', 'update', 'delete', 'pin', 'check', 'archive', 'restore'];
const EDITABLE = [
  'text',
  'tags',
  'cues',
  'triggers',
  'triggerMode',
  'type',
  'scope',
  'repo',
];
const SOURCE_FIELDS = /** @type {const} */ (['harness', 'session', 'task']);

/**
 * @typedef {{ via: string, harness?: string, session?: string, task?: string }} Source
 *
 * @typedef {object} NoteFields
 * @property {string} text
 * @property {string} scope `user` · `machine` · `repo`
 * @property {string | null} repo set for repo notes only
 * @property {string} type `preference` · `fact` · `howto` · `episode`
 * @property {string[]} tags
 * @property {string[]} [cues] literal prompt phrases
 * @property {string[]} triggers command or error patterns (PreToolUse)
 * @property {'inject' | 'block'} [triggerMode] defaults to inject
 * @property {Source} source
 * @property {boolean} pinned
 * @property {string | null} supersedes
 *
 * @typedef {NoteFields & {
 *   id: string,
 *   created: string,
 *   updated: string,
 *   checked: string | null,
 *   status: 'active' | 'archived' | 'deleted',
 *   archived?: string,
 *   deleted?: string,
 *   why?: string,
 * }} Note
 *
 * @typedef {object} NoteInput
 * @property {string} text
 * @property {string} scope
 * @property {string | null} [repo]
 * @property {string} type
 * @property {string[]} [tags]
 * @property {string[]} [cues]
 * @property {string[]} [triggers]
 * @property {'inject' | 'block'} [triggerMode]
 * @property {Source} [source]
 * @property {boolean} [pinned]
 * @property {string | null} [supersedes]
 * @property {boolean} [unchecked] store with `checked: null` (imported notes)
 * @property {string} [archived] original archive date when importing a note
 *
 * @typedef {object} Op
 * @property {string} op
 * @property {string} at ISO time
 * @property {string} [id]
 * @property {Record<string, unknown>} [note] add
 * @property {Record<string, unknown>} [set] update
 * @property {string} [why] delete
 * @property {boolean} [pinned] pin
 * @property {Source} [source] update, delete
 *
 * @typedef {{ hits: number, lastHit: string }} Usage
 */

export class MemoryError extends Error {
  /**
   * @param {'invalid' | 'budget' | 'secret' | 'not-found' | 'deleted'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

/** @param {string} rootDir */
export const memoryDir = (rootDir) => path.join(rootDir, MEMORY_DIR);

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new MemoryError('invalid', message);
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {string} value */
const foldCase = (value) => value.normalize('NFKC').toLowerCase();

/**
 * Trimmed, non-empty, unique (case-insensitive) strings.
 *
 * @param {unknown} value
 * @param {string} label singular, e.g. `tag`
 * @param {number} maxCount
 * @param {number} maxLength
 * @returns {string[]}
 */
function normalizeList(value, label, maxCount, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`The ${label}s must be a list.`);
  /** @type {Map<string, string>} */
  const unique = new Map();
  for (const item of value) {
    if (typeof item !== 'string')
      invalid(`Invalid ${label}s: every ${label} must be text.`);
    const trimmed = item.trim();
    if (trimmed.length > maxLength) {
      invalid(
        `A ${label} is over ${maxLength} characters: "${trimmed.slice(0, 40)}…".`
      );
    }
    if (trimmed && !unique.has(foldCase(trimmed)))
      unique.set(foldCase(trimmed), trimmed);
  }
  if (unique.size > maxCount) {
    invalid(`Too many ${label}s: at most ${maxCount} ${label}s.`);
  }
  return [...unique.values()];
}

/**
 * @param {unknown} source
 * @returns {Source}
 */
function normalizeSource(source) {
  if (source === undefined) return { via: 'agent' };
  if (!isObject(source))
    invalid('The source must be an object with a via field.');
  const { via } = /** @type {Record<string, unknown>} */ (source);
  if (typeof via !== 'string' || !VIAS.includes(via)) {
    invalid(`Unknown source "${String(via)}"; use one of: ${VIAS.join(', ')}.`);
  }
  /** @type {Source} */
  const result = { via };
  for (const key of SOURCE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (source)[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') invalid(`The source.${key} must be text.`);
    result[key] = value;
  }
  return result;
}

/**
 * Validate and normalize a note's fields. Throws MemoryError('invalid').
 *
 * @param {any} input
 * @returns {NoteFields & { unchecked: boolean, archived?: string }}
 */
export function normalizeInput(input) {
  if (!isObject(input)) invalid('A note must be an object.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) invalid('The note text is empty.');
  if (text.length > LIMITS.text) {
    invalid(
      `The note is ${text.length} characters; the limit is ${LIMITS.text}. Shorten it or split it into notes.`
    );
  }
  if (termSet(text).size === 0) invalid('The note has no searchable words.');
  if (!SCOPES.includes(input.scope)) {
    invalid(
      `Unknown scope "${input.scope}"; use one of: ${SCOPES.join(', ')}.`
    );
  }
  const repo =
    typeof input.repo === 'string' ? input.repo.trim() : (input.repo ?? null);
  if (input.scope === 'repo' && !repo)
    invalid('A repo note needs a repo (--repo <name>).');
  if (input.scope !== 'repo' && repo !== null) {
    invalid(
      `Only repo notes take a repo; this note's scope is ${input.scope}.`
    );
  }
  if (!TYPES.includes(input.type)) {
    invalid(`Unknown type "${input.type}"; use one of: ${TYPES.join(', ')}.`);
  }
  const pinned = input.pinned ?? false;
  if (typeof pinned !== 'boolean')
    invalid('The pinned field must be true or false.');
  const archived = input.archived;
  if (
    archived !== undefined &&
    (pinned ||
      typeof archived !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(archived) ||
      Number.isNaN(Date.parse(archived)))
  ) {
    invalid('An archived note needs an archive date and cannot be pinned.');
  }
  const supersedes = input.supersedes ?? null;
  if (supersedes !== null && typeof supersedes !== 'string') {
    invalid('The supersedes field must be a note id.');
  }
  const triggerMode = input.triggerMode;
  if (
    triggerMode !== undefined &&
    triggerMode !== 'inject' &&
    triggerMode !== 'block'
  ) {
    invalid('Use --trigger-mode inject or block.');
  }
  return {
    text,
    scope: input.scope,
    repo,
    type: input.type,
    tags: normalizeList(input.tags, 'tag', LIMITS.tags, LIMITS.tag),
    ...(input.cues === undefined
      ? {}
      : {
          cues: normalizeList(input.cues, 'cue', LIMITS.cues, LIMITS.cue),
        }),
    triggers: normalizeList(
      input.triggers,
      'trigger',
      LIMITS.triggers,
      LIMITS.trigger
    ),
    ...(triggerMode === undefined ? {} : { triggerMode }),
    source: normalizeSource(input.source),
    pinned,
    supersedes,
    unchecked: input.unchecked === true,
    ...(archived === undefined ? {} : { archived }),
  };
}

/**
 * @param {unknown} changes
 * @returns {Record<string, unknown>}
 */
function normalizeChanges(changes) {
  if (!isObject(changes)) invalid('The changes must be an object.');
  for (const key of Object.keys(/** @type {object} */ (changes))) {
    if (!EDITABLE.includes(key)) {
      invalid(
        `Cannot change "${key}"; editable fields: ${EDITABLE.join(', ')}.`
      );
    }
  }
  return { .../** @type {object} */ (changes) };
}

/**
 * Refuse a note whose text, tags, cues, or triggers match a secret rule.
 *
 * @param {Pick<NoteFields, 'text' | 'tags' | 'triggers' | 'cues'>} fields
 */
export function assertNoSecrets({ text, tags, cues = [], triggers }) {
  const rules = new Set(
    [text, ...tags, ...cues, ...triggers].flatMap(findSecrets)
  );
  if (rules.size > 0) {
    throw new MemoryError(
      'secret',
      `Refused: the note looks like it holds a secret (${[...rules].join(', ')}). Notes must not hold secrets; save the fact without the value.`
    );
  }
}

/**
 * Apply one op to the notes. Returns a problem, or null when applied.
 *
 * @param {Map<string, Note>} notes
 * @param {Op} op
 * @returns {string | null}
 */
function applyOp(notes, op) {
  if (!isObject(op) || typeof op.at !== 'string') return 'an op without a time';
  const label = `${op.op} ${op.id ?? op.note?.id ?? '?'} at ${op.at}`;
  if (!OPS.includes(op.op)) return `${label}: unknown op`;
  const day = op.at.slice(0, 10);
  try {
    if (op.op === 'add') {
      const id = op.note?.id;
      if (typeof id !== 'string' || !ID_RE.test(id))
        return `${label}: no valid id`;
      if (notes.has(id)) return `${label}: the id is already used`;
      const { unchecked, ...fields } = normalizeInput({
        ...op.note,
        unchecked: op.note?.checked === null,
      });
      notes.set(id, {
        id,
        ...fields,
        created: day,
        updated: day,
        checked: unchecked ? null : day,
        status: fields.archived === undefined ? 'active' : 'archived',
      });
      return null;
    }
    const note = notes.get(/** @type {string} */ (op.id));
    if (!note) return `${label}: unknown note`;
    if (note.status === 'deleted') return `${label}: the note is deleted`;
    if (op.op === 'update') {
      const { text, tags, cues, triggers, triggerMode, type, scope, repo } =
        normalizeInput({
          ...note,
          ...normalizeChanges(op.set),
        });
      Object.assign(note, {
        text,
        tags,
        cues,
        triggers,
        triggerMode,
        type,
        scope,
        repo,
      });
      note.updated = day;
      note.checked = day;
    } else if (op.op === 'delete') {
      Object.assign(note, {
        status: 'deleted',
        deleted: day,
        why: op.why ?? '',
      });
    } else if (op.op === 'pin') {
      note.pinned = op.pinned === true;
    } else if (op.op === 'archive') {
      note.status = 'archived';
      note.archived = day;
    } else if (op.op === 'restore') {
      note.status = 'active';
      delete note.archived;
      note.checked = day;
      note.updated = day;
    } else {
      note.checked = day;
    }
    return null;
  } catch (error) {
    return `${label}: ${/** @type {Error} */ (error).message}`;
  }
}

/**
 * Replay ops into notes (in id order of creation), with the problems found:
 * ops that are malformed or refer to unknown or deleted notes are skipped.
 *
 * @param {Op[]} ops
 * @returns {{ notes: Note[], problems: string[] }}
 */
export function replay(ops) {
  /** @type {Map<string, Note>} */
  const notes = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const op of ops) {
    const problem = applyOp(notes, op);
    if (problem) problems.push(problem);
  }
  return { notes: [...notes.values()], problems };
}

/**
 * @param {string} content
 * @returns {{ ops: Op[], problems: string[] }}
 */
export function parseLog(content) {
  /** @type {Op[]} */
  const ops = [];
  /** @type {string[]} */
  const problems = [];
  content.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      problems.push(`line ${index + 1}: not JSON`);
      return;
    }
    if (isObject(op)) ops.push(op);
    else problems.push(`line ${index + 1}: not an op`);
  });
  return { ops, problems };
}

/**
 * @param {string} file
 * @returns {unknown} the parsed JSON, or null when missing or unreadable
 */
export function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Every note (active and deleted) with the log's problems, from the cache
 * when the log is unchanged, else by replaying the log (and caching it).
 * `stamp` identifies the log state the notes come from (other caches key on
 * it); it is null when there is no log or the log changed while it was read.
 *
 * @param {string} dir the memory directory
 * @returns {{ notes: Note[], problems: string[], stamp: string | null }}
 */
export function loadNotes(dir) {
  const logFile = path.join(dir, LOG_FILE);
  const stat = fs.statSync(logFile, { throwIfNoEntry: false });
  if (!stat) return { notes: [], problems: [], stamp: null };
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cacheFile = path.join(dir, CACHE_DIR, NOTES_CACHE_FILE);
  const cached = /** @type {any} */ (readJsonOrNull(cacheFile));
  if (cached?.version === CACHE_VERSION && cached.stamp === stamp) {
    return { notes: cached.notes, problems: cached.problems, stamp };
  }
  const content = fs.readFileSync(logFile);
  const parsed = parseLog(content.toString('utf-8'));
  const { notes, problems } = replay(parsed.ops);
  const result = { notes, problems: [...parsed.problems, ...problems] };
  // A writer appended between stat and read: the stamp would not match the
  // content, so leave caching to the next reader.
  if (content.length !== stat.size) return { ...result, stamp: null };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileAtomic(
    cacheFile,
    JSON.stringify({ version: CACHE_VERSION, stamp, ...result })
  );
  return { ...result, stamp };
}

/**
 * Every op in the log, oldest first, and the lines that are not ops.
 *
 * @param {string} dir the memory directory
 * @returns {{ ops: Op[], problems: string[] }}
 */
export function readLog(dir) {
  const content = readIfExists(path.join(dir, LOG_FILE));
  return content === null ? { ops: [], problems: [] } : parseLog(content);
}

/**
 * The ops that touched one note, oldest first.
 *
 * @param {string} dir
 * @param {string} id
 * @returns {Op[]}
 */
export function noteHistory(dir, id) {
  return readLog(dir).ops.filter(
    (op) => (op?.op === 'add' ? op.note?.id : op?.id) === id
  );
}

/**
 * Run `fn` on the current notes under the memory lock.
 *
 * @template T
 * @param {string} dir
 * @param {(notes: Map<string, Note>) => T} fn
 * @returns {T}
 */
function mutate(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  return withLock(
    dir,
    () => fn(new Map(loadNotes(dir).notes.map((note) => [note.id, note]))),
    { label: 'Memory' }
  );
}

/**
 * Append an op and apply it to `notes`; returns the note it changed.
 *
 * @param {string} dir
 * @param {Map<string, Note>} notes
 * @param {Op} op
 * @returns {Note}
 */
function commit(dir, notes, op) {
  fs.appendFileSync(
    path.join(dir, LOG_FILE),
    `${JSON.stringify(op)}\n`,
    'utf-8'
  );
  applyOp(notes, op);
  return /** @type {Note} */ (
    notes.get(op.id ?? /** @type {string} */ (op.note?.id))
  );
}

/**
 * @param {Map<string, Note>} notes
 * @param {string} id
 * @returns {Note}
 */
function activeNote(notes, id) {
  const note = notes.get(id);
  if (!note) {
    throw new MemoryError(
      'not-found',
      `No note ${id}. Run pnpm memory list to see the ids.`
    );
  }
  if (note.status === 'deleted')
    throw new MemoryError('deleted', `Note ${id} is deleted.`);
  return note;
}

/**
 * The next id: `t<n>` for a task digest, else `m<n>`, from one sequence.
 *
 * @param {Map<string, Note>} notes
 * @param {string} via
 */
function nextId(notes, via) {
  let max = 0;
  for (const id of notes.keys()) max = Math.max(max, Number(id.slice(1)));
  return `${via === 'digest' ? 't' : 'm'}${max + 1}`;
}

/**
 * The most similar note in the same status, scope and repo, if similar enough
 * to be the same note (ties go to the newer one).
 *
 * @param {Iterable<Note>} notes
 * @param {Pick<NoteFields, 'text' | 'scope' | 'repo'>} fields
 * @param {'active' | 'archived'} [status]
 * @returns {Note | null}
 */
export function findNearDuplicate(notes, fields, status = 'active') {
  const terms = termSet(fields.text);
  /** @type {Note | null} */
  let best = null;
  let bestSimilarity = DUPLICATE_SIMILARITY;
  for (const note of notes) {
    if (
      note.status !== status ||
      note.scope !== fields.scope ||
      note.repo !== fields.repo
    ) {
      continue;
    }
    const similarity = jaccard(terms, termSet(note.text));
    if (similarity >= bestSimilarity) {
      best = note;
      bestSimilarity = similarity;
    }
  }
  return best;
}

/**
 * `a` plus the items of `b` it lacks (case-insensitive), at most `max`.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} max
 */
function joinLists(a, b, max) {
  const seen = new Set(a.map(foldCase));
  return [...a, ...b.filter((item) => !seen.has(foldCase(item)))].slice(0, max);
}

/**
 * Save a note. A near-duplicate of an active note in the same scope and repo
 * updates that note instead (new text and type, tags and triggers joined),
 * unless `merge` is false (task digests: two similar tasks are two notes).
 *
 * @param {string} dir the memory directory
 * @param {NoteInput} input
 * @param {{ now?: Date, merge?: boolean }} [options]
 * @returns {{ action: 'added' | 'merged' | 'unchanged', note: Note }}
 */
export function addNote(dir, input, { now = new Date(), merge = true } = {}) {
  const fields = normalizeInput(input);
  assertNoSecrets(fields);
  const at = now.toISOString();
  return mutate(dir, (notes) => {
    const existing =
      merge && fields.archived === undefined
        ? findNearDuplicate(notes.values(), fields)
        : null;
    if (existing) {
      if (existing.triggerMode === 'block' && automatic(fields.source)) {
        return { action: /** @type {const} */ ('unchanged'), note: existing };
      }
      return mergeInto(dir, notes, existing, fields, at);
    }
    const { unchecked, ...rest } = fields;
    const id = nextId(notes, fields.source.via);
    const note = commit(dir, notes, {
      op: 'add',
      at,
      note: { id, ...rest, ...(unchecked ? { checked: null } : {}) },
    });
    return { action: /** @type {const} */ ('added'), note };
  });
}

/**
 * @param {string} dir
 * @param {Map<string, Note>} notes
 * @param {Note} existing
 * @param {NoteFields} fields
 * @param {string} at
 * @returns {{ action: 'merged' | 'unchanged', note: Note }}
 */
function mergeInto(dir, notes, existing, fields, at) {
  /** @type {Record<string, unknown>} */
  const set = {};
  if (fields.text !== existing.text) set.text = fields.text;
  if (fields.type !== existing.type) set.type = fields.type;
  const tags = joinLists(existing.tags, fields.tags, LIMITS.tags);
  if (tags.length !== existing.tags.length) set.tags = tags;
  const cues = joinLists(existing.cues ?? [], fields.cues ?? [], LIMITS.cues);
  if (cues.length !== (existing.cues?.length ?? 0)) set.cues = cues;
  if (
    fields.triggerMode !== undefined &&
    fields.triggerMode !== existing.triggerMode
  ) {
    set.triggerMode = fields.triggerMode;
  }
  if (fields.triggerMode === 'block') {
    if (JSON.stringify(fields.triggers) !== JSON.stringify(existing.triggers)) {
      set.triggers = fields.triggers;
    }
  } else if (
    existing.triggerMode !== 'block' ||
    fields.triggerMode === 'inject'
  ) {
    const triggers = joinLists(
      existing.triggers,
      fields.triggers,
      LIMITS.triggers
    );
    if (triggers.length !== existing.triggers.length) set.triggers = triggers;
  }
  const update = Object.keys(set).length > 0;
  const pin = fields.pinned && !existing.pinned;
  const { id } = existing;
  // commit applies each op to `existing` itself (it is the object in `notes`).
  if (update)
    commit(dir, notes, { op: 'update', id, at, set, source: fields.source });
  if (pin) commit(dir, notes, { op: 'pin', id, at, pinned: true });
  return { action: update || pin ? 'merged' : 'unchanged', note: existing };
}

/** @param {Source} source */
const automatic = (source) =>
  source.via === 'extract' || source.via === 'consolidate';

/** @param {Note} note @param {Source} source */
function protectBlockingNote(note, source) {
  if (note.triggerMode === 'block' && automatic(source)) {
    invalid(`${note.id} has a blocking trigger and needs a manual edit.`);
  }
}

/**
 * Change a note's text, tags, triggers, type, scope, or repo. Writes nothing
 * when the values are already the same.
 *
 * @param {string} dir
 * @param {string} id
 * @param {Partial<Pick<NoteFields, 'text' | 'tags' | 'cues' | 'triggers' | 'triggerMode' | 'type' | 'scope' | 'repo'>>} changes
 * @param {{ now?: Date, source?: Source }} [options]
 * @returns {Note}
 */
export function updateNote(
  dir,
  id,
  changes,
  { now = new Date(), source } = {}
) {
  const set = normalizeChanges(changes);
  const by = normalizeSource(source);
  return mutate(dir, (notes) => {
    const note = activeNote(notes, id);
    protectBlockingNote(note, by);
    const next = normalizeInput({ ...note, ...set });
    assertNoSecrets(next);
    /** @type {Record<string, unknown>} */
    const diff = {};
    for (const key of Object.keys(set)) {
      const value = next[/** @type {keyof NoteFields} */ (key)];
      if (
        JSON.stringify(value) !==
        JSON.stringify(note[/** @type {keyof Note} */ (key)])
      ) {
        diff[key] = value;
      }
    }
    if (Object.keys(diff).length === 0) return note;
    return commit(dir, notes, {
      op: 'update',
      id,
      at: now.toISOString(),
      set: diff,
      source: by,
    });
  });
}

/**
 * Transfer searchable metadata while both records are locked. An intervening
 * edit or an overflowing metadata list leaves the source in active recall.
 *
 * @param {string} dir
 * @param {Map<string, Note>} notes
 * @param {Note} note being retired
 * @param {{ keeper: Note, sourceText: string }} merge
 * @param {string} at
 * @param {Source} source
 */
function keepMergeMetadata(dir, notes, note, merge, at, source) {
  const keeper = activeNote(notes, merge.keeper.id);
  if (
    keeper.id === note.id ||
    keeper.status !== 'active' ||
    note.status !== 'active' ||
    keeper.text !== merge.keeper.text ||
    note.text !== merge.sourceText ||
    keeper.scope !== note.scope ||
    keeper.repo !== note.repo ||
    note.pinned
  ) {
    invalid(`The source or keeper changed before retiring ${note.id}.`);
  }
  protectBlockingNote(keeper, source);
  const tags = joinLists(keeper.tags, note.tags, Infinity);
  const cues = joinLists(keeper.cues ?? [], note.cues ?? [], Infinity);
  const triggers = joinLists(keeper.triggers, note.triggers, Infinity);
  if (
    tags.length === keeper.tags.length &&
    cues.length === (keeper.cues?.length ?? 0) &&
    triggers.length === keeper.triggers.length
  )
    return;
  const metadata = { tags, cues, triggers };
  assertNoSecrets(normalizeInput({ ...keeper, ...metadata }));
  commit(dir, notes, {
    op: 'update',
    id: keeper.id,
    at,
    set: metadata,
    source,
  });
}

/**
 * Mark a note deleted. It stays in the log (history, undo) and in loadNotes
 * with `status: 'deleted'`, but is no longer recalled or merged into.
 *
 * @param {string} dir
 * @param {string} id
 * @param {string} why
 * @param {{ now?: Date, source?: Source, merge?: { keeper: Note, sourceText: string } }} [options]
 * @returns {Note}
 */
export function deleteNote(
  dir,
  id,
  why,
  { now = new Date(), source, merge } = {}
) {
  const reason = why.trim();
  if (!reason) invalid(`Give a reason for deleting ${id} (-m "why").`);
  const by = normalizeSource(source);
  const at = now.toISOString();
  return mutate(dir, (notes) => {
    const note = activeNote(notes, id);
    protectBlockingNote(note, by);
    if (merge) keepMergeMetadata(dir, notes, note, merge, at, by);
    return commit(dir, notes, {
      op: 'delete',
      id,
      at,
      why: reason,
      source: by,
    });
  });
}

/** @param {Note} note @param {Date} now @param {Usage} [usage] */
export function canArchive(note, now, usage) {
  if (note.status !== 'active' || note.pinned || note.triggerMode === 'block')
    return false;
  const daysSince = (/** @type {string} */ date) =>
    (now.getTime() - Date.parse(date)) / DAY_MS;
  if (note.source.via === 'digest') return daysSince(note.updated) > 30;
  return isStale(note, now) && daysSince(usage?.lastHit ?? note.updated) > 60;
}

/** @param {string} dir @param {string} id @param {Date} now */
export function archiveNote(dir, id, now) {
  return mutate(dir, (notes) => {
    const note = activeNote(notes, id);
    if (!canArchive(note, now, readUsage(dir)[id]))
      invalid(`${id} is no longer eligible for archiving.`);
    return commit(dir, notes, { op: 'archive', id, at: now.toISOString() });
  });
}

/** @param {string} dir @param {string} id @param {Date} [now] */
export function restoreNote(dir, id, now = new Date()) {
  return mutate(dir, (notes) => {
    const note = activeNote(notes, id);
    if (note.status === 'active') return note;
    return commit(dir, notes, { op: 'restore', id, at: now.toISOString() });
  });
}

/**
 * @param {string} dir
 * @param {string} id
 * @param {boolean} pinned
 * @param {{ now?: Date }} [options]
 * @returns {Note}
 */
export function setPinned(dir, id, pinned, { now = new Date() } = {}) {
  return mutate(dir, (notes) => {
    const note = activeNote(notes, id);
    if (pinned && note.status === 'archived')
      invalid(`Restore ${id} before pinning it.`);
    if (note.pinned === pinned) return note;
    return commit(dir, notes, { op: 'pin', id, at: now.toISOString(), pinned });
  });
}

/**
 * Record that a note was confirmed today (it is no longer stale or unchecked).
 *
 * @param {string} dir
 * @param {string} id
 * @param {{ now?: Date }} [options]
 * @returns {Note}
 */
export function checkNote(dir, id, { now = new Date() } = {}) {
  return mutate(dir, (notes) => {
    activeNote(notes, id);
    return commit(dir, notes, { op: 'check', id, at: now.toISOString() });
  });
}

/**
 * Whether a fact or how-to needs re-checking: never checked (imported), or
 * last checked more than `maxAgeDays` ago. Preferences and episodes are never
 * stale.
 *
 * @param {Pick<Note, 'type' | 'checked'>} note
 * @param {Date} [now]
 * @param {number} [maxAgeDays]
 */
export function isStale(note, now = new Date(), maxAgeDays = STALE_DAYS) {
  if (note.type === 'preference' || note.type === 'episode') return false;
  if (note.checked === null) return true;
  return (
    (now.getTime() - Date.parse(`${note.checked}T00:00:00Z`)) / DAY_MS >
    maxAgeDays
  );
}

/**
 * @param {string} dir
 * @returns {Record<string, Usage>}
 */
export function readUsage(dir) {
  const data = readJsonOrNull(path.join(dir, CACHE_DIR, USAGE_FILE));
  return isObject(data) ? /** @type {Record<string, Usage>} */ (data) : {};
}

/**
 * Count one recall for each id. Not locked: concurrent hooks may lose a
 * count, which only nudges ranking.
 *
 * @param {string} dir
 * @param {string[]} ids
 * @param {Date} [now]
 */
export function recordHits(dir, ids, now = new Date()) {
  if (ids.length === 0) return;
  const usage = readUsage(dir);
  for (const id of ids) {
    const hits = usage[id]?.hits;
    usage[id] = {
      hits: typeof hits === 'number' ? hits + 1 : 1,
      lastHit: now.toISOString(),
    };
  }
  const file = path.join(dir, CACHE_DIR, USAGE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(usage));
}
