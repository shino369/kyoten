#!/usr/bin/env node
/**
 * `pnpm remote <command> [options]` — Manage OSC 7501 status emission for Herdr / Rex.
 */
import { mainCheckout } from '../memory/repo.js';
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readRemoteConfig, writeRemoteConfig } from './config.js';

export const HELP = `Usage: pnpm remote <command> [options]

Manage OSC 7501 status hooks (Herdr/Rex).

Commands
  status [--json]
  osc7501 on|off
  help

Options
  --help, -h   Show this help
  --json       Machine-readable JSON output`;

/**
 * @param {string[]} argv
 * @param {string[]} boolFlags
 */
function parseOptions(argv, boolFlags = []) {
  /** @type {Set<string>} */
  const flags = new Set();
  /** @type {string[]} */
  const positionals = [];
  for (const arg of argv) {
    if (boolFlags.includes(arg)) {
      flags.add(arg);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".\nFix: pnpm remote --help`);
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

/**
 * @param {string[]} argv
 * @param {{
 *   rootDir?: string,
 *   out?: (line: string) => void,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv, deps = {}) {
  const { rootDir = mainCheckout(ROOT_DIR), out = console.log } = deps;
  const [command, ...rest] = argv;
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    out(HELP);
    return 0;
  }

  if (command === 'status') {
    const { flags } = parseOptions(rest, ['--json']);
    const cfg = readRemoteConfig(rootDir);
    if (flags.has('--json')) {
      out(JSON.stringify({ osc7501: cfg.osc7501 }, null, 2));
    } else {
      out(`OSC 7501: ${cfg.osc7501 ? 'on' : 'off'}`);
    }
    return 0;
  }

  if (command === 'osc7501') {
    const { positionals } = parseOptions(rest);
    const val = positionals[0];
    if (val !== 'on' && val !== 'off') {
      throw new Error('Usage: pnpm remote osc7501 on|off');
    }
    const cfg = readRemoteConfig(rootDir);
    writeRemoteConfig(rootDir, { ...cfg, osc7501: val === 'on' });
    out(`OSC 7501 hook emission turned ${val}.`);
    return 0;
  }

  throw new Error(
    `Unknown remote command "${command}".\nFix: pnpm remote --help`
  );
}

/* c8 ignore start - CLI entry point; runCli is tested directly */
runIfMain(import.meta.url, async () => {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
});
/* c8 ignore stop */
