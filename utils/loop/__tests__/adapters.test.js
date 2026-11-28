import fs from 'fs';
import { vi } from 'vitest';
import { EXTRACT_ENV } from '../../memory/extract-env.js';
import {
  AGENTS,
  AGY_READ_SETTINGS,
  AGY_WRITE_SETTINGS,
  CALLER_HARNESS_ENV,
  assertAgyAllowed,
  buildCommand,
  dshDirProblem,
  foreignHarnessForAgy,
  installHint,
  isAgyBinary,
  parseAgyStreamJson,
  runAgent,
} from '../adapters.js';

describe('buildCommand', () => {
  test.each([
    '',
    '  ',
    'model alias',
    'model\n',
    '-flag',
    'mod"el',
    'model%TEMP%',
  ])('should reject an unsafe or empty model identifier %j', (model) => {
    expect(() =>
      buildCommand({ agent: 'codex', mode: 'oneshot', model })
    ).toThrow('Invalid --model');
  });

  test('should accept qualified model identifiers and dscc context suffixes', () => {
    expect(
      buildCommand({
        agent: 'claude',
        mode: 'oneshot',
        model: 'provider/deepseek-flash[1m]',
      }).args.slice(-2)
    ).toEqual(['--model', 'provider/deepseek-flash[1m]']);
  });

  test('should put Codex model and effort before stdin in oneshot mode', () => {
    const { args } = buildCommand({
      agent: 'codex',
      mode: 'oneshot',
      model: 'chosen-model',
      effort: 'low',
    });
    expect(args.slice(-5)).toEqual([
      '--model',
      'chosen-model',
      '-c',
      'model_reasoning_effort=low',
      '-',
    ]);
    expect(args).toContain('--ignore-user-config');
    expect(args).not.toContain('--sandbox');
  });

  test.each([
    [{ agent: 'dsh', model: 'm' }, /DSH selects its model/],
    [{ agent: 'claude', effort: 'low' }, /effort is only supported/],
    [{ agent: 'dsh', effort: 'low' }, /effort is only supported/],
    [{ agent: 'agy', effort: 'invalid' }, /Unknown effort/],
  ])('should reject unsupported model options for %j', (options, error) => {
    expect(() => buildCommand(options)).toThrow(error);
  });

  test('should append Antigravity model and effort options', () => {
    expect(
      buildCommand({
        agent: 'agy',
        mode: 'oneshot',
        model: 'selected',
        effort: 'low',
      }).args.slice(-4)
    ).toEqual(['--model', 'selected', '--effort', 'low']);
  });
  test('should build the claude command with the prompt on stdin', () => {
    expect(buildCommand({ agent: 'claude' })).toEqual({
      agent: 'claude',
      bin: 'claude',
      args: [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
    });
  });

  test('should build the codex command reading stdin', () => {
    expect(buildCommand({ agent: 'codex' })).toEqual({
      agent: 'codex',
      bin: 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
    });
  });

  test('should build the dsh headless command with the workspace hooks patch', () => {
    expect(buildCommand({ agent: 'dsh' }).args).toEqual([
      '--profile',
      'headless',
      '--patch',
      '.dsh/workspace.patch.yml',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '-',
    ]);
  });

  test('should build the agy headless command with stream-json and write settings', () => {
    expect(buildCommand({ agent: 'agy' })).toEqual({
      agent: 'agy',
      bin: 'agy',
      args: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--mode',
        'accept-edits',
        '--settings',
        AGY_WRITE_SETTINGS,
      ],
    });
  });

  test('should split --bin on whitespace and keep the adapter args', () => {
    const command = buildCommand({
      agent: 'dsh',
      bin: '  npx -y @deepseek-ai/dsh ',
    });
    expect(command.bin).toBe('npx');
    expect(command.args.slice(0, 4)).toEqual([
      '-y',
      '@deepseek-ai/dsh',
      '--profile',
      'headless',
    ]);
  });

  test('should ignore a blank --bin', () => {
    expect(buildCommand({ agent: 'codex', bin: '  ' }).bin).toBe('codex');
  });

  test('should build read-only commands in read mode', () => {
    expect(buildCommand({ agent: 'claude', mode: 'read' }).args).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      '--output-format',
      'text',
      '--no-session-persistence',
    ]);
    expect(buildCommand({ agent: 'codex', mode: 'read' }).args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '-',
    ]);
    expect(buildCommand({ agent: 'dsh', mode: 'read' }).args).toEqual([
      '--profile',
      'headless',
      '--patch',
      '.dsh/workspace.patch.yml',
      '--permission-mode',
      'read-only',
      '--approval-policy',
      'never',
      '-',
    ]);
    expect(buildCommand({ agent: 'agy', mode: 'read' }).args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--settings',
      AGY_READ_SETTINGS,
    ]);
  });

  test('should reject an unknown mode with a Fix line', () => {
    expect(() => buildCommand({ agent: 'codex', mode: 'yolo' })).toThrow(
      /Unknown mode "yolo"\.\nFix: use mode write or read/
    );
  });

  test('should use a registry argv prefix as-is, paths with spaces included', () => {
    const command = buildCommand({
      agent: 'codex',
      argv: ['/Program Files/codex', '--profile', 'x'],
    });
    expect(command.bin).toBe('/Program Files/codex');
    expect(command.args.slice(0, 3)).toEqual(['--profile', 'x', 'exec']);
  });

  test('should prefer --bin over the registry argv, and ignore an empty argv', () => {
    expect(
      buildCommand({ agent: 'dsh', bin: 'mydsh', argv: ['npx', '-y', 'x'] }).bin
    ).toBe('mydsh');
    expect(buildCommand({ agent: 'dsh', argv: [] }).bin).toBe('dsh');
    expect(buildCommand({ agent: 'dsh', argv: null }).bin).toBe('dsh');
  });

  test('should append the spend cap for claude', () => {
    expect(
      buildCommand({ agent: 'claude', maxBudgetUsd: 2.5 }).args.slice(-2)
    ).toEqual(['--max-budget-usd', '2.5']);
  });

  test('should reject a spend cap for other agents', () => {
    expect(() => buildCommand({ agent: 'codex', maxBudgetUsd: 1 })).toThrow(
      /only supported by --agent claude/
    );
  });

  test('should reject an unknown agent with a Fix line', () => {
    expect(() => buildCommand({ agent: 'opencode' })).toThrow(
      /Fix: use --agent claude\|codex\|dsh\|agy/
    );
  });
});

