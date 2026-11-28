/**
 * Tests for utils/memory/consolidate.js (path D: merge, retire, profile)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../config.js';
import {
  CONSOLIDATED_FILE,
  MAX_SHOWN,
  MIN_CHANGES,
  PROFILE_MAX,
  buildConsolidationPrompt,
  cleanProfile,
  consolidate,
  consolidateLocked,
  consolidationDue,
  consolidationInput,
  countOps,
  parseConsolidation,
  readConsolidated,
  similarGroups,
} from '../consolidate.js';
import { appendJournal, readInbox, readJournal, tryLock } from '../queue.js';
import { PROFILE_FILE, initLocal } from '../render.js';
import { listSnapshots } from '../snapshot.js';
import {
  addNote,
  loadNotes,
  memoryDir,
  setPinned,
  updateNote,
} from '../store.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;

const NOW = new Date('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consolidate-'))
  );
  dir = memoryDir(root);
  initLocal(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {any} input @param {Date} [now] */
const add = (input, now = NOW) =>
  addNote(dir, { scope: 'machine', type: 'fact', ...input }, { now }).note;

/** @param {unknown} answer @param {object} [extra] */
const agentReturning = (answer, extra = {}) =>
  vi.fn(() => {
    const stdout = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return {
      code: 0,
      signal: null,
      stdout,
      output: stdout,
      durationMs: 9,
      ...extra,
    };
  });

/** @param {any} [overrides] */
const deps = (overrides = {}) => ({
  rootDir: root,
  env: {},
  now: () => NOW,
  runAgent: agentReturning({ profile: [], ops: [] }),
  tmpdir: () => root,
  lock: { isAlive: () => true },
  ...overrides,
});

/**
 * A store with a user note and two notes that say the same thing.
 * @param {'normal' | 'dscc' | 'agy'} [side] record an extraction that added the notes
 * @param {string} [agent] override the extractor recorded in the journal
 */
function seed(side, agent) {
  const session = `seed-${side}`;
  const harness = side === 'agy' ? 'agy' : 'claude';
  const source = side ? { via: 'extract', session, harness } : undefined;
  const user = add({
    scope: 'user',
    type: 'preference',
    text: 'The user prefers short answers.',
    tags: ['style'],
    source,
  });
  const a = add({
    text: 'The office proxy blocks GitHub GraphQL requests.',
    tags: ['proxy'],
    source,
  });
  const b = add({
    text: 'GitHub GraphQL requests are blocked by the office proxy here.',
    tags: ['graphql'],
    source,
  });
  if (side) {
    appendJournal(dir, {
      at: NOW.toISOString(),
      status: 'applied',
      side,
      agent: agent ?? harness,
      session,
      changes: [user, a, b].map(({ id }) => ({ action: 'added', id })),
    });
  }
  return { user, a, b };
}

describe('countOps and readConsolidated', () => {
  test('should count the log lines, and read no state before a first run', () => {
    expect(countOps(dir)).toBe(0);
    seed();

    expect(countOps(dir)).toBe(3);
    expect(readConsolidated(dir)).toBeNull();
  });
});

describe('consolidationDue', () => {
  /** @param {object} state */
  const writeState = (state) => {
    fs.mkdirSync(path.join(dir, 'extract'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extract', CONSOLIDATED_FILE),
      JSON.stringify(state)
    );
  };

  test('should wait for enough changes before a first run', () => {
    seed();
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });

    expect(consolidationDue(root, { now: NOW })).toBe('weekly');
  });

  test('should wait a week and enough changes after the last run', () => {
    for (let i = 0; i < MIN_CHANGES + 2; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    writeState({ at: new Date(NOW.getTime() - 3 * DAY).toISOString(), ops: 0 });
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    writeState({
      at: new Date(NOW.getTime() - 8 * DAY).toISOString(),
      ops: 10,
    });
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    writeState({ at: new Date(NOW.getTime() - 8 * DAY).toISOString(), ops: 0 });
    expect(consolidationDue(root, { now: NOW })).toBe('weekly');
  });

  test('should run daily while the core block is over budget', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, budget: 1000 });
    for (let i = 0; i < 12; i++) {
      setPinned(
        dir,
        add({
          text: `Pinned fact ${i}: ${'detail '.repeat(15)}`,
          tags: [`p${i}`],
        }).id,
        true
      );
    }
    writeState({
      at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      ops: 1000,
    });
    expect(consolidationDue(root, { now: NOW })).toBe('over budget');

    writeState({
      at: new Date(NOW.getTime() - DAY / 2).toISOString(),
      ops: 1000,
    });
    expect(consolidationDue(root, { now: NOW })).toBeNull();
  });

  test('should wait a day after a failed attempt', () => {
    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    writeState({ tried: new Date(NOW.getTime() - DAY / 2).toISOString() });

    expect(consolidationDue(root, { now: NOW })).toBeNull();
  });

  test('should not be due while saving is off, and be due again once it is on', () => {
    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });

    expect(consolidationDue(root, { now: NOW })).toBeNull();

    writeConfig(dir, { ...DEFAULT_CONFIG, off: false });

    expect(consolidationDue(root, { now: NOW })).toBe('weekly');
  });

  test('should not be due when the config cannot be read', () => {
    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    fs.writeFileSync(path.join(dir, 'config.json'), '{oops');

    expect(consolidationDue(root, { now: NOW })).toBeNull();
  });

  test('should use the current time and stay quiet before memory exists', () => {
    fs.rmSync(dir, { recursive: true });

    expect(consolidationDue(root)).toBeNull();
  });
});

