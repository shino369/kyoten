/**
 * Tests for module-runner.js
 */
import { runIfMain } from '../module-runner.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { vi } from 'vitest';
import { linkDir } from './support/links.js';

describe('module-runner', () => {
  describe('runIfMain', () => {
    test('should not run function when import.meta.url is not file:', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      runIfMain('https://example.com/module.js', mockFn);

      expect(called).toBe(false);
    });

    test('should not run function when paths do not match', () => {
      const main = vi.fn();
      const differentScript = new URL('./different-script.js', import.meta.url);

      runIfMain(differentScript.href, main);

      expect(main).not.toHaveBeenCalled();
    });

    test('should run function when module is executed directly', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Get the actual file path of the current test file
      const currentFilePath = fileURLToPath(import.meta.url);

      // Temporarily mock process.argv[1] to match
      const originalArgv = process.argv[1];
      process.argv[1] = currentFilePath;

      try {
        runIfMain(import.meta.url, mockFn);
        expect(called).toBe(true);
      } finally {
        // Restore original argv
        process.argv[1] = originalArgv;
      }
    });

    test('should run function when scriptPath + .js matches', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Get the current file path
      const currentFilePath = fileURLToPath(import.meta.url);

      // Mock process.argv[1] to be the path without .js
      const originalArgv = process.argv[1];
      process.argv[1] = currentFilePath.replace(/\.js$/, '');

      try {
        runIfMain(import.meta.url, mockFn);
        expect(called).toBe(true);
      } finally {
        // Restore original argv
        process.argv[1] = originalArgv;
      }
    });

    test('should run when the script was started through a linked folder', () => {
      const tmp = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
      );
      const real = path.join(tmp, 'real');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'script.js'), '');
      linkDir(real, path.join(tmp, 'link'));
      const originalArgv = process.argv[1];
      process.argv[1] = path.join(tmp, 'link', 'script.js');
      let called = false;

      try {
        runIfMain(pathToFileURL(path.join(real, 'script.js')).href, () => {
          called = true;
        });
      } finally {
        process.argv[1] = originalArgv;
        fs.rmSync(tmp, { recursive: true, force: true });
      }

      expect(called).toBe(true);
    });

    test('should run when both import.meta.url and process.argv[1] go through a linked folder', () => {
      const tmp = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
      );
      const real = path.join(tmp, 'real');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'script.js'), '');
      linkDir(real, path.join(tmp, 'link'));
      const linkedScript = path.join(tmp, 'link', 'script.js');
      const originalArgv = process.argv[1];
      process.argv[1] = linkedScript;
      let called = false;

      try {
        runIfMain(pathToFileURL(linkedScript).href, () => {
          called = true;
        });
      } finally {
        process.argv[1] = originalArgv;
        fs.rmSync(tmp, { recursive: true, force: true });
      }

      expect(called).toBe(true);
    });

    test('should run when process.argv[1] is a relative path', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      const originalArgv = process.argv[1];
      process.argv[1] = path.relative(
        process.cwd(),
        fileURLToPath(import.meta.url)
      );

      try {
        runIfMain(import.meta.url, mockFn);
        expect(called).toBe(true);
      } finally {
        process.argv[1] = originalArgv;
      }
    });

    test('should not throw when process.argv[1] is missing', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      const originalArgv = process.argv[1];
      process.argv[1] = /** @type {any} */ (undefined);

      try {
        expect(() => runIfMain(import.meta.url, mockFn)).not.toThrow();
        expect(called).toBe(false);
      } finally {
        process.argv[1] = originalArgv;
      }
    });

    test('should handle invalid file URLs gracefully', () => {
      const main = vi.fn();

      // Node rejects an encoded path separator on both POSIX and Windows.
      runIfMain('file:///C:/invalid%2Fpath', main);

      expect(main).not.toHaveBeenCalled();
    });
  });
});