describe('AGY permission settings', () => {
  /** @param {string[]} rules @param {string} cmd */
  function matchesCommand(rules, cmd) {
    return rules.some((rule) => {
      if (rule === `command(${cmd})`) return true;
      const m = /^command\(regex:(.*)\)$/.exec(rule);
      return m ? new RegExp(m[1]).test(cmd) : false;
    });
  }

  /** @param {string} raw @param {string} cmd */
  function allowedCommand(raw, cmd) {
    const { permissions } = JSON.parse(raw);
    return (
      matchesCommand(permissions.allow, cmd) &&
      !matchesCommand(permissions.deny, cmd)
    );
  }

  test('should grant workspace commands and include protected-path denies in write settings', () => {
    const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
    expect(permissions.allow).not.toContain('write_file(*)');
    expect(permissions.allow).not.toContain('read_file(*)');
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'read_file(.env)',
        'read_file(.env.local)',
        'read_file(secrets/)',
        'read_file(credentials.json)',
        'read_file(~/.ssh)',
        'read_file(~/.aws)',
        'write_file(.git/)',
      ])
    );
    for (const cmd of [
      'pnpm check',
      'pnpm test',
      'pnpm test:coverage',
      'pnpm test utils/task/__tests__/store.test.js',
      'pnpm add -D foo --save-catalog-name=dev',
      'pnpm task step s1 done -m "fix(agy): verified"',
      'pnpm task verify',
      'pnpm harness check',
      'pnpm docs:cli --check',
      'pnpm workspace:check',
      'git status --short',
      'git branch --show-current',
      'git commit -m "feat(agy): add support"',
      'node utils/task/cli.js status',
      'mkdir -p src/new-dir',
      'pwd',
    ]) {
      expect(allowedCommand(AGY_WRITE_SETTINGS, cmd)).toBe(true);
    }
    for (const cmd of [
      'pnpm publish',
      'pnpm -s publish',
      'pnpm add -g foo',
      'pnpm add --global foo',
      'pnpm -g add foo',
      'pnpm install -g pkg',
      'pnpm exec rm -rf .',
      'pnpm -r exec rm -rf ../main',
      'pnpm -C . exec cat .env',
      'pnpm dlx evil',
      'pnpm --dir ../main check',
      'pnpm --dir /abs/main format',
      'pnpm format --dir /abs/main',
      'pnpm check -C /abs/main',
      'git branch -D main',
      'git branch --delete main',
      'git commit --no-verify -m x',
      'git commit -nm x',
      'git commit (Remove-Item README.md)',
      'git commit -m "a\\" (Remove-Item x)"',
      'git add -f .env',
      'git diff --output=../main/AGENTS.md',
      'git diff --no-index .env /dev/null',
      'git push origin main',
      'git status (Remove-Item README.md)',
      'rm README.md',
      'type .env',
      'node utils/../../outside.js',
      'git status && rm -rf .',
      'echo bad > ../main/AGENTS.md',
      'echo (Get-Content .env)',
      'echo (Remove-Item -Force ../main/AGENTS.md)',
      'mkdir ../outside',
      'mkdir /abs/outside',
      'mkdir C:\\outside',
      'mkdir ~/outside',
    ]) {
      expect(allowedCommand(AGY_WRITE_SETTINGS, cmd)).toBe(false);
    }
  });

  test.each(['pnpm workspace:setup', 'pnpm memory', 'pnpm memory export'])(
    'should omit shared setup and memory grants in write settings (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      expect(matchesCommand(permissions.allow, cmd)).toBe(false);
    }
  );

  test.each([
    'pnpm workspace:setup',
    'pnpm run workspace:setup',
    'pnpm memory export',
    'pnpm run memory export',
    'pnpm run-script memory export',
    'pnpm run-script --silent workspace:setup',
    'pnpm  run  memory export',
    'pnpm --silent workspace:setup',
    'pnpm --silent run memory status',
    'pnpm run --silent memory status',
    'pnpm run --reporter silent memory status',
    'pnpm --filter "workspace package" run --if-present workspace:setup',
    'pnpm run "memory" status',
    "pnpm run 'workspace:setup'",
    'pnpm run --test-pattern "C:\\Program Files\\pnpm-store" memory status',
    'pnpm run --test-pattern="C:\\Program Files\\pnpm-store" memory status',
  ])(
    'should explicitly deny shared pnpm commands in write settings (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      const regexDenies = permissions.deny.filter(
        (/** @type {string} */ rule) => rule.startsWith('command(regex:')
      );
      expect(matchesCommand(regexDenies, cmd)).toBe(true);
    }
  );

  test.each([
    'pnpm run --silent workspace:check memory',
    'pnpm run --test-pattern memory workspace:check',
  ])(
    'should leave other pnpm scripts outside the shared-script deny (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      expect(matchesCommand(permissions.deny, cmd)).toBe(false);
    }
  );

  test.each([
    'node utils/workspace-setup.js',
    'node utils/memory/cli.js export',
    'node utils/WORKSPACE-SETUP.js',
    'node utils/MEMORY/CLI.js export',
  ])(
    'should deny the direct Node entries for shared setup and memory (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      expect(matchesCommand(permissions.deny, cmd)).toBe(true);
    }
  );

  test('should include inspection grants and file write and protected-path denies in read settings', () => {
    const { permissions } = JSON.parse(AGY_READ_SETTINGS);
    expect(permissions.allow).not.toContain('write_file(*)');
    expect(permissions.allow).not.toContain('read_file(*)');
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'write_file(*)',
        'read_file(.env)',
        'read_file(secrets/)',
        'read_file(credentials.json)',
        'read_file(~/.ssh)',
        'read_file(~/.aws)',
      ])
    );
    for (const cmd of [
      'git status --short',
      'git diff main...HEAD',
      'git log -n 5 --oneline',
      'git show HEAD:package.json',
      'git branch --show-current',
      'ls utils',
      'pwd',
      'node -v',
    ]) {
      expect(allowedCommand(AGY_READ_SETTINGS, cmd)).toBe(true);
    }
    for (const cmd of [
      'git diff --output=AGENTS.md',
      'git diff --no-index .env /dev/null',
      'git diff -O .env',
      'git branch -D main',
      'pnpm lint -- --fix',
      'pnpm test -- --outputFile=AGENTS.md',
      'pnpm test -u',
      'pnpm test --coverage',
      'pnpm check',
      'pnpm format',
      'ls > AGENTS.md',
      "git status && node -e \"require('fs').writeFileSync('x','1')\"",
      'git status $(whoami)',
      'git status (rm x)',
    ]) {
      expect(allowedCommand(AGY_READ_SETTINGS, cmd)).toBe(false);
    }
  });

  test.each([
    'pnpm test',
    'pnpm test utils/loop/__tests__/adapters.test.js',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm format:check',
    'pnpm workspace:check',
    'pnpm harness check',
    'pnpm docs:cli --check',
    'pnpm skills:check',
    'pnpm task status --json',
    'pnpm tools show agy',
  ])('should omit checkout script grants in read settings (%s)', (cmd) => {
    const { permissions } = JSON.parse(AGY_READ_SETTINGS);
    expect(matchesCommand(permissions.allow, cmd)).toBe(false);
  });
});

