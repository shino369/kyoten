/** Orchestrate a review and triage using the same pipeline in task and loop. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENTS,
  CALLER_HARNESS_ENV,
  assertAgyAllowed,
  buildCommand,
} from '../loop/adapters.js';
import {
  envSecrets,
  prepareAgentExecution,
  profileEnv,
  scrubSecrets,
} from '../loop/dscc.js';
import { DSCC_DROP, profilePath, writePrivate } from '../kyoten/dscc.js';
import { INNER_LOOP_ENV } from './loop.js';
import { SEVERITIES, VERDICTS } from './quality.js';
import {
  buildReviewPack,
  buildTriagePack,
  FINDINGS_HEADER,
  readReviewText,
  reviewFiles,
  scopeRoot,
  splitRow,
} from './review.js';
import { sessionHarnesses } from './store.js';
import { commandFor } from '../tools/registry.js';

export const BEGIN = 'BEGIN FINDINGS';
export const END = 'END FINDINGS';

const HEADER_ROW = `| ${FINDINGS_HEADER.join(' | ')} |`;
const SEPARATOR_ROW = `| ${FINDINGS_HEADER.map(() => '---').join(' | ')} |`;

/** @param {string} line */
const isHeader = (line) =>
  splitRow(line).join('|').toLowerCase() === FINDINGS_HEADER.join('|');
/** @param {string} line */
const isSeparator = (line) => /^\|[\s|:-]+$/.test(line);
/** @param {string} line */
const isBlank = (line) => splitRow(line).every((cell) => cell === '');

/**
 * The findings rows in the last validly formatted BEGIN/END block. Read
 * mode permits surrounding prose. Oneshot mode requires a standalone block.
 *
 * @param {string} output
 * @param {'read' | 'oneshot'} [mode]
 * @returns {string[] | null}
 */
export function extractRows(output, mode = 'read') {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const end = lines.lastIndexOf(END);
  const begin = end === -1 ? -1 : lines.slice(0, end).lastIndexOf(BEGIN);
  if (
    begin === -1 ||
    (mode === 'oneshot' && (begin !== 0 || end !== lines.length - 1))
  ) {
    return null;
  }
  const block = lines.slice(begin + 1, end).filter(Boolean);
  if (block.some((line) => !line.startsWith('|'))) return null;
  return block.filter(
    (line) => !isHeader(line) && !isSeparator(line) && !isBlank(line)
  );
}

/**
 * The rows of the findings table in a findings file.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function tableRows(markdown) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex(
    (line) => line.startsWith('|') && isHeader(line)
  );
  if (start === -1) return [];
  /** @type {string[]} */
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    if (!isBlank(line)) rows.push(line);
  }
  return rows;
}

/**
 * Replace the rows of the findings table (the text around it is kept).
 *
 * @param {string} markdown
 * @param {string[]} rows
 * @returns {string}
 */
export function replaceRows(markdown, rows) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().startsWith('|') && isHeader(line.trim())
  );
  if (start === -1) {
    return `${markdown.trimEnd()}\n\n${[HEADER_ROW, SEPARATOR_ROW, ...rows].join('\n')}\n`;
  }
  let end = start + 2;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  return [...lines.slice(0, start + 2), ...rows, ...lines.slice(end)].join(
    '\n'
  );
}

/**
 * Problems with the reviewer's rows (empty = fine): every row has all cells,
 * a known severity, a location, a claim, and a scenario. Recording assigns
 * IDs and triage assigns verdicts. Checked before anything is written, so a
 * bad reply never sticks in the findings file.
 *
 * @param {string[]} rows
 * @returns {string[]}
 */
