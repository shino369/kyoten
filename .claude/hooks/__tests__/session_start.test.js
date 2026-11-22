/**
 * Tests for session_start.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { sessionFile as memorySessionFile } from '#utils/memory/hook.js';
import { readOpen } from '#utils/memory/queue.js';
import { memoryDir } from '#utils/memory/store.js';
import { readSession, writeSession } from '#utils/task/store.js';
import {
  callerLine,
  processHookInput,
  registryLine,
} from '../session_start.js';

/** @type {string} */
let root;

/**
 * @param {string} name
 * @param {{ plan?: string, notes?: string }} [files]
 */
function makeTask(
  name,
  { plan = `# Plan — ${name}\n\nGoal: Ship it\n\n- [ ] Write it\n`, notes } = {}
) {
  const dir = path.join(root, 'tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  if (notes) fs.writeFileSync(path.join(dir, 'NOTES.md'), notes);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('session_start processHookInput', () => {
  test('should stay silent with no tasks and no tools line', () => {
    expect(
      processHookInput(
        { source: 'startup' },
        { rootDir: root, tools: () => null }
      )
    ).toBeNull();
  });

  test('should nudge a scan when no tools are recorded', () => {
    expect(
      processHookInput({ source: 'startup' }, { rootDir: root })
        ?.hookSpecificOutput.additionalContext
    ).toBe(
      'Tools: none recorded on this machine — run pnpm tools scan to list the agents and CLIs you can call'
    );
  });

  test('should append the tools line after the task brief', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(
      path.join(root, 'tools', 'local.json'),
      JSON.stringify({
        version: 1,
        updatedAt: null,
        tools: [
          {
            name: 'codex',
            kind: 'agent',
            path: '/bin/codex',
            version: '1',
            source: 'scan',
            ok: true,
            checkedAt: 'x',
          },
        ],
      })
    );
    const context =
      processHookInput({ source: 'clear' }, { rootDir: root })
        ?.hookSpecificOutput.additionalContext ?? '';
    expect(context.split('\n').at(-1)).toMatch(
      /^Tools: agents codex \(pnpm tools list;/
    );
    expect(context).toContain('[Task] demo-261117');
  });

  test('should send the task brief alone when there is no tools line', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');
    const context =
      processHookInput({}, { rootDir: root, tools: () => null })
        ?.hookSpecificOutput.additionalContext ?? '';
    expect(context).not.toContain('Tools:');
    expect(context).toContain('[Task] demo-261117');
  });

  test('should skip the tools line when the registry is unreadable', () => {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'local.json'), '{oops');
    expect(registryLine(root)).toBeNull();
  });

  test('should inject the active task brief with its goal and next step', () => {
    makeTask('demo-261117', {
      notes:
        '# NOTES\n\n## 2026-11-17 10:00 — claude\n\nNext: write the parser\n',
    });
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

    const output = processHookInput({ source: 'clear' }, { rootDir: root });
    const context = output?.hookSpecificOutput.additionalContext ?? '';

    expect(output?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain('[Task] demo-261117');
    expect(context).toContain('Goal: Ship it');
    expect(context).toContain('Next step: Write it');
    expect(context).toContain('Next (last note): write the parser');
    expect(context).toContain('injected on session clear');
  });

  test('should bind a new session, dormant, to the default task', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

    processHookInput(
      { source: 'startup', session_id: 'sess-1' },
      { rootDir: root, tools: () => null }
    );

    expect(readSession(root, 'sess-1')).toMatchObject({
      task: 'demo-261117',
      engaged: false,
    });
  });

  test('should bind a new session to no task when none is active', () => {
    makeTask('older-261116');
    processHookInput(
      { source: 'startup', session_id: 'sess-1' },
      { rootDir: root, tools: () => null }
    );
    expect(readSession(root, 'sess-1')).toMatchObject({
      task: null,
      engaged: false,
    });
  });

  test("should keep a resumed session's binding and brief its task", () => {
    makeTask('demo-261117');
    makeTask('mine-261117', {
      plan: '# Plan\n\nGoal: My work\n\n- [ ] Do it\n',
    });
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');
    writeSession(root, 'sess-1', { task: 'mine-261117', engaged: true });
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(
      path.join(root, 'tasks', '.sessions', 'sess-1.json'),
      old,
      old
    );

    const context =
      processHookInput(
        { source: 'compact', session_id: 'sess-1' },
        { rootDir: root, tools: () => null }
      )?.hookSpecificOutput.additionalContext ?? '';

    expect(context).toContain('[Task] mine-261117');
    expect(readSession(root, 'sess-1')).toMatchObject({
      task: 'mine-261117',
      engaged: true,
    });
    const file = path.join(root, 'tasks', '.sessions', 'sess-1.json');
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  test('should prune stale bindings at session start', () => {
    makeTask('demo-261117');
    writeSession(root, 'old', { task: 'demo-261117', engaged: true });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(root, 'tasks', '.sessions', 'old.json'), old, old);

    processHookInput(
      { source: 'startup', session_id: 'sess-1' },
      { rootDir: root, tools: () => null }
    );

    expect(readSession(root, 'old')).toBeNull();
  });

  test('should write no binding without a session id', () => {
    makeTask('demo-261117');
    processHookInput(
      { source: 'startup' },
      { rootDir: root, tools: () => null }
    );
    expect(fs.existsSync(path.join(root, 'tasks', '.sessions'))).toBe(false);
  });

  test('should list open tasks when none is active', () => {
    makeTask('older-261116');

    const output = processHookInput(undefined, { rootDir: root });
    const context = output?.hookSpecificOutput.additionalContext ?? '';

    expect(context).toContain('[Task] No active task');
    expect(context).toContain('older-261116');
    expect(context).toContain('Injected on session startup');
  });

  test('should inject Antigravity injectSteps output and bind conversationId', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

    const output = processHookInput(
      { conversationId: 'agy-1' },
      { rootDir: root, harness: 'agy', tools: () => null }
    );

    expect(output).toEqual({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: expect.stringContaining('[Task] demo-261117'),
          },
        },
      ],
    });
    expect(readSession(root, 'agy-1')).toMatchObject({
      task: 'demo-261117',
      engaged: false,
    });
  });

  test.each([{}, { hookEventName: 'SessionStart' }])(
    'should return both Antigravity startup contexts for %j',
    (event) => {
      const conversationId = 'ec33ebf9-0cba-4100-8142-c61503f6c587';
      const dir = memoryDir(root);
      const transcriptPath = path.join(root, 'transcript.jsonl');
      fs.mkdirSync(dir);
      fs.writeFileSync(transcriptPath, '');
      makeTask('demo-261117');
      fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

      const output = processHookInput(
        { ...event, conversationId, transcriptPath, cwd: root },
        { rootDir: root, harness: 'agy', tools: () => null }
      );

      expect(
        output?.injectSteps.map((step) => step.systemMessage.systemMessage)
      ).toEqual([
        expect.stringContaining('[Task] demo-261117'),
        expect.stringContaining('## Memory'),
      ]);
      expect(readOpen(dir)).toEqual([
        expect.objectContaining({
          session: conversationId,
          transcript: transcriptPath,
        }),
      ]);
    }
  );

  test('should return Antigravity startup memory when the task brief is empty', () => {
    fs.mkdirSync(memoryDir(root));
    const output = processHookInput(
      { conversationId: 'agy-1' },
      { rootDir: root, harness: 'agy', tools: () => null }
    );
    expect(output?.injectSteps).toEqual([
      {
        systemMessage: { systemMessage: expect.stringContaining('## Memory') },
      },
    ]);
  });

  test('should keep the Antigravity task brief if memory startup throws', () => {
    const dir = path.dirname(memorySessionFile(memoryDir(root), 'agy-1'));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'sessions path is a file');
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

    const output = processHookInput(
      { conversationId: 'agy-1' },
      { rootDir: root, harness: 'agy', tools: () => null }
    );
    expect(output?.injectSteps).toEqual([
      {
        systemMessage: {
          systemMessage: expect.stringContaining('[Task] demo-261117'),
        },
      },
    ]);
  });

  test('should stay silent when neither Antigravity startup context is available', () => {
    expect(
      processHookInput(undefined, {
        rootDir: root,
        harness: 'agy',
        tools: () => null,
      })
    ).toBeNull();
  });

  test('should report an unreadable task instead of failing', () => {
    const brief = vi.fn(() => {
      throw new Error('state.json is not valid JSON');
    });

    const output = processHookInput(
      { source: 'resume' },
      { rootDir: root, brief }
    );

    expect(output?.hookSpecificOutput.additionalContext).toContain(
      'Could not read the active task — Error: state.json is not valid JSON'
    );
  });
});

