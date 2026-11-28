/** Read Codex configuration layers without starting a model turn or an MCP server. */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { runIfMain } from '../module-runner.js';
import { resolveCommand } from '../spawn.js';

export const MCP_CHECK_OK = 'No active MCP servers outside user configuration.';

// The app server loads the user layer during startup. If that layer can
// change the identity or routing used to fetch cloud configuration, its
// view of managed layers cannot stand in for exec --ignore-user-config.
const BOOTSTRAP_SETTINGS = [
  'chatgpt_base_url',
  'cli_auth_credentials_store',
  'forced_chatgpt_workspace_id',
  'forced_login_method',
  'project_root_markers',
];
const BOOTSTRAP_FEATURES = ['respect_system_proxy', 'secret_auth_storage'];

/** @param {any} value @returns {value is Record<string, any>} */
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {any} result Codex config/read response from the review's cwd */
export function reviewMcpIsEmpty(result) {
  if (!Array.isArray(result?.layers)) return false;
  const features = result.config?.features;
  if (features?.apps !== false || features?.plugins !== false) return false;
  let sawUserLayer = false;
  // The protocol returns layers in precedence order, highest first.
  const enabled = new Map();
  for (const layer of result.layers.toReversed()) {
    const type = layer?.name?.type;
    const config = layer?.config;
    if (typeof type !== 'string' || !record(config)) return false;
    if (type === 'user') {
      sawUserLayer = true;
      if (
        BOOTSTRAP_SETTINGS.some((key) => Object.hasOwn(config, key)) ||
        BOOTSTRAP_FEATURES.some((feature) =>
          Object.hasOwn(config.features ?? {}, feature)
        )
      )
        return false;
      continue;
    }
    if (!Object.hasOwn(config, 'mcp_servers')) continue;
    if (!record(config.mcp_servers)) return false;
    const servers = Object.entries(config.mcp_servers);
    // If TMPDIR is in a checkout, ignoring user config can change project
    // trust. A project override cannot prove that an inherited server is off.
    if (type === 'project' && servers.length > 0) return false;
    if (layer.disabledReason) continue;
    for (const [name, server] of servers) {
      if (!record(server)) return false;
      if (!enabled.has(name) || Object.hasOwn(server, 'enabled')) {
        enabled.set(name, server.enabled !== false);
      }
    }
  }
  return sawUserLayer && ![...enabled.values()].some(Boolean);
}

/** @param {string} executable @param {string[]} argv @param {number} timeoutMs */
export async function checkReviewMcp(executable, argv, timeoutMs) {
  const { bin, args, options } = resolveCommand(executable, argv);
  const child = spawn(bin, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  const timeout = setTimeout(() => lines.close(), timeoutMs);
  const send = (/** @type {object} */ message) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'kyoten', version: '1' } },
    });
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply?.id === 0) {
        if (!reply.result) return false;
        send({ method: 'initialized' });
        send({
          id: 1,
          method: 'config/read',
          params: { cwd: process.cwd(), includeLayers: true },
        });
      }
      if (reply?.id === 1) {
        if (!reviewMcpIsEmpty(reply.result)) return false;
        // Managed feature requirements can override the CLI disables when
        // Codex starts a session, even if config/read reports them as off.
        send({ id: 2, method: 'configRequirements/read' });
      }
      if (reply?.id === 2) {
        const requirements = reply.result?.requirements;
        if (requirements === null) return true;
        const features = requirements?.featureRequirements;
        return (
          features === null ||
          (record(features) &&
            [features.apps, features.plugins].every(
              (value) => value === undefined || value === false
            ))
        );
      }
    }
    return false;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

/* c8 ignore next 10 - process entry point; the adapter tests exercise its contract */
runIfMain(import.meta.url, async () => {
  const [limit, executable, ...argv] = process.argv.slice(2);
  try {
    const ok = await checkReviewMcp(
      executable,
      argv,
      Math.max(1, Number(limit) - 100)
    );
    if (ok) console.log(MCP_CHECK_OK);
    else process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
});
