import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_CONFIG, writeConfig } from '../config.js';
import { EXTRACT_ENV } from '../extract-env.js';
import {
  GUARD_STATE_FILE,
  MIN_LETTERS,
  checkStop,
  measureReply,
  runGuard,
  targetScript,
} from '../language_guard.js';
import { writePersonalization } from '../personalize.js';

const JA =
  'おじさま、修正が終わりましたわ。テストもすべて通りましたので、ご安心くださいな。次はレビューにかけますわね。';
const EN =
  'The fix is finished on the branch, and every test passes. Next I will open a review round and report back.';

/** @type {string} */
let home;
/** @type {string} */
let dir;

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'language-guard-'))
  );
  dir = path.join(home, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  writePersonalization(dir, { language: '日本語。進捗メモも日本語で話す' });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>} input
 * @param {{ harness?: any, env?: NodeJS.ProcessEnv }} [options]
 */
const stop = (input, options = {}) =>
  checkStop(
    { hook_event_name: 'Stop', session_id: 'sess-1', ...input },
    { home, harness: options.harness ?? 'claude', env: options.env ?? {} }
  );

describe('targetScript', () => {
  test.each([
    ['日本語。おじさまが英語で書いても日本語で話す', 'ja'],
    ['Japanese', 'ja'],
    ['ですます調で', 'ja'],
    ['한국어로 답하기', 'ko'],
    ['Korean', 'ko'],
    ['繁體中文（台灣）', 'zh'],
    ['简体中文', 'zh'],
    ['Chinese', 'zh'],
    ['반말로 친근하게', 'ko'],
    ['用台灣的用語', 'zh'],
  ])('should map %s to %s', (language, script) => {
    expect(targetScript(language)).toBe(script);
  });

  test.each([['English'], ['français'], [''], [undefined]])(
    'should return null for %s',
    (language) => {
      expect(targetScript(language)).toBeNull();
    }
  );
});

describe('measureReply', () => {
  test('should count kana letters for Japanese', () => {
    const { letters, inScript } = measureReply('テストabc', 'ja');

    expect(letters).toBe(6);
    expect(inScript).toBe(3);
  });

  test('should ignore fenced blocks of any fence length', () => {
    const text = `日本語の説明ですわ\n\n\`\`\`\`markdown\n\`\`\`js\nconst englishWordsHere = 1;\n\`\`\`\n\`\`\`\`\n`;

    expect(measureReply(text, 'ja').letters).toBe(
      measureReply('日本語の説明ですわ', 'ja').letters
    );
  });

  test('should ignore inline code, URLs, paths, and quoted lines', () => {
    const text =
      'ですわ `someIdentifier` https://example.com/docs utils/memory/hook.js\n> Quoted English review text';

    expect(measureReply(text, 'ja')).toEqual({ letters: 3, inScript: 3 });
  });

  test('should count Hangul for Korean and Han for Chinese', () => {
    expect(measureReply('안녕 hi', 'ko')).toEqual({ letters: 4, inScript: 2 });
    expect(measureReply('你好 hi', 'zh')).toEqual({ letters: 4, inScript: 2 });
  });
});

