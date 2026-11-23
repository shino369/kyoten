import path from 'path';
import {
  agySettingsPath,
  agyTrustsProject,
  codexTrustsProject,
} from '../trust.js';
import * as setup from '../../workspace-setup.js';

describe('codexTrustsProject', () => {
  const root = '/repo';
  test.each([
    ['[projects."/repo"]\ntrust_level = "trusted"\n', true],
    ["[projects.'/repo']\ntrust_level = 'trusted'", true],
    ['[projects."/repo"]\ntrust_level = "untrusted"', false],
    ['[projects."/other"]\ntrust_level = "trusted"', false],
    ['[projects."/repo"]\n[other]\ntrust_level = "trusted"', false],
    ['trust_level = "trusted"', false],
    ['', false],
  ])('should parse %j as %s', (text, expected) => {
    expect(codexTrustsProject(text, root)).toBe(expected);
  });

  test('should unescape Windows paths', () => {
    expect(
      codexTrustsProject(
        '[projects."C:\\\\r"]\ntrust_level = "trusted"',
        'C:\\r'
      )
    ).toBe(true);
  });
});

describe('agyTrustsProject', () => {
  test('should match normalized paths and ignore case on Windows/macOS', () => {
    const settings = JSON.stringify({
      trustedWorkspaces: ['C:\\Work\\Repo\\', '/Users/Me/Proj'],
    });
    expect(agyTrustsProject(settings, 'c:\\work\\repo', 'win32')).toBe(true);
    expect(agyTrustsProject(settings, '/users/me/proj', 'darwin')).toBe(true);
    expect(agyTrustsProject(settings, '/users/me/proj', 'linux')).toBe(false);
    expect(agyTrustsProject(settings, '/Users/Me/Proj', 'linux')).toBe(true);
  });

  test('should return false for invalid JSON, non-array, or non-string entries', () => {
    expect(agyTrustsProject('{bad', '/repo')).toBe(false);
    expect(agyTrustsProject('{}', '/repo')).toBe(false);
    expect(
      agyTrustsProject(JSON.stringify({ trustedWorkspaces: [42] }), '/repo')
    ).toBe(false);
  });
});

describe('agySettingsPath', () => {
  test('should name the settings file under the home directory', () => {
    expect(agySettingsPath('/h')).toBe(
      path.join('/h', '.gemini', 'antigravity-cli', 'settings.json')
    );
  });
});

describe('workspace-setup re-exports', () => {
  test('should keep both trust rules importable from workspace-setup', () => {
    expect(setup.codexTrustsProject).toBe(codexTrustsProject);
    expect(setup.agyTrustsProject).toBe(agyTrustsProject);
  });
});
