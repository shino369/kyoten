#!/usr/bin/env node
/**
 * Auto-formatting hook: runs Prettier on files an edit touched.
 *
 * - Claude Code: PostToolUse on Edit|Write; formats `tool_input.file_path`.
 * - DSH (bridge): PostToolUse on its edit tools; formats the edit's files.
 * - Codex: shell-run `apply_patch` sends only PreToolUse, so the patch's
 *   files are queued there and formatted at the next PostToolUse (the Stop
 *   hook flushes what is left; see utils/harness/format.js).
 *
 * Started with `--harness claude|codex|dsh`. Never blocks: exit 0 always.
 */
import path from 'path';
import {
  flushFormatQueue,
  formatTargets,
  prettierBin,
  queueFiles,
  runPrettier,
  taskRepoRoots,
} from '#utils/harness/format.js';
import {
  normalizeHookInput,
  parseHarness,
  projectDir,
  toolEvent,
} from '#utils/harness/input.js';
import { runIfMain } from '#utils/module-runner.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

export { prettierBin, runPrettier };

/**
 * Claude Code: format an Edit or Write target, under the same rule as the
 * other harnesses: only inside the project or the session task's --repo.
 * Prettier loads the config of the file's repository, which can be code, so
 * an edit anywhere else (such as the repository kyoten passes with
 * --add-dir) is left alone.
 *
 * @param {{ tool_name: string, session_id?: string, cwd?: string, tool_input?: { file_path?: string } }} input
 * @param {{ rootDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean}
 */
export function processHookInput(
  input,
  { rootDir = ROOT_DIR, env = process.env } = {}
) {
  const filePath = input.tool_input?.file_path;
  if (!['Edit', 'Write'].includes(input.tool_name) || !filePath) return false;

  const dir = projectDir({ harness: 'claude', env, rootDir });
  const extraRoots = taskRepoRoots(rootDir, input.session_id);
  const targets = formatTargets([filePath], {
    cwd: input.cwd,
    projectDir: dir,
    extraRoots,
  });
  // No session: Claude Code queues nothing, so only `targets` are formatted.
  const formatted = flushFormatQueue(null, {
    projectDir: dir,
    extraRoots,
    extra: targets,
  });
  if (formatted.length === 0) return false;
  console.log(`✓ Formatted ${path.basename(filePath)} with prettier`);
  return true;
}

/**
 * Codex, DSH, and Antigravity: queue or format the files of an edit (see the
 * file header).
 *
 * @param {Record<string, any>} input
 * @param {'codex' | 'dsh' | 'agy'} harness
 * @param {{ rootDir?: string, env?: NodeJS.ProcessEnv, tmpDir?: string }} [options]
 * @returns {string[]} the files formatted
 */
export function processOtherHarness(
  input,
  harness,
  { rootDir = ROOT_DIR, env = process.env, tmpDir } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const dir = projectDir({ harness, env, rootDir });
  const extraRoots = taskRepoRoots(rootDir, normalized.session_id);
  const event = toolEvent(normalized);
  const targets =
    event.kind === 'edit'
      ? formatTargets(event.files, {
          // A leading `cd <dir> &&` moves the patch's paths, as in the guard.
          cwd: event.dir
            ? path.resolve(normalized.cwd ?? dir, event.dir)
            : normalized.cwd,
          projectDir: dir,
          extraRoots,
        })
      : [];
  if (harness === 'codex' && normalized.hook_event_name === 'PreToolUse') {
    queueFiles(normalized.session_id, targets, { tmpDir });
    return [];
  }
  return flushFormatQueue(normalized.session_id, {
    projectDir: dir,
    extraRoots,
    extra: targets,
    tmpDir,
  });
}

/* istanbul ignore next - stdin handling is tested via integration */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let inputData = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    inputData += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(inputData);
      // Codex and DSH get no plain stdout; Antigravity expects `{}`.
      if (harness === 'claude') processHookInput(input);
      else processOtherHarness(input, harness);
    } catch (err) {
      console.error(
        `Auto-format error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (harness === 'agy') {
      process.stdout.write('{}', () => process.exit(0));
      return;
    }
    process.exit(0); // never block the edit
  });
}

runIfMain(import.meta.url, main);
