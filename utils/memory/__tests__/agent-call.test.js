import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { INNER_LOOP_ENV } from '../../task/loop.js';
import {
  AGENT_CALL_TIMEOUT_MS,
  CALL_AGENTS,
  SETTINGS_FILE,
  callAgent,
  headlessCommand,
  jsonObjectOf,
} from '../agent-call.js';
import { EXTRACT_ENV } from '../queue.js';
import { apply as isolateDsh } from '../dsh-persona.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-call-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {Partial<import('../../loop/adapters.js').AgentResult>} [result] */
const agentReturning = (result = {}) =>
  vi.fn(() => ({
    code: 0,
    signal: null,
    stdout: 'answer',
    output: 'answer',
    durationMs: 10,
    ...result,
  }));

/** @param {ReturnType<typeof agentReturning>} runAgent */
const deps = (runAgent) => ({
  env: { PATH: '/bin' },
  runAgent,
  tmpdir: () => root,
});

describe('headlessCommand', () => {
  test('should run claude read-only without tools, with the model when given', () => {
    const command = headlessCommand({
      agent: 'claude',
      model: 'opus',
      rootDir: root,
    });

    expect(command.bin).toBe('claude');
    expect(command.args).toEqual(
      expect.arrayContaining(['-p', '--permission-mode', 'plan'])
    );
    expect(command.args).toContain('--strict-mcp-config');
    expect(command.args).toContain('{"disableAllHooks":true}');
    expect(command.args).toContain('--settings');
    expect(command.args.slice(-4)).toEqual(['--tools', '', '--model', 'opus']);
    expect(
      headlessCommand({ agent: 'claude', rootDir: root }).args.slice(-2)
    ).toEqual(['--tools', '']);
  });

  test('should run codex and dsh in their read-only modes', () => {
    const codex = headlessCommand({ agent: 'codex', rootDir: root });
    const dsh = headlessCommand({ agent: 'dsh', rootDir: root });

    expect(codex.bin).toBe('codex');
    expect(codex.args).toContain(
      "permissions.memory-persona.filesystem={':root'='deny'}"
    );
    expect(codex.args).toContain('default_permissions=memory-persona');
    expect(codex.args).not.toContain('--sandbox');
    expect(codex.args).toContain('--skip-git-repo-check');
    expect(codex.args).toContain('--ignore-user-config');
    expect(codex.args).toContain('shell_tool');
    expect(codex.args).toContain('view_image');
    expect(codex.args).toContain('web_search=disabled');
    expect(codex.args).not.toContain('--tools');
    expect(dsh.bin).toBe('dsh');
    expect(dsh.args).toContain('read-only');
    const patch = dsh.args.indexOf('--patch');
    expect(patch).toBeGreaterThan(-1);
    expect(patch).toBeLessThan(dsh.args.indexOf('--permission-mode'));
    expect(fs.readFileSync(dsh.args[patch + 1], 'utf-8')).toContain(
      'inject: [headlessStartup, personaIsolation]'
    );
    expect(dsh.args).not.toContain('--tools');
  });

  test('should run agy in strict all-tools-denied isolation mode', () => {
    const agy = headlessCommand({
      agent: 'agy',
      model: 'gemini-3.8-flash-low',
      rootDir: root,
    });
    expect(agy.bin).toBe('agy');
    expect(agy.args).toContain('--disable-slash-commands');
    expect(agy.args.slice(-2)).toEqual(['--model', 'gemini-3.8-flash-low']);
    const idx = agy.args.indexOf('--settings');
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(agy.args[idx + 1])).toEqual({
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
  });

  test.each([
    ['codex', 'm'],
    ['dsh', null],
  ])(
    'should keep double quotes out of the %s command line (Windows .cmd shims)',
    (agent, model) => {
      const command = headlessCommand({ agent, model, rootDir: root });

      expect(command.args.filter((arg) => arg.includes('"'))).toEqual([]);
    }
  );

  test('should refuse --model for dsh (DSH selects its model in its profile)', () => {
    expect(() =>
      headlessCommand({ agent: 'dsh', model: 'deepseek-v4', rootDir: root })
    ).toThrow(/DSH selects its model in its profile/);
  });

  test('should refuse an agent memory jobs cannot call', () => {
    expect(() => headlessCommand({ agent: 'gemini', rootDir: root })).toThrow(
      `Memory jobs run on claude, codex, dsh, agy, dscc (got gemini).\n${CALL_AGENTS.map((name) => `Fix: use --agent ${name}`).join('\n')}`
    );
  });
});

test('should block DSH tool calls and hide global tools before the first request', () => {
  const guard = vi.fn();
  const on = vi.fn();
  const provide = vi.fn();
  const restrict = vi.fn();

  isolateDsh({ tools: { guard }, on, provide });

  expect(guard.mock.calls[0][0]()).toMatch(/disabled/);
  expect(on.mock.calls[0][0]).toBe('agent/created');
  on.mock.calls[0][1]({ agent: { ctx: { tools: { restrict } } } });
  expect(restrict).toHaveBeenCalledWith({ allow: [] });
  expect(provide).toHaveBeenCalledWith('personaIsolation', true);
});

describe('callAgent', () => {
  const command = headlessCommand({ agent: 'claude', rootDir: '/nowhere' });

  test('should call in an empty folder with the memory hooks and loop off', () => {
    const runAgent = agentReturning();

    const result = callAgent(deps(runAgent), command, 'P');

    expect(result.stdout).toBe('answer');
    const call = /** @type {any} */ (runAgent.mock.calls[0])[0];
    expect(call).toMatchObject({
      command: expect.objectContaining({ bin: command.bin }),
      prompt: 'P',
      timeoutMs: AGENT_CALL_TIMEOUT_MS,
      env: { PATH: '/bin', [EXTRACT_ENV]: '1', [INNER_LOOP_ENV]: 'off' },
    });
    expect(path.basename(call.cwd)).toMatch(/^memory-extraction-/);
    expect(path.dirname(call.cwd)).toBe(root);
    expect(fs.existsSync(call.cwd)).toBe(false);
  });

  test('should refuse calling agy from another agent harness and suggest alternatives, while allowing agy -> claude', () => {
    const agyCmd = headlessCommand({ agent: 'agy', rootDir: root });
    const runAgent = agentReturning();

    expect(() =>
      callAgent(
        {
          ...deps(runAgent),
          env: { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'cc-1' },
        },
        agyCmd,
        'P',
        { job: 'persona compaction' }
      )
    ).toThrow(
      /Terms of Service.*\nFix: use --agent claude\nFix: use --agent codex\nFix: use --agent dsh/s
    );
    expect(runAgent).not.toHaveBeenCalled();

    // agy -> claude is allowed.
    expect(
      callAgent(
        {
          ...deps(runAgent),
          env: {
            PATH: '/bin',
            ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
            KYOTEN_AGENT: 'agy',
          },
        },
        command,
        'P'
      ).stdout
    ).toBe('answer');
  });

  test('should check for Codex MCP servers before handing it any persona text', () => {
    const codex = headlessCommand({ agent: 'codex', rootDir: root });
    const runAgent = agentReturning();
    runAgent.mockReturnValueOnce({
      stdout:
        'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n',
      output: '',
      code: 0,
      signal: null,
      durationMs: 0,
    });

    expect(callAgent(deps(runAgent), codex, 'Speak plainly.').stdout).toBe(
      'answer'
    );
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: expect.objectContaining({
          args: expect.arrayContaining(['mcp', 'list']),
        }),
        prompt: '',
      })
    );
    expect(runAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: 'Speak plainly.',
      })
    );
  });

  test.each([0, 1])(
    'should stop before sending persona text if the Codex MCP check fails (code %d)',
    (code) => {
      const codex = headlessCommand({ agent: 'codex', rootDir: root });
      const runAgent = agentReturning({
        code,
        stdout: 'Configured MCP server.',
      });

      expect(() => callAgent(deps(runAgent), codex, 'Speak plainly.')).toThrow(
        /Cannot verify Codex persona isolation/
      );
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(root)).toEqual([]);
    }
  );

  test.each([
    [
      'persona-audit',
      'Fix: use --agent claude\nFix: use --agent dsh\nFix: use --agent agy\nFix: use --agent dscc',
    ],
    [
      'extraction',
      'Fix: pnpm memory set --extract-agent claude\nFix: pnpm memory set --extract-agent dsh\nFix: pnpm memory set --extract-agent agy\nFix: pnpm memory set --extract-agent dscc',
    ],
  ])('should point a failed Codex check of %s at another agent', (job, fix) => {
    const codex = headlessCommand({ agent: 'codex', rootDir: root });
    const runAgent = agentReturning({ code: 1, stdout: 'x' });

    expect(() => callAgent(deps(runAgent), codex, 'P', { job })).toThrow(
      new RegExp(`${fix}$`)
    );
  });

  test('should stop before sending the prompt when cancel returns true after the Codex probe', () => {
    const codex = headlessCommand({ agent: 'codex', rootDir: root });
    let cancelled = false;
    const runAgent = vi.fn(() => {
      cancelled = true;
      return {
        code: 0,
        signal: null,
        stdout:
          'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n',
        output: '',
        durationMs: 0,
      };
    });

    const result = callAgent(deps(runAgent), codex, 'Private note', {
      cancel: () => cancelled,
    });

    expect(result.cancelled).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('should add a switch-agent Fix line to a missing CLI', () => {
    const runAgent = vi.fn(() => {
      throw new Error('claude was not found (agent claude).\nFix: install');
    });

    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      /Fix: install\nFix: pnpm memory set --extract-agent codex\nFix: pnpm memory set --extract-agent dsh\nFix: pnpm memory set --extract-agent agy\nFix: pnpm memory set --extract-agent dscc$/
    );
  });

  test('should pass claude settings as a quote-free relative filename', () => {
    const trickyTmp = path.join(root, 'a!b%c');
    fs.mkdirSync(trickyTmp);
    const claude = headlessCommand({ agent: 'claude', rootDir: root });
    /** @type {string[]} */
    let args = [];
    let jobDir = '';
    let settings = '';
    const runAgent = vi.fn((/** @type {any} */ input) => {
      args = input.command.args;
      jobDir = input.cwd;
      settings = fs.readFileSync(
        path.join(input.cwd, args[args.indexOf('--settings') + 1]),
        'utf-8'
      );
      return { code: 0, signal: null, stdout: 'a', output: 'a', durationMs: 1 };
    });

    callAgent(
      { ...deps(/** @type {any} */ (runAgent)), tmpdir: () => trickyTmp },
      claude,
      'P'
    );

    const file = args[args.indexOf('--settings') + 1];
    expect(file).toBe(SETTINGS_FILE);
    expect(args.filter((arg) => /["!%]/.test(arg))).toEqual([]);
    expect(JSON.parse(settings)).toEqual({ disableAllHooks: true });
    expect(fs.existsSync(path.join(jobDir, file))).toBe(false);
    expect(claude.args).toContain('{"disableAllHooks":true}');
  });

  test('should pass agy settings as a quote-free relative filename', () => {
    const trickyTmp = path.join(root, 'a!b%c');
    fs.mkdirSync(trickyTmp);
    const agy = headlessCommand({ agent: 'agy', rootDir: root });
    /** @type {string[]} */
    let args = [];
    let jobDir = '';
    let settings = '';
    const runAgent = vi.fn((/** @type {any} */ input) => {
      args = input.command.args;
      jobDir = input.cwd;
      settings = fs.readFileSync(
        path.join(input.cwd, args[args.lastIndexOf('--settings') + 1]),
        'utf-8'
      );
      return { code: 0, signal: null, stdout: 'a', output: 'a', durationMs: 1 };
    });

    callAgent(
      { ...deps(/** @type {any} */ (runAgent)), tmpdir: () => trickyTmp },
      agy,
      'P'
    );

    const file = args[args.lastIndexOf('--settings') + 1];
    expect(file).toBe(SETTINGS_FILE);
    expect(args.filter((arg) => /["!%]/.test(arg))).toEqual([]);
    expect(JSON.parse(settings)).toEqual({
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
    expect(fs.existsSync(path.join(jobDir, file))).toBe(false);
    expect(agy.args[agy.args.lastIndexOf('--settings') + 1]).toContain(
      '"toolPermission":"strict"'
    );
  });

  test('should rewrite the isolation --settings flag when the command already has one', () => {
    const claude = headlessCommand({ agent: 'claude', rootDir: root });
    const withPrefix = {
      ...claude,
      args: ['--settings', '/path/base.json', ...claude.args],
    };
    /** @type {string[]} */
    let args = [];
    let settings = '';
    const runAgent = vi.fn((/** @type {any} */ input) => {
      args = input.command.args;
      settings = fs.readFileSync(
        path.join(input.cwd, args[args.lastIndexOf('--settings') + 1]),
        'utf-8'
      );
      return { code: 0, signal: null, stdout: 'a', output: 'a', durationMs: 1 };
    });

    callAgent(deps(/** @type {any} */ (runAgent)), withPrefix, 'P');

    expect(args.slice(0, 2)).toEqual(['--settings', '/path/base.json']);
    expect(args[args.lastIndexOf('--settings') + 1]).toBe(SETTINGS_FILE);
    expect(args.filter((arg) => arg.includes('"'))).toEqual([]);
    expect(JSON.parse(settings)).toEqual({ disableAllHooks: true });
  });

  test('should leave a claude command without --settings alone', () => {
    const runAgent = agentReturning();
    const bare = { ...command, args: ['-p'] };

    callAgent(deps(runAgent), bare, 'P');

    expect(/** @type {any} */ (runAgent.mock.calls[0])[0].command).toEqual(
      bare
    );
  });

  test('should pass other runner errors through unchanged', () => {
    const boom = new Error('disk full');
    const runAgent = vi.fn(() => {
      throw boom;
    });
    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(boom);
    const odd = vi.fn(() => {
      // eslint-disable-next-line no-throw-literal -- a non-Error rejection
      throw 'plain';
    });
    expect(() => callAgent(deps(odd), command, 'P')).toThrow('plain');
  });

  test('should name the job and use its timeout', () => {
    const runAgent = agentReturning();

    callAgent(deps(runAgent), command, 'P', {
      job: 'persona-audit',
      timeoutMs: 5,
    });

    const call = /** @type {any} */ (runAgent.mock.calls[0])[0];
    expect(path.basename(call.cwd)).toMatch(/^memory-persona-audit-/);
    expect(call.timeoutMs).toBe(5);
  });

  test('should throw with the exit code and the end of the output', () => {
    const runAgent = agentReturning({
      code: 1,
      output: `${'x'.repeat(400)}auth error\n`,
    });

    expect(() =>
      callAgent(deps(runAgent), command, 'P', { job: 'compaction' })
    ).toThrow(/^the compaction agent exited with code 1: x+auth error$/);
    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      /^the extraction agent exited with code 1: x{290}auth error$/
    );
  });

  test('should say which signal stopped the agent', () => {
    const runAgent = agentReturning({
      code: null,
      signal: 'SIGTERM',
      output: '(stopped)',
    });

    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      'the extraction agent was stopped by SIGTERM: (stopped)'
    );
  });

  test('should redact a credential before truncating a failed agent response', () => {
    const key = 'gh' + 'p_' + 'a'.repeat(36);
    const runAgent = agentReturning({
      code: 1,
      output: `Authentication failure: \u001b[31m${key}\u001b[0m`,
    });

    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      /^the extraction agent exited with code 1: Authentication failure: \[REDACTED\]$/
    );
  });

  test('should remove the folder when the call itself throws', () => {
    const runAgent = vi.fn(() => {
      throw new Error('spawn failed');
    });

    expect(() =>
      callAgent(deps(/** @type {any} */ (runAgent)), command, 'P')
    ).toThrow('spawn failed');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('jsonObjectOf', () => {
  test('should find the object inside prose or a code fence', () => {
    expect(
      jsonObjectOf('Here it is:\n```json\n{"a": [1]}\n```\nDone.')
    ).toEqual({ a: [1] });
  });

  test('should return null without a parsable object', () => {
    expect(jsonObjectOf('no json here')).toBeNull();
    expect(jsonObjectOf('} before {')).toBeNull();
    expect(jsonObjectOf('{"a": 1} and {"b": 2}')).toBeNull();
  });
});