describe('similarGroups and consolidationInput', () => {
  test('should group notes that share most words, within one scope and repo', () => {
    const { a, b } = seed();
    add({
      scope: 'repo',
      repo: 'web',
      text: 'The office proxy blocks GitHub GraphQL requests.',
    });

    expect(similarGroups(loadNotes(dir).notes)).toEqual([[a.id, b.id]]);
  });

  test('should show user notes and groups, without digests or deleted notes', () => {
    const { user, a, b } = seed();
    addNote(
      dir,
      {
        scope: 'machine',
        type: 'episode',
        text: 'Task x: done.',
        source: { via: 'digest', task: 'x' },
      },
      { now: NOW }
    );

    const { shown, groups } = consolidationInput(loadNotes(dir).notes, {
      now: NOW,
    });

    expect(shown.map((note) => note.id)).toEqual([user.id, a.id, b.id]);
    expect(groups).toEqual([[a.id, b.id]]);
  });

  test('should reserve room for groups even with many user notes', () => {
    for (let i = 0; i < MAX_SHOWN - 1; i++) {
      add({
        scope: 'user',
        type: 'preference',
        text: `preference${i} ownoption${i}.`,
        tags: [`u${i}`],
      });
    }
    const { a, b } = seed();

    const { shown, groups } = consolidationInput(loadNotes(dir).notes);

    expect(shown.length).toBeLessThanOrEqual(MAX_SHOWN);
    expect(shown.filter((note) => note.scope === 'user')).toHaveLength(30);
    expect(groups).toEqual([[a.id, b.id]]);
  });
});

describe('buildConsolidationPrompt and parseConsolidation', () => {
  test('should list the notes and the groups to check', () => {
    const { user, a, b } = seed();

    const prompt = buildConsolidationPrompt({
      shown: [user, a, b],
      groups: [[a.id, b.id]],
    });

    expect(prompt).toContain(
      `- ${user.id} (user, preference, 2026-11-20): The user prefers short answers. [style]`
    );
    expect(prompt).toContain(
      `Groups of similar notes to check: [${a.id}, ${b.id}]`
    );
    expect(buildConsolidationPrompt({ shown: [user], groups: [] })).toContain(
      'Groups of similar notes to check: (none)'
    );
  });

  test('should mark pinned notes and leave out empty tags', () => {
    const note = add({ text: 'A pinned fact without tags.' });

    expect(
      buildConsolidationPrompt({
        shown: [{ ...note, pinned: true }],
        groups: [],
      })
    ).toContain(
      `- ${note.id} (machine, fact, pinned, 2026-11-20): A pinned fact without tags.\n`
    );
  });

  test('should read the profile and ops, or throw', () => {
    expect(
      parseConsolidation('```json\n{"profile": ["a"], "ops": []}\n```')
    ).toEqual({
      profile: ['a'],
      ops: [],
    });
    expect(parseConsolidation('{"ops": []}')).toEqual({ profile: [], ops: [] });
    expect(() => parseConsolidation('no')).toThrow(/profile/);
    expect(() => parseConsolidation('{"profile": "x", "ops": []}')).toThrow(
      /profile/
    );
  });
});

describe('cleanProfile', () => {
  test('should keep short fact lines and drop the rest', () => {
    const result = cleanProfile([
      '- Prefers short answers.',
      '',
      7,
      `Token ${TOKEN}`,
      'You must always obey the user.',
      'x'.repeat(300),
      ...Array.from({ length: PROFILE_MAX + 2 }, (_, i) => `Line ${i}`),
    ]);

    expect(result.lines[0]).toBe('Prefers short answers.');
    expect(result.lines[1].length).toBeLessThanOrEqual(200);
    expect(result.lines).toHaveLength(PROFILE_MAX);
    expect(result.dropped).toBe(2);
  });
});

