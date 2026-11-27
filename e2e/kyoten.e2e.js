/**
 * kyoten end to end, through the path users take: the packed tarball run with
 * `npx --package <tgz> -- kyoten …`. Fake claude, codex, dsh, and agy go first on
 * PATH (on Windows as .cmd shims, so the cmd.exe path is covered); they record
 * their argv, cwd, and environment and exit with $FAKE_EXIT.
 *
 * The tarball is built from HEAD (`pnpm kyoten:pack`): commit before running.
 * A second tarball, from a scratch repository whose README differs, drives a
 * real `kyoten update` merge.
 */
import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { crossSpawn } from '../utils/spawn.js';
import { exportTree } from '../utils/kyoten/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const run = crossSpawn();
const KEY = 'sk-e2e-token-1234567890';
const callerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/i.test(name)
  )
);

test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** @type {string} */
let tmp;
/** @type {string} */
let bin;
/** @type {string} */
let tarball;
/** @type {string} */
let home;
/** The tarball of the scratch repository (the update test). */
let second = '';

/**
 * @param {string} file
 * @param {string[]} args
 * @param {object} [options]
 */
function must(file, args, options = {}) {
  const result = run(file, args, { encoding: 'utf-8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} failed (${result.status}): ${result.stderr}${result.error ?? ''}`
    );
  }
  return String(result.stdout);
}

/** @param {string} dir  a git repo with an isolated identity */
const git = (dir, /** @type {string[]} */ ...args) =>
  must('git', [
    '-C',
    dir,
    '-c',
    'user.name=e2e',
    '-c',
    'user.email=e2e@x',
    '-c',
    'commit.gpgSign=false',
    ...args,
  ]);

/**
 * Build a tarball from `root` (a kyoten repo) into `out`.
 *
 * @param {string} root
 * @param {string} out
 */
function packFrom(root, out) {
  const stdout = must(
    process.execPath,
    [path.join(root, 'utils', 'kyoten', 'pack.js'), '--out', out],
    { cwd: root }
  );
  return stdout.trim().split('\n').at(-1) ?? '';
}

/** Write the fake agents into `bin`. */
function writeFakes() {
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'fake.mjs');
  fs.writeFileSync(
    fake,
    `import fs from 'fs';
import path from 'path';
const name = path.basename(process.argv[2]);
const keys = ['KYOTEN_HOME', 'KYOTEN_CALLER_DIR', 'KYOTEN_ADD_DIR', 'KYOTEN_AGENT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID'];
const env = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ name, argv: process.argv.slice(3), cwd: process.cwd(), env }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`
  );
  for (const name of ['claude', 'codex', 'dsh', 'agy']) {
    if (WIN) {
      fs.writeFileSync(
        path.join(bin, `${name}.cmd`),
        `@echo off\r\nnode "%~dp0fake.mjs" ${name} %*\r\n`
      );
    } else {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\nexec node "${fake}" ${name} "$@"\n`);
      fs.chmodSync(file, 0o755);
    }
  }
}

/**
 * Run kyoten from a tarball.
 *
 * @param {string[]} args
 * @param {{ tgz?: string, env?: Record<string, string>, input?: string, cwd?: string }} [options]
 */
function kyoten(args, { tgz = tarball, env = {}, input, cwd = tmp } = {}) {
  const out = path.join(
    tmp,
    `fake-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const result = run(
    'npx',
    ['--yes', '--package', tgz, '--', 'kyoten', ...args],
    {
      cwd,
      input: input ?? '',
      encoding: 'utf-8',
      env: {
        ...callerEnv,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        KYOTEN_HOME: home,
        XDG_CONFIG_HOME: path.join(tmp, 'cfg'),
        APPDATA: path.join(tmp, 'cfg'),
        DSCC_PROFILE: path.join(tmp, 'cfg', 'dscc.env'),
        FAKE_OUT: out,
        ...env,
      },
    }
  );
  const agent = fs.existsSync(out)
    ? JSON.parse(fs.readFileSync(out, 'utf-8'))
    : null;
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
    agent,
  };
}