describe('parseAgyStreamJson', () => {
  test('should count unique tool steps and use uncached input for the hit rate', () => {
    const tool = (/** @type {number} */ step_index) => ({
      event: 'step_update',
      step_index,
      step_update: { step_type: 'tool' },
    });
    const raw = [
      null,
      tool(0),
      tool(0),
      tool(3),
      { event: 'result', result: { usage: { input_tokens: 900 } } },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'answer',
          num_turns: 2,
          duration_seconds: 5.1,
          usage: {
            input_tokens: 25,
            cache_read_tokens: 75,
            output_tokens: 4,
            thinking_tokens: 2,
            total_tokens: 106,
          },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseAgyStreamJson(raw)).toEqual({
      stdout: 'answer',
      failed: false,
      usage: {
        toolCallsCount: 2,
        inputTokens: 25,
        cachedTokens: 75,
        outputTokens: 4,
        thinkingTokens: 2,
        totalTokens: 106,
        numTurns: 2,
        durationSeconds: 5.1,
        cacheHitRate: 0.75,
      },
    });
  });
  test('should extract the last result response on success', () => {
    const raw = [
      'not json',
      JSON.stringify({ event: 'init' }),
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'final answer' },
      }),
      '',
    ].join('\n');
    expect(parseAgyStreamJson(raw)).toEqual({
      stdout: 'final answer',
      failed: false,
    });
  });

  test('should flag non-SUCCESS results and empty responses with denied_actions', () => {
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: { status: 'ERROR', response: 'boom' },
        })
      )
    ).toEqual({ stdout: 'boom', failed: true });
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: '',
            denied_actions: [{ action: 'command' }],
          },
        })
      )
    ).toEqual({ stdout: '', failed: true });
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS' },
        })
      )
    ).toEqual({ stdout: '', failed: false });
  });

  test('should fall back to raw output when there is no result event', () => {
    expect(parseAgyStreamJson('plain error text')).toEqual({
      stdout: 'plain error text',
      failed: false,
    });
    const nullResult = JSON.stringify({ event: 'result', result: null });
    expect(parseAgyStreamJson(nullResult)).toEqual({
      stdout: nullResult,
      failed: false,
    });
  });
});

