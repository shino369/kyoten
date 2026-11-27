#!/usr/bin/env node
/**
 * Stop hook: keep the final reply in the personalization Language.
 *
 * Run as `node utils/memory/language_guard.js --harness <claude|codex>` (see
 * utils/harness/hooks.js). It reads the reply from the Stop input
 * (`last_assistant_message`; in Claude Code, the transcript's last assistant
 * message when that is missing), and when the Language is Japanese or Chinese and
 * the reply is mostly in another script, it blocks once so the agent rewrites
 * it. A slip tends to be copied by the following turns (an English reply is
 * followed by another English reply most of the time), so catching the first
 * one is what keeps the session in the Language.
 *
 * It adds nothing to a reply already in the Language, and passes (fail open)
 * without a reply text, for any other Language (English, a language the
 * workspace does not support, or a setting that names none), while
 * personalization is off,
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
/** A mark file: a SESSION_ID_RE-checked session id plus `.json`. */
const isMark = (/** @type {string} */ name) =>
  name.endsWith('.json') && SESSION_ID_RE.test(name.slice(0, -'.json'.length));

/**
 * The scripts the guard checks: the workspace's languages besides English
 * (Japanese and Chinese, as in the README). Any other Language passes.
 *
 * @typedef {'ja' | 'zh'} Script
 */
/** @typedef {{ decision: 'block', reason: string }} GuardOutput */

const KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/u;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const LATIN = /[A-Za-z\u00C0-\u024F]/u;
/** Letters of any script, so a reply in Cyrillic or Greek counts too. */
const LETTER = /\p{L}/gu;
// Japanese prose is kana plus kanji; a Chinese reply would also pass for a
// Japanese Language, which is accepted (the guard is for slips into English).
/** @type {Record<Script, (letter: string) => boolean>} */
const IN_SCRIPT = {
  ja: (letter) => KANA.test(letter) || HAN.test(letter),
  zh: (letter) => HAN.test(letter),
};
/** Names of the workspace's languages, one named group per language. */
const NAMES = String.raw`(?<ja>\bjapanese\b|日本語|日本语|日語|日语|日文|にほんご)|(?<zh>\bchinese\b|\bmandarin\b|中文|漢語|汉语|華語|华语|繁體|繁体|簡體|简体)|(?<en>\benglish\b|英語|英语|英文|えいご)`;
/**
 * A Latin-letter setting that starts by naming a language, after an optional
 * lead-in ("Reply in", "Always answer in Traditional").
 */
const NAMED_FIRST = new RegExp(
  String.raw`^(?:please\s+)?(?:always\s+)?(?:(?:reply|respond|answer|write|speak|talk|use)\s+(?:only\s+)?(?:in\s+)?)?(?:traditional\s+|simplified\s+)?(?:${NAMES})`,
  'iu'
);
/** Every language name in a setting. */
const NAMED_ANY = new RegExp(NAMES, 'giu');
/** Fixed names for the reason: the user's free-text setting is never echoed into it. */
const SCRIPT_LABEL = { ja: '日本語', zh: '中文' };

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
 * The script a Language setting asks for, from its first phrase, decided
 * only by a name of Japanese, Chinese, or English. A phrase mostly in Latin
 * letters names its language first ("English even when the user writes in
 * Japanese" is English; "Swahili even when … Japanese" names none); a phrase
 * in kana or Han puts the language it asks for last, after any condition
 * ("英語で書いても日本語で話す" is Japanese, "用英文回答" is English). Null
 * for English and for a phrase that names none of them, such as another
 * language (韓国語, 한국어): the guard passes those.
 *
 * @param {string | undefined} language
 * @returns {Script | null}
 */
export function targetScript(language) {
  const name = language ? languageName(language) : '';
  if (!name) return null;
  const letters = name.match(LETTER) ?? [];
  const latin = letters.filter((letter) => LATIN.test(letter)).length;
  const named =
    latin * 2 >= letters.length
      ? NAMED_FIRST.exec(name)?.groups
      : [...name.matchAll(NAMED_ANY)].at(-1)?.groups;
  if (named?.ja) return 'ja';
  return named?.zh ? 'zh' : null;
}

/** A list marker and the spaces after it: their width is the item's content indent. */
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\S/u;
/** A fence (after an optional list marker), its run, and the rest of the line. */
const FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u;

/** Column width of a line's leading whitespace (a tab counts 4). */
const indentOf = (/** @type {string} */ line) =>
  (/^[ \t]*/u.exec(line)?.[0] ?? '').replace(/\t/gu, '    ').length;

/**
 * Drop code blocks. Fenced: a fence may be indented or follow a list marker,
 * and is closed by a fence of the same character at least as long; an
 * unclosed fence runs to the end. A backtick run with another backtick later
 * on the line is inline code, not a fence. Indented: after a blank line,
 * lines indented 4 columns past the enclosing list item's content (4 outside
 * a list); a line indented less continues the item as prose.
 *
 * @param {string} text
 */
function stripCode(text) {
  /** @type {string[]} */
  const kept = [];
  /** @type {string | null} */
  let open = null;
  let codeIndent = -1;
  let afterBlank = true;
  // The content column of the current list item; 0 outside a list.
  let listIndent = 0;
  for (const line of text.split('\n')) {
    const blank = line.trim() === '';
    const indent = indentOf(line);
    const fenceMatch = FENCE.exec(line);
    const fence =
      fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))
        ? fenceMatch[1]
        : null;
    if (open !== null) {
      if (
        fence &&
        fence[0] === open[0] &&
        fence.length >= open.length &&
        fenceMatch?.[2].trim() === ''
      ) {
        open = null;
      }
      continue;
    }
    if (codeIndent >= 0) {
      if (blank || indent >= codeIndent) continue;
      codeIndent = -1;
    }
    if (!blank && afterBlank && indent >= listIndent + 4) {
      codeIndent = listIndent + 4;
      continue;
    }
    afterBlank = blank;
    if (fence) {
      open = fence;
      continue;
    }
    kept.push(line);
    if (blank) continue;
    const marker = LIST_MARKER.exec(line);
    if (marker) {
      listIndent = `${marker[1]}${marker[2]}${marker[3]}`.replace(
        /\t/gu,
        '    '
      ).length;
    } else if (indent === 0) {
      listIndent = 0;
    }
  }
  return kept.join('\n');
}