export function reviewerProblems(rows) {
  /** @type {string[]} */
  const problems = [];
  rows.forEach((row, i) => {
    const cells = splitRow(row);
    const at = `row ${i + 1}`;
    if (cells.length !== FINDINGS_HEADER.length) {
      problems.push(
        `${at}: ${cells.length} cells, expected ${FINDINGS_HEADER.length}`
      );
      return;
    }
    const [id, location, severity, claim, scenario, verdict, reason] = cells;
    if (id) problems.push(`${at}: id must stay empty until recording`);
    if (!SEVERITIES.includes(severity.toLowerCase())) {
      problems.push(
        `${at}: severity "${severity}" is not one of ${SEVERITIES.join(', ')}`
      );
    }
    if (!location || !claim || !scenario) {
      problems.push(`${at}: file:line, claim, or failure scenario is empty`);
    }
    if (verdict || reason) {
      problems.push(`${at}: verdict and reason must stay empty for the triage`);
    }
  });
  return problems;
}

/**
 * Problems with the triage's rows against the reviewer's (empty = fine):
 * same findings, same order; only verdict and reason may change, and severity
 * only downwards (raising one would create a fix the reviewer never claimed).
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
export function triageProblems(before, after) {
  if (after.length !== before.length) {
    return [
      `the triage printed ${after.length} row(s) for ${before.length} finding(s)`,
    ];
  }
  /** @type {string[]} */
  const problems = [];
  before.forEach((row, i) => {
    const [id, location, severity, claim, scenario] = splitRow(row);
    const cells = splitRow(after[i]);
    const rank = (/** @type {string | undefined} */ value) =>
      SEVERITIES.indexOf(String(value).toLowerCase());
    if (
      cells[0] !== id ||
      cells[1] !== location ||
      cells[3] !== claim ||
      cells[4] !== scenario ||
      cells.length !== FINDINGS_HEADER.length
    ) {
      problems.push(
        `row ${i + 1}: the triage changed the finding (id, file:line, claim, or scenario)`
      );
    } else if (rank(cells[2]) === -1 || rank(cells[2]) < rank(severity)) {
      problems.push(
        `row ${i + 1}: severity ${severity} → ${cells[2]}: the triage may only lower it to one of ${SEVERITIES.join(', ')}`
      );
    } else if (!cells[5] || !cells[6]) {
      problems.push(`row ${i + 1}: no verdict or no reason`);
    } else if (!VERDICTS.includes(cells[5].toUpperCase())) {
      problems.push(`row ${i + 1}: verdict must be CONFIRMED or REFUTED`);
    }
  });
  return problems;
}

/**
 * The block every reviewer and triage prompt ends with.
 *
 * @param {string[]} rows example or input rows
 * @returns {string[]}
 */
const outputBlock = (rows) => [BEGIN, HEADER_ROW, SEPARATOR_ROW, ...rows, END];

/**
 * @param {{ name: string, round: number, brief: string, findings: string }} input
 *   brief and findings: repo-relative paths
 * @returns {string}
 */
export function reviewerPrompt({ name, round, brief, findings }) {
  return [
    `You are the reviewer for review round ${round} of task ${name}. You run unattended, read-only, in a clean context: someone else wrote this code, and nobody will answer questions.`,
    '',
    'Read .claude/agents/reviewer.md and follow it, with one change: you cannot edit files, so do not add rows to the findings file — print them instead.',
    '',
    `The round's brief (read it first): ${brief}`,
    `The findings file (do not edit it): ${findings}`,
    '',
    'End your reply with your findings in exactly this form: one row per finding, id, verdict, and reason empty. No rows between the markers is a valid review.',
    ...outputBlock([
      '|  | app/src/store.js:42 | high | save() and load() race | two tabs save within 50 ms → the first write is lost |  |  |',
    ]),
  ].join('\n');
}

/**
 * @param {{ name: string, round: number, brief: string, rows: string[] }} input
 * @returns {string}
 */