describe('checkStop', () => {
  test('should pass a reply in the Language', () => {
    expect(stop({ last_assistant_message: JA })).toBeNull();
  });

  test('should block an English reply once with the Language in the reason', () => {
    const output = stop({ last_assistant_message: EN });

    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('日本語');
    expect(output?.reason).toMatch(/^\[Persona\]/);
  });

  test('should pass the rewrite that follows a block, even if it is still English', () => {
    stop({ last_assistant_message: EN });

    expect(stop({ last_assistant_message: EN })).toBeNull();
  });

  test('should block again on a later slip after a passing reply', () => {
    stop({ last_assistant_message: EN });
    stop({ last_assistant_message: JA });

    expect(stop({ last_assistant_message: EN })?.decision).toBe('block');
  });

  test('should block a new slip after a passed English rewrite without stop_hook_active', () => {
    stop({ last_assistant_message: EN });
    stop({ last_assistant_message: EN });

    expect(stop({ last_assistant_message: EN })?.decision).toBe('block');
  });

  test('should keep the one-retry state per session', () => {
    stop({ last_assistant_message: EN });

    expect(
      stop({ last_assistant_message: EN, session_id: 'sess-2' })?.decision
    ).toBe('block');
  });

  test('should pass when stop_hook_active is true', () => {
    expect(
      stop({ last_assistant_message: EN, stop_hook_active: true })
    ).toBeNull();
  });

  test('should pass a reply under the letter minimum', () => {
    const short = 'Done.'.padEnd(MIN_LETTERS - 1, 'x');

    expect(stop({ last_assistant_message: short })).toBeNull();
  });

  test('should pass a reply that is mostly code', () => {
    expect(
      stop({
        last_assistant_message: `ですわ\n\`\`\`js\n${EN}\n\`\`\``,
      })
    ).toBeNull();
  });

  test.each([
    ['no reply text', {}],
    ['a non-string reply', { last_assistant_message: 42 }],
  ])('should pass with %s', (_label, input) => {
    expect(stop(input)).toBeNull();
  });

  test('should pass for a non-Stop event', () => {
    expect(
      stop({ hook_event_name: 'SubagentStop', last_assistant_message: EN })
    ).toBeNull();
  });

  test('should pass while personalization is off', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, personalizationEnabled: false });

    expect(stop({ last_assistant_message: EN })).toBeNull();
  });

  test('should pass without a Language or with a non-CJK Language', () => {
    writePersonalization(dir, { persona: 'Calm.' });
    expect(stop({ last_assistant_message: EN })).toBeNull();

    writePersonalization(dir, { language: 'English' });
    expect(stop({ last_assistant_message: JA })).toBeNull();
  });

  test('should pass in headless runs and for review roles', () => {
    expect(
      stop({ last_assistant_message: EN }, { env: { [EXTRACT_ENV]: '1' } })
    ).toBeNull();
    expect(
      stop({ last_assistant_message: EN, agent_type: 'reviewer' })
    ).toBeNull();
    expect(
      stop({ last_assistant_message: EN, agent_type: 'verifier' })
    ).toBeNull();
  });

  test('should pass without a memory directory', () => {
    fs.rmSync(dir, { recursive: true, force: true });

    expect(stop({ last_assistant_message: EN })).toBeNull();
  });

  test('should pass with unreadable personalization settings', () => {
    fs.writeFileSync(path.join(dir, 'personalization.json'), '{not json');

    expect(stop({ last_assistant_message: EN })).toBeNull();
  });

  test('should block without a session id and keep no state', () => {
    const output = stop({ last_assistant_message: EN, session_id: undefined });

    expect(output?.decision).toBe('block');
    expect(fs.existsSync(path.join(dir, GUARD_STATE_FILE))).toBe(false);
  });

  test('should recover from a broken state file', () => {
    fs.mkdirSync(path.dirname(path.join(dir, GUARD_STATE_FILE)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, GUARD_STATE_FILE), 'not json');

    expect(stop({ last_assistant_message: EN })?.decision).toBe('block');
  });

  test('should drop state entries older than a day', () => {
    const file = path.join(dir, GUARD_STATE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ old: { blockedAt: '2000-01-01T00:00:00.000Z' } })
    );

    stop({ last_assistant_message: EN });

    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([
      'sess-1',
    ]);
  });
});

describe('checkStop output', () => {
  test('should use the Antigravity continue decision for agy', () => {
    expect(
      stop({ last_assistant_message: EN }, { harness: 'agy' })?.decision
    ).toBe('continue');
  });

  test('should name the whole Language when its first sentence is empty', () => {
    writePersonalization(dir, { language: '。日本語' });

    expect(stop({ last_assistant_message: EN })?.reason).toContain('。日本語');
  });

  test('should treat a non-object state file as empty', () => {
    const file = path.join(dir, GUARD_STATE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]');

    expect(stop({ last_assistant_message: EN })?.decision).toBe('block');
  });
});

describe('runGuard', () => {
  test('should print the block output as JSON', () => {
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-1',
      last_assistant_message: EN,
    });

    expect(JSON.parse(runGuard(raw, { home })).decision).toBe('block');
  });

  test('should print nothing for a passing reply, empty input, or bad JSON', () => {
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      last_assistant_message: JA,
    });

    expect(runGuard(raw, { home })).toBe('');
    expect(runGuard('', { home })).toBe('');
    expect(runGuard('{oops', { home })).toBe('');
  });
});