/**
 * Remove inline code spans: a backtick run opens a span that the next run of
 * the same length closes, within one paragraph (CommonMark); a run with no
 * closer is kept as text. Linear in the text: each run is visited once.
 *
 * @param {string} text
 */
function stripCodeSpans(text) {
  return text
    .split(/(\n[ \t]*\n)/u)
    .map((block) => {
      const runs = [...block.matchAll(/`+/gu)].map((match) => ({
        at: match.index,
        length: match[0].length,
      }));
      /** @type {Map<number, number[]>} run indexes by run length */
      const byLength = new Map();
      runs.forEach((run, index) => {
        const list = byLength.get(run.length) ?? [];
        list.push(index);
        byLength.set(run.length, list);
      });
      /** @type {Map<number, number>} the next unvisited entry per length */
      const next = new Map();
      let out = '';
      let from = 0;
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        const list = byLength.get(run.length) ?? [];
        let at = next.get(run.length) ?? 0;
        while (at < list.length && list[at] <= index) at += 1;
        next.set(run.length, at);
        if (at === list.length) continue;
        const close = runs[list[at]];
        out += block.slice(from, run.at);
        from = close.at + close.length;
        index = list[at];
      }
      return out + block.slice(from);
    })
    .join('');
}

/**
 * Remove what is not prose: code blocks, inline code, URLs, POSIX and
 * Windows paths, and quoted lines.
 *
 * @param {string} text
 */
function prose(text) {
  return (
    stripCodeSpans(stripCode(text))
      .replace(/https?:\/\/\S+/gu, '')
      // The lookbehinds try each run once (no quadratic backtracking).
      .replace(/(?<![\w.~-])[\w.~-]*\/[\w./~-]+/gu, '')
      .replace(/(?<![\w.~:\\-])(?:[A-Za-z]:)?[\w.~-]*\\[\w.~\\-]+/gu, '')
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
    inScript: letters.filter(IN_SCRIPT[script]).length,
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
 * when that message has no text or a user entry comes after it: an earlier
 * message, possibly from the previous turn, is never taken instead.
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
  let seen = false;
  for (const line of text.split('\n').reverse()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain) continue;
    if (entry?.type === 'user') break;
    if (entry?.type !== 'assistant') continue;
    if (seen && entry.message?.id !== id) break;
    seen = true;
    id = entry.message?.id;
    const content = entry.message?.content;
    const texts = (Array.isArray(content) ? content : [])
      .map(blockText)
      .filter((part) => part !== null);
    if (texts.length > 0) parts.unshift(texts.join('\n'));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Whether this session's previous stop was blocked by the guard, then record
 * whether this one is. Each session has its own mark file (no shared file to
 * race on), written by rename so a symlink is replaced, not followed. Only a
 * regular file counts as a mark. Marks older than a day count as absent and
 * are pruned first, best effort, so a pruning error never leaves a mark
 * without its block; only regular files named like a mark are pruned. False
 * (pass) when the cache or state directory is a link or not a directory, so
 * nothing is written or deleted outside the memory directory.
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
  /** @param {string} name @returns {'fresh' | 'stale' | 'other'} */
  const markState = (name) => {
    try {
      const stat = fs.lstatSync(path.join(stateDir, name));
      if (!stat.isFile()) return 'other';
      return now.getTime() - stat.mtimeMs < STATE_TTL_MS ? 'fresh' : 'stale';
    } catch {
      return 'other';
    }
  };
  if (dirs[1] === 'dir') {
    try {
      for (const name of fs.readdirSync(stateDir)) {
        if (isMark(name) && markState(name) === 'stale') {
          fs.rmSync(path.join(stateDir, name), { force: true });
        }
      }
    } catch {
      // Pruning is housekeeping; the decision does not depend on it.
    }
  }
  const block = decide(markState(`${session}.json`) === 'fresh');
  if (block) {
    if (dirs[0] === 'missing') fs.mkdirSync(cacheDir);
    if (dirs[1] === 'missing') fs.mkdirSync(stateDir);
    writeFileAtomic(
      file,
      `${JSON.stringify({ blockedAt: now.toISOString() })}\n`
    );
  } else if (markState(`${session}.json`) !== 'other') {
    fs.rmSync(file, { force: true });
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

  const reply =
    typeof event.last_assistant_message === 'string'
      ? event.last_assistant_message
      : harness === 'claude'
        ? lastReplyFromTranscript(event.transcript_path)
        : null;
  // A stop without reply text passes, but still goes through recordStop so
  // it clears the mark: a later continued stop is then checked.
  const { letters, inScript } =
    typeof reply === 'string'
      ? measureReply(reply, script)
      : { letters: 0, inScript: 0 };
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
