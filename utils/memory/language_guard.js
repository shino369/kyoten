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
import { SESSION_ID_RE, writeFileAtomic } from '../task/store.js';
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
/** One `<session>.json` mark per session blocked at its last stop, under the memory directory. */
export const GUARD_STATE_DIR = path.join('cache', 'language-guard');
/** Only the start of a reply is measured: a share needs no more, and it bounds the regex work. */
export const MAX_CHARS = 20_000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const ROLE_AGENTS = ['reviewer', 'verifier'];

/** @typedef {'ja' | 'ko' | 'zh'} Script */
/** @typedef {{ decision: 'block' | 'continue', reason: string }} GuardOutput */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/gu;
const HAN = /[㐀-䶿一-鿿]/gu;
const LETTER = /[A-Za-zÀ-ɏ぀-ヿ㐀-䶿一-鿿ᄀ-ᇿ㄰-㆏가-힯]/gu;
// Japanese prose is kana plus kanji; a Chinese reply would also pass for a
// Japanese Language, which is accepted (the guard is for slips into English).
/** @type {Record<Script, RegExp>} */
const SCRIPT_RE = {
  ja: /[぀-ヿ㐀-䶿一-鿿]/gu,
  ko: HANGUL,
  zh: HAN,
};
/** Fixed names for the reason: the user's free-text setting is never echoed into it. */
const SCRIPT_LABEL = { ja: '日本語', ko: '한국어', zh: '中文' };

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
  return (
    stripFences(text)
      .replace(/`[^`\n]*`/gu, '')
      .replace(/https?:\/\/\S+/gu, '')
      // The lookbehind tries each run once (no quadratic backtracking).
      .replace(/(?<![\w.~-])[\w.~-]*\/[\w./~-]+/gu, '')
      .replace(/^[ \t]*>.*$/gmu, '')
  );
}

/**
 * @param {string} text
 * @param {Script} script
 * @returns {{ letters: number, inScript: number }}
 */
export function measureReply(text, script) {
  const body = prose(text.slice(0, MAX_CHARS));
  return {
    letters: (body.match(LETTER) ?? []).length,
    inScript: (body.match(SCRIPT_RE[script]) ?? []).length,
  };
}

/**
 * Whether this session's previous stop was blocked by the guard, then record
 * whether this one is. Each session has its own mark file (no shared file to
 * race on), written by rename so a symlink is replaced, not followed. Marks
 * older than a day count as absent and are pruned.
 *
 * @param {string} dir the memory directory
 * @param {string} session a SESSION_ID_RE-checked id, safe as a file name
 * @param {(wasBlocked: boolean) => boolean} decide whether to block now
 * @param {Date} now
 * @returns {boolean} the decision
 */
function recordStop(dir, session, decide, now) {
  const stateDir = path.join(dir, GUARD_STATE_DIR);
  const file = path.join(stateDir, `${session}.json`);
  const fresh = (/** @type {string} */ name) => {
    try {
      const stat = fs.lstatSync(path.join(stateDir, name));
      return now.getTime() - stat.mtimeMs < STATE_TTL_MS;
    } catch {
      return false;
    }
  };
  const block = decide(fresh(`${session}.json`));
  if (block) {
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(
      file,
      `${JSON.stringify({ blockedAt: now.toISOString() })}\n`
    );
  } else {
    fs.rmSync(file, { force: true });
  }
  if (fs.existsSync(stateDir)) {
    for (const name of fs.readdirSync(stateDir)) {
      if (!fresh(name)) fs.rmSync(path.join(stateDir, name), { force: true });
    }
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
  // Without a usable session id the one-retry mark cannot be kept, so pass
  // rather than risk blocking every stop.
  if (
    typeof event.session_id !== 'string' ||
    !SESSION_ID_RE.test(event.session_id)
  ) {
    return null;
  }
  const session = event.session_id;

  const { letters, inScript } = measureReply(reply, script);
  const slipped = letters >= MIN_LETTERS && inScript / letters < MIN_SHARE;
  // One retry per reply: the stop right after the guard's own block passes.
  // stop_hook_active is not used: it is also true after another Stop hook
  // (the task loop) continued the turn, and DSH always sends false.
  const decide = (/** @type {boolean} */ wasBlocked) => slipped && !wasBlocked;
  if (!recordStop(dir, session, decide, now)) return null;

  const name = SCRIPT_LABEL[script];
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
