#!/usr/bin/env node
/**
 * `pnpm remote <command> [options]` — Manage OSC 7501 status emission and
 * host-direct RFC 8291/8292 Web Push notifications.
 */
import os from 'node:os';
import path from 'node:path';
import { mainCheckout } from '../memory/repo.js';
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  addSubscription,
  readRemoteConfig,
  removeSubscription,
  writeRemoteConfig,
} from './config.js';
import { deliverNotifications } from './notify-worker.js';
import {
  buildSubscribeUrl,
  exportSubscribeBundle,
  startSubscribeServer,
} from './subscribe-page.js';
import { buildAlertPayload, generateVapidKeys } from './webpush.js';

export const HELP = `Usage: pnpm remote <command> [options]

Manage OSC 7501 status hooks (Herdr/Rex) and host-direct E2EE Web Push alerts.

Commands
  status [--json]
  osc7501 on|off
  vapid init [--subject <mailto:...|https://...>] [--force] [--json]
  vapid show [--json]
  push on|off
  push add --endpoint <url> --p256dh <key> --auth <secret> [--label <name>]
  push remove <id>
  push list [--json]
  push test [--title <text>] [--body <text>] [--dry-run] [--json]
  push subscribe-page --out <dir> [--base-url <https://...>] [--json]
  push subscribe-serve [--port <n>] [--json]
  help

Options
  --help, -h   Show this help
  --json       Machine-readable JSON output`;

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
        throw new Error(`Option ${flagName} needs a value.`);
      }
      values[valueFlags[flagName]] = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".\nFix: pnpm remote --help`);
    }
    positionals.push(arg);
  }
  return { values, flags, positionals };
}