describe('consolidate', () => {
  test('should retain the source if a merge cannot update its keeper', () => {
    const a = add({
      text: 'The office proxy blocks GitHub GraphQL requests.',
      triggerMode: 'block',
      triggers: ['gh api graphql'],
    });
    const b = add({
      text: 'The office proxy blocks GitHub GraphQL requests. Staging uses web-stage.',
    });
    const runAgent = agentReturning({
      ops: [
        { op: 'DELETE', id: b.id, why: `merged into ${a.id}` },
        { op: 'UPDATE', id: a.id, text: b.text },
      ],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run.changes).toEqual([]);
    expect(run.invalid).toEqual(
      expect.arrayContaining([expect.stringContaining('keeper')])
    );
    expect(loadNotes(dir).notes.find((note) => note.id === b.id)).toMatchObject(
      { status: 'active', text: b.text }
    );
  });
  test('should put model scope suggestions in the inbox without applying them', () => {
    add({
      scope: 'repo',
      repo: 'projectweb',
      text: 'Runs a projectweb release.',
    });
    const note = add({
      text: 'The projectweb repository uses a release manifest.',
    });
    const runAgent = agentReturning({ ops: [{ op: 'RESCOPE', id: note.id }] });

    expect(consolidate(deps({ runAgent })).quarantined).toBe(1);
    expect(readInbox(dir)).toMatchObject([
      {
        op: 'RESCOPE',
        id: note.id,
        changes: { scope: 'repo', repo: 'projectweb' },
      },
    ]);
    expect(
      loadNotes(dir).notes.find((item) => item.id === note.id)?.scope
    ).toBe('machine');
  });
  test('should archive an eligible digest, retain its text, and create a snapshot', () => {
    const old = add(
      {
        text: 'Delivered the basil recipe.',
        type: 'episode',
        source: { via: 'digest' },
      },
      new Date(NOW.getTime() - 31 * DAY)
    );
    const recent = add({
      text: 'Delivered the mint recipe.',
      type: 'episode',
      source: { via: 'digest' },
    });
    const runAgent = agentReturning({
      ops: [
        { op: 'ARCHIVE', id: old.id },
        { op: 'ARCHIVE', id: recent.id },
      ],
    });

    expect(consolidate(deps({ runAgent })).changes).toEqual([
      expect.objectContaining({ action: 'archived', id: old.id }),
    ]);
    expect(loadNotes(dir).notes).toEqual([
      expect.objectContaining({ status: 'archived', text: old.text }),
      expect.objectContaining({ status: 'active' }),
    ]);
    expect(listSnapshots(root)[0].reason).toBe('consolidate');
  });

  test('should rotate through groups even with over thirty user notes', () => {
    for (let i = 0; i < 65; i++)
      add({
        scope: 'user',
        type: 'preference',
        text: `preference${i} ownoption${i}.`,
      });
    for (let i = 0; i < 20; i++) {
      const key = `compoundxyz${i}`;
      add({
        scope: 'repo',
        repo: key,
        text: `${key} builds use cache where enabled.`,
        tags: ['build cache'],
      });
      add({
        scope: 'repo',
        repo: key,
        text: `${key} builds cache artifacts using enabled settings.`,
        tags: ['build cache'],
      });
    }
    const first = consolidate(deps({ dryRun: true }));
    consolidate(deps());
    const second = consolidate(deps({ dryRun: true }));

    expect(first.prompt).toContain('compoundxyz0');
    expect(first.prompt).not.toContain('compoundxyz19');
    expect(second.prompt).toContain('compoundxyz19');
  });
  test('should merge, retire, and rewrite the profile after a snapshot', () => {
    const { a, b } = seed();
    updateNote(
      dir,
      a.id,
      { type: 'howto', cues: ['merge PR'], triggers: ['git merge'] },
      { now: NOW }
    );
    updateNote(
      dir,
      b.id,
      { cues: ['pull request'], triggers: ['gh pr'] },
      { now: NOW }
    );
    const runAgent = agentReturning({
      profile: ['Prefers short answers.'],
      ops: [
        {
          op: 'UPDATE',
          id: a.id,
          text: 'The office proxy blocks GitHub GraphQL requests (gh pr create fails).',
          tags: ['replacement'],
          cues: ['triage PR'],
          triggers: ['git status'],
        },
        { op: 'DELETE', id: b.id, why: `merged into ${a.id}` },
        { op: 'ADD', scope: 'user', type: 'fact', text: 'New fact.' },
      ],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({
      job: 'consolidation',
      status: 'consolidated',
      profile: 1,
      invalid: ['op 3: consolidation does not add notes'],
      changes: [
        expect.objectContaining({ action: 'updated', id: a.id }),
        expect.objectContaining({ action: 'deleted', id: b.id }),
      ],
    });
    expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8')).toBe(
      '- Prefers short answers.\n'
    );
    expect(
      fs.readFileSync(path.join(root, 'AGENTS.local.md'), 'utf-8')
    ).toContain('Prefers short answers.');
    expect(listSnapshots(root)[0].reason).toBe('consolidate');
    expect(readConsolidated(dir)).toEqual({
      at: NOW.toISOString(),
      ops: countOps(dir),
    });
    expect(readJournal(dir)).toEqual([
      expect.objectContaining({ status: 'consolidated' }),
    ]);
    const updated = loadNotes(dir).notes.find((note) => note.id === a.id);
    expect(updated?.source.via).not.toBe('consolidate');
    expect(updated).toMatchObject({
      tags: ['proxy', 'graphql'],
      cues: ['merge PR', 'pull request'],
      triggers: ['git merge', 'gh pr'],
    });
  });

  test('should hold back a pinned delete and keep the old profile when none comes', () => {
    const { a } = seed();
    setPinned(dir, a.id, true);
    fs.writeFileSync(path.join(dir, PROFILE_FILE), '- old profile\n');
    const runAgent = agentReturning({
      ops: [{ op: 'DELETE', id: a.id, why: 'dup' }],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({ quarantined: 1, profile: 0, snapshot: null });
    expect(readInbox(dir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8')).toBe(
      '- old profile\n'
    );
  });

  test('should use the configured model, else the last session model', () => {
    seed();
    appendJournal(dir, { at: 'x', status: 'applied', model: 'session-model' });
    const runAgent = agentReturning({ profile: [], ops: [] });

    consolidate(deps({ runAgent }));
    writeConfig(dir, { ...DEFAULT_CONFIG, extractModel: 'claude-sonnet-5-5' });
    consolidate(deps({ runAgent }));

    const models = runAgent.mock.calls.map((call) =>
      /** @type {any} */ (call)[0].command.args.at(-1)
    );
    expect(models).toEqual(['session-model', 'claude-sonnet-5-5']);
  });

  describe('the consolidation agent', () => {
    /** @param {import('vitest').Mock} runAgent */
    const lastCall = (runAgent) =>
      /** @type {any} */ (runAgent.mock.calls.at(-1))[0];
    const answering = () => agentReturning({ profile: [], ops: [] });

    test('should default to claude without a journal or session harness', () => {
      seed();
      const runAgent = answering();

      const run = consolidate(deps({ runAgent }));

      expect(lastCall(runAgent).command.agent).toBe('claude');
      expect(run).toMatchObject({ agent: 'claude', model: null });
    });

    test('should use the session harness when there is no prior journal run', () => {
      seed();
      const runAgent = answering();

      const run = consolidate(
        deps({ runAgent, env: { DSH_SESSION_ID: 'dsh-1' } })
      );

      expect(lastCall(runAgent).command.agent).toBe('dsh');
      expect(run).toMatchObject({ agent: 'dsh', model: null });
    });

    test('should treat an old journal line without agent as claude', () => {
      seed();
      appendJournal(dir, { at: 'x', status: 'applied', model: 'old-model' });

      const run = consolidate(deps({ runAgent: answering() }));

      expect(run).toMatchObject({ agent: 'claude', model: 'old-model' });
    });

    test('should use the session harness, not the last applied run', () => {
      seed();
      appendJournal(dir, {
        at: 'x',
        status: 'applied',
        agent: 'agy',
        model: 'gemini-3.8-flash-low',
      });
      appendJournal(dir, { at: 'y', status: 'failed', error: 'boom' });
      const runAgent = answering();

      const run = consolidate(deps({ runAgent }));

      expect(lastCall(runAgent).command.agent).toBe('claude');
      expect(lastCall(runAgent).command.args).not.toContain('--model');
      expect(run).toMatchObject({ agent: 'claude', model: null });
    });

    test('should omit any legacy journal model when consolidating on dsh', () => {
      seed();
      appendJournal(dir, {
        at: 'x',
        status: 'applied',
        agent: 'dsh',
        model: 'deepseek-v4',
      });
      const runAgent = answering();

      const run = consolidate(
        deps({ runAgent, env: { DSH_SESSION_ID: 'dsh-1' } })
      );

      expect(lastCall(runAgent).command.agent).toBe('dsh');
      expect(lastCall(runAgent).command.args).not.toContain('--model');
      expect(run).toMatchObject({ agent: 'dsh', model: null });
    });

    test('should pair extractModel with the default agent, not the last run', () => {
      seed();
      appendJournal(dir, {
        at: 'x',
        status: 'applied',
        agent: 'agy',
        model: 'gemini-3.8-flash-low',
      });
      writeConfig(dir, {
        ...DEFAULT_CONFIG,
        extractModel: 'claude-sonnet-5-5',
      });

      const run = consolidate(deps({ runAgent: answering() }));

      expect(run).toMatchObject({
        agent: 'claude',
        model: 'claude-sonnet-5-5',
      });
    });

    test('should use the configured agent over the session harness', () => {
      seed();
      writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'dsh' });
      const runAgent = answering();

      const run = consolidate(
        deps({ runAgent, env: { CLAUDE_CODE_SESSION_ID: 'cc-1' } })
      );

      expect(lastCall(runAgent).command.agent).toBe('dsh');
      expect(run).toMatchObject({ agent: 'dsh', model: null });
    });

    test('should pair extractModel with the configured agent', () => {
      seed('agy');
      writeConfig(dir, {
        ...DEFAULT_CONFIG,
        extractAgent: 'agy',
        extractModel: 'gemini-3.8-flash-low',
      });

      const run = consolidate(deps({ runAgent: answering() }));

      expect(run).toMatchObject({
        agent: 'agy',
        model: 'gemini-3.8-flash-low',
      });
    });

    test('should report the agent on a dry run', () => {
      seed();
      appendJournal(dir, { at: 'x', status: 'applied', agent: 'dsh' });

      const run = consolidate(
        deps({ dryRun: true, env: { DSH_SESSION_ID: 'dsh-1' } })
      );

      expect(run).toMatchObject({ agent: 'dsh', model: null });
    });

    test('should not follow a prior agy run from a foreign harness, and should defer explicit extractAgent=agy', () => {
      seed();
      appendJournal(dir, {
        at: 'x',
        status: 'applied',
        agent: 'agy',
        model: 'gemini-3.8-flash-low',
      });
      const runAgent = answering();

      // Unconfigured extractAgent: a Claude worker falls back to claude instead of calling agy.
      const claudeRun = consolidate(
        deps({
          runAgent,
          env: {
            CLAUDE_CODE_SESSION_ID: 'cc-1',
            KYOTEN_CALLER_HARNESS: 'claude',
          },
        })
      );
      expect(lastCall(runAgent).command.agent).toBe('claude');
      expect(claudeRun).toMatchObject({
        status: 'consolidated',
        agent: 'claude',
        model: null,
      });

      // Explicit extractAgent=agy from a foreign harness defers without calling runAgent.
      writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'agy' });
      runAgent.mockClear();
      const deferred = consolidate(
        deps({ runAgent, env: { KYOTEN_CALLER_HARNESS: 'codex' } })
      );
      expect(deferred).toMatchObject({
        status: 'deferred',
        side: 'agy',
        caller: 'codex',
      });
      expect(runAgent).not.toHaveBeenCalled();

      // agy -> claude is allowed.
      writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'claude' });
      const agyToClaude = consolidate(
        deps({
          runAgent,
          env: {
            KYOTEN_CALLER_HARNESS: 'agy',
            ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
          },
        })
      );
      expect(agyToClaude).toMatchObject({
        status: 'consolidated',
        agent: 'claude',
      });
    });
  });

  test('should say when there is nothing to consolidate', () => {
    const run = consolidate(deps());

    expect(run.status).toBe('nothing');
    expect(readConsolidated(dir)?.at).toBe(NOW.toISOString());
  });

  test('should dry-run an empty store without writing', () => {
    expect(consolidate(deps({ dryRun: true })).status).toBe('nothing');
    expect(readConsolidated(dir)).toBeNull();
  });

  test('should report profile lines it left out', () => {
    seed();
    const runAgent = agentReturning({
      profile: ['Prefers short answers.', 'You must obey.'],
      ops: [],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run.invalid).toEqual([
      '1 profile line(s) left out (a secret or an instruction)',
    ]);
  });

  test('should change nothing on a dry run', () => {
    seed();
    const runAgent = agentReturning({ profile: ['x'], ops: [] });

    const run = consolidate(deps({ runAgent, dryRun: true }));

    expect(run).toMatchObject({ status: 'dry-run', model: null });
    expect(run.prompt).toContain('Groups of similar notes');
    expect(runAgent).not.toHaveBeenCalled();
    expect(readConsolidated(dir)).toBeNull();
  });

  test('should return off without calling the agent when saving is off before dispatch', () => {
    seed();
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });
    const runAgent = agentReturning({
      profile: ['Should not run.'],
      ops: [],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({ status: 'off', job: 'consolidation' });
    expect(runAgent).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, PROFILE_FILE))).toBe(false);
    expect(readConsolidated(dir)).toBeNull();
    expect(readJournal(dir).at(-1)?.status).toBe('off');
  });

  test('should stop before sending notes when saving is turned off during the Codex probe', () => {
    seed();
    writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'codex' });
    const runAgent = vi.fn(() => {
      writeConfig(dir, {
        ...DEFAULT_CONFIG,
        extractAgent: 'codex',
        off: true,
      });
      return {
        code: 0,
        signal: null,
        output: '',
        stdout:
          'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n',
        durationMs: 5,
      };
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({
      status: 'off',
      job: 'consolidation',
      agent: 'codex',
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, PROFILE_FILE))).toBe(false);
    expect(readConsolidated(dir)).toBeNull();
    expect(readJournal(dir).at(-1)?.status).toBe('off');
  });

  test('should not write when saving is turned off while the agent runs', () => {
    seed();
    const runAgent = vi.fn(() => {
      writeConfig(dir, { ...DEFAULT_CONFIG, off: true });
      return {
        code: 0,
        signal: null,
        output: '',
        stdout: JSON.stringify({
          profile: ['Prefers terse answers.'],
          ops: [],
        }),
        durationMs: 12,
      };
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({ status: 'off', job: 'consolidation' });
    expect(fs.existsSync(path.join(dir, PROFILE_FILE))).toBe(false);
    expect(readConsolidated(dir)).toBeNull();
    expect(readJournal(dir).at(-1)?.status).toBe('off');
  });

  test('should write when forced even if saving is turned off', () => {
    seed();
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });
    const runAgent = agentReturning({
      profile: ['Prefers terse answers.'],
      ops: [],
    });

    const run = consolidate(deps({ runAgent, force: true }));

    expect(run.status).toBe('consolidated');
    expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8')).toBe(
      '- Prefers terse answers.\n'
    );
  });
});

