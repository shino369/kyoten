#!/usr/bin/env node
/**
 * `pnpm sync <command> [options]` — Zero-trust E2EE Git Vault memory sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runIfMain } from '../module-runner.js';
import { mainCheckout } from '../memory/repo.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  SyncError,
  enrollDevice,
  exportRootKey,
  importRootKey,
  initSync,
  pullSync,
  pushSync,
  revokeDevice,
  rotateRootKey,
  setSyncMode,
  syncStatus,
} from './vault.js';

export const HELP = `Usage: pnpm sync <command> [options]

Zero-trust E2EE Git Vault sync for personal memory and personas.

Commands
  init --vault <url-or-path> [--name <name>] [--zone personal|work]
       [--mode full|receive|off] [--compartments <list>]
       [--root-key <b64> | --root-fingerprint <16-hex> | --trust-vault-root]
  status [--json]
  mode <full|receive|off>
  push [--dry-run] [--json]
  pull [--dry-run] [--json]
  root show [--json]
  root export --out <file> [--passphrase <str> | --passphrase-env <var>] [--json]
  root import --in <file> [--passphrase <str> | --passphrase-env <var>] [--json]
  root rotate [--json]
  device list [--json]
  device add --pubkey <file-or-json> [--name <name>] [--zone personal|work]
             [--compartments <list>]
  device revoke <device-id>
  help

Options
  --help, -h   Show this help
  --json       Machine-readable JSON output`;

/**
 * @typedef {{ rootDir?: string, cwd?: string, out?: (line: string) => void, run?: import('../spawn.js').Spawn, env?: NodeJS.ProcessEnv }} CliDeps
 */

/**
 * @param {string[]} argv
 * @param {Record<string, string>} valueFlags
 * @param {string[]} boolFlags
 */
function parseOptions(argv, valueFlags = {}, boolFlags = []) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Set<string>} */
  const flags = new Set();
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (boolFlags.includes(arg)) {
      flags.add(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flagName = eq >= 0 ? arg.slice(0, eq) : arg;
    if (Object.hasOwn(valueFlags, flagName)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) {
        throw new SyncError(`Option ${flagName} needs a value.`);
      }
      values[valueFlags[flagName]] = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new SyncError(`Unknown option "${arg}".`, 'Run pnpm sync --help');
    }
    positionals.push(arg);
  }
  return { values, flags, positionals };
}

/**
 * @param {string[]} argv
 * @param {CliDeps} [deps]
 * @returns {number}
 */