export function triagePrompt({ name, round, brief, rows }) {
  return [
    `You are the triage for review round ${round} of task ${name}. You run unattended, read-only, in a clean context: you wrote neither the code nor the findings, and nobody will answer questions.`,
    '',
    'Read the "Triage mode" section of .claude/agents/verifier.md and follow it, with one change: you cannot edit files, so print the table instead of editing the findings file.',
    '',
    `The round's brief (read it first): ${brief}`,
    '',
    'The findings to triage:',
    HEADER_ROW,
    SEPARATOR_ROW,
    ...rows,
    '',
    'End your reply with every row above, in the same order, with the verdict (CONFIRMED or REFUTED) and the reason filled in. Leave id, file:line, claim, and failure scenario as they are; change severity only as the role allows:',
    ...outputBlock(['| … one row per finding above … |']),
  ].join('\n');
}

export const REVIEW_AGENTS = [...AGENTS, 'dscc'];

/** @param {string[]} inherited @param {string[]} selected */
function mergeSecrets(inherited, selected) {
  return [...new Set([...inherited, ...selected])].sort(
    (a, b) => b.length - a.length
  );
}

/**
 * @typedef {{ reviewer?: string, reviewerModel?: string, reviewerEffort?: string,
 *   triage?: string, triageModel?: string, triageEffort?: string,
 *   mode?: string, timeoutMin?: string, noRecord?: boolean }} ReviewOptions
 * @typedef {ReturnType<typeof prepareAgentExecution> & {
 *    agent: string, model: string | null, effort: string | null,
 * }} ReviewExecution
 * @typedef {{ agent: string, model: string | null, effort: string | null,
 *    prepare: () => ReviewExecution }} ReviewAgentPlan
 * @typedef {{ reviewer: ReviewExecution, triage: ReviewAgentPlan | null,
 *    mode: 'oneshot' | 'read', timeoutMs: number, tip: string | null }} ReviewExecutionPlan
 */

/**
 * @param {ReviewOptions} options
 * @param {{ rootDir: string, env: NodeJS.ProcessEnv, defaultAgent?: string, bin?: string }} context
 * @returns {ReviewExecutionPlan}
 */