describe('consolidation policy and sides', () => {
  const disableAgy = () =>
    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      autoConsolidate: { ...DEFAULT_CONFIG.autoConsolidate, agy: false },
    });

  test('should report unknown provenance for a note rewritten by an unaudited legacy consolidation when off', () => {
    const { user } = seed('agy');
    disableAgy();
    updateNote(
      dir,
      user.id,
      { text: 'Prefers short warnings with examples.' },
      { now: NOW, source: { via: 'consolidate' } }
    );
    appendJournal(dir, {
      at: NOW.toISOString(),
      job: 'consolidation',
      status: 'consolidated',
      agent: 'agy',
      side: 'agy',
    });
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({
      status: 'deferred',
      policy: 'disabled',
      foreign: ['unknown'],
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should recognize DSH-written notes in a legacy DSCC extraction journal when dscc is off', () => {
    seed('dscc', 'dsh');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' } }));

    expect(run).toMatchObject({
      status: 'deferred',
      policy: 'disabled',
      foreign: ['normal'],
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should ignore foreign extraction runs that contributed nothing to the prompt', () => {
    seed('agy');
    disableAgy();
    appendJournal(dir, { status: 'applied', side: 'normal', changes: [] });
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({ status: 'deferred', policy: 'disabled' });
    expect(run.foreign).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should report unknown provenance for manual notes after an empty same-side extraction when off', () => {
    seed();
    disableAgy();
    appendJournal(dir, {
      at: NOW.toISOString(),
      status: 'applied',
      side: 'agy',
      session: 'agy-1',
      changes: [],
    });
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({
      status: 'deferred',
      policy: 'disabled',
      foreign: ['unknown'],
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should defer an empty store without recording a checkpoint when dscc is disabled', () => {
    const run = consolidate(deps({ env: { KYOTEN_AGENT: 'dscc' } }));

    expect(run.status).toBe('deferred');
    expect(readConsolidated(dir)).toBeNull();
    expect(readJournal(dir)).toEqual([]);
  });

  test('should report unknown provenance after a same-side note is manually edited when off', () => {
    const { user } = seed('agy');
    disableAgy();
    updateNote(
      dir,
      user.id,
      { text: 'Prefers warnings at the top.' },
      { now: NOW }
    );
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({
      status: 'deferred',
      policy: 'disabled',
      foreign: ['unknown'],
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should preserve foreign provenance after consolidating an unknown note into a known note when off', () => {
    const { user } = seed('agy');
    disableAgy();
    const unknown = add({
      scope: 'user',
      type: 'preference',
      text: 'The user wants summaries to include examples.',
    });
    const env = { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' };
    const merge = agentReturning({
      profile: [],
      ops: [
        {
          op: 'UPDATE',
          id: user.id,
          text: 'Prefers short answers with examples.',
        },
        { op: 'DELETE', id: unknown.id, why: `merged into ${user.id}` },
      ],
    });
    const first = consolidate(
      deps({ env, runAgent: merge, allowCrossSide: true })
    );
    const nextAgent = agentReturning({ profile: [], ops: [] });

    const next = consolidate(deps({ env, runAgent: nextAgent }));

    expect(first).toMatchObject({
      status: 'consolidated',
      crossSide: ['unknown'],
    });
    expect(
      loadNotes(dir).notes.find(({ id }) => id === unknown.id)?.status
    ).toBe('deleted');
    expect(next).toMatchObject({
      status: 'deferred',
      policy: 'disabled',
      foreign: ['unknown'],
    });
    expect(nextAgent).not.toHaveBeenCalled();
  });

  test('should defer the claude call from a dscc worker by default, leaving it due', () => {
    seed();
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' } }));

    expect(run).toMatchObject({
      job: 'consolidation',
      status: 'deferred',
      side: 'dscc',
      policy: 'disabled',
      foreign: ['unknown'],
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(readConsolidated(dir)).toBeNull();
    expect(readJournal(dir)).toEqual([]);
  });

  test('should defer on dscc even when every run was dscc until opted in', () => {
    seed('dscc');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const deferred = consolidate(
      deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' } })
    );
    expect(deferred).toMatchObject({
      status: 'deferred',
      side: 'dscc',
      policy: 'disabled',
    });
    expect(runAgent).not.toHaveBeenCalled();

    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      autoConsolidate: { ...DEFAULT_CONFIG.autoConsolidate, dscc: true },
    });
    const run = consolidate(deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' } }));
    expect(run.status).toBe('consolidated');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('should consolidate mixed notes on dscc once opted in', () => {
    seed('normal');
    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      autoConsolidate: { ...DEFAULT_CONFIG.autoConsolidate, dscc: true },
    });
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' } }));

    expect(run).toMatchObject({
      status: 'consolidated',
      side: 'dscc',
      crossSide: ['normal'],
      crossSideAuto: true,
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('should consolidate mixed notes on agy by default, and defer when agy is disabled', () => {
    seed('normal');
    const session = 'dscc-1';
    const note = add({
      scope: 'user',
      type: 'preference',
      text: 'The user prefers examples in documentation.',
      source: { via: 'extract', session, harness: 'claude' },
    });
    appendJournal(dir, {
      at: NOW.toISOString(),
      status: 'applied',
      side: 'dscc',
      agent: 'claude',
      session,
      changes: [{ action: 'added', id: note.id }],
    });
    const runAgent = agentReturning({ profile: [], ops: [] });
    const agyEnv = {
      ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
      KYOTEN_AGENT: 'agy',
    };

    const run = consolidate(deps({ runAgent, env: agyEnv }));
    expect(run).toMatchObject({
      status: 'consolidated',
      side: 'agy',
      crossSide: ['normal', 'dscc'],
      crossSideAuto: true,
    });
    expect(runAgent).toHaveBeenCalledTimes(1);

    disableAgy();
    const deferred = consolidate(deps({ runAgent, env: agyEnv }));
    expect(deferred).toMatchObject({
      status: 'deferred',
      side: 'agy',
      policy: 'disabled',
      policyAgent: 'agy',
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('should preview a dry run even when auto-consolidation is off', () => {
    seed('dscc');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ dryRun: true, runAgent, env: { KYOTEN_AGENT: 'dscc' } })
    );

    expect(run).toMatchObject({ status: 'dry-run', side: 'dscc' });
    expect(run.crossSide).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should allow disabling auto-consolidation for claude, codex, or dsh', () => {
    seed();
    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      autoConsolidate: { ...DEFAULT_CONFIG.autoConsolidate, dsh: false },
    });
    const runAgent = agentReturning({ profile: [], ops: [] });

    const deferred = consolidate(
      deps({ runAgent, env: { KYOTEN_CALLER_HARNESS: 'dsh' } })
    );
    expect(deferred).toMatchObject({
      status: 'deferred',
      side: 'normal',
      policy: 'disabled',
      policyAgent: 'dsh',
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('should support explicit agent override and block foreign harnesses targeting agy', () => {
    seed();
    const runAgent = agentReturning({ profile: [], ops: [] });

    const manualAgy = consolidate(
      deps({ runAgent, agent: 'agy', env: {}, allowCrossSide: true })
    );
    expect(manualAgy).toMatchObject({
      status: 'consolidated',
      agent: 'agy',
      side: 'agy',
    });

    expect(() =>
      consolidate(
        deps({
          runAgent,
          agent: 'agy',
          env: { CLAUDE_CODE_SESSION_ID: 'c1' },
        })
      )
    ).toThrow(/Google Antigravity Terms of Service/);

    expect(() =>
      consolidate(
        deps({
          runAgent,
          agent: 'agy',
          env: { KYOTEN_AGENT: 'dscc' },
        })
      )
    ).toThrow(/Google Antigravity Terms of Service/);

    expect(() =>
      consolidate(deps({ runAgent, agent: 'gemini', env: {} }))
    ).toThrow(/Invalid --agent/);
  });

  test('should record the agy side for a directly opened Antigravity session', () => {
    seed('agy');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({ status: 'consolidated', side: 'agy' });
    expect(runAgent).toHaveBeenCalled();
  });

  test('should consolidate across sides with --allow-cross-side and record them', () => {
    seed('normal');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const run = consolidate(
      deps({ runAgent, env: { KYOTEN_AGENT: 'dscc' }, allowCrossSide: true })
    );

    expect(run).toMatchObject({
      status: 'consolidated',
      side: 'dscc',
      crossSide: ['normal'],
    });
    expect(runAgent).toHaveBeenCalled();
  });

  test('should record the provider side on a cross-side dry run', () => {
    seed('normal');

    const run = consolidate(
      deps({
        dryRun: true,
        allowCrossSide: true,
        env: { KYOTEN_AGENT: 'dscc' },
      })
    );

    expect(run).toMatchObject({
      status: 'dry-run',
      side: 'dscc',
      crossSide: ['normal'],
    });
  });

  test('should consolidate on a normal worker after dscc runs', () => {
    seed();
    appendJournal(dir, { status: 'applied', side: 'dscc' });

    expect(consolidate(deps()).status).toBe('consolidated');
  });

  test('should not reuse a dscc run model on a normal worker', () => {
    seed();
    appendJournal(dir, {
      status: 'applied',
      agent: 'claude',
      model: 'deepseek-v4',
      side: 'dscc',
    });

    const run = consolidate(deps());

    expect(run).toMatchObject({ model: null, side: 'normal' });
  });

  test('should reuse a dscc run model on a dscc worker when opted in', () => {
    seed('dscc');
    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      autoConsolidate: { ...DEFAULT_CONFIG.autoConsolidate, dscc: true },
    });
    appendJournal(dir, {
      status: 'applied',
      agent: 'claude',
      model: 'deepseek-v4',
      side: 'dscc',
    });

    const run = consolidate(deps({ env: { KYOTEN_AGENT: 'dscc' } }));

    expect(run).toMatchObject({ model: 'deepseek-v4', side: 'dscc' });
  });

  test('should still run a dsh consolidation on a dscc worker, but defer agy', () => {
    seed();
    writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'dsh' });

    expect(consolidate(deps({ env: { KYOTEN_AGENT: 'dscc' } })).status).toBe(
      'consolidated'
    );

    writeConfig(dir, { ...DEFAULT_CONFIG, extractAgent: 'agy' });
    expect(consolidate(deps({ env: { KYOTEN_AGENT: 'dscc' } }))).toMatchObject({
      status: 'deferred',
      side: 'agy',
      caller: 'dscc',
    });
  });

  test('should record the recipient side for an explicit dsh run from dscc', () => {
    seed();

    const run = consolidate(
      deps({ agent: 'dsh', env: { KYOTEN_AGENT: 'dscc' } })
    );

    expect(run).toMatchObject({ agent: 'dsh', side: 'normal' });
  });

  test('should fall back to KYOTEN_CALLER_HARNESS for detached workers without session env vars', () => {
    seed('agy');
    const runAgent = vi.fn(({ command }) => {
      if (command.args.includes('mcp')) {
        return {
          code: 0,
          signal: null,
          output: '',
          stdout:
            'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n',
          durationMs: 1,
        };
      }
      const stdout = JSON.stringify({ profile: [], ops: [] });
      return { code: 0, signal: null, output: stdout, stdout, durationMs: 2 };
    });

    const codexRun = consolidate(
      deps({ runAgent, env: { KYOTEN_CALLER_HARNESS: 'codex' } })
    );
    expect(codexRun).toMatchObject({
      status: 'consolidated',
      agent: 'codex',
      side: 'normal',
    });

    const dshRun = consolidate(
      deps({
        runAgent: agentReturning({ profile: [], ops: [] }),
        env: { KYOTEN_CALLER_HARNESS: 'dsh' },
      })
    );
    expect(dshRun).toMatchObject({
      status: 'consolidated',
      agent: 'dsh',
      side: 'normal',
    });

    const agyRun = consolidate(
      deps({
        runAgent: agentReturning({ profile: [], ops: [] }),
        env: { KYOTEN_CALLER_HARNESS: 'agy' },
      })
    );
    expect(agyRun).toMatchObject({
      status: 'consolidated',
      agent: 'agy',
      side: 'agy',
    });
  });

  test('should prefer KYOTEN_CALLER_HARNESS and dscc over inherited outer session IDs', () => {
    seed();
    const runAgent = agentReturning({ profile: [], ops: [] });

    // claude launched inside an agy shell: KYOTEN_CALLER_HARNESS='claude' must win over ANTIGRAVITY_CONVERSATION_ID
    const nestedClaude = consolidate(
      deps({
        runAgent,
        env: {
          ANTIGRAVITY_CONVERSATION_ID: 'outer-agy',
          CLAUDE_CODE_SESSION_ID: 'inner-claude',
          KYOTEN_CALLER_HARNESS: 'claude',
        },
      })
    );
    expect(nestedClaude).toMatchObject({
      status: 'consolidated',
      agent: 'claude',
      side: 'normal',
    });

    // dscc launched inside a codex shell must stay on dscc even when both session markers are present
    const nestedDscc = consolidate(
      deps({
        runAgent,
        env: {
          CODEX_THREAD_ID: 'outer-codex',
          CLAUDE_CODE_SESSION_ID: 'inner-claude',
          KYOTEN_AGENT: 'dscc',
        },
      })
    );
    expect(nestedDscc).toMatchObject({
      status: 'deferred',
      side: 'dscc',
      policy: 'disabled',
    });
  });

  test('should let --force override a disabled worker on mixed notes and record crossSideVia', () => {
    seed('normal');
    const runAgent = agentReturning({ profile: [], ops: [] });

    const forced = consolidate(
      deps({
        runAgent,
        force: true,
        env: { KYOTEN_AGENT: 'dscc' },
      })
    );
    expect(forced).toMatchObject({
      status: 'consolidated',
      side: 'dscc',
      crossSide: ['normal'],
      crossSideVia: '--force',
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('should let --force override a disabled worker for its own side', () => {
    seed('dscc');

    const run = consolidate(
      deps({ force: true, env: { KYOTEN_AGENT: 'dscc' } })
    );

    expect(run).toMatchObject({ status: 'consolidated', side: 'dscc' });
  });

  test('should record the provider side on skipped off and nothing runs', () => {
    const nothingRun = consolidate(
      deps({ env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );
    expect(nothingRun).toMatchObject({ status: 'nothing', side: 'agy' });
    expect(readJournal(dir).at(-1)).toMatchObject({
      status: 'nothing',
      side: 'agy',
    });

    seed();
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });
    const offRun = consolidate(deps({ env: { KYOTEN_AGENT: 'dscc' } }));
    expect(offRun).toMatchObject({ status: 'off', side: 'dscc' });
    expect(readJournal(dir).at(-1)).toMatchObject({
      status: 'off',
      side: 'dscc',
    });
  });
});

describe('consolidateLocked', () => {
  test('should run under the worker lock', () => {
    seed();

    expect(consolidateLocked(deps())?.status).toBe('consolidated');
    expect(tryLock(dir)).not.toBeNull();
  });

  test('should return null while a worker runs', () => {
    tryLock(dir, { pid: 999, isAlive: () => true });

    expect(consolidateLocked(deps())).toBeNull();
  });

  test('should journal a failure and wait a day before trying again', () => {
    seed();
    const runAgent = agentReturning('', { code: 1, output: `boom ${TOKEN}` });

    const run = consolidateLocked(deps({ runAgent }));

    expect(run).toMatchObject({
      job: 'consolidation',
      status: 'failed',
      side: 'normal',
    });
    expect(run?.error).toContain('the consolidation agent exited with code 1:');
    expect(run?.error).not.toContain(TOKEN);
    expect(readConsolidated(dir)).toEqual({ tried: NOW.toISOString() });
    expect(readJournal(dir).at(-1)?.status).toBe('failed');
  });

  test('should record the agent side when a directly opened agy consolidation fails', () => {
    seed('agy');
    const runAgent = agentReturning('', { code: 1, output: 'boom' });

    const run = consolidateLocked(
      deps({
        runAgent,
        env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' },
      })
    );

    expect(run).toMatchObject({ status: 'failed', side: 'agy' });
    expect(readJournal(dir).at(-1)).toMatchObject({
      status: 'failed',
      side: 'agy',
    });
  });

  test('should record the explicit --agent side when a manual consolidation fails', () => {
    seed('agy');
    const runAgent = agentReturning('', { code: 1, output: 'boom' });

    const run = consolidateLocked(deps({ runAgent, agent: 'agy', env: {} }));

    expect(run).toMatchObject({ status: 'failed', side: 'agy' });
    expect(readJournal(dir).at(-1)).toMatchObject({
      status: 'failed',
      side: 'agy',
    });
  });

  test('should fall back to env side when failure happens on unreadable config', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{bad json');

    const run = consolidateLocked(
      deps({ env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1' } })
    );

    expect(run).toMatchObject({ status: 'failed', side: 'agy' });
  });

  test('should record a thrown value that is not an error', () => {
    seed();
    const notAnError = /** @type {unknown} */ ('plain');
    const runAgent = vi.fn(() => {
      throw notAnError;
    });

    expect(consolidateLocked(deps({ runAgent }))?.error).toBe('plain');
  });

  test('should keep the last success when an attempt fails', () => {
    seed();
    consolidateLocked(deps());
    const later = new Date(NOW.getTime() + DAY);

    consolidateLocked(
      deps({
        now: () => later,
        runAgent: agentReturning('', { code: 1, output: 'x' }),
      })
    );

    expect(readConsolidated(dir)).toEqual({
      at: NOW.toISOString(),
      ops: expect.any(Number),
      tried: later.toISOString(),
    });
  });

  test('should use the default lock options', () => {
    expect(consolidateLocked(deps({ lock: undefined }))?.status).toBe(
      'nothing'
    );
  });
});
