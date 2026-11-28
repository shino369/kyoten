/** Shared command, provider environment, and redaction for headless calls. */
import os from 'os';
import { buildCommand, assertAgyAllowed } from './adapters.js';
import { TOKEN_KEYS, dsccEnv, profilePath } from '../kyoten/dscc.js';
import { REDACTED, redactSecrets } from '../redact.js';
import { commandFor } from '../tools/registry.js';

/** Profile fields the dscc launcher accepts as credentials. */
const PROFILE_CREDENTIAL_KEYS = new Set(TOKEN_KEYS);
/** Profile and environment field holding extra request headers. */
const HEADERS_KEY_RE = /(?:^|_)CUSTOM_HEADERS$/i;
/**
 * The shortest literal that is scrubbed: a shorter value (a port, a count, a
 * flag) would shred ordinary output. A profile credential field is a known
 * secret, so it uses a lower floor than a value matched only by its inherited
 * variable name.
 */
const MIN_PROFILE_SECRET_LENGTH = 4;
const MIN_ENV_SECRET_LENGTH = 8;
/**
 * Inherited variable names that hold credentials: TOKEN, SECRET, PASSWORD,
 * PASSWD, API_KEY, ACCESS_KEY, PRIVATE_KEY, AUTH_KEY, AUTH_HEADER,
 * AUTHORIZATION, or CREDENTIAL(S) as a whole `_`-separated word, or a `_PWD`
 * suffix. `GITHUB_TOKEN` and `MYSQL_PWD` match; `CLAUDE_CODE_MAX_OUTPUT_TOKENS`,
 * `GIT_AUTHOR_EMAIL`, and the shell's `PWD` / `OLDPWD` do not.
 */
const ENV_SECRET_NAME_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_(?:KEY|HEADER)|AUTHORIZATION|CREDENTIALS?)(?:$|_)|_PWD$/i;
const HEADER_SCHEME_RE = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;

/**
 * Add a literal secret, unquoted when wrapped in matching quotes, to `values`
 * unless it is shorter than `minLength` or a reference (`$VAR`,
 * `<placeholder>`).
 *
 * @param {Set<string>} values
 * @param {string} raw
 * @param {number} minLength
 */
function addSecretValue(values, raw, minLength) {
  const trimmed = raw.trim();
  const value = /^(["']).*\1$/s.test(trimmed)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  if (value.length >= minLength && !/^(?:\$|<[^>]*>$)/.test(value)) {
    values.add(value);
  }
}

/**
 * Add each header value of a custom-headers field (`Name: value` lines), and
 * the token after a `Bearer`/`Basic`/`Token` scheme.
 *
 * @param {Set<string>} values
 * @param {string} raw
 * @param {number} minLength
 */
function addHeaderSecrets(values, raw, minLength) {
  const trimmed = raw.trim();
  const unquoted = /^(["']).*\1$/s.test(trimmed)
    ? trimmed.slice(1, -1)
    : trimmed;
  for (const line of unquoted.split(/\r?\n|\\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const headerValue = line.slice(colon + 1).trim();
    addSecretValue(values, headerValue, minLength);
    const scheme = HEADER_SCHEME_RE.exec(headerValue)?.[1];
    if (scheme) addSecretValue(values, scheme, minLength);
  }
}

/** @param {Set<string>} values */
const longestFirst = (values) =>
  [...values].sort((a, b) => b.length - a.length);

/**
 * Literal credential values from a dscc profile (`set`): the token fields and
 * the custom header values, longest first so a full token is replaced before
 * any substring. Other profile values (endpoint, model names, limits) are
 * configuration and stay visible; URL credentials in output are caught by the
 * shared `redactSecrets` patterns.
 *
 * @param {Record<string, string>} set
 * @returns {string[]}
 */
export function profileSecrets(set) {
  /** @type {Set<string>} */
  const values = new Set();
  for (const [key, value] of Object.entries(set)) {
    if (!value) continue;
    if (PROFILE_CREDENTIAL_KEYS.has(key)) {
      addSecretValue(values, value, MIN_PROFILE_SECRET_LENGTH);
    }
    if (HEADERS_KEY_RE.test(key)) {
      addHeaderSecrets(values, value, MIN_PROFILE_SECRET_LENGTH);
    }
  }
  return longestFirst(values);
}

/**
 * Literal credential values the child process receives in its environment
 * (inherited API keys and tokens), by variable name only.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function envSecrets(env) {
  /** @type {Set<string>} */
  const values = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (ENV_SECRET_NAME_RE.test(key)) {
      addSecretValue(values, value, MIN_ENV_SECRET_LENGTH);
    }
    if (HEADERS_KEY_RE.test(key)) {
      addHeaderSecrets(values, value, MIN_ENV_SECRET_LENGTH);
    }
  }
  return longestFirst(values);
}

/**
 * Scrub literal secret values and pattern-matched credentials from text.
 *
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function scrubSecrets(text, secrets = []) {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, REDACTED);
  }
  return redactSecrets(out);
}

/**
 * `base` without the names `drop` removes (`NAME*` drops by prefix; Windows
 * env names are case-insensitive), then `set` applied.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {{ drop: string[], set: Record<string, string> }} profile
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function profileEnv(base, profile, platform = process.platform) {
  const folded = (/** @type {string} */ name) =>
    platform === 'win32' ? name.toUpperCase() : name;
  const names = new Set(
    profile.drop.filter((name) => !name.endsWith('*')).map(folded)
  );
  const prefixes = profile.drop
    .filter((name) => name.endsWith('*'))
    .map((name) => folded(name.slice(0, -1)));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = folded(name);
    if (names.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    out[name] = value;
  }
  for (const [name, value] of Object.entries(profile.set)) {
    for (const existing of Object.keys(out)) {
      if (folded(existing) === folded(name)) delete out[existing];
    }
    out[name] = value;
  }
  return out;
}

/**
 * Prepare a headless execution. Only selecting dscc loads its provider profile.
 * Callers choose the provider before preparing the execution.
 *
 * @param {{
 *   agent: string, env: NodeJS.ProcessEnv, rootDir?: string,
 *   homedir?: () => string, platform?: NodeJS.Platform, warn?: (message: string) => void,
 *   bin?: string, mode?: string, model?: string | null, effort?: string | null,
 *   command?: import('./adapters.js').AgentCommand,
 * }} options
 */
export function prepareAgentExecution({
  agent,
  env,
  rootDir,
  homedir = os.homedir,
  platform = process.platform,
  warn = console.error,
  bin,
  mode,
  model,
  effort,
  command,
}) {
  const adapter = agent === 'dscc' ? 'claude' : agent;
  const argv = !bin && rootDir ? commandFor(rootDir, adapter) : null;
  const prepared =
    command ?? buildCommand({ agent: adapter, bin, argv, mode, model, effort });
  assertAgyAllowed(prepared.agent, env, 'headless agy', prepared.bin);
  let effectiveEnv = env;
  /** @type {string[]} */
  let credentials = [];
  if (agent === 'dscc') {
    const profile = dsccEnv(profilePath({ env, homedir: homedir(), platform }));
    credentials = profileSecrets(profile.set);
    for (const warning of profile.warnings) {
      warn(scrubSecrets(`! dscc profile ${warning}`, credentials));
    }
    effectiveEnv = {
      ...profileEnv(env, profile, platform),
      KYOTEN_AGENT: 'dscc',
    };
  }
  const secrets = longestFirst(
    new Set([...credentials, ...envSecrets(effectiveEnv)])
  );
  return { command: prepared, env: effectiveEnv, secrets };
}