test.beforeAll(() => {
  // The real native path: on macOS /var -> /private/var; on Windows 8.3 short
  // %TEMP% paths (RUNNER~1) and drive/folder casing match outsideRepo().
  tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-e2e-'))
  );
  bin = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  writeFakes();
  tarball = packFrom(ROOT, path.join(tmp, 'dist'));
});

test.afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('prints the version of the workspace package', () => {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
  ).version;

  const result = kyoten(['--version']);

  expect(result.stdout.trim()).toBe(version);
});

test('init creates a clean home from the snapshot', () => {
  const result = kyoten(['init', '--no-setup']);

  expect(result.status).toBe(0);
  for (const file of [
    '.gitignore',
    'pnpm-lock.yaml',
    'AGENTS.md',
    'utils/kyoten/cli.js',
  ]) {
    expect(fs.existsSync(path.join(home, file)), file).toBe(true);
  }
  expect(
    git(home, 'branch', '--format=%(refname:short)').trim().split('\n').sort()
  ).toEqual(['kyoten/upstream', 'main']);
  expect(git(home, 'status', '--porcelain')).toBe('');
  // No terminal: automatic memory saving starts off (opt-in).
  expect(
    JSON.parse(
      fs.readFileSync(path.join(home, 'memory', 'config.json'), 'utf-8')
    )
  ).toEqual({ off: true });
  expect(result.stderr).toContain('opt in with: kyoten run memory on');
});

test('claude starts in the home with the arguments and exit code passed through', () => {
  const result = kyoten(['-p', 'hello world'], {
    env: { FAKE_EXIT: '3', CLAUDE_CODE_SESSION_ID: 'parent' },
  });

  expect(result.status).toBe(3);
  expect(result.agent.name).toBe('claude');
  expect(result.agent.env.KYOTEN_AGENT).toBe('claude');
  expect(result.agent.argv).toEqual(['-p', 'hello world']);
  // Real native paths: macOS reaches /var -> /private/var; Windows expands 8.3.
  expect(fs.realpathSync.native(result.agent.cwd)).toBe(
    fs.realpathSync.native(home)
  );
  expect(fs.realpathSync.native(result.agent.env.KYOTEN_CALLER_DIR)).toBe(
    fs.realpathSync.native(tmp)
  );
  expect(result.agent.env.CLAUDE_CODE_SESSION_ID).toBeNull();
});

test('codex starts in the home', () => {
  const result = kyoten(['codex', 'resume']);

  expect(result.agent.name).toBe('codex');
  expect(result.agent.env.KYOTEN_AGENT).toBe('codex');
  expect(result.agent.argv).toEqual(['resume']);
});

test('dsh starts with its profile and the workspace patch', () => {
  const result = kyoten(['dsh', 'tui']);

  expect(result.agent.name).toBe('dsh');
  expect(result.agent.env.KYOTEN_AGENT).toBe('dsh');
  expect(result.agent.argv).toEqual([
    'tui',
    '--patch',
    '.dsh/workspace.patch.yml',
  ]);
  expect(result.stderr).not.toContain('Choose workspace');
});

test('dsh web says which Web UI workspace to choose', () => {
  const result = kyoten(['dsh', '--no-open']);

  expect(result.agent.argv).toEqual([
    'web',
    '--patch',
    '.dsh/workspace.patch.yml',
    '--no-open',
  ]);
  expect(result.stderr).toContain(
    `click Choose workspace, add ${home}, and select it`
  );
});

test('agy starts in the home with no added arguments', () => {
  const result = kyoten(['agy']);

  expect(result.agent.name).toBe('agy');
  expect(result.agent.env.KYOTEN_AGENT).toBe('agy');
  expect(result.agent.argv).toEqual([]);
  expect(fs.realpathSync.native(result.agent.cwd)).toBe(
    fs.realpathSync.native(home)
  );
});

