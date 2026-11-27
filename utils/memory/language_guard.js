#!/usr/bin/env node
/**
 * Stop hook: keep the final reply in the personalization Language.
 *
 * Run as `node utils/memory/language_guard.js --harness <claude|codex>` (see
 * utils/harness/hooks.js). It reads the reply from the Stop input
 * (`last_assistant_message`), and when the Language names a CJK language and
 * the reply is mostly in another script, it blocks once so the agent rewrites
 * it. A slip tends to be copied by the following turns (an English reply is
 * followed by another English reply most of the time), so catching the first
 * one is what keeps the session in the Language.
 *
 * It adds nothing to a reply already in the Language, and passes (fail open)
 * without a reply text, without a CJK Language, while personalization is off,
 * in headless runs (EXTRACT_ENV), for the reviewer and verifier roles, on the
 * rewrite that follows its own block, and on any error.
 */
import fs from 'fs';
import path from 'path';
import { normalizeHookInput, parseHarness } from '../harness/input.js';
import { runIfMain } from '../module-runner.js';
import { SESSION_ID_RE } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readConfig } from './config.js';
import { EXTRACT_ENV } from './extract-env.js';
import { readPersonalization } from './personalize.js';
import { mainCheckout } from './repo.js';
import { memoryDir } from './store.js';

/** Replies with fewer letters (after stripping code) are not checked. */
export const MIN_LETTERS = 40;
/** A reply passes when at least this share of its letters is in the target script. */
export const MIN_SHARE = 0.2;
/** Sessions blocked at their last stop, relative to the memory directory. */
export const GUARD_STATE_FILE = path.join('cache', 'language-guard.json');
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const ROLE_AGENTS = ['reviewer', 'verifier'];

/** @typedef {'ja' | 'ko' | 'zh'} Script */
/** @typedef {{ decision: 'block' | 'continue', reason: string }} GuardOutput */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/gu;
const HAN = /[㐀-䶿一-鿿]/gu;
const LETTER = /[A-Za-zÀ-ɏ぀-ヿ㐀-䶿一-鿿ᄀ-ᇿ㄰-㆏가-힯]/gu;
/** @type {Record<Script, RegExp>} */
// Japanese prose is kana plus kanji; a Chinese reply would also pass for a
// Japanese Language, which is accepted (the guard is for slips into English).
const SCRIPT_RE = {
  ja: /[぀-ヿ㐀-䶿一-鿿]/gu,
  ko: HANGUL,
  zh: HAN,
};

/**
 * The first phrase of a Language setting ("日本語。…" → "日本語"): the part
 * that names the language; the rest is free text that may mention others.
 *
 * @param {string} language
 */