describe('installHint', () => {
  test('should give a hint for every agent', () => {
    for (const agent of AGENTS) expect(installHint(agent)).toBeTruthy();
  });
});

describe('dshDirProblem', () => {
  test('should accept ordinary paths, with spaces, and Windows backslashes', () => {
    expect(dshDirProblem('/Users/me/My Repo', 'darwin')).toBeNull();
    expect(dshDirProblem('C:\\Users\\me\\ws', 'win32')).toBeNull();
  });

  test.each([
    ['/home/me/a$b', 'linux'],
    ['/home/me/a`b', 'linux'],
    ['/home/me/a"b', 'linux'],
    ['/home/me/a\\b', 'linux'],
    ['/home/me/a\nb', 'linux'],
    ['C:\\Users\\me\\a$b', 'win32'],
    ['C:\\Users\\me\\a`b', 'win32'],
  ])(
    'should refuse %j on %s: the hook command reads it as shell syntax',
    (dir, platform) => {
      expect(dshDirProblem(dir, platform)).toMatch(
        /^DSH cannot run this workspace's hooks from .*\nFix: /s
      );
    }
  );
});

describe('isAgyBinary', () => {
  test.each([
    ['agy', true],
    ['AGY', true],
    ['agy acp', true],
    ['agy.exe', true],
    ['agy.CMD', true],
    ['agy.ps1', true],
    ['C:\\tools\\agy.exe', true],
    ['C:/tools/agy', true],
    ['tools/agy.bat', true],
    ['claude', false],
    ['myagy', false],
    ['agy.txt', false],
    ['npx -y @antigravity/agy', true],
    ['npx -y somepkg', false],
    ['', false],
  ])('should classify %j as %s', (bin, expected) => {
    expect(isAgyBinary(bin)).toBe(expected);
  });

  test('should treat a missing value as not agy', () => {
    expect(isAgyBinary(undefined)).toBe(false);
  });
});

