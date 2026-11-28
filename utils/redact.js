/**
 * Secret rules shared by every path that must not keep a secret:
 *
 * - the audit logger redacts matches before a tool call is logged;
 * - memory writes (add, extraction, consolidation, import) refuse text with a match;
 * - memory export scans every file and stops on a match.
 *
 * Detection and redaction use the same rules, so `findSecrets(text)` is empty
 * exactly when `redactSecrets(text) === text`. Matching is pattern-based and
 * best-effort: it catches the common token shapes, not every secret.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose string values are always secret (e.g. `{ API_KEY: '...' }`). */
const SECRET_KEY_NAME = /(TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_KEY)/i;

/**
 * A value in `NAME=value` that refers to a secret without containing one: an
 * env reference (`$GITHUB_TOKEN`, `${X}`), a command substitution
 * (`$(gh auth token)`), a `<placeholder>`, or an already redacted value.
 * Case-sensitive, so `$ecret` and `$Secret1` still count as values.
 */
const REFERENCE_VALUE =
  /^(?:\$\{|\$\(|\$[A-Z_][A-Z0-9_]*\b|<[^>]*>$|\[REDACTED)/;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isReference(value) {
  const unquoted = /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
  return REFERENCE_VALUE.test(unquoted);
}

/**
 * @typedef {object} SecretRule
 * @property {string} name stable id, reported by findSecrets
 * @property {RegExp} pattern global
 * @property {(match: string, ...groups: string[]) => string} replace
 */

/**
 * Ordered rules. PEM blocks and Bearer tokens run before the generic
 * `NAME=value` rule so multi-part secrets are removed whole.
 *
 * @type {readonly SecretRule[]}
 */
const SECRET_RULES = [
  {
    name: 'private-key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    name: 'basic-auth',
    pattern: /\b(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    name: 'url-credentials',
    // The authority ends at `/`, `?`, or `#`: an `@` after a query or fragment
    // (an email in `?invite=reader@example.com`) is not a credential.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s?#@]+)@/gi,
    replace: (match, scheme, creds) =>
      creds.includes(REDACTED) ? match : `${scheme}${REDACTED}@`,
  },
  {
    name: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|<[^>\n]*>|\S+)/gi,
    replace: (match, name, separator, value) =>
      isReference(value) ? match : `${name}${separator}${REDACTED}`,
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'api-key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
];

/** Every rule name findSecrets can report, in rule order. */
export const SECRET_RULE_NAMES = SECRET_RULES.map((rule) => rule.name);

/**
 * @param {SecretRule} rule
 * @param {string} text
 * @returns {string}
 */
function applyRule(rule, text) {
  return text.replace(rule.pattern, rule.replace);
}

/** @typedef {{ start: number, end: number, replacement: string }} RedactionEdit */

/**
 * Collect edits against original offsets. Keep unchanged context such as
 * a header name outside the edit so literal matches can be merged with it.
 *
 * @param {string} text
 * @param {SecretRule} rule
 * @returns {IterableIterator<RedactionEdit>}
 */
function* patternEdits(text, rule) {
  for (const match of text.matchAll(rule.pattern)) {
    const [original, ...groups] = match;
    const replacement = rule.replace(original, ...groups);
    if (replacement === original) continue;

    const marker = replacement.indexOf(REDACTED);
    const prefix = marker < 0 ? '' : replacement.slice(0, marker);
    const suffix =
      marker < 0 ? '' : replacement.slice(marker + REDACTED.length);
    if (
      marker >= 0 &&
      original.startsWith(prefix) &&
      original.endsWith(suffix)
    ) {
      yield {
        start: match.index + prefix.length,
        end: match.index + original.length - suffix.length,
        replacement: REDACTED,
      };
    } else {
      yield {
        start: match.index,
        end: match.index + original.length,
        replacement,
      };
    }
  }
}

/**
 * @param {string} text
 * @param {RegExp} pattern a lookahead that captures the longest literal at each position
 * @returns {IterableIterator<RedactionEdit>}
 */
function* literalEdits(text, pattern) {
  for (const match of text.matchAll(pattern)) {
    yield {
      start: match.index,
      end: match.index + match[1].length,
      replacement: REDACTED,
    };
  }
}

/**
 * Merge already ordered match streams while keeping one pending edit from
 * each, even when one short credential matches throughout a large response.
 *
 * @param {IterableIterator<RedactionEdit>[]} streams
 * @returns {IterableIterator<RedactionEdit>}
 */
function* editsByPosition(streams) {
  const pending = streams.map((stream) => stream.next());
  for (;;) {
    let index = 0;
    /** @type {RedactionEdit | undefined} */
    let next;
    for (const [i, candidate] of pending.entries()) {
      if (!candidate.done && (!next || candidate.value.start < next.start)) {
        next = candidate.value;
        index = i;
      }
    }
    if (!next) return;
    yield next;
    pending[index] = streams[index].next();
  }
}

/**
 * @param {string} text
 * @param {Iterable<RedactionEdit>} edits edits in original-text order
 * @returns {string}
 */
function applyEdits(text, edits) {
  /** @type {RedactionEdit | undefined} */
  let previous;
  let end = 0;
  let output = '';
  for (const edit of edits) {
    if (previous && edit.start <= previous.end) {
      previous.end = Math.max(previous.end, edit.end);
      previous.replacement = REDACTED;
      continue;
    }
    if (previous) {
      output += text.slice(end, previous.start) + previous.replacement;
      end = previous.end;
    }
    previous = edit;
  }
  return previous
    ? output +
        text.slice(end, previous.start) +
        previous.replacement +
        text.slice(previous.end)
    : text;
}

/**
 * Redact known patterns and optional literal credentials. Both match the
 * original text so a literal cannot erase the syntax of another credential.
 *
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  let output = text;
  const literals = secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  if (literals.length > 0) {
    const pattern = new RegExp(`(?=(${literals.join('|')}))`, 'g');
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      output = applyEdits(
        text,
        editsByPosition([
          literalEdits(text, pattern),
          ...SECRET_RULES.map((rule) => patternEdits(text, rule)),
        ])
      );
    }
  }
  // Replacing a literal can expose a boundary that another rule needs.
  return SECRET_RULES.reduce((result, rule) => applyRule(rule, result), output);
}

/**
 * The names of the rules that match `text`, each once, in rule order. Empty
 * when the text holds no known secret.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findSecrets(text) {
  return SECRET_RULES.filter((rule) => applyRule(rule, text) !== text).map(
    (rule) => rule.name
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
  return SECRET_RULES.some((rule) => applyRule(rule, text) !== text);
}

/**
 * Whether a key's string value should be treated as a secret
 * (`API_KEY`, `Password`, `gh_token`, …).
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  return SECRET_KEY_NAME.test(key);
}