export function resolveReviewExecution(
  options,
  { rootDir, env, defaultAgent, bin }
) {
  const mode = options.mode ?? 'oneshot';
  if (mode !== 'oneshot' && mode !== 'read') {
    throw new Error('Invalid review mode.\nFix: use --mode oneshot or read');
  }
  const timeoutMs = Number(options.timeoutMin ?? 2) * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-min must be a positive number.');
  }

  const launcher = env.KYOTEN_AGENT?.trim() ?? '';
  const markers = [
    REVIEW_AGENTS.includes(launcher) ? launcher : '',
    env[CALLER_HARNESS_ENV]?.trim() ?? '',
    ...sessionHarnesses(env),
  ].filter(Boolean);
  // dscc runs on Claude Code and therefore has Claude's session markers.
  const callers = [
    ...new Set(
      markers.map((agent) =>
        launcher === 'dscc' && agent === 'claude' ? 'dscc' : agent
      )
    ),
  ];
  const caller = callers[0] ?? 'claude';
  const requestedReviewer = options.reviewer ?? env.KYOTEN_REVIEWER;
  const selectedReviewer = requestedReviewer ?? defaultAgent;
  if (selectedReviewer === undefined && callers.length > 1) {
    throw new Error(
      'Conflicting harness markers identify multiple providers.\nFix: select a provider explicitly with --reviewer'
    );
  }
  const reviewer = selectedReviewer ?? caller;
  const requestedTriage = options.triage ?? env.KYOTEN_TRIAGE;
  const triage = requestedTriage ?? reviewer;
  for (const [flag, agent] of [
    ['reviewer', reviewer],
    ['triage', triage],
  ]) {
    if (flag === 'triage' && agent === 'none') continue;
    if (!REVIEW_AGENTS.includes(agent)) {
      throw new Error(
        `Invalid --${flag} ${JSON.stringify(agent)}.\nFix: use ${REVIEW_AGENTS.join('|')}${flag === 'triage' ? '|none' : ''}`
      );
    }
  }
  const guardEnv =
    defaultAgent && defaultAgent !== 'agy'
      ? { ...env, [CALLER_HARNESS_ENV]: defaultAgent }
      : env;
  const inheritedSecrets = envSecrets(env);
  /**
   * @param {'reviewer' | 'triage'} role
   * @param {string} agent
   * @param {string | null} model
   * @param {string | null} effort
   * @returns {ReviewAgentPlan}
   */
  const plan = (role, agent, model, effort) => {
    const adapter = agent === 'dscc' ? 'claude' : agent;
    const requestedBin = agent === defaultAgent ? bin : undefined;
    const command = buildCommand({
      agent: adapter,
      bin: requestedBin,
      argv: requestedBin ? null : commandFor(rootDir, adapter),
      mode,
      model,
      effort,
    });
    assertAgyAllowed(command.agent, guardEnv, `--${role} agy`, command.bin);
    const settings = { agent, model, effort };
    const requested =
      role === 'triage'
        ? (requestedTriage ?? requestedReviewer)
        : requestedReviewer;
    const nativeClaude = launcher === 'dscc' && requested === 'claude';
    return {
      ...settings,
      prepare: () => {
        const dispatchEnv = nativeClaude
          ? profileEnv(env, { drop: [...DSCC_DROP, 'KYOTEN_AGENT'], set: {} })
          : env;
        const execution = prepareAgentExecution({
          agent,
          env: dispatchEnv,
          command,
        });
        return {
          ...execution,
          ...settings,
          secrets: mergeSecrets(inheritedSecrets, execution.secrets),
        };
      },
    };
  };
  const reviewerPlan = plan(
    'reviewer',
    reviewer,
    options.reviewerModel ??
      env.KYOTEN_REVIEWER_MODEL ??
      (reviewer === 'claude' ? 'sonnet' : null),
    options.reviewerEffort ?? env.KYOTEN_REVIEWER_EFFORT ?? null
  );
  const triagePlan =
    triage === 'none'
      ? null
      : plan(
          'triage',
          triage,
          options.triageModel ??
            env.KYOTEN_TRIAGE_MODEL ??
            (triage === 'claude' ? 'haiku' : null),
          options.triageEffort ??
            env.KYOTEN_TRIAGE_EFFORT ??
            (triage === 'codex' || triage === 'agy' ? 'low' : null)
        );
  const runningAgy = caller === 'agy' && [reviewer, triage].includes('agy');
  const hasAlternate =
    runningAgy &&
    (commandFor(rootDir, 'dsh') ||
      fs.existsSync(
        profilePath({ env, homedir: os.homedir(), platform: process.platform })
      ));
  return {
    mode,
    timeoutMs,
    reviewer: reviewerPlan.prepare(),
    triage: triagePlan,
    tip: hasAlternate
      ? 'Tip: pass --reviewer dscc or dsh to opt into a different provider next time.'
      : null,
  };
}

/**
 * The artifact locations and review scope returned by pnpm task review.
 * @typedef {{ round: number, brief: string, findings: string, reopened: boolean,
 *   scope: import('./review.js').Scope, diff: string | null, incrementalDiff: string | null,
 *   incrementalUnavailable?: boolean, stats?: [string, import('./review.js').FileStat][] }} OpenedReview
 * @typedef {{ stage: 'reviewer' | 'triage', agent: string, model: string | null,
 *   effort: string | null, attempt: number, result?: import('../loop/adapters.js').AgentResult,
 *   error?: string }} ReviewAttempt
 */

/**
 * @param {{ rootDir: string, taskDir: string, state: import('./state.js').TaskState,
 *   opened: OpenedReview }} info
 * @returns {import('./review.js').ReviewPackInput}
 */