describe('runAgent', () => {
  const command = buildCommand({ agent: 'codex' });
  let clock = 0;
  const now = () => (clock += 1000);

  test.each([false, true])(
    'should clean the private settings file after spawn throws=%s',
    (throws) => {
      const command = buildCommand({ agent: 'claude', mode: 'oneshot' });
      const at = command.args.indexOf('--settings') + 1;
      let settingsFile = '';
      const invoke = () =>
        runAgent({
          command,
          cwd: '/wt',
          prompt: 'p',
          timeoutMs: 5000,
          env: {},
          platform: 'win32',
          spawn: (_bin, args) => {
            settingsFile = args[at];
            expect(settingsFile).not.toContain('"');
            expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(
              command.args[at]
            );
            if (process.platform !== 'win32')
              expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
            if (throws) throw new Error('spawn failed');
            return { status: 0 };
          },
        });
      if (throws) expect(invoke).toThrow('spawn failed');
      else expect(invoke().code).toBe(0);
      expect(fs.existsSync(settingsFile)).toBe(false);
      expect(command.args[at]).toBe('{"disableAllHooks":true}');
    }
  );

  test('should refuse to start DSH from a dir its hook commands cannot carry', () => {
    const spawn = vi.fn();
    expect(() =>
      runAgent({
        command: buildCommand({ agent: 'dsh' }),
        cwd: '/wt/a$b',
        prompt: 'p',
        timeoutMs: 1,
        env: {},
        spawn,
        now,
        platform: 'linux',
      })
    ).toThrow(/DSH cannot run this workspace's hooks from \/wt\/a\$b/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should start the other agents from such a dir', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    runAgent({
      command,
      cwd: '/wt/a$b',
      prompt: 'p',
      timeoutMs: 1,
      env: {},
      spawn,
      now,
      platform: 'linux',
    });
    expect(spawn).toHaveBeenCalled();
  });

  test("should not pass the parent harness's session ids to the child agent", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const env = {
      A: '1',
      TASK_SESSION: 'mine',
      CLAUDE_CODE_SESSION_ID: 'cc-1',
      CODEX_THREAD_ID: 'cx-1',
      CODEX_SESSION_ID: 'cx-1',
      DSH_SESSION_ID: 'dsh-1',
      ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
    };
    runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1,
      env,
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({
        env: {
          A: '1',
          TASK_SESSION: 'mine',
          MEMORY_EXTRACT: '1',
          [CALLER_HARNESS_ENV]: 'codex',
        },
      })
    );
    expect(env.CLAUDE_CODE_SESSION_ID).toBe('cc-1');
  });

  test('should keep the memory hooks silent in every headless child', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

    runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1,
      env: { MEMORY_EXTRACT: '0' },
      spawn,
      now,
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({
        env: { [EXTRACT_ENV]: '1', [CALLER_HARNESS_ENV]: 'codex' },
      })
    );
  });

  test('should pass the prompt on stdin and join stdout and stderr', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'done',
      stderr: 'note',
    }));
    const result = runAgent({
      command,
      cwd: '/wt',
      prompt: 'fix it',
      timeoutMs: 5000,
      env: { A: '1' },
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({
        cwd: '/wt',
        input: 'fix it',
        timeout: 5000,
        env: {
          A: '1',
          MEMORY_EXTRACT: '1',
          [CALLER_HARNESS_ENV]: 'codex',
        },
      })
    );
    expect(result).toEqual({
      code: 0,
      signal: null,
      output: 'done\nnote',
      stdout: 'done',
      durationMs: 1000,
    });
  });

  test('should not open a console window for the child agent', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1,
      env: {},
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({ windowsHide: true })
    );
  });

  test('should report a timeout kill', () => {
    const result = runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 60000,
      env: {},
      spawn: () => ({
        status: null,
        signal: 'SIGTERM',
        stdout: null,
        error: new Error('spawnSync codex ETIMEDOUT'),
      }),
      now,
    });
    expect(result.signal).toBe('SIGTERM');
    expect(result.output).toContain('ETIMEDOUT');
    expect(result.stdout).toBe('');
    expect(result.output).toContain('(stopped by SIGTERM; timeout 60s)');
  });

  test('should encode prompts and decode stream-json responses for agy', () => {
    const agyCmd = buildCommand({ agent: 'agy', mode: 'read' });
    const ndjson = `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok answer' } })}\n`;
    const spawn = vi.fn(() => ({ status: 0, stdout: ndjson, stderr: '' }));
    const ok = runAgent({
      command: agyCmd,
      cwd: '/wt',
      prompt: 'review this',
      timeoutMs: 5000,
      env: {},
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'agy',
      [...agyCmd.args.slice(0, -1), expect.stringMatching(/settings\.json$/)],
      expect.objectContaining({
        input: `${JSON.stringify({ event: 'user', message: { content: 'review this' } })}\n`,
      })
    );
    expect(ok).toMatchObject({ code: 0, stdout: 'ok answer' });

    const denied = runAgent({
      command: agyCmd,
      cwd: '/wt',
      prompt: 'run cmd',
      timeoutMs: 5000,
      env: {},
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: '',
            denied_actions: [{ action: 'command' }],
          },
        }),
        stderr: 'auto-denied',
      }),
      now,
    });
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.output).toContain('auto-denied');
  });

  test('should throw a Fix line when the executable is missing', () => {
    const error = Object.assign(new Error('spawnSync dsh ENOENT'), {
      code: 'ENOENT',
    });
    expect(() =>
      runAgent({
        command: buildCommand({ agent: 'dsh' }),
        cwd: '/wt',
        prompt: 'p',
        timeoutMs: 1,
        env: {},
        spawn: () => ({ status: null, error }),
      })
    ).toThrow(/dsh was not found.*\nFix: pass --bin/s);
  });

  test('should block headless agy from foreign harnesses while allowing agy -> others', () => {
    const agyCmd = buildCommand({ agent: 'agy', mode: 'read' });
    const spawn = vi.fn(() => ({ status: 0, stdout: 'ok', stderr: '' }));
    for (const env of [
      { CLAUDE_CODE_SESSION_ID: 'cc-1' },
      { CLAUDECODE: '1' },
      { CODEX_THREAD_ID: 'cx-1' },
      { CODEX_SESSION_ID: 'cx-2' },
      { DSH_SESSION_ID: 'dsh-1' },
      { OPENCODE: '1' },
      { KYOTEN_AGENT: 'dscc' },
      { [CALLER_HARNESS_ENV]: 'codex' },
      { ANTIGRAVITY_CONVERSATION_ID: 'agy-1', CLAUDECODE: '1' },
    ]) {
      expect(() =>
        runAgent({
          command: agyCmd,
          cwd: '/wt',
          prompt: 'p',
          timeoutMs: 1000,
          env,
          spawn,
        })
      ).toThrow(/Terms of Service/);
    }
    expect(spawn).not.toHaveBeenCalled();

    // agy -> others is allowed, and does not leak KYOTEN_AGENT=agy to the child.
    runAgent({
      command: buildCommand({ agent: 'codex', mode: 'read' }),
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1000,
      env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1', KYOTEN_AGENT: 'agy' },
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const callEnv = (/** @type {number} */ n) =>
      /** @type {any} */ (spawn.mock.calls[n])?.[2]?.env;
    expect(callEnv(0).KYOTEN_AGENT).toBeUndefined();
    expect(callEnv(0)[CALLER_HARNESS_ENV]).toBe('codex');

    // dscc -> claude keeps KYOTEN_AGENT=dscc; agy -> agy keeps KYOTEN_AGENT=agy.
    runAgent({
      command: buildCommand({ agent: 'claude', mode: 'read' }),
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1000,
      env: { KYOTEN_AGENT: 'dscc' },
      spawn,
    });
    expect(callEnv(1).KYOTEN_AGENT).toBe('dscc');

    runAgent({
      command: agyCmd,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1000,
      env: { ANTIGRAVITY_CONVERSATION_ID: 'agy-1', KYOTEN_AGENT: 'agy' },
      spawn,
    });
    expect(callEnv(2).KYOTEN_AGENT).toBe('agy');
    expect(foreignHarnessForAgy({})).toBeNull();
    expect(
      foreignHarnessForAgy({
        ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
        KYOTEN_AGENT: 'agy',
        [CALLER_HARNESS_ENV]: 'agy',
      })
    ).toBeNull();
    expect(() => assertAgyAllowed('codex', { CLAUDECODE: '1' })).not.toThrow();
  });

  test('should block an agy executable passed with --bin from a foreign harness', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    for (const bin of ['agy', 'agy acp', 'AGY.EXE', 'C:\\tools\\agy.cmd']) {
      expect(() =>
        runAgent({
          command: buildCommand({ agent: 'claude', bin }),
          cwd: '/wt',
          prompt: 'p',
          timeoutMs: 1000,
          env: { CLAUDE_CODE_SESSION_ID: 'cc-1' },
          spawn,
        })
      ).toThrow(/Terms of Service/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should not treat another executable passed with --bin as agy', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    runAgent({
      command: buildCommand({ agent: 'claude', bin: 'myclaude' }),
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1000,
      env: { CLAUDECODE: '1' },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      'myclaude',
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({ CLAUDECODE: '1' }),
      })
    );
  });
});