describe('session_start callerLine', () => {
  /** @param {string} dir */
  const gitRepo = (dir) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  };

  test('should point at the git repository kyoten was started from', () => {
    const repo = gitRepo(path.join(root, 'project'));
    const nested = path.join(repo, 'src');
    fs.mkdirSync(nested);

    const line = callerLine(path.join(root, 'home'), {
      KYOTEN_CALLER_DIR: nested,
    });

    expect(line).toContain(`[kyoten] Started from ${path.resolve(repo)}`);
    expect(line).toContain(`--repo "${path.resolve(repo)}"`);
  });

  test('should say the repository is already added when kyoten added it', () => {
    const repo = gitRepo(path.join(root, 'project'));

    const line = callerLine(path.join(root, 'home'), {
      KYOTEN_CALLER_DIR: repo,
      KYOTEN_ADD_DIR: repo,
    });

    expect(line).toContain('readable and writable');
    expect(line).toContain(`--repo "${path.resolve(repo)}"`);
  });

  test('should keep the plain text when KYOTEN_ADD_DIR names another folder', () => {
    const repo = gitRepo(path.join(root, 'project'));

    const line = callerLine(path.join(root, 'home'), {
      KYOTEN_CALLER_DIR: repo,
      KYOTEN_ADD_DIR: path.join(root, 'elsewhere'),
    });

    expect(line).not.toContain('readable and writable');
    expect(line).toContain('work on it through a task');
  });

  test('should stay quiet without KYOTEN_CALLER_DIR', () => {
    expect(callerLine(root, {})).toBeNull();
  });

  test('should stay quiet outside a git repository', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);

    expect(
      callerLine(path.join(root, 'home'), { KYOTEN_CALLER_DIR: plain })
    ).toBeNull();
  });

  test('should stay quiet when started from the workspace itself', () => {
    const home = gitRepo(path.join(root, 'home'));

    expect(callerLine(home, { KYOTEN_CALLER_DIR: home })).toBeNull();
  });

  test('should stay quiet when the lookup fails', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(callerLine(root, { KYOTEN_CALLER_DIR: root })).toBeNull();
    vi.restoreAllMocks();
  });

  test('should default to the process environment', () => {
    expect(callerLine(root)).toBeNull();
  });

  test('should add the hint to the session context', () => {
    const output = processHookInput(
      {},
      {
        rootDir: root,
        brief: () => '',
        tools: () => null,
        caller: () => '[kyoten] hint',
      }
    );

    expect(output?.hookSpecificOutput.additionalContext).toBe('[kyoten] hint');
  });
});
