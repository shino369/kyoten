/**
 * `pnpm loop --review`: the quality loop of a code task, headless, for any
 * harness (AGENTS.md §4.5). After the build loop makes verify green:
 *
 * 1. open a review round (`pnpm task review`);
 * 2. a reviewer agent — read-only, fresh context — prints findings rows;
 * 3. a triage agent — read-only, fresh context — prints the same rows with
 *    verdicts (it tries to refute each; unsure means REFUTED);
 * 4. `pnpm task review record` turns CONFIRMED must-fix/high into `fix:` steps;
 * 5. the fixer (the write-mode agent) runs the verify loop until verify passes
 *    and every fix step is marked done;
 *
 * then again, until the round limit (2) is reached or nothing changed since
 * the last review. Reviewers never edit files: they print their rows between
 * BEGIN/END markers on stdout (stderr may echo the prompt, which has an
 * example block) and this module writes them into the findings file.
 */
import fs from 'fs';
import path from 'path';
import { formatGit } from '../task/git.js';
import {
  appendSeparator,
  formatLocal,
  formatNoteEntry,
} from '../task/markdown.js';
import { decideQuality, freshQuality, toFix } from '../task/quality.js';
import { splitRow } from '../task/review.js';
import { runReviewAgents } from '../task/review-run.js';
import { prepareAgentExecution } from './dscc.js';
export {
  BEGIN,
  END,
  extractRows,
  replaceRows,
  reviewerProblems,
  reviewerPrompt,
  tableRows,
  triageProblems,
  triagePrompt,
} from '../task/review-run.js';
import {
  appendNotes,
  loadTask,
  tasksRoot,
  updateState,
} from '../task/store.js';
import { runLoop } from './driver.js';
import { relPosix } from '../paths.js';

/**
 * @typedef {import('../task/state.js').TaskState} TaskState
 * @typedef {import('./adapters.js').AgentCommand} AgentCommand
 * @typedef {import('./driver.js').LoopDeps & {
 *   runTask: (argv: string[]) => string,
 *   scopeFingerprint: (rootDir: string, taskDir: string, state: TaskState) => string | null,
 * }} ReviewDeps
 * @typedef {'complete' | 'verify' | 'fix' | 'blocked' | 'steps-open' | 'no-scope' | 'open' | 'reviewer' | 'triage' | 'record' | 'timeout'} ReviewStop
 * @typedef {{ ok: boolean, reason: ReviewStop, detail: string, rounds: number, logDir: string }} ReviewResult
 */

/**
 * The open `fix:` steps of the task, one prompt line each.
 *
 * @param {TaskState} state
 * @returns {string[]}
 */
export function pendingFixes(state) {
  const quality = state.quality ?? freshQuality();
  const ids = new Set(toFix(quality).map((f) => f.step));
  return state.steps
    .filter((s) => ids.has(s.id) && s.status !== 'done')
    .map(
      (s) =>
        `${s.id}. ${s.title} — when it is fixed and verify passes: pnpm task step ${s.id} done -m "<what changed>"`
    );
}

/**
 * Run the build loop, then review rounds with fixes, for one code task in
 * `rootDir` (already a worktree).
 *
 * @param {{ rootDir: string, name: string, command: AgentCommand, reviewer: AgentCommand, selection?: import('../task/review-run.js').ReviewExecutionPlan, max: number, stall: number, timeoutMs: number, iterationTimeoutMs: number, deps: ReviewDeps }} options
 * @returns {ReviewResult}
 */