/**
 * @param {string[]} argv
 * @param {{
 *   rootDir?: string,
 *   cwd?: string,
 *   out?: (line: string) => void,
 *   fetchFn?: typeof globalThis.fetch,
 *   allowLocalhost?: boolean,
 *   startServer?: typeof startSubscribeServer,
 *   waitForClose?: () => Promise<void>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv, deps = {}) {
  const {
    rootDir = mainCheckout(ROOT_DIR),
    cwd = process.cwd(),
    out = console.log,
    fetchFn = globalThis.fetch,
    allowLocalhost = false,
    startServer = startSubscribeServer,
    waitForClose,
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

  if (command === 'status') {
    const { flags } = parseOptions(rest, {}, ['--json']);
    const cfg = readRemoteConfig(rootDir);
    const publicView = {
      osc7501: cfg.osc7501,
      pushEnabled: cfg.pushEnabled,
      subject: cfg.subject,
      vapidPublicKey: cfg.vapid?.publicKey ?? null,
      subscriptions: cfg.subscriptions.map((s) => ({
        id: s.id,
        label: s.label ?? null,
        endpointHost: new URL(s.endpoint).host,
        addedAt: s.addedAt,
      })),
      quietMs: cfg.quietMs,
    };
    if (flags.has('--json')) {
      out(JSON.stringify(publicView, null, 2));
    } else {
      out(
        `OSC 7501: ${cfg.osc7501 ? 'on' : 'off'} | Web Push: ${cfg.pushEnabled ? 'on' : 'off'}`
      );
      out(
        `VAPID key: ${cfg.vapid ? cfg.vapid.publicKey : 'not initialized (pnpm remote vapid init)'}`
      );
      out(`Subscriptions: ${cfg.subscriptions.length}`);
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

  if (command === 'vapid') {
    const [sub, ...subRest] = rest;
    if (sub === 'init') {
      const { values, flags } = parseOptions(
        subRest,
        { '--subject': 'subject' },
        ['--force', '--json']
      );
      const cfg = readRemoteConfig(rootDir);
      if (cfg.vapid && !flags.has('--force')) {
        throw new Error(
          'VAPID keypair already exists.\nFix: pass --force to rotate it (existing subscriptions must re-subscribe).'
        );
      }
      const vapid = generateVapidKeys();
      const updated = writeRemoteConfig(rootDir, {
        ...cfg,
        subject: values.subject ?? cfg.subject,
        vapid,
      });
      if (flags.has('--json')) {
        out(
          JSON.stringify(
            { publicKey: vapid.publicKey, subject: updated.subject },
            null,
            2
          )
        );
      } else {
        out(`Initialized VAPID keypair (subject=${updated.subject}).`);
        out(`Public key: ${vapid.publicKey}`);
      }
      return 0;
    }
    if (sub === 'show') {
      const { flags } = parseOptions(subRest, {}, ['--json']);
      const cfg = readRemoteConfig(rootDir);
      if (!cfg.vapid) {
        throw new Error(
          'VAPID keypair is not initialized.\nFix: pnpm remote vapid init'
        );
      }
      if (flags.has('--json')) {
        out(
          JSON.stringify(
            { publicKey: cfg.vapid.publicKey, subject: cfg.subject },
            null,
            2
          )
        );
      } else {
        out(`Subject: ${cfg.subject}`);
        out(`Public key: ${cfg.vapid.publicKey}`);
      }
      return 0;
    }
    throw new Error(
      `Unknown vapid subcommand "${sub ?? ''}".\nFix: pnpm remote vapid init | show`
    );
  }

  if (command === 'push') {
    const [sub, ...subRest] = rest;
    if (sub === 'on' || sub === 'off') {
      const cfg = readRemoteConfig(rootDir);
      if (sub === 'on' && !cfg.vapid) {
        throw new Error(
          'Cannot enable Web Push before initializing VAPID keys.\nFix: pnpm remote vapid init'
        );
      }
      writeRemoteConfig(rootDir, { ...cfg, pushEnabled: sub === 'on' });
      out(`Web Push notifications turned ${sub}.`);
      return 0;
    }
    if (sub === 'add') {
      const { values, flags } = parseOptions(
        subRest,
        {
          '--endpoint': 'endpoint',
          '--p256dh': 'p256dh',
          '--auth': 'auth',
          '--label': 'label',
        },
        ['--json']
      );
      if (!values.endpoint || !values.p256dh || !values.auth) {
        throw new Error(
          'Missing required flags.\nFix: pnpm remote push add --endpoint <url> --p256dh <key> --auth <secret>'
        );
      }
      const created = addSubscription(rootDir, {
        endpoint: values.endpoint,
        p256dh: values.p256dh,
        auth: values.auth,
        label: values.label,
        allowLocalhost,
      });
      if (flags.has('--json')) out(JSON.stringify(created, null, 2));
      else out(`Added push subscription ${created.id}.`);
      return 0;
    }
    if (sub === 'remove') {
      const { positionals } = parseOptions(subRest);
      if (!positionals[0]) {
        throw new Error('Subscription id is required.');
      }
      const removed = removeSubscription(rootDir, positionals[0]);
      if (!removed) {
        throw new Error(`No subscription with id "${positionals[0]}".`);
      }
      out(`Removed push subscription ${positionals[0]}.`);
      return 0;
    }
    if (sub === 'list') {
      const { flags } = parseOptions(subRest, {}, ['--json']);
      const cfg = readRemoteConfig(rootDir);
      if (flags.has('--json')) {
        out(JSON.stringify(cfg.subscriptions, null, 2));
      } else if (cfg.subscriptions.length === 0) {
        out('No push subscriptions registered.');
      } else {
        for (const s of cfg.subscriptions) {
          out(
            `${s.id}  ${s.label ?? '(unlabeled)'}  ${new URL(s.endpoint).host}`
          );
        }
      }
      return 0;
    }
    if (sub === 'test') {
      const { values, flags } = parseOptions(
        subRest,
        { '--title': 'title', '--body': 'body' },
        ['--dry-run', '--json']
      );
      const cfg = readRemoteConfig(rootDir);
      if (!cfg.vapid) {
        throw new Error(
          'VAPID keypair is not initialized.\nFix: pnpm remote vapid init'
        );
      }
      const alert = buildAlertPayload({
        title: values.title ?? 'kyoten test alert',
        body: values.body ?? 'Host-direct E2EE Web Push is working.',
        event: 'Test',
        harness: 'kyoten',
        host: os.hostname() || 'kyoten',
      });
      if (flags.has('--dry-run')) {
        const preview = {
          dryRun: true,
          subscriptions: cfg.subscriptions.length,
          alert,
        };
        out(
          flags.has('--json')
            ? JSON.stringify(preview, null, 2)
            : `[dry-run] Would send "${alert.title}" to ${cfg.subscriptions.length} subscription(s).`
        );
        return 0;
      }
      const summary = await deliverNotifications({
        rootDir,
        alert,
        fetchFn,
        allowLocalhost,
      });
      if (flags.has('--json')) out(JSON.stringify(summary, null, 2));
      else {
        out(
          `Push test: sent=${summary.sent}, failed=${summary.failed}, pruned=${summary.pruned}.`
        );
      }
      return 0;
    }
    if (sub === 'subscribe-page') {
      const { values, flags } = parseOptions(
        subRest,
        { '--out': 'out', '--base-url': 'baseUrl' },
        ['--json']
      );
      if (!values.out) {
        throw new Error(
          'Output directory (--out <dir>) is required.\nFix: pnpm remote push subscribe-page --out ./dist/push-pwa'
        );
      }
      const cfg = readRemoteConfig(rootDir);
      const result = exportSubscribeBundle(path.resolve(cwd, values.out));
      const subscribeUrl =
        values.baseUrl && cfg.vapid
          ? buildSubscribeUrl({
              baseUrl: values.baseUrl,
              vapidPublicKey: cfg.vapid.publicKey,
            })
          : null;
      const payload = { ...result, subscribeUrl };
      if (flags.has('--json')) {
        out(JSON.stringify(payload, null, 2));
      } else {
        out(
          `Wrote static Web Push subscribe PWA (${result.files.join(', ')}) to ${result.outDir}.`
        );
        if (subscribeUrl) {
          out(`Subscribe URL: ${subscribeUrl}`);
        } else if (cfg.vapid) {
          out(
            `Open <https-host>/#vapid=${encodeURIComponent(cfg.vapid.publicKey)} on your phone.`
          );
        } else {
          out(
            'Run pnpm remote vapid init, then pass --base-url https://... to generate the #vapid URL.'
          );
        }
      }
      return 0;
    }
    if (sub === 'subscribe-serve') {
      const { values, flags } = parseOptions(subRest, { '--port': 'port' }, [
        '--json',
      ]);
      const port = values.port === undefined ? 0 : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(
          `Invalid --port "${String(values.port)}".\nFix: pass an integer between 0 and 65535.`
        );
      }
      const cfg = readRemoteConfig(rootDir);
      if (!cfg.vapid) {
        throw new Error(
          'VAPID keypair is not initialized.\nFix: pnpm remote vapid init'
        );
      }
      const srv = await startServer({
        port,
        host: '127.0.0.1',
        vapidPublicKey: cfg.vapid.publicKey,
      });
      try {
        if (flags.has('--json')) {
          out(JSON.stringify({ port: srv.port, url: srv.url }, null, 2));
        } else {
          out(`Subscribe URL: ${srv.url}`);
          out(
            `Expose over Tailscale Serve: tailscale serve --https=443 http://127.0.0.1:${srv.port}`
          );
        }
        /* c8 ignore start - real signal wait when running interactively */
        const awaitClose =
          waitForClose ??
          (() =>
            new Promise((resolve) => {
              const stop = () => {
                process.off('SIGINT', stop);
                process.off('SIGTERM', stop);
                resolve();
              };
              process.once('SIGINT', stop);
              process.once('SIGTERM', stop);
            }));
        /* c8 ignore stop */
        await awaitClose();
      } finally {
        await srv.close();
      }
      return 0;
    }
    throw new Error(
      `Unknown push subcommand "${sub ?? ''}".\nFix: pnpm remote push on|off|add|remove|list|test|subscribe-page|subscribe-serve`
    );
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