test.describe('started inside a git repository outside the home', () => {
  /** @type {string} */
  let repo;

  test.beforeAll(() => {
    repo = path.join(tmp, 'project');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q');
  });

  test('claude, codex, and agy get --add-dir=<repo> first', () => {
    for (const agent of ['claude', 'codex', 'agy']) {
      const result = kyoten([agent, 'hello'], { cwd: path.join(repo, 'src') });

      expect(result.agent.name).toBe(agent);
      expect(result.agent.argv).toEqual([`--add-dir=${repo}`, 'hello']);
      expect(result.agent.env.KYOTEN_ADD_DIR).toBe(repo);
      expect(result.stderr).toContain(`; --add-dir=${repo}`);
    }
  });

  test('--no-add-dir turns it off', () => {
    const result = kyoten(['--no-add-dir', 'claude', 'hello'], { cwd: repo });

    expect(result.agent.argv).toEqual(['hello']);
    expect(result.agent.env.KYOTEN_ADD_DIR).toBeNull();
  });

  test('dsh does not get it', () => {
    const dsh = kyoten(['dsh', 'tui'], { cwd: repo });

    expect(dsh.agent.argv).not.toContain(`--add-dir=${repo}`);
  });
});

test('dscc saves a piped key, masks it, and starts claude on the DeepSeek profile', () => {
  const saved = kyoten(['dscc', '--set-key'], { input: `${KEY}\n` });
  const shown = kyoten(['dscc', '--show']);
  const result = kyoten(['dscc'], {
    env: { ANTHROPIC_API_KEY: 'sk-ant-inherited' },
  });

  expect(saved.status).toBe(0);
  expect(shown.stdout).toContain('ANTHROPIC_AUTH_TOKEN=sk-e...7890');
  expect(shown.stdout).not.toContain(KEY);
  expect(result.agent.name).toBe('claude');
  expect(result.agent.env.ANTHROPIC_BASE_URL).toBe(
    'https://api.deepseek.com/anthropic'
  );
  expect(result.agent.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  expect(result.agent.env.ANTHROPIC_API_KEY).toBeNull();
  expect(result.agent.env.KYOTEN_AGENT).toBe('dscc');
});

test('run lists the home scripts and runs one there', () => {
  const version = JSON.parse(
    fs.readFileSync(path.join(home, 'package.json'), 'utf-8')
  ).version;

  const list = kyoten(['run']);
  // The home's own kyoten script needs no installed dependencies.
  const result = kyoten(['run', 'kyoten', 'version']);

  expect(list.status).toBe(0);
  expect(list.stdout).toContain('Usage: kyoten run <script>');
  expect(list.stdout).toContain('  task\n');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(version);
});

test('update merges a newer snapshot with a local commit', () => {
  // A scratch kyoten repository: HEAD's files, then a README change.
  const scratch = path.join(tmp, 'scratch');
  exportTree({ repo: ROOT, dest: scratch });
  git(scratch, 'init', '-q');
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-q', '-m', 'chore: snapshot');
  fs.appendFileSync(path.join(scratch, 'README.md'), '\nUpstream change.\n');
  git(scratch, 'commit', '-q', '-am', 'docs: upstream change');
  second = packFrom(scratch, path.join(tmp, 'dist2'));
  // A local change to another file in the home.
  fs.appendFileSync(path.join(home, 'docs', 'harness.md'), '\nLocal note.\n');
  git(home, 'commit', '-q', '-am', 'docs: local note');

  const result = kyoten(['update', '--no-setup'], { tgz: second });

  expect(result.status, `${second}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(path.join(home, 'README.md'), 'utf-8')).toContain(
    'Upstream change.'
  );
  expect(
    fs.readFileSync(path.join(home, 'docs', 'harness.md'), 'utf-8')
  ).toContain('Local note.');
  expect(git(home, 'log', '-1', '--format=%s')).toContain(
    "Merge branch 'kyoten/upstream'"
  );
  expect(git(home, 'status', '--porcelain')).toBe('');
});

test('a second update with the same snapshot changes nothing', () => {
  const head = git(home, 'rev-parse', 'HEAD');

  const result = kyoten(['update', '--no-setup'], { tgz: second });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('already has kyoten');
  expect(git(home, 'rev-parse', 'HEAD')).toBe(head);
});

test('config sets, gets, and unsets a value', () => {
  const set = kyoten(['config', 'set', 'args.codex', '--model', 'x']);
  const get = kyoten(['config', 'get', 'args.codex']);
  const launched = kyoten(['codex']);
  const unset = kyoten(['config', 'unset', 'args.codex']);
  const shown = kyoten(['config']);

  expect(set.status, set.stderr).toBe(0);
  expect(JSON.parse(get.stdout)).toEqual(['--model', 'x']);
  expect(launched.agent.argv).toEqual(['--model', 'x']);
  expect(unset.status).toBe(0);
  expect(shown.stdout).not.toContain('args');
});

test('backup, then restore into a fresh home, brings back a local commit and the config', () => {
  kyoten(['config', 'set', 'addDir', 'true']);
  // The homes are not installed (init --no-setup); borrow this repository's
  // modules so `pnpm memory export|import` can run.
  const modules = (/** @type {string} */ dir) =>
    fs.symlinkSync(
      path.join(ROOT, 'node_modules'),
      path.join(dir, 'node_modules'),
      'junction'
    );
  modules(home);
  const folder = path.join(tmp, 'e2e-backup');

  const made = kyoten(['backup', folder]);
  const fresh = path.join(tmp, 'restored-home');
  const cfg2 = path.join(tmp, 'cfg2');
  const isolated = {
    KYOTEN_HOME: fresh,
    XDG_CONFIG_HOME: cfg2,
    APPDATA: cfg2,
    DSCC_PROFILE: path.join(cfg2, 'dscc.env'),
  };
  kyoten(['init', '--no-setup'], { env: isolated });
  modules(fresh);
  const restored = kyoten(['restore', folder, '--yes'], { env: isolated });

  expect(made.status, made.stderr).toBe(0);
  expect(fs.existsSync(path.join(folder, 'manifest.json'))).toBe(true);
  expect(fs.existsSync(path.join(folder, 'dscc.env'))).toBe(false);
  expect(restored.status, restored.stderr).toBe(0);
  expect(
    fs.readFileSync(path.join(fresh, 'docs', 'harness.md'), 'utf-8')
  ).toContain('Local note.');
  expect(git(fresh, 'log', '--format=%s', '--no-merges')).toContain(
    'docs: local note'
  );
  expect(
    JSON.parse(
      fs.readFileSync(path.join(cfg2, 'kyoten', 'config.json'), 'utf-8')
    )
  ).toEqual({ addDir: true });
});

test('reset --yes moves a home aside and prints the undo', () => {
  const other = path.join(tmp, 'reset-home');
  kyoten(['init', '--no-setup'], { env: { KYOTEN_HOME: other } });

  const result = kyoten(['reset', '--yes'], { env: { KYOTEN_HOME: other } });

  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(other)).toBe(false);
  const moved = fs
    .readdirSync(tmp)
    .filter((name) => name.startsWith('reset-home.removed-'));
  expect(moved).toHaveLength(1);
  expect(result.stderr).toContain(moved[0]);
  expect(result.stderr).toMatch(/mv |Move-Item/);
});

test('init --memory on keeps automatic memory saving on in a new home', () => {
  const other = path.join(tmp, 'memory-on-home');

  const result = kyoten(['init', '--no-setup', '--memory', 'on'], {
    env: { KYOTEN_HOME: other },
  });

  expect(result.status, result.stderr).toBe(0);
  const config = path.join(other, 'memory', 'config.json');
  // On is the default, so the file may be missing; it must not say off.
  const saved = fs.existsSync(config)
    ? JSON.parse(fs.readFileSync(config, 'utf-8'))
    : {};
  expect(saved.off).not.toBe(true);
  expect(result.stderr).not.toContain('opt in with: kyoten run memory on');
});

test('doctor reports the agy and dsh web checks', () => {
  const other = path.join(tmp, 'doctor-home');
  kyoten(['init', '--no-setup'], { env: { KYOTEN_HOME: other } });

  const result = kyoten(['doctor'], { env: { KYOTEN_HOME: other } });

  // Each line's status depends on the machine, and doctor exits 1 here (the
  // home has no node_modules), so assert only that the lines exist.
  const output = result.stdout + result.stderr;
  expect(output).toContain('agy-trust');
  expect(output).toContain('dsh-web');
});

test('the language guard CLI blocks a reply in the wrong language once', () => {
  const other = path.join(tmp, 'guard-home');
  const env = { KYOTEN_HOME: other };
  kyoten(['init', '--no-setup', '--memory', 'on'], { env });
  fs.symlinkSync(
    path.join(ROOT, 'node_modules'),
    path.join(other, 'node_modules'),
    'junction'
  );
  must('pnpm', ['memory', 'personalize', '--language', '日本語'], {
    cwd: other,
  });
  const guard = (
    /** @type {string[]} */ args,
    /** @type {Record<string, unknown>} */ input
  ) =>
    run(
      process.execPath,
      [path.join(other, 'utils', 'memory', 'language_guard.js'), ...args],
      {
        cwd: other,
        encoding: 'utf-8',
        input: JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'e2e-guard',
          last_assistant_message:
            'The fix is finished on the branch, and every test passes. Next I will open a review round.',
          ...input,
        }),
        env: { ...process.env, MEMORY_EXTRACT: '' },
      }
    );

  const first = guard(['--harness', 'codex'], {});
  const retry = guard(['--harness', 'codex'], { stop_hook_active: true });
  const broken = run(
    process.execPath,
    [path.join(other, 'utils', 'memory', 'language_guard.js')],
    { cwd: other, encoding: 'utf-8', input: '{oops' }
  );

  expect(first.status).toBe(0);
  expect(JSON.parse(String(first.stdout))).toMatchObject({
    decision: 'block',
  });
  expect(String(first.stdout)).toContain('日本語');
  expect(retry.status).toBe(0);
  expect(String(retry.stdout)).toBe('');
  expect(broken.status).toBe(0);
  expect(String(broken.stdout)).toBe('');
});

test('a per-agent persona reaches only the SessionStart hook of its own harness', () => {
  const other = path.join(tmp, 'persona-home');
  const env = { KYOTEN_HOME: other };
  kyoten(['init', '--no-setup', '--memory', 'on'], { env });
  fs.symlinkSync(
    path.join(ROOT, 'node_modules'),
    path.join(other, 'node_modules'),
    'junction'
  );
  // The local files Claude Code loads natively, so the hook adds the override.
  must('pnpm', ['memory', 'init'], { cwd: other });
  must(
    'pnpm',
    [
      'memory',
      'personalize',
      '--for',
      'claude',
      '--persona',
      'Speak like a pirate',
    ],
    { cwd: other }
  );
  const hook = (
    /** @type {string} */ harness,
    /** @type {Record<string, string>} */ extra
  ) => {
    const result = run(
      process.execPath,
      [path.join(other, 'utils', 'memory', 'hook.js'), '--harness', harness],
      {
        cwd: other,
        encoding: 'utf-8',
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 'e2e-persona',
          source: 'startup',
          cwd: other,
        }),
        env: { ...process.env, KYOTEN_AGENT: '', ...extra },
      }
    );
    return String(result.stdout);
  };

  const own = hook('claude', { KYOTEN_AGENT: 'claude' });
  // Without KYOTEN_AGENT (an agent started without kyoten), the hook uses the
  // file of the harness it runs in.
  const direct = hook('claude', {});
  const codex = hook('codex', {});
  const inherited = hook('codex', { KYOTEN_AGENT: 'claude' });

  for (const output of [own, direct]) {
    expect(output).toContain(
      '[Persona] This claude session has its own persona'
    );
    expect(output).toContain('Speak like a pirate');
  }
  for (const output of [codex, inherited]) {
    expect(output).toContain('<!-- memory:start -->');
    expect(output).not.toContain('has its own persona');
    expect(output).not.toContain('Speak like a pirate');
  }
});
