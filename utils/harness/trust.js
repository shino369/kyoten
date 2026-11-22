/**
 * Project trust of Codex and Antigravity CLI, shared by pnpm workspace:setup
 * and kyoten doctor. Only Node built-ins: kyoten runs before any install.
 */
import path from 'path';

/**
 * Whether Codex config text marks `root` as a trusted project: a
 * `[projects."<root>"]` table holding `trust_level = "trusted"`. The text is
 * only matched, never printed.
 *
 * @param {string} text
 * @param {string} root
 * @returns {boolean}
 */
export function codexTrustsProject(text, root) {
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header =
      /^\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]/.exec(line);
    if (header) {
      const name = header[2] ?? header[1].replace(/\\(.)/g, '$1');
      inTable = name === root;
    } else if (line.startsWith('[')) {
      inTable = false;
    } else if (inTable && /^trust_level\s*=\s*["']trusted["']/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Antigravity CLI's settings file, which lists `trustedWorkspaces`.
 *
 * @param {string} homedir
 */
export const agySettingsPath = (homedir) =>
  path.join(homedir, '.gemini', 'antigravity-cli', 'settings.json');

/**
 * Whether Antigravity CLI settings JSON marks `root` as a trusted workspace
 * (`trustedWorkspaces` array). The text is only matched, never printed.
 *
 * @param {string} text
 * @param {string} root
 * @param {string} [platform]
 * @returns {boolean}
 */
export function agyTrustsProject(text, root, platform = process.platform) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const list = parsed?.trustedWorkspaces;
  if (!Array.isArray(list)) return false;
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  /** @param {string} value */
  const norm = (value) => {
    const clean = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return ignoreCase ? clean.toLowerCase() : clean;
  };
  const target = norm(root);
  return list.some(
    (entry) => typeof entry === 'string' && norm(entry) === target
  );
}
