/**
 * `kyoten config`: show and change the per-user config file without editing
 * JSON by hand.
 *
 *   kyoten config                       the path and the content
 *   kyoten config path                  only the path
 *   kyoten config get <key>
 *   kyoten config set <key> <value…>
 *   kyoten config unset <key>
 *
 * Keys: `home` (a kyoten workspace), `args.<agent>` (every remaining word is
 * one argument, also words that start with `-`), `addDir` (true or false).
 * Writes go through `validateConfig` and an atomic file write.
 */
import path from 'path';
import {
  AGENTS,
  expandHome,
  homeState,
  validateConfig,
  writeConfig,
} from './home.js';

export const CONFIG_KEYS = ['home', 'args.<agent>', 'addDir'];
const USAGE =
  'kyoten config [path | get <key> | set <key> <value…> | unset <key>]';

/**
 * @typedef {import('./home.js').KyotenConfig} KyotenConfig
 * @typedef {{ name: 'home' | 'addDir' } | { name: 'args', agent: import('./home.js').AgentName }} ConfigKey
 */

/**
 * @param {string} what
 * @param {string} fix
 */
const fail = (what, fix) => new Error(`${what}.\nFix: ${fix}`);

/**
 * @param {string} key
 * @returns {ConfigKey}
 */
function parseKey(key) {
  if (key === 'home' || key === 'addDir') return { name: key };
  if (key.startsWith('args.')) {
    const agent = /** @type {import('./home.js').AgentName} */ (key.slice(5));
    if (!AGENTS.includes(agent)) {
      throw fail(
        `"${agent}" is not an agent (agents: ${AGENTS.join(', ')})`,
        'kyoten config set args.<agent> <argument>…'
      );
    }
    return { name: 'args', agent };
  }
  throw fail(
    `unknown config key "${key}" (keys: ${CONFIG_KEYS.join(', ')})`,
    'kyoten config'
  );
}

/**
 * @param {KyotenConfig} config
 * @param {ConfigKey} key
 */
function currentValue(config, key) {
  return key.name === 'args' ? config.args?.[key.agent] : config[key.name];
}

/**
 * @param {string[]} words  the `set` arguments after the key
 * @param {ConfigKey} key
 * @param {{ cwd: string, homedir: string }} dirs
 * @returns {string[] | string | boolean}
 */
function parseValue(words, key, { cwd, homedir }) {
  if (key.name === 'args') {
    if (words.length === 0) {
      throw fail(
        `args.${key.agent} needs at least one argument`,
        `kyoten config set args.${key.agent} <argument>… (to clear it: kyoten config unset args.${key.agent})`
      );
    }
    return words;
  }
  if (words.length !== 1) {
    throw fail(
      `${key.name} takes exactly one value`,
      key.name === 'home'
        ? 'kyoten config set home <dir>'
        : 'kyoten config set addDir true|false'
    );
  }
  const [word] = words;
  if (key.name === 'addDir') {
    if (word !== 'true' && word !== 'false') {
      throw fail(
        `addDir must be true or false, not "${word}"`,
        'kyoten config set addDir true|false'
      );
    }
    return word === 'true';
  }
  const dir = path.resolve(cwd, expandHome(word, homedir));
  if (homeState(dir) !== 'workspace') {
    throw fail(
      `${dir} is not a kyoten workspace`,
      'kyoten init <dir> (it creates the home and makes it the default)'
    );
  }
  return dir;
}

/**
 * @param {KyotenConfig} config
 * @param {ConfigKey} key
 * @param {string[] | string | boolean | undefined} value  undefined removes the key
 * @returns {KyotenConfig}
 */
function withValue(config, key, value) {
  /** @type {Record<string, unknown>} */
  const next = { ...config };
  if (key.name === 'args') {
    const args = { ...config.args };
    if (value === undefined) delete args[key.agent];
    else args[key.agent] = /** @type {string[]} */ (value);
    if (Object.keys(args).length > 0) next.args = args;
    else delete next.args;
  } else if (value === undefined) {
    delete next[key.name];
  } else {
    next[key.name] = value;
  }
  return next;
}

/**
 * @param {{ args: string[], file: string, config: KyotenConfig, cwd: string, homedir: string, out: (text: string) => void, err: (text: string) => void }} input
 * @returns {number}  the exit code
 */
export function runConfig({ args, file, config, cwd, homedir, out, err }) {
  const [sub, keyName, ...words] = args;
  if (sub === undefined) {
    out(file);
    out(JSON.stringify(config, null, 2));
    return 0;
  }
  if (sub === 'path' && keyName === undefined) {
    out(file);
    return 0;
  }
  if (sub !== 'get' && sub !== 'set' && sub !== 'unset') {
    throw fail(`unknown config command: ${sub}`, USAGE);
  }
  if (keyName === undefined) {
    throw fail(`kyoten config ${sub} needs a key`, USAGE);
  }
  const key = parseKey(keyName);
  if (sub !== 'set' && words.length > 0) {
    throw fail(
      `unexpected argument for kyoten config ${sub}: ${words[0]}`,
      `kyoten config ${sub} <key>`
    );
  }
  const current = currentValue(config, key);
  if (sub === 'get') {
    if (current === undefined) {
      throw fail(
        `${keyName} is not set in ${file}`,
        `kyoten config set ${keyName} <value>`
      );
    }
    out(typeof current === 'string' ? current : JSON.stringify(current));
    return 0;
  }
  if (sub === 'unset' && current === undefined) {
    err(`kyoten: ${keyName} was not set; nothing changed`);
    return 0;
  }
  const value =
    sub === 'set' ? parseValue(words, key, { cwd, homedir }) : undefined;
  writeConfig(file, validateConfig(withValue(config, key, value), file));
  err(
    sub === 'set'
      ? `kyoten: ${keyName} saved in ${file}`
      : `kyoten: ${keyName} removed from ${file}`
  );
  return 0;
}
