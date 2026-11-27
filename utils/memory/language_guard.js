#!/usr/bin/env node
/**
 * Stop hook: keep the final reply in the personalization Language.
 *
 * Run as `node utils/memory/language_guard.js --harness <claude|codex>` (see
 * utils/harness/hooks.js). It reads the reply from the Stop input
 * (`last_assistant_message`; in Claude Code, the transcript's last assistant
 * message when that is missing), and when the Language names a CJK language and
 * the reply is mostly in another script, it blocks once so the agent rewrites
 * it. A slip tends to be copied by the following turns (an English reply is
 * followed by another English reply most of the time), so catching the first
 * one is what keeps the session in the Language.
 *
 * It adds nothing to a reply already in the Language, and passes (fail open)
 * without a reply text, without a CJK Language, while personalization is off,
 * in headless runs (EXTRACT_ENV), for the reviewer and verifier roles, on the
 * rewrite that follows its own block, when its state directory is a link,
 * and on any error.
 */
import fs from 'fs';
import path from 'path';
import { normalizeHookInput, parseHarness } from '../harness/input.js';
import { runIfMain } from '../module-runner.js';
import { SESSION_ID_RE, writeFileAtomic } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readConfig } from './config.js';
import { quietRun } from './extract-env.js';
import { readPersonalization } from './personalize.js';
import { mainCheckout } from './repo.js';
import { memoryDir } from './store.js';

/** Replies with fewer letters (after stripping code) are not checked. */
export const MIN_LETTERS = 40;
/** A reply passes when at least this share of its letters is in the target script. */
export const MIN_SHARE = 0.2;
/** One `<session>.json` mark per session blocked at its last stop, under the memory directory. */
export const GUARD_STATE_DIR = path.join('cache', 'language-guard');
/** Only the start of a reply's prose is measured: a share needs no more. */
export const MAX_CHARS = 20_000;
/** Code is stripped from at most this much of the reply, which bounds the regex work. */
export const MAX_INPUT_CHARS = 1_000_000;
/** How much of a transcript's end is read for the last reply (Claude Code fallback). */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
/** A mark file: a SESSION_ID_RE-shaped name plus `.json`. */
const MARK_RE = /^[A-Za-z0-9_-]{1,128}\.json$/u;

/** @typedef {'ja' | 'ko' | 'zh'} Script */
/** @typedef {{ decision: 'block', reason: string }} GuardOutput */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
/** Letters of any script, so a reply in Cyrillic or Greek counts too. */
const LETTER = /\p{L}/gu;
// Japanese prose is kana plus kanji; a Chinese reply would also pass for a
// Japanese Language, which is accepted (the guard is for slips into English).
/** @type {Record<Script, RegExp>} */
const SCRIPT_RE = {
  ja: /[぀-ヿㇰ-ㇿｦ-ﾟ㐀-䶿一-鿿豈-﫿]/u,
  ko: HANGUL,
  zh: HAN,
};
/** Names of languages the guard does not check, in their own and English spelling. */
const OTHER_LANGUAGE =
  /english|français|french|deutsch|german|español|spanish|italiano|italian|português|portuguese|русский|russian|nederlands|dutch|tiếng việt|vietnamese|bahasa|indonesian|ไทย|thai|العربية|arabic|हिन्दी|hindi/iu;
/** @type {[Script | null, RegExp][]} */
const LANGUAGE_NAMES = [
  ['ja', /日本語|japanese/iu],
  ['ko', /한국어|korean/iu],
  ['zh', /中文|漢語|汉语|chinese/iu],
  [null, OTHER_LANGUAGE],
];
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
  // The language named first is the one asked for ("English even when the
  // user writes in Japanese"); later ones are what the rest of the phrase
  // mentions.
  /** @type {{ at: number, script: Script | null } | null} */
  let first = null;
  for (const [script, re] of LANGUAGE_NAMES) {
    const at = name.search(re);
    if (at >= 0 && (first === null || at < first.at)) first = { at, script };
  }
  if (first) return first.script;
  if (/[぀-ヿ]/u.test(name)) return 'ja';
  if (/[ᄀ-ᇿ㄰-㆏가-힯]/u.test(name)) return 'ko';
  if (/[㐀-䶿一-鿿]/u.test(name)) return 'zh';
  return null;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;
const INDENTED = /^(?: {4}|\t)/u;

/**
 * Drop code blocks. Fenced: a fence may be indented (inside a list item) and
 * is closed by a fence of the same character at least as long; an unclosed
 * fence runs to the end. Indented: lines indented 4 spaces or a tab after a
 * blank line, unless they continue a list item (then they are prose).
 *
 * @param {string} text
 */
