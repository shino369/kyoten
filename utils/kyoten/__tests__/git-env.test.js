import { childEnv, gitEnv } from '../git-env.js';

const INHERITED = {
  PATH: '/bin',
  HOME: '/home/u',
  GIT_DIR: '/other/.git',
  GIT_WORK_TREE: '/other',
  GIT_INDEX_FILE: '/other/index',
  GIT_OBJECT_DIRECTORY: '/other/objects',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/a',
  GIT_CEILING_DIRECTORIES: '/c',
  GIT_CONFIG_GLOBAL: '/g',
  GIT_CONFIG_COUNT: '1',
  GIT_NAMESPACE: 'ns',
  GIT_COMMON_DIR: '/common',
};

describe('gitEnv', () => {
  test('should drop every inherited GIT_ variable and keep the rest', () => {
    expect(gitEnv(INHERITED, {}, 'linux')).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
    });
  });

  test('should add back what kyoten sets on purpose', () => {
    expect(
      gitEnv(INHERITED, { GIT_INDEX_FILE: '/scratch/index' }, 'linux')
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GIT_INDEX_FILE: '/scratch/index',
    });
  });

  test('should match names case-sensitively except on win32', () => {
    const env = { git_dir: '/x', Git_Work_Tree: '/y', PATH: '/bin' };

    expect(gitEnv(env, {}, 'linux')).toEqual(env);
    expect(gitEnv(env, {}, 'win32')).toEqual({ PATH: '/bin' });
  });

  test('should default to the process environment', () => {
    vi.stubEnv('GIT_DIR', '/other/.git');

    expect(gitEnv().GIT_DIR).toBeUndefined();
    expect(gitEnv().PATH).toBe(process.env.PATH);
    vi.unstubAllEnvs();
  });
});

describe('childEnv', () => {
  test('should drop the variables that pick a repository and keep the rest', () => {
    const env = childEnv(
      {
        GIT_DIR: '/other/.git',
        GIT_WORK_TREE: '/other',
        GIT_INDEX_FILE: 'i',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath'='x'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: 'x',
        GIT_SSH_COMMAND: 'ssh -i key',
        GIT_EDITOR: 'vim',
        PATH: '/bin',
      },
      'linux'
    );

    expect(env).toEqual({
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_EDITOR: 'vim',
      PATH: '/bin',
    });
  });

  test('should match names case-insensitively on Windows', () => {
    expect(childEnv({ Git_Dir: 'x', Path: 'p' }, 'win32')).toEqual({
      Path: 'p',
    });
  });

  test('should keep a differently cased name on POSIX', () => {
    expect(childEnv({ git_dir: 'x' }, 'linux')).toEqual({ git_dir: 'x' });
  });
});