export function runCli(argv, deps = {}) {
  const {
    rootDir = mainCheckout(ROOT_DIR),
    cwd = process.cwd(),
    out = console.log,
    run,
    env = process.env,
  } = deps;
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

  if (command === 'init') {
    const { values, flags } = parseOptions(
      rest,
      {
        '--vault': 'vault',
        '--name': 'name',
        '--zone': 'zone',
        '--mode': 'mode',
        '--compartments': 'compartments',
        '--root-key': 'rootPublicKey',
        '--root-fingerprint': 'rootFingerprint',
        '--repo-allowlist': 'repoAllowlist',
      },
      ['--trust-vault-root', '--json']
    );
    const result = initSync(rootDir, {
      vault: values.vault,
      name: values.name,
      zone: values.zone,
      mode: values.mode,
      compartments: values.compartments
        ? values.compartments.split(',')
        : undefined,
      repoAllowlist: values.repoAllowlist
        ? values.repoAllowlist
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      rootPublicKey: values.rootPublicKey,
      rootFingerprint: values.rootFingerprint,
      trustVaultRoot: flags.has('--trust-vault-root'),
      run,
    });
    if (flags.has('--json')) {
      out(JSON.stringify(result, null, 2));
    } else {
      out(
        `Initialized sync device ${result.config.deviceId} (${result.config.name}, mode=${result.config.mode}, zone=${result.config.zone}).`
      );
      out(`Root key fingerprint: ${result.rootFingerprint}`);
      if (result.isOwner) {
        out(`Root key: ${result.rootPublicKey}`);
      }
      if (result.trustedOnFirstUse) {
        out(
          'Warning: trusted vault root on first use (--trust-vault-root); verify fingerprint with owner.'
        );
      }
      if (result.mdmSuggestedReceive) {
        out('MDM/endpoint agent detected: defaulted sync mode to "receive".');
      }
    }
    return 0;
  }

  if (command === 'status') {
    const { flags } = parseOptions(rest, {}, ['--json']);
    const status = syncStatus(rootDir);
    if (flags.has('--json')) {
      out(JSON.stringify(status, null, 2));
    } else if (!status.initialized) {
      out(
        'Sync is not initialized. Run: pnpm sync init --vault <git-url-or-path>'
      );
    } else {
      const { config, devices, epoch, isOwner, rootFingerprint } = status;
      if (!config) return 0;
      out(
        `Device: ${config.deviceId} (${config.name}) | zone=${config.zone} | mode=${config.mode} | owner=${isOwner}`
      );
      out(`Root fingerprint: ${rootFingerprint}`);
      out(`Compartments: ${config.compartments.join(', ')}`);
      out(
        `Vault: ${config.vault} (epoch ${epoch}, ${devices.length} device(s))`
      );
    }
    return 0;
  }

  if (command === 'root') {
    const [sub, ...subRest] = rest;
    if (sub === 'show') {
      const { flags } = parseOptions(subRest, {}, ['--json']);
      const status = syncStatus(rootDir);
      if (!status.initialized || !status.rootPublicKey) {
        throw new SyncError(
          'Sync is not initialized.',
          'Run pnpm sync init --vault <url>'
        );
      }
      const view = {
        rootPublicKey: status.rootPublicKey,
        rootFingerprint: status.rootFingerprint,
        holdsRootKey: status.isOwner,
        epoch: status.epoch,
        rotations: status.rootRotations,
      };
      if (flags.has('--json')) out(JSON.stringify(view, null, 2));
      else {
        out(`Root key: ${view.rootPublicKey}`);
        out(`Root fingerprint: ${view.rootFingerprint}`);
        out(`Holds root private key: ${view.holdsRootKey}`);
      }
      return 0;
    }
    if (sub === 'export') {
      const { values, flags } = parseOptions(
        subRest,
        {
          '--out': 'outFile',
          '--passphrase': 'passphrase',
          '--passphrase-env': 'passphraseEnv',
        },
        ['--json']
      );
      if (!values.outFile) {
        throw new SyncError(
          'Output file (--out <file>) is required.',
          'Run pnpm sync root export --out <file> --passphrase-env KYOTEN_SYNC_PASSPHRASE'
        );
      }
      const passphrase =
        values.passphrase ??
        env[values.passphraseEnv ?? 'KYOTEN_SYNC_PASSPHRASE'];
      if (!passphrase) {
        throw new SyncError(
          'Backup passphrase is required.',
          'Pass --passphrase <str> or set KYOTEN_SYNC_PASSPHRASE (or --passphrase-env <VAR>).'
        );
      }
      const res = exportRootKey(rootDir, {
        passphrase,
        outFile: path.resolve(cwd, values.outFile),
      });
      if (flags.has('--json')) out(JSON.stringify(res, null, 2));
      else {
        out(
          `Exported encrypted root key backup (${res.rootFingerprint}) to ${res.outFile}.`
        );
      }
      return 0;
    }
    if (sub === 'import') {
      const { values, flags } = parseOptions(
        subRest,
        {
          '--in': 'inFile',
          '--passphrase': 'passphrase',
          '--passphrase-env': 'passphraseEnv',
        },
        ['--json']
      );
      if (!values.inFile) {
        throw new SyncError(
          'Backup file (--in <file>) is required.',
          'Run pnpm sync root import --in <file> --passphrase-env KYOTEN_SYNC_PASSPHRASE'
        );
      }
      const passphrase =
        values.passphrase ??
        env[values.passphraseEnv ?? 'KYOTEN_SYNC_PASSPHRASE'];
      if (!passphrase) {
        throw new SyncError(
          'Backup passphrase is required.',
          'Pass --passphrase <str> or set KYOTEN_SYNC_PASSPHRASE (or --passphrase-env <VAR>).'
        );
      }
      const backup = JSON.parse(
        fs.readFileSync(path.resolve(cwd, values.inFile), 'utf-8')
      );
      const res = importRootKey(rootDir, { backup, passphrase, run });
      if (flags.has('--json')) out(JSON.stringify(res, null, 2));
      else {
        out(`Imported root signing key (${res.rootFingerprint}).`);
      }
      return 0;
    }
    if (sub === 'rotate') {
      const { flags } = parseOptions(subRest, {}, ['--json']);
      const res = rotateRootKey(rootDir, { run });
      if (flags.has('--json')) out(JSON.stringify(res, null, 2));
      else {
        out(
          `Rotated root key ${res.previousFingerprint} -> ${res.rootFingerprint} at epoch ${res.epoch}.`
        );
      }
      return 0;
    }
    throw new SyncError(
      `Unknown root subcommand "${sub ?? ''}".`,
      'Use: pnpm sync root show | export | import | rotate'
    );
  }

  if (command === 'mode') {
    const { flags, positionals } = parseOptions(rest, {}, ['--json']);
    if (!positionals[0]) {
      throw new SyncError(
        'Mode is required.',
        'Run pnpm sync mode full|receive|off'
      );
    }
    const config = setSyncMode(rootDir, positionals[0]);
    if (flags.has('--json')) out(JSON.stringify(config, null, 2));
    else out(`Sync mode set to ${config.mode}.`);
    return 0;
  }

  if (command === 'push') {
    const { flags } = parseOptions(rest, {}, ['--dry-run', '--json']);
    const result = pushSync(rootDir, {
      dryRun: flags.has('--dry-run'),
      run,
    });
    if (flags.has('--json')) {
      out(JSON.stringify(result, null, 2));
    } else if (result.batches.length === 0) {
      out('Nothing new to push.');
    } else {
      const prefix = result.dryRun ? '[dry-run] Would push' : 'Pushed';
      for (const b of result.batches) {
        out(
          `${prefix} ${b.compartment} seq=${b.seq} (${b.ops} op(s), personalization=${b.hasPersonalization}, personas=${b.personas.length}) to [${b.recipients.join(', ')}].`
        );
      }
    }
    return 0;
  }

  if (command === 'pull') {
    const { flags } = parseOptions(rest, {}, ['--dry-run', '--json']);
    const result = pullSync(rootDir, {
      dryRun: flags.has('--dry-run'),
      run,
    });
    if (flags.has('--json')) {
      out(JSON.stringify(result, null, 2));
    } else {
      const verb = result.dryRun ? '[dry-run] Would apply' : 'Applied';
      out(
        `${verb} ${result.applied || result.opsToApply} op(s) across ${result.batchesDecrypted} batch(es); quarantined=${result.quarantined}, refused=${result.refused}.`
      );
      if (result.skippedCompartments.length > 0) {
        out(
          `Skipped compartments without key access: ${result.skippedCompartments.join(', ')}`
        );
      }
    }
    return 0;
  }

  if (command === 'device') {
    const [sub, ...subRest] = rest;
    if (sub === 'list') {
      const { flags } = parseOptions(subRest, {}, ['--json']);
      const status = syncStatus(rootDir);
      if (!status.initialized || !status.devices) {
        throw new SyncError(
          'Sync is not initialized.',
          'Run pnpm sync init --vault <url>'
        );
      }
      if (flags.has('--json')) {
        out(JSON.stringify(status.devices, null, 2));
      } else {
        for (const d of status.devices) {
          const state = d.revokedAt ? `revoked (${d.revokedAt})` : 'active';
          out(
            `${d.deviceId}  ${d.name}  zone=${d.zone}  compartments=${d.compartments.join(',')}  ${state}`
          );
        }
      }
      return 0;
    }
    if (sub === 'add') {
      const { values, flags } = parseOptions(
        subRest,
        {
          '--pubkey': 'pubkey',
          '--name': 'name',
          '--zone': 'zone',
          '--compartments': 'compartments',
        },
        ['--json']
      );
      if (!values.pubkey) {
        throw new SyncError(
          'A device public key bundle (--pubkey <file-or-json>) is required.'
        );
      }
      const raw = values.pubkey.trim().startsWith('{')
        ? values.pubkey
        : fs.readFileSync(path.resolve(cwd, values.pubkey), 'utf-8');
      const result = enrollDevice(rootDir, {
        pubkey: JSON.parse(raw),
        name: values.name,
        zone: values.zone,
        compartments: values.compartments
          ? values.compartments.split(',')
          : undefined,
        run,
      });
      if (flags.has('--json')) out(JSON.stringify(result, null, 2));
      else {
        out(
          `Enrolled device ${result.device.deviceId} (${result.device.name}) at epoch ${result.epoch}.`
        );
      }
      return 0;
    }
    if (sub === 'revoke') {
      const { flags, positionals } = parseOptions(subRest, {}, ['--json']);
      if (!positionals[0]) {
        throw new SyncError(
          'Device id is required.',
          'Run pnpm sync device revoke <id>'
        );
      }
      const result = revokeDevice(rootDir, positionals[0], { run });
      if (flags.has('--json')) out(JSON.stringify(result, null, 2));
      else out(`Revoked device ${result.deviceId} at epoch ${result.epoch}.`);
      return 0;
    }
    throw new SyncError(
      `Unknown device subcommand "${sub ?? ''}".`,
      'Use: pnpm sync device list | add | revoke'
    );
  }

  throw new SyncError(
    `Unknown sync command "${command}".`,
    'Run pnpm sync --help'
  );
}

/* c8 ignore start - CLI entry point; runCli is tested directly */
runIfMain(import.meta.url, () => {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
});
/* c8 ignore stop */