function stripCode(text) {
  /** @type {string[]} */
  const kept = [];
  /** @type {string | null} */
  let open = null;
  let indented = false;
  let afterBlank = true;
  let inList = false;
  for (const line of text.split('\n')) {
    // A fence may follow a list marker ("- ```bash", "1. ```").
    const fence = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})/u.exec(line)?.[1];
    const blank = line.trim() === '';
    if (open === null) {
      if (indented && !blank && !INDENTED.test(line)) indented = false;
      if (!indented && !blank && afterBlank && !inList && INDENTED.test(line)) {
        indented = true;
      }
      if (indented) continue;
      if (fence) open = fence;
      else kept.push(line);
      if (!blank) {
        if (LIST_ITEM.test(line)) inList = true;
        else if (!/^\s/u.test(line)) inList = false;
      }
      afterBlank = blank;
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
 * Inline code spans of up to 16 backticks (`` a `b` c ``). The bounded
 * opening run keeps a long run of backticks linear (an unbounded `+ backtracks
 * through the whole run at every position).
 */
const CODE_SPAN = /(?<!`)(`{1,16})(?!`)(?:(?!\1)[^\n])*?[^`\n]\1(?!`)/gu;

/**
 * Remove what is not prose: fenced blocks (any fence length), inline code,
 * URLs, paths, and quoted lines.
 *
 * @param {string} text
 */
function prose(text) {
  return (
    stripCode(text)
      .replace(CODE_SPAN, '')
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
  // Code is removed before the measured part is cut, so a long code block
  // cannot push the prose after it out of the measurement.
  const body = prose(text.slice(0, MAX_INPUT_CHARS)).slice(0, MAX_CHARS);
  const letters = body.match(LETTER) ?? [];
  return {
    letters: letters.length,
    inScript: letters.filter((letter) => SCRIPT_RE[script].test(letter)).length,
  };
}

/**
 * A directory that exists as a real directory (not a link), or that is
 * missing; anything else (a link, a file) is refused.
 *
 * @param {string} dir
 * @returns {'dir' | 'missing' | 'refused'}
 */
function plainDir(dir) {
  try {
    return fs.lstatSync(dir).isDirectory() ? 'dir' : 'refused';
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
      ? 'missing'
      : 'refused';
  }
}

/** @param {unknown} block */
const blockText = (block) =>
  /** @type {any} */ (block)?.type === 'text'
    ? String(/** @type {any} */ (block).text ?? '')
    : null;

/**
 * The last assistant reply in a Claude Code transcript: the text blocks of
 * the last main-thread assistant message (one message may span several
 * entries). Null when the path is not an absolute `.jsonl` regular file, or
 * its tail holds no reply.
 *
 * @param {unknown} file the Stop input's transcript_path
 * @returns {string | null}
 */
export function lastReplyFromTranscript(file) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    !file.endsWith('.jsonl')
  ) {
    return null;
  }
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return null;
  }
  /** @type {string[]} */
  const parts = [];
  /** @type {unknown} */
  let id;
  for (const line of text.split('\n').reverse()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' || entry.isSidechain) continue;
    const content = entry.message?.content;
    const texts = (Array.isArray(content) ? content : [])
      .map(blockText)
      .filter((part) => part !== null);
    if (parts.length > 0 && entry.message?.id !== id) break;
    if (texts.length === 0) continue;
    id = entry.message?.id;
    parts.unshift(texts.join('\n'));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Whether this session's previous stop was blocked by the guard, then record
 * whether this one is. Each session has its own mark file (no shared file to
 * race on), written by rename so a symlink is replaced, not followed. Marks
 * older than a day count as absent and are pruned; only mark files are
 * pruned. False (pass) when the cache or state directory is a link or not a
 * directory, so nothing is written or deleted outside the memory directory.
 *
 * @param {string} dir the memory directory
 * @param {string} session a SESSION_ID_RE-checked id, safe as a file name
 * @param {(wasBlocked: boolean) => boolean} decide whether to block now
 * @param {Date} now
 * @returns {boolean} the decision
 */
function recordStop(dir, session, decide, now) {
  const cacheDir = path.join(dir, path.dirname(GUARD_STATE_DIR));
  const stateDir = path.join(dir, GUARD_STATE_DIR);
  const dirs = [plainDir(cacheDir), plainDir(stateDir)];
  if (dirs.includes('refused')) return false;
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
    if (dirs[0] === 'missing') fs.mkdirSync(cacheDir);
    if (dirs[1] === 'missing') fs.mkdirSync(stateDir);
    writeFileAtomic(
      file,
      `${JSON.stringify({ blockedAt: now.toISOString() })}\n`
    );
  } else {
    fs.rmSync(file, { force: true });
  }
  if (plainDir(stateDir) === 'dir') {
    for (const name of fs.readdirSync(stateDir)) {
      if (MARK_RE.test(name) && !fresh(name)) {
        fs.rmSync(path.join(stateDir, name), { force: true });
      }
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
  if (quietRun(env, event.agent_type)) return null;
  const reply =
    typeof event.last_assistant_message === 'string'
      ? event.last_assistant_message
      : harness === 'claude'
        ? lastReplyFromTranscript(event.transcript_path)
        : null;
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
  // That stop is a continuation (stop_hook_active true in Claude Code and
  // Codex); a mark seen without it is left from a rewrite that was
  // interrupted, so the new turn is checked. stop_hook_active alone is not
  // enough: it is also true after another Stop hook (the task loop)
  // continued the turn.
  const continued = event.stop_hook_active === true;
  const decide = (/** @type {boolean} */ wasBlocked) =>
    slipped && !(wasBlocked && continued);
  if (!recordStop(dir, session, decide, now)) return null;

  const name = SCRIPT_LABEL[script];
  const reason = `[Persona] Your last reply was not in ${name}. Rewrite the whole reply in ${name} (the Language setting); keep code, commands, paths, and identifiers as they are.`;
  return { decision: 'block', reason };
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

/* c8 ignore start - stdin/stdout wiring; tested through runGuard and as a subprocess in e2e/kyoten.e2e.js */
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