export function runReviewLoop({
  rootDir,
  name,
  command,
  reviewer,
  selection,
  max,
  stall,
  timeoutMs,
  iterationTimeoutMs,
  deps,
}) {
  const started = deps.clock();
  const remaining = () => timeoutMs - (deps.clock() - started);
  const taskDir = path.join(tasksRoot(rootDir), name);
  const logDir = path.join(
    taskDir,
    'loop',
    `run-${formatLocal(deps.date(), { withTime: true }).replace(/[^0-9]/g, '')}-review`
  );
  const load = () => /** @type {TaskState} */ (loadTask(rootDir, name).state);
  /** @param {{ label?: string, pending?: (state: TaskState) => string[] }} phase */
  const loop = (phase) =>
    runLoop({
      rootDir,
      name,
      command,
      max,
      stall,
      timeoutMs: Math.max(1, remaining()),
      iterationTimeoutMs,
      deps,
      ...phase,
    });
  let rounds = 0;
  /**
   * @param {ReviewStop} reason
   * @param {string} detail
   * @param {string} [extra] more note text
   * @returns {ReviewResult}
   */
  const finish = (reason, detail, extra) => {
    const ok = reason === 'complete';
    const state = load();
    appendNotes(
      taskDir,
      formatNoteEntry({
        at: deps.date(),
        agent: command.agent,
        label: 'auto: review loop',
        message: `pnpm loop --review --agent ${command.agent} (reviewer ${selection?.reviewer.agent ?? reviewer.agent}): ${ok ? 'complete' : `stopped (${reason})`} — ${detail} ${rounds} round(s) this run.${extra ? ` ${extra}` : ''}${fs.existsSync(logDir) ? ` Logs: ${relPosix(rootDir, logDir)}/` : ''}`,
        state: `${formatGit(deps.git(rootDir))}; verify ${state.lastVerify?.ok ? 'pass' : 'fail'}`,
      }),
      appendSeparator
    );
    return { ok, reason, detail, rounds, logDir };
  };

  const build = loop({});
  if (!build.ok) {
    return finish(
      'verify',
      `the build loop stopped (${build.reason}): \`${build.lastVerify.failed}\` fails.`
    );
  }

  for (;;) {
    if (remaining() <= 0) return finish('timeout', 'wall-clock cap reached.');
    const state = load();
    const quality = state.quality ?? freshQuality();
    const fixes = pendingFixes(state);
    if (fixes.length > 0) {
      deps.log(`▶ fixing ${fixes.length} confirmed finding(s)`);
      const fixed = loop({
        label: `fix-r${quality.reviewRounds}`,
        pending: pendingFixes,
      });
      if (!fixed.ok) {
        return finish(
          'fix',
          `the fix loop stopped (${fixed.reason}): ${fixed.lastVerify.ok ? `${pendingFixes(load()).length} fix step(s) still open` : `\`${fixed.lastVerify.failed}\` fails`}.`
        );
      }
      continue;
    }
    if (state.steps.some((s) => s.status === 'blocked')) {
      return finish('blocked', 'a step is blocked; the user decides.');
    }
    const open = state.steps.filter(
      (s) => s.status !== 'done' && s.status !== 'waiting'
    );
    if (open.length > 0) {
      return finish(
        'steps-open',
        `verify passes, but ${open.map((s) => s.id).join(', ')} not done; the review runs once every step is done.`
      );
    }
    if (quality.phase !== 'review') {
      const print =
        quality.reviewRounds >= quality.maxRounds
          ? quality.reviewedDiff
          : deps.scopeFingerprint(rootDir, taskDir, state);
      if (print === null) {
        return finish(
          'no-scope',
          'no review scope (no task code and no git merge base).'
        );
      }
      if (
        quality.reviewRounds >= quality.maxRounds ||
        print === quality.reviewedDiff
      ) {
        const decision = decideQuality({
          state: { ...state, quality: { ...quality, nudged: null } },
          fingerprint: print,
        });
        updateState(
          rootDir,
          name,
          (current) => ({ ...current, quality: decision.quality }),
          { now: deps.date(), agent: command.agent }
        );
        return finish(
          'complete',
          quality.reviewRounds >= quality.maxRounds
            ? `review round limit reached (${quality.reviewRounds}/${quality.maxRounds}).`
            : 'nothing changed since the last review.',
          decision.note
        );
      }
    }

    /** @type {import('../task/review-run.js').OpenedReview} */
    let opened;
    try {
      opened = JSON.parse(deps.runTask(['review', '--task', name, '--json']));
    } catch (error) {
      return finish(
        'open',
        `pnpm task review could not open a round: ${/** @type {Error} */ (error).message}`
      );
    }
    const round = /** @type {number} */ (opened.round);
    const mode = selection?.mode ?? 'read';
    const fallback = {
      ...prepareAgentExecution({
        agent: reviewer.agent,
        command: reviewer,
        env: deps.env,
      }),
      agent: reviewer.agent,
      model: null,
      effort: null,
    };
    const review = selection ?? {
      mode,
      reviewer: fallback,
      triage: {
        agent: fallback.agent,
        model: fallback.model,
        effort: fallback.effort,
        prepare: () => fallback,
      },
      tip: null,
      timeoutMs: iterationTimeoutMs,
    };
    deps.log(
      `▶ review round ${round}${opened.reopened ? ' (reopened)' : ''}: ${review.reviewer.agent}`
    );
    const { rows, failure } = runReviewAgents({
      rootDir,
      taskDir,
      state: load(),
      opened,
      runAgent: deps.runAgent,
      runLogDir: logDir,
      perAttemptMs: iterationTimeoutMs,
      clock: deps.clock,
      selection: { ...review, timeoutMs: remaining() },
    });
    if (failure) {
      return finish(
        failure.stage,
        `The ${failure.stage} failed: ${failure.message}; round ${round} stays open.`
      );
    }
    if (
      rows.length > 0 &&
      (!review.triage || rows.some((row) => !splitRow(row)[5]))
    ) {
      return finish(
        'triage',
        `round ${round} stays open with untriaged findings (--triage none).`
      );
    }
    try {
      const recorded = JSON.parse(
        deps.runTask(['review', 'record', '--task', name, '--json'])
      );
      rounds += 1;
      deps.log(
        `  round ${round}: ${recorded.findings.length} finding(s), ${recorded.fixSteps.length} fix step(s)`
      );
    } catch (error) {
      return finish(
        'record',
        `pnpm task review record failed: ${/** @type {Error} */ (error).message}`
      );
    }
  }
}