export const languageName = (language) =>
  language
    .split(/[。．.,，、;；:：\n(（]/u)
    .map((part) => part.trim())
    .find(Boolean) ?? '';

/**
 * The script a Language setting asks for, from its first phrase: a language
 * name first, then the script the phrase is written in. Null for any other
 * language.
 *
 * @param {string | undefined} language
 * @returns {Script | null}
 */
export function targetScript(language) {
  const name = language ? languageName(language) : '';
  if (!name) return null;
  if (/日本語|japanese/iu.test(name)) return 'ja';
  if (/한국어|korean/iu.test(name)) return 'ko';
  if (/中文|漢語|汉语|chinese/iu.test(name)) return 'zh';
  if (/[぀-ヿ]/u.test(name)) return 'ja';
  if (/[ᄀ-ᇿ㄰-㆏가-힯]/u.test(name)) return 'ko';
  if (/[㐀-䶿一-鿿]/u.test(name)) return 'zh';
  return null;
}

/**
 * Drop fenced code blocks: a fence may be indented (inside a list item) and
 * is closed by a fence of the same character at least as long; an unclosed
 * fence runs to the end.
 *
 * @param {string} text
 */
function stripFences(text) {
  /** @type {string[]} */
  const kept = [];
  /** @type {string | null} */
  let open = null;
  for (const line of text.split('\n')) {
    // A fence may follow a list marker ("- ```bash", "1. ```").
    const fence = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})/u.exec(line)?.[1];
    if (open === null) {
      if (fence) open = fence;
      else kept.push(line);
    } else if (
      fence &&
      fence[0] === open[0] &&
      fence.length >= open.length &&
      /^\s*[`~]+\s*$/u.test(line)
    ) {
      open = null;
    }
  }
  return kept.join('\n');
}

/**
 * Remove what is not prose: fenced blocks (any fence length), inline code,
 * URLs, paths, and quoted lines.
 *
 * @param {string} text
 */
function prose(text) {
  return stripFences(text)
    .replace(/`[^`\n]*`/gu, '')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/[\w.~-]*\/[\w./~-]+/gu, '')
    .replace(/^[ \t]*>.*$/gmu, '');
}

/**
 * @param {string} text
 * @param {Script} script
 * @returns {{ letters: number, inScript: number }}
 */
export function measureReply(text, script) {
  const body = prose(text);
  return {
    letters: (body.match(LETTER) ?? []).length,
    inScript: (body.match(SCRIPT_RE[script]) ?? []).length,
  };
}

/**
 * @param {string} file
 * @returns {Record<string, { blockedAt: string }>}
 */
function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Whether this session's previous stop was blocked by the guard, then record
 * whether this one is. Entries older than a day are dropped.
 *
 * @param {string} dir the memory directory
 * @param {string} session
 * @param {(wasBlocked: boolean) => boolean} decide whether to block now
 * @param {Date} now
 * @returns {boolean} the decision
 */
function recordStop(dir, session, decide, now) {
  const file = path.join(dir, GUARD_STATE_FILE);
  const state = readState(file);
  const wasBlocked = Boolean(state[session]);
  const block = decide(wasBlocked);
  for (const [id, entry] of Object.entries(state)) {
    const at = Date.parse(entry?.blockedAt);
    if (!(now.getTime() - at < STATE_TTL_MS)) delete state[id];
  }
  if (block) state[session] = { blockedAt: now.toISOString() };
  else delete state[session];
  if (wasBlocked || block) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
  }
  return block;
}

/**
 * Decide one Stop event.
 *
 * @param {unknown} input the Stop hook input
 * @param {{ home?: string, harness?: import('../harness/input.js').Harness, env?: NodeJS.ProcessEnv, now?: Date }} [options]
 * @returns {GuardOutput | null} null to let the stop through
 */
export function checkStop(input, options = {}) {
  const {
    home = mainCheckout(ROOT_DIR),
    harness = 'claude',
    env = process.env,
    now = new Date(),
  } = options;
  const event = normalizeHookInput(input, harness);
  if (event.hook_event_name !== 'Stop') return null;
  if (env[EXTRACT_ENV] === '1' || ROLE_AGENTS.includes(event.agent_type)) {
    return null;
  }
  const reply = event.last_assistant_message;
  if (typeof reply !== 'string') return null;
  const dir = memoryDir(home);
  if (!fs.existsSync(dir)) return null;
  let language;
  try {
    if (!readConfig(dir).personalizationEnabled) return null;
    language = readPersonalization(dir).language;
  } catch {
    return null;
  }
  const script = targetScript(language);
  if (!script) return null;
  const session =
    typeof event.session_id === 'string' && SESSION_ID_RE.test(event.session_id)
      ? event.session_id
      : null;

  const { letters, inScript } = measureReply(reply, script);
  const slipped = letters >= MIN_LETTERS && inScript / letters < MIN_SHARE;
  // One retry per reply: the stop right after the guard's own block passes.
  // stop_hook_active is not used: it is also true after another Stop hook
  // (the task loop) continued the turn, and DSH always sends false.
  const decide = (/** @type {boolean} */ wasBlocked) => slipped && !wasBlocked;
  const block = session ? recordStop(dir, session, decide, now) : decide(false);
  if (!block) return null;

  const name = languageName(/** @type {string} */ (language));
  const reason = `[Persona] Your last reply was not in ${name}. Rewrite the whole reply in ${name} (the Language setting); keep code, commands, paths, and identifiers as they are.`;
  return harness === 'agy'
    ? { decision: 'continue', reason }
    : { decision: 'block', reason };
}

/**
 * @param {string} raw stdin
 * @param {Parameters<typeof checkStop>[1]} [options]
 * @returns {string} the hook's stdout
 */
export function runGuard(raw, options = {}) {
  try {
    const output = checkStop(raw.trim() ? JSON.parse(raw) : {}, options);
    return output ? JSON.stringify(output) : '';
  } catch {
    return '';
  }
}

/* c8 ignore start - stdin/stdout wiring; the logic is tested through runGuard */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    const out = runGuard(data, { harness });
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