function reviewInput({ rootDir, taskDir, state, opened }) {
  return {
    state,
    round: opened.round,
    repoDir: scopeRoot(rootDir, state, opened.scope),
    scope: opened.scope,
    planText:
      readReviewText(
        rootDir,
        path.relative(rootDir, path.join(taskDir, 'plan.md'))
      ) ?? '',
    diff: opened.diff ? readReviewText(rootDir, opened.diff) : null,
    incrementalDiff: opened.incrementalDiff
      ? readReviewText(rootDir, opened.incrementalDiff)
      : null,
    incrementalUnavailable: opened.incrementalUnavailable,
    stats: opened.stats ? new Map(opened.stats) : undefined,
  };
}

/** @param {ReviewAttempt} entry */
export function reviewTelemetry(entry) {
  const { stage, agent, model, effort, attempt, result, error } = entry;
  const status = error
    ? 'failed to start'
    : (result?.signal ?? result?.code ?? 'unknown');
  return [
    `- ${stage} attempt ${attempt}: ${agent}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}; exit ${status}${result ? `; ${result.durationMs} ms` : ''}`,
    ...(result?.usage ? [`  Usage: ${JSON.stringify(result.usage)}`] : []),
    ...(error ? [`  ${error.replace(/\r?\n/g, ' ')}`] : []),
  ].join('\n');
}

/**
 * Workspace files are only available to read mode. Isolate oneshot sessions in
 * a disposable directory so local agent instructions don't fill the context.
 * @param {{ rootDir: string, mode: ReviewExecutionPlan['mode'],
 *   execution: ReviewExecution, prompt: string, timeoutMs: number,
 *   runAgent: typeof import('../loop/adapters.js').runAgent }} options
 */
function askReview({ rootDir, mode, execution, prompt, timeoutMs, runAgent }) {
  const cwd =
    mode === 'oneshot'
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-review-'))
      : rootDir;
  try {
    return runAgent({
      command: execution.command,
      cwd,
      prompt,
      timeoutMs,
      env: {
        ...execution.env,
        [INNER_LOOP_ENV]: 'off',
        TASK_AGENT: execution.agent,
      },
    });
  } finally {
    if (mode === 'oneshot') fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   rootDir: string, taskDir: string, state: import('./state.js').TaskState,
 *   opened: OpenedReview, selection: ReviewExecutionPlan,
 *   runAgent: typeof import('../loop/adapters.js').runAgent,
 *   runLogDir?: string, perAttemptMs?: number, clock?: () => number,
 * }} options
 * @returns {{ rows: string[], failure: { stage: 'reviewer' | 'triage', message: string } | null }}
 */
export function runReviewAgents({
  rootDir,
  taskDir,
  state,
  opened,
  selection,
  runAgent,
  runLogDir,
  perAttemptMs = Infinity,
  clock = Date.now,
}) {
  const { reviewer, triage, mode, timeoutMs } = selection;
  const deadline = clock() + timeoutMs;
  let secrets = reviewer.secrets;
  const scrub = (/** @type {string} */ text) => scrubSecrets(text, secrets);
  const paths = reviewFiles(state.name, opened.round);
  const findingsFile = path.join(rootDir, opened.findings);
  const original = readReviewText(rootDir, opened.findings);
  if (original === null) {
    throw new Error(
      'Cannot read the review findings as a regular, safe text file.'
    );
  }
  let rows = tableRows(original).map(scrub);
  /** @type {ReviewAttempt[]} */
  const attempts = [];
  const input =
    mode === 'oneshot'
      ? { ...reviewInput({ rootDir, taskDir, state, opened }), scrub }
      : null;
  const reviewPrompt = input
    ? buildReviewPack(input)
    : scrub(
        reviewerPrompt({
          name: state.name,
          round: opened.round,
          brief: opened.brief,
          findings: opened.findings,
        })
      );
  if (input) writePrivate(path.join(taskDir, paths.pack), reviewPrompt);

  /**
   * @param {ReviewAttempt['stage']} stage
   * @param {ReviewExecution} execution
   * @param {string} prompt
   * @param {(rows: string[]) => string[]} validate
   * @returns {{ rows: string[] } | { problem: string }}
   */
  const ask = (stage, execution, prompt, validate) => {
    let problem = 'timeout';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - clock();
      if (remaining <= 0) break;
      const { agent, model, effort } = execution;
      const entry = { stage, agent, model, effort, attempt };
      let result;
      try {
        result = askReview({
          rootDir,
          mode,
          execution,
          prompt,
          timeoutMs: Math.min(remaining, perAttemptMs),
          runAgent,
        });
      } catch (error) {
        problem = scrub(error instanceof Error ? error.message : String(error));
        attempts.push({ ...entry, error: problem });
        break;
      }
      attempts.push({ ...entry, result });
      if (runLogDir) {
        fs.mkdirSync(runLogDir, { recursive: true, mode: 0o700 });
        writePrivate(
          path.join(runLogDir, `r${opened.round}-${stage}.md`),
          scrub(
            `# ${stage}\n\n${attempts
              .filter((call) => call.stage === stage)
              .map(reviewTelemetry)
              .join(
                '\n'
              )}\n\n## Prompt\n\n${prompt}\n\n## Output\n\n${result.output}\n`
          )
        );
      }
      if (result.code !== 0) {
        problem = `exited ${result.signal ?? result.code}`;
        break;
      }
      if (mode === 'oneshot' && result.usage?.toolCallsCount) {
        problem = 'used tools in oneshot mode';
        break;
      }
      const printed = extractRows(scrub(result.stdout), mode);
      const problems =
        printed === null
          ? [`printed no ${BEGIN} … ${END} block`]
          : validate(printed);
      if (printed !== null && problems.length === 0) return { rows: printed };
      problem = problems.join('; ');
    }
    return { problem };
  };

  const save = () =>
    writePrivate(findingsFile, scrub(replaceRows(original, rows)));
  try {
    if (rows.length === 0) {
      const response = ask(
        'reviewer',
        reviewer,
        reviewPrompt,
        reviewerProblems
      );
      if ('problem' in response)
        return {
          rows,
          failure: { stage: 'reviewer', message: response.problem },
        };
      rows = response.rows;
      save();
    }
    if (triage && rows.some((row) => !splitRow(row)[5])) {
      let execution;
      try {
        execution = triage.prepare();
      } catch (error) {
        const message = scrub(
          error instanceof Error ? error.message : String(error)
        );
        attempts.push({
          stage: 'triage',
          agent: triage.agent,
          model: triage.model,
          effort: triage.effort,
          attempt: 1,
          error: message,
        });
        return { rows, failure: { stage: 'triage', message } };
      }
      secrets = mergeSecrets(secrets, execution.secrets);
      const safeRows = rows.map(scrub);
      if (safeRows.some((row, i) => row !== rows[i])) {
        rows = safeRows;
        save();
      }
      const prompt = input
        ? buildTriagePack({ ...input, rows })
        : scrub(
            triagePrompt({
              name: state.name,
              round: opened.round,
              brief: opened.brief,
              rows,
            })
          );
      const response = ask('triage', execution, prompt, (after) =>
        triageProblems(rows, after)
      );
      if ('problem' in response)
        return {
          rows,
          failure: { stage: 'triage', message: response.problem },
        };
      rows = response.rows;
      save();
    }
    return { rows, failure: null };
  } finally {
    const runLog = path.join(taskDir, paths.runLog);
    const previous =
      readReviewText(rootDir, path.relative(rootDir, runLog)) ??
      `# Review runs for round ${opened.round}\n`;
    writePrivate(
      runLog,
      scrub(
        `${previous}\n## Run (${mode})\n\n${attempts.map(reviewTelemetry).join('\n') || '- Resumed from existing findings.'}\n`
      )
    );
  }
}
