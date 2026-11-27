/**
 * Track 1 (`pnpm sync`): Zero-Trust E2EE Git Vault.
 *
 * Enforces the three-plane separation:
 * - Plane 1 (Code/Harness): never synced here (Git + signed commits only).
 * - Plane 2 (Memory & Persona): per-device signed, compartmentalized E2EE
 *   op-logs (`personal`, `home-private`, `work`) with secret refusal and
 *   receive-side instruction quarantine (`memory/inbox.jsonl`).
 * - Plane 3 (Machine-local): `machine` notes, API keys, `memory/config.json`,
 *   extraction state, and `memory/sync/identity.json` never leave the host.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshAfterWrite } from '../memory/context.js';
import { injectionsIn, looksLikeInstruction } from '../memory/instructions.js';
import {
  PERSONA_KEYS,
  agentPersonaFile,
  normalizePersonalization,
  personaFromMarkdown,
  readPersonalization,
  storedPersona,
  syncPersonaFile,
  writePersonalization,
} from '../memory/personalize.js';
import { appendInbox } from '../memory/queue.js';
import { repoIdentity } from '../memory/repo.js';
import { takeSnapshot } from '../memory/snapshot.js';
import {
  MemoryError,
  assertNoSecrets,
  compareHlc,
  formatHlc,
  loadNotes,
  maxHlcFromOps,
  memoryDir,
  mergeSyncedOps,
  nextHlc,
  normalizeInput,
  parseHlc,
  readJsonOrNull,
  readLog,
} from '../memory/store.js';
import { findSecrets } from '../redact.js';
import { crossSpawn } from '../spawn.js';
import { readIfExists, writeFileAtomic } from '../task/store.js';
import {
  GENESIS_HASH,
  SyncCryptoError,
  createRootRotation,
  decryptBatch,
  decryptRootKeyBackup,
  deriveEd25519PublicKey,
  encryptBatch,
  encryptRootKeyBackup,
  generateDeviceIdentity,
  generateRootKeyPair,
  keyFingerprint,
  sha256Hex,
  signRegistry,
  verifyRegistry,
  verifyRegistryChain,
} from './crypto.js';

export const SYNC_SUBDIR = 'sync';
export const SYNC_MODES = /** @type {const} */ (['full', 'receive', 'off']);
export const COMPARTMENTS = /** @type {const} */ ([
  'personal',
  'home-private',
  'work',
]);
export const ZONES = /** @type {const} */ (['personal', 'work']);

const DEVICES_FILE = 'devices.json';
const DEVICES_SIG_FILE = 'devices.json.sig';
const OPS_DIR = 'ops';
const BATCH_FILE_RE = /^(\d+)-([a-z-]+)\.enc\.json$/;
const LEGACY_ID_RE = /^([mt])([1-9]\d*)$/;

/**
 * @typedef {typeof SYNC_MODES[number]} SyncMode
 * @typedef {typeof COMPARTMENTS[number]} Compartment
 * @typedef {typeof ZONES[number]} DeviceZone
 * @typedef {import('./crypto.js').PublicDevice} PublicDevice
 * @typedef {import('./crypto.js').DevicePrivateKeys} DevicePrivateKeys
 * @typedef {import('../memory/store.js').Op} Op
 * @typedef {import('../spawn.js').Spawn} Spawn
 *
 * @typedef {object} SyncConfig
 * @property {number} version
 * @property {string} deviceId
 * @property {string} name
 * @property {DeviceZone} zone
 * @property {SyncMode} mode
 * @property {string} vault
 * @property {string[]} compartments
 * @property {string[]} repoAllowlist
 * @property {string} rootPublicKey
 *
 * @typedef {object} SyncIdentity
 * @property {string} deviceId
 * @property {string} ed25519PrivateKey
 * @property {string} x25519PrivateKey
 * @property {string | null} rootPrivateKey
 *
 * @typedef {{ seq: number, lastHash: string }} StreamCursor
 *
 * @typedef {object} SyncCursors
 * @property {number} pushedLogOps
 * @property {string | null} lastHlc
 * @property {Record<string, string>} pushedArtifacts
 * @property {Record<string, StreamCursor>} pushed
 * @property {Record<string, StreamCursor>} pulled
 *
 * @typedef {{ version: number, epoch: number, updatedAt: string, rootHistory?: import('./crypto.js').RootRotation[], devices: PublicDevice[] }} DeviceRegistry
 */

export class SyncError extends Error {
  /**
   * @param {string} message
   * @param {string} [fix]
   */
  constructor(message, fix) {
    super(fix ? `${message}\nFix: ${fix}` : message);
    this.name = 'SyncError';
    this.fix = fix;
  }
}

/** @param {string} rootDir */
export const syncDir = (rootDir) => path.join(memoryDir(rootDir), SYNC_SUBDIR);
/** @param {string} rootDir */
const vaultDir = (rootDir) => path.join(syncDir(rootDir), 'vault');
/** @param {string} rootDir */
const configFile = (rootDir) => path.join(syncDir(rootDir), 'config.json');
/** @param {string} rootDir */
const identityFile = (rootDir) => path.join(syncDir(rootDir), 'identity.json');
/** @param {string} rootDir */
const cursorsFile = (rootDir) => path.join(syncDir(rootDir), 'cursors.json');
/** @param {string} rootDir */
const pubFile = (rootDir) => path.join(syncDir(rootDir), 'device-pub.json');

/**
 * Best-effort read-only MDM presence hint (suggests `receive` mode on managed machines).
 *
 * @param {{ platform?: NodeJS.Platform, existsSync?: (p: string) => boolean, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {boolean}
 */
export function detectMdmHint({
  platform = process.platform,
  existsSync = fs.existsSync,
  env = process.env,
} = {}) {
  if (env.KYOTEN_MDM_HINT === '1') return true;
  if (env.KYOTEN_MDM_HINT === '0') return false;
  if (platform === 'darwin') {
    return (
      existsSync('/Library/Application Support/Jamf') ||
      existsSync('/Library/Application Support/Netskope') ||
      existsSync('/Library/Managed Preferences')
    );
  }
  if (platform === 'win32') {
    const programData = env.ProgramData ?? 'C:\\ProgramData';
    return (
      existsSync(path.join(programData, 'CrowdStrike')) ||
      existsSync(path.join(programData, 'Netskope'))
    );
  }
  return false;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function normalizeCompartments(values) {
  const unique = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw new SyncError(
      'At least one compartment is required.',
      `Specify --compartments ${COMPARTMENTS.join(',')}`
    );
  }
  for (const c of unique) {
    if (!COMPARTMENTS.includes(/** @type {any} */ (c))) {
      throw new SyncError(
        `Unknown compartment "${c}".`,
        `Use a comma-separated subset of: ${COMPARTMENTS.join(', ')}`
      );
    }
  }
  return unique;
}

/**
 * @param {string} mode
 * @returns {SyncMode}
 */
function assertMode(mode) {
  if (!SYNC_MODES.includes(/** @type {any} */ (mode))) {
    throw new SyncError(
      `Unknown sync mode "${mode}".`,
      `Use one of: ${SYNC_MODES.join(', ')}`
    );
  }
  return /** @type {SyncMode} */ (mode);
}

/**
 * @param {string} zone
 * @returns {DeviceZone}
 */
function assertZone(zone) {
  if (!ZONES.includes(/** @type {any} */ (zone))) {
    throw new SyncError(
      `Unknown device zone "${zone}".`,
      `Use one of: ${ZONES.join(', ')}`
    );
  }
  return /** @type {DeviceZone} */ (zone);
}

/**
 * Run a git command against the vault repo (or target path), failing clearly on error.
 *
 * @param {Spawn} run
 * @param {string[]} args
 * @param {{ cwd?: string, allowFail?: boolean }} [options]
 */
function git(run, args, { cwd, allowFail = false } = {}) {
  const res = run('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    throw new SyncError(`Failed to run git: ${res.error.message}`);
  }
  if (!allowFail && res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim();
    const stdout = String(res.stdout ?? '').trim();
    throw new SyncError(
      `git ${args.join(' ')} failed (${res.status}): ${stderr || stdout}`
    );
  }
  return {
    status: res.status ?? 0,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

/**
 * @param {Spawn} run
 * @param {string} vDir
 * @param {string} message
 */
function gitCommitAndPush(run, vDir, message) {
  git(run, ['-C', vDir, 'add', '-A']);
  const diff = git(run, ['-C', vDir, 'status', '--porcelain']);
  if (!diff.stdout.trim()) return false;
  git(run, [
    '-C',
    vDir,
    '-c',
    'user.name=kyoten-sync',
    '-c',
    'user.email=sync@kyoten.local',
    'commit',
    '-q',
    '--no-gpg-sign',
    '-m',
    message,
  ]);
  const remotes = git(run, ['-C', vDir, 'remote']).stdout.trim();
  if (remotes) {
    git(run, ['-C', vDir, 'push', '-q', 'origin', 'HEAD']);
  }
  return true;
}

/**
 * Pull latest commits if `origin` has an upstream branch (empty remote repos stay clean).
 *
 * @param {Spawn} run
 * @param {string} vDir
 */
function gitPullIfReady(run, vDir) {
  const remotes = git(run, ['-C', vDir, 'remote']).stdout.trim();
  if (!remotes) return;
  const ls = git(run, ['-C', vDir, 'ls-remote', '--heads', 'origin'], {
    allowFail: true,
  });
  if (ls.status !== 0 || !ls.stdout.trim()) return;
  git(run, ['-C', vDir, 'pull', '-q', '--ff-only', 'origin', 'HEAD']);
}

/** @param {string} rootDir @returns {SyncConfig} */
export function readSyncConfig(rootDir) {
  const cfg = /** @type {SyncConfig | null} */ (
    readJsonOrNull(configFile(rootDir))
  );
  if (!cfg || typeof cfg.deviceId !== 'string') {
    throw new SyncError(
      'Sync is not initialized in this workspace.',
      'Run pnpm sync init --vault <git-url-or-path>'
    );
  }
  return cfg;
}

/** @param {string} rootDir @returns {SyncIdentity} */
function readIdentity(rootDir) {
  const id = /** @type {SyncIdentity | null} */ (
    readJsonOrNull(identityFile(rootDir))
  );
  if (!id || typeof id.ed25519PrivateKey !== 'string') {
    throw new SyncError(
      'Sync device identity is missing.',
      'Run pnpm sync init --vault <git-url-or-path>'
    );
  }
  return id;
}

/** @param {string} rootDir @returns {SyncCursors} */
function readCursors(rootDir) {
  const data = /** @type {SyncCursors | null} */ (
    readJsonOrNull(cursorsFile(rootDir))
  );
  if (data && typeof data === 'object') {
    return {
      pushedLogOps: Number.isInteger(data.pushedLogOps) ? data.pushedLogOps : 0,
      lastHlc:
        typeof data.lastHlc === 'string' && parseHlc(data.lastHlc)
          ? data.lastHlc
          : null,
      pushedArtifacts: data.pushedArtifacts ?? {},
      pushed: data.pushed ?? {},
      pulled: data.pulled ?? {},
    };
  }
  return {
    pushedLogOps: 0,
    lastHlc: null,
    pushedArtifacts: {},
    pushed: {},
    pulled: {},
  };
}

/**
 * Load and verify `devices.json` + `devices.json.sig`, following any dual-signed
 * `rootHistory` key rotations and persisting the rotated root public key locally.
 *
 * @param {string} rootDir
 * @param {string} vDir
 * @param {SyncConfig} config
 * @returns {{ registry: DeviceRegistry, rootPublicKey: string, rotated: boolean }}
 */
function loadVerifiedRegistry(rootDir, vDir, config) {
  const registry = /** @type {DeviceRegistry | null} */ (
    readJsonOrNull(path.join(vDir, DEVICES_FILE))
  );
  const sig = readJsonOrNull(path.join(vDir, DEVICES_SIG_FILE));
  if (!registry || !Array.isArray(registry.devices)) {
    throw new SyncError('Vault registry devices.json is missing or invalid.');
  }
  const verified = verifyRegistryChain(registry, sig, config.rootPublicKey);
  if (!verified.valid || !verified.currentRootPublicKey) {
    throw new SyncError(
      'Vault registry signature check failed (devices.json.sig does not match pinned root key or valid rotation chain).'
    );
  }
  if (verified.rotated) {
    config.rootPublicKey = verified.currentRootPublicKey;
    writeJson(configFile(rootDir), config);
    const id = /** @type {SyncIdentity | null} */ (
      readJsonOrNull(identityFile(rootDir))
    );
    if (id && id.rootPrivateKey) {
      let matches = false;
      try {
        matches =
          deriveEd25519PublicKey(id.rootPrivateKey) ===
          verified.currentRootPublicKey;
      } catch {
        matches = false;
      }
      if (!matches) {
        writeJson(identityFile(rootDir), { ...id, rootPrivateKey: null }, true);
      }
    }
  }
  return {
    registry,
    rootPublicKey: verified.currentRootPublicKey,
    rotated: verified.rotated,
  };
}

/**
 * @param {string} file
 * @param {unknown} data
 * @param {boolean} [restrictMode]
 */
function writeJson(file, data, restrictMode = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  if (restrictMode && process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
  }
}

/**
 * Initialize `pnpm sync` for this workspace: generates Ed25519/X25519 device
 * keys, clones/opens the E2EE Git vault, and either creates a dedicated
 * root-signed `devices.json` (first owner machine) or verifies an existing
 * vault against `--root-key` / `--root-fingerprint` (TOFU only with explicit
 * `--trust-vault-root`).
 *
 * @param {string} rootDir
 * @param {{
 *   vault: string,
 *   name?: string,
 *   zone?: string,
 *   mode?: string,
 *   compartments?: string[],
 *   repoAllowlist?: string[],
 *   rootPublicKey?: string,
 *   rootFingerprint?: string,
 *   trustVaultRoot?: boolean,
 *   now?: Date,
 *   run?: Spawn,
 *   mdmHint?: boolean,
 * }} options
 */
export function initSync(
  rootDir,
  {
    vault,
    name = os.hostname() || 'kyoten-host',
    zone = 'personal',
    mode,
    compartments,
    repoAllowlist = [],
    rootPublicKey,
    rootFingerprint,
    trustVaultRoot = false,
    now = new Date(),
    run = crossSpawn(),
    mdmHint = detectMdmHint(),
  }
) {
  if (typeof vault !== 'string' || !vault.trim()) {
    throw new SyncError(
      'Vault repository URL or path is required.',
      'Pass --vault <git-url-or-path>'
    );
  }
  const validZone = assertZone(zone);
  const resolvedMode = assertMode(
    mode ?? (mdmHint ? 'receive' : validZone === 'work' ? 'receive' : 'full')
  );
  const resolvedCompartments = normalizeCompartments(
    compartments ??
      (validZone === 'work' ? ['personal'] : ['personal', 'home-private'])
  );
  const { publicDevice, privateKeys } = generateDeviceIdentity({
    name,
    zone: validZone,
    compartments: resolvedCompartments,
    now,
  });

  const vDir = vaultDir(rootDir);
  if (fs.existsSync(vDir)) {
    fs.rmSync(vDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(vDir), { recursive: true });

  const resolvedVault =
    fs.existsSync(vault) && path.isAbsolute(vault)
      ? vault
      : vault.startsWith('.') || fs.existsSync(path.resolve(rootDir, vault))
        ? path.resolve(rootDir, vault)
        : vault;

  git(run, ['clone', '-q', resolvedVault, vDir]);
  // Ensure an unborn remote repository has an initial branch name.
  const hasHead =
    git(run, ['-C', vDir, 'rev-parse', '--verify', 'HEAD'], {
      allowFail: true,
    }).status === 0;
  if (!hasHead) {
    git(run, ['-C', vDir, 'checkout', '-q', '-b', 'main'], { allowFail: true });
  }

  const existingRegPath = path.join(vDir, DEVICES_FILE);
  const existingSigPath = path.join(vDir, DEVICES_SIG_FILE);
  let isOwner = false;
  let trustedOnFirstUse = false;
  let pinnedRootKey = '';
  /** @type {string | null} */
  let rootPrivateKey = null;

  try {
    if (fs.existsSync(existingRegPath)) {
      const existingReg = /** @type {DeviceRegistry} */ (
        readJsonOrNull(existingRegPath)
      );
      const existingSig = /** @type {any} */ (readJsonOrNull(existingSigPath));
      if (!existingReg || !existingSig?.rootPublicKey) {
        throw new SyncError('Existing vault has an invalid devices registry.');
      }
      const trimmedKey =
        typeof rootPublicKey === 'string' ? rootPublicKey.trim() : '';
      const trimmedFp =
        typeof rootFingerprint === 'string'
          ? rootFingerprint.trim().toLowerCase()
          : '';

      if (trimmedKey) {
        const verified = verifyRegistryChain(
          existingReg,
          existingSig,
          trimmedKey
        );
        if (!verified.valid || !verified.currentRootPublicKey) {
          throw new SyncError(
            'Existing vault devices.json.sig failed signature verification against --root-key.'
          );
        }
        pinnedRootKey = verified.currentRootPublicKey;
      } else if (trimmedFp) {
        if (!/^[0-9a-f]{16}$/.test(trimmedFp)) {
          throw new SyncError(
            `Invalid --root-fingerprint "${rootFingerprint}": expected 16 hex characters.`
          );
        }
        const actualFp = keyFingerprint(String(existingSig.rootPublicKey));
        if (actualFp !== trimmedFp) {
          throw new SyncError(
            `Vault root fingerprint mismatch: expected ${trimmedFp}, found ${actualFp}.`
          );
        }
        if (
          !verifyRegistry(
            existingReg,
            existingSig,
            String(existingSig.rootPublicKey)
          )
        ) {
          throw new SyncError(
            'Existing vault devices.json.sig failed signature verification.'
          );
        }
        pinnedRootKey = String(existingSig.rootPublicKey);
      } else if (trustVaultRoot === true) {
        if (
          !verifyRegistry(
            existingReg,
            existingSig,
            String(existingSig.rootPublicKey)
          )
        ) {
          throw new SyncError(
            'Existing vault devices.json.sig failed self-signed verification.'
          );
        }
        pinnedRootKey = String(existingSig.rootPublicKey);
        trustedOnFirstUse = true;
      } else {
        throw new SyncError(
          'Joining an existing vault requires --root-key or --root-fingerprint to prevent TOFU attacks.',
          'Run pnpm sync root show on the owner machine, then pass --root-key <b64> or --root-fingerprint <16-hex> (or pass --trust-vault-root to explicitly accept TOFU).'
        );
      }
    } else {
      isOwner = true;
      const rootKeys = generateRootKeyPair();
      pinnedRootKey = rootKeys.publicKey;
      rootPrivateKey = rootKeys.privateKey;
      /** @type {DeviceRegistry} */
      const registry = {
        version: 1,
        epoch: 1,
        updatedAt: now.toISOString(),
        rootHistory: [],
        devices: [publicDevice],
      };
      const sig = signRegistry(registry, rootPrivateKey, pinnedRootKey, now);
      writeJson(existingRegPath, registry);
      writeJson(existingSigPath, sig);
      gitCommitAndPush(
        run,
        vDir,
        `chore(sync): initialize vault (${publicDevice.deviceId})`
      );
    }
  } catch (error) {
    fs.rmSync(vDir, { recursive: true, force: true });
    throw error;
  }

  /** @type {SyncConfig} */
  const config = {
    version: 1,
    deviceId: publicDevice.deviceId,
    name: publicDevice.name,
    zone: validZone,
    mode: resolvedMode,
    vault: resolvedVault,
    compartments: resolvedCompartments,
    repoAllowlist: [...repoAllowlist],
    rootPublicKey: pinnedRootKey,
  };
  /** @type {SyncIdentity} */
  const identity = {
    deviceId: publicDevice.deviceId,
    ed25519PrivateKey: privateKeys.ed25519PrivateKey,
    x25519PrivateKey: privateKeys.x25519PrivateKey,
    rootPrivateKey,
  };
  /** @type {SyncCursors} */
  const cursors = {
    pushedLogOps: 0,
    lastHlc: null,
    pushedArtifacts: {},
    pushed: {},
    pulled: {},
  };

  writeJson(identityFile(rootDir), identity, true);
  writeJson(pubFile(rootDir), publicDevice);
  writeJson(configFile(rootDir), config);
  writeJson(cursorsFile(rootDir), cursors);

  return {
    config,
    publicDevice,
    isOwner,
    trustedOnFirstUse,
    mdmSuggestedReceive: mdmHint && mode === undefined,
    rootPublicKey: pinnedRootKey,
    rootFingerprint: keyFingerprint(pinnedRootKey),
  };
}

/**
 * Switch the local sync mode (`full` / `receive` / `off`).
 *
 * @param {string} rootDir
 * @param {string} mode
 * @returns {SyncConfig}
 */
export function setSyncMode(rootDir, mode) {
  const config = readSyncConfig(rootDir);
  const next = { ...config, mode: assertMode(mode) };
  writeJson(configFile(rootDir), next);
  return next;
}

/**
 * Read current local sync status and enrolled devices (if vault exists locally).
 *
 * @param {string} rootDir
 */
export function syncStatus(rootDir) {
  if (!fs.existsSync(configFile(rootDir))) {
    return { initialized: false, mdmHint: detectMdmHint() };
  }
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  const cursors = readCursors(rootDir);
  const vDir = vaultDir(rootDir);
  let devices = /** @type {PublicDevice[]} */ ([]);
  let epoch = 0;
  let rootRotations = 0;
  if (fs.existsSync(path.join(vDir, DEVICES_FILE))) {
    const loaded = loadVerifiedRegistry(rootDir, vDir, config);
    devices = loaded.registry.devices;
    epoch = loaded.registry.epoch;
    rootRotations = (loaded.registry.rootHistory ?? []).length;
  }
  return {
    initialized: true,
    isOwner: Boolean(identity.rootPrivateKey),
    mdmHint: detectMdmHint(),
    rootPublicKey: config.rootPublicKey,
    rootFingerprint: keyFingerprint(config.rootPublicKey),
    rootRotations,
    config,
    cursors,
    epoch,
    devices,
  };
}

/**
 * Export an encrypted offline backup of the vault root Ed25519 private key.
 *
 * @param {string} rootDir
 * @param {{ passphrase: string, outFile?: string, now?: Date }} options
 */
export function exportRootKey(
  rootDir,
  { passphrase, outFile, now = new Date() }
) {
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  if (!identity.rootPrivateKey) {
    throw new SyncError(
      'This machine does not hold the vault root signing key.',
      'Run pnpm sync root export on a machine holding the root key.'
    );
  }
  const backup = encryptRootKeyBackup({
    rootPrivateKey: identity.rootPrivateKey,
    rootPublicKey: config.rootPublicKey,
    passphrase,
    now,
  });
  if (outFile) {
    writeJson(outFile, backup, true);
  }
  return {
    backup,
    outFile: outFile ?? null,
    rootPublicKey: backup.rootPublicKey,
    rootFingerprint: backup.rootFingerprint,
  };
}

/**
 * Restore the vault root Ed25519 private key from an encrypted offline backup
 * onto an initialized machine whose pinned root key matches the backup.
 *
 * @param {string} rootDir
 * @param {{ backup: unknown, passphrase: string, run?: Spawn }} options
 */
export function importRootKey(
  rootDir,
  { backup, passphrase, run = crossSpawn() }
) {
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const loaded = loadVerifiedRegistry(rootDir, vDir, config);
  const decrypted = decryptRootKeyBackup({ backup, passphrase });
  if (decrypted.rootPublicKey !== loaded.rootPublicKey) {
    throw new SyncError(
      `Backup root key (${decrypted.rootFingerprint}) does not match this vault's current root key (${keyFingerprint(loaded.rootPublicKey)}).`
    );
  }
  writeJson(
    identityFile(rootDir),
    { ...identity, rootPrivateKey: decrypted.rootPrivateKey },
    true
  );
  return {
    rootPublicKey: decrypted.rootPublicKey,
    rootFingerprint: decrypted.rootFingerprint,
  };
}

/**
 * Rotate the vault root Ed25519 keypair, publishing a dual-signed `rootHistory`
 * entry in `devices.json` so all enrolled peers verify and follow automatically.
 *
 * @param {string} rootDir
 * @param {{ now?: Date, run?: Spawn }} [options]
 */
export function rotateRootKey(
  rootDir,
  { now = new Date(), run = crossSpawn() } = {}
) {
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  if (!identity.rootPrivateKey) {
    throw new SyncError(
      'This machine does not hold the vault root signing key.',
      'Run pnpm sync root import --in <backup.json> first.'
    );
  }
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const loaded = loadVerifiedRegistry(rootDir, vDir, config);
  const oldPub = loaded.rootPublicKey;
  if (deriveEd25519PublicKey(identity.rootPrivateKey) !== oldPub) {
    throw new SyncError(
      'Local rootPrivateKey does not match the current vault root key.'
    );
  }

  const nextRoot = generateRootKeyPair();
  const nextEpoch = loaded.registry.epoch + 1;
  const rotation = createRootRotation({
    oldRootPrivateKey: identity.rootPrivateKey,
    oldRootPublicKey: oldPub,
    newRootPrivateKey: nextRoot.privateKey,
    newRootPublicKey: nextRoot.publicKey,
    epoch: nextEpoch,
    now,
  });
  /** @type {DeviceRegistry} */
  const nextReg = {
    version: 1,
    epoch: nextEpoch,
    updatedAt: now.toISOString(),
    rootHistory: [...(loaded.registry.rootHistory ?? []), rotation],
    devices: loaded.registry.devices,
  };
  const sig = signRegistry(
    nextReg,
    nextRoot.privateKey,
    nextRoot.publicKey,
    now
  );
  writeJson(path.join(vDir, DEVICES_FILE), nextReg);
  writeJson(path.join(vDir, DEVICES_SIG_FILE), sig);
  gitCommitAndPush(
    run,
    vDir,
    `chore(sync): rotate root key (${nextRoot.fingerprint})`
  );

  writeJson(configFile(rootDir), {
    ...config,
    rootPublicKey: nextRoot.publicKey,
  });
  writeJson(
    identityFile(rootDir),
    { ...identity, rootPrivateKey: nextRoot.privateKey },
    true
  );

  return {
    previousFingerprint: keyFingerprint(oldPub),
    rootPublicKey: nextRoot.publicKey,
    rootFingerprint: nextRoot.fingerprint,
    epoch: nextEpoch,
  };
}

/**
 * Enroll a peer device's public bundle (`device-pub.json`) into the root-signed registry.
 *
 * @param {string} rootDir
 * @param {{
 *   pubkey: PublicDevice | string,
 *   name?: string,
 *   zone?: string,
 *   compartments?: string[],
 *   now?: Date,
 *   run?: Spawn,
 * }} options
 * @returns {{ device: PublicDevice, epoch: number }}
 */
export function enrollDevice(
  rootDir,
  { pubkey, name, zone, compartments, now = new Date(), run = crossSpawn() }
) {
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  if (!identity.rootPrivateKey) {
    throw new SyncError(
      'Only a machine holding the vault root signing key can enroll devices.',
      'Run pnpm sync device add on an owner machine (or import a root backup).'
    );
  }
  const rawPub =
    typeof pubkey === 'string'
      ? /** @type {PublicDevice} */ (JSON.parse(pubkey))
      : pubkey;
  if (
    !rawPub ||
    typeof rawPub.deviceId !== 'string' ||
    typeof rawPub.ed25519PublicKey !== 'string' ||
    typeof rawPub.x25519PublicKey !== 'string'
  ) {
    throw new SyncError('Invalid device public key bundle.');
  }
  const expectedDeviceId = sha256Hex(
    Buffer.from(rawPub.ed25519PublicKey, 'base64url')
  ).slice(0, 8);
  if (rawPub.deviceId !== expectedDeviceId) {
    throw new SyncError(
      `Device id "${rawPub.deviceId}" does not match ed25519PublicKey fingerprint "${expectedDeviceId}".`
    );
  }
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const loaded = loadVerifiedRegistry(rootDir, vDir, config);
  const reg = loaded.registry;
  /** @type {PublicDevice} */
  const device = {
    ...rawPub,
    name: name ?? rawPub.name,
    zone: zone ? assertZone(zone) : assertZone(rawPub.zone ?? 'personal'),
    compartments: normalizeCompartments(
      compartments ?? rawPub.compartments ?? ['personal']
    ),
    revokedAt: null,
  };
  const nextDevices = reg.devices.filter((d) => d.deviceId !== device.deviceId);
  nextDevices.push(device);
  /** @type {DeviceRegistry} */
  const nextReg = {
    version: 1,
    epoch: reg.epoch + 1,
    updatedAt: now.toISOString(),
    rootHistory: reg.rootHistory ?? [],
    devices: nextDevices,
  };
  const sig = signRegistry(
    nextReg,
    identity.rootPrivateKey,
    loaded.rootPublicKey,
    now
  );
  writeJson(path.join(vDir, DEVICES_FILE), nextReg);
  writeJson(path.join(vDir, DEVICES_SIG_FILE), sig);
  gitCommitAndPush(run, vDir, `chore(sync): enroll device ${device.deviceId}`);
  return { device, epoch: nextReg.epoch };
}

/**
 * Revoke a device in the root-signed registry so future encrypted batches
 * exclude its X25519 key and peers reject batches signed after revocation.
 *
 * @param {string} rootDir
 * @param {string} targetDeviceId
 * @param {{ now?: Date, run?: Spawn }} [options]
 */
export function revokeDevice(
  rootDir,
  targetDeviceId,
  { now = new Date(), run = crossSpawn() } = {}
) {
  const config = readSyncConfig(rootDir);
  const identity = readIdentity(rootDir);
  if (!identity.rootPrivateKey) {
    throw new SyncError(
      'Only a machine holding the vault root signing key can revoke devices.',
      'Run pnpm sync device revoke on an owner machine (or import a root backup).'
    );
  }
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const loaded = loadVerifiedRegistry(rootDir, vDir, config);
  const reg = loaded.registry;
  const target = reg.devices.find((d) => d.deviceId === targetDeviceId);
  if (!target) {
    throw new SyncError(
      `Unknown device "${targetDeviceId}".`,
      'Run pnpm sync device list'
    );
  }
  const revokedAt = now.toISOString();
  const nextDevices = reg.devices.map((d) =>
    d.deviceId === targetDeviceId ? { ...d, revokedAt } : d
  );
  /** @type {DeviceRegistry} */
  const nextReg = {
    version: 1,
    epoch: reg.epoch + 1,
    updatedAt: revokedAt,
    rootHistory: reg.rootHistory ?? [],
    devices: nextDevices,
  };
  const sig = signRegistry(
    nextReg,
    identity.rootPrivateKey,
    loaded.rootPublicKey,
    now
  );
  writeJson(path.join(vDir, DEVICES_FILE), nextReg);
  writeJson(path.join(vDir, DEVICES_SIG_FILE), sig);
  gitCommitAndPush(run, vDir, `chore(sync): revoke device ${targetDeviceId}`);
  return { deviceId: targetDeviceId, revokedAt, epoch: nextReg.epoch };
}

/**
 * Map a legacy local id (`m1`, `t2`) to a collision-free v2 id (`m-<dev4>-1`)
 * for cross-machine sync while leaving v2 ids untouched.
 *
 * @param {string} id
 * @param {string} dev4
 * @returns {string}
 */
function exportNoteId(id, dev4) {
  const match = LEGACY_ID_RE.exec(id);
  return match ? `${match[1]}-${dev4}-${match[2]}` : id;
}

/**
 * @param {string} rootDir
 * @param {SyncConfig} config
 * @param {SyncCursors} cursors
 * @param {Date} [now]
 */
function collectOutgoing(rootDir, config, cursors, now = new Date()) {
  const memDir = memoryDir(rootDir);
  const { ops } = readLog(memDir);
  const dev4 = config.deviceId.slice(0, 4);
  const repoId = repoIdentity(rootDir);

  let currentHlc = cursors.lastHlc;
  const logMaxHlc = maxHlcFromOps(ops);
  if (logMaxHlc && (!currentHlc || compareHlc(logMaxHlc, currentHlc) > 0)) {
    currentHlc = logMaxHlc;
  }

  /** @type {Map<string, string>} */
  const scopeById = new Map();
  /** @type {Map<string, string | null>} */
  const repoById = new Map();
  /** @type {Set<string>} */
  const exportedIds = new Set();
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op.op === 'add' && typeof op.note?.id === 'string') {
      const s = String(op.note.scope ?? 'machine');
      scopeById.set(op.note.id, s);
      repoById.set(
        op.note.id,
        typeof op.note.repo === 'string' ? op.note.repo : null
      );
      if (
        s !== 'machine' &&
        (i < cursors.pushedLogOps || typeof op.syncedAt === 'string')
      ) {
        exportedIds.add(op.note.id);
      }
    } else if (op.op === 'update' && typeof op.id === 'string' && op.set) {
      if (typeof op.set.scope === 'string') scopeById.set(op.id, op.set.scope);
      if (op.set.repo !== undefined) {
        repoById.set(
          op.id,
          typeof op.set.repo === 'string' ? op.set.repo : null
        );
      }
    }
  }
  const activeNoteById = new Map(
    loadNotes(memDir).notes.map((note) => [note.id, note])
  );

  /** @type {Record<Compartment, { ops: Op[], personalization?: unknown, personas?: Record<string, string> }>} */
  const byComp = {
    personal: { ops: [] },
    'home-private': { ops: [] },
    work: { ops: [] },
  };
  const newOps = ops.slice(cursors.pushedLogOps);
  newOps.forEach((op, offset) => {
    // Do not re-export ops that arrived via remote sync pull.
    if (typeof op.syncedAt === 'string') return;
    const rawId = op.op === 'add' ? /** @type {string} */ (op.note?.id) : op.id;
    if (typeof rawId !== 'string') return;
    const scope = scopeById.get(rawId);
    // Plane 3: machine-scoped notes never leave the machine.
    if (!scope || scope === 'machine') return;
    const repo = repoById.get(rawId) ?? null;
    if (
      scope === 'repo' &&
      config.repoAllowlist.length > 0 &&
      (!repo || !config.repoAllowlist.includes(repo))
    ) {
      return;
    }

    /** @type {Compartment} */
    let targetComp;
    if (scope === 'user') {
      targetComp =
        config.zone === 'work' && config.compartments.includes('work')
          ? 'work'
          : 'personal';
    } else {
      targetComp =
        config.zone === 'work' && config.compartments.includes('work')
          ? 'work'
          : 'home-private';
    }
    if (!config.compartments.includes(targetComp)) return;

    const lineIdx = cursors.pushedLogOps + offset;
    const mappedId = exportNoteId(rawId, dev4);
    const opId =
      typeof op.opId === 'string' && op.opId
        ? op.opId
        : `${config.deviceId}-l${lineIdx}`;
    const parsedOpHlc = parseHlc(op.hlc);
    /** @type {string} */
    let opHlc;
    if (parsedOpHlc) {
      opHlc =
        parsedOpHlc.node === 'local'
          ? formatHlc(parsedOpHlc.ms, parsedOpHlc.counter, config.deviceId)
          : /** @type {string} */ (op.hlc);
      if (!currentHlc || compareHlc(opHlc, currentHlc) > 0) {
        currentHlc = opHlc;
      }
    } else {
      const opMs = Date.parse(op.at);
      currentHlc = nextHlc(
        currentHlc,
        Number.isFinite(opMs) ? opMs : now.getTime(),
        config.deviceId
      );
      opHlc = currentHlc;
    }

    if (op.op === 'add' && op.note) {
      if (op.note.scope === 'machine') return;
      exportedIds.add(rawId);
      byComp[targetComp].ops.push({
        ...op,
        opId,
        device: op.device ?? config.deviceId,
        hlc: opHlc,
        note: {
          ...op.note,
          id: mappedId,
          ...(scope === 'repo' && repoId?.name === repo && repoId.hash
            ? { repoHash: repoId.hash }
            : {}),
        },
      });
      return;
    }

    // If a note was promoted from machine -> user/repo after initial creation,
    // synthesize its full `add` op so peers receive a valid complete note.
    if (!exportedIds.has(rawId)) {
      const current = activeNoteById.get(rawId);
      if (!current || current.status === 'deleted') return;
      exportedIds.add(rawId);
      byComp[targetComp].ops.push({
        op: 'add',
        at: op.at,
        opId,
        device: config.deviceId,
        hlc: opHlc,
        note: {
          id: mappedId,
          text: current.text,
          scope: current.scope,
          repo: current.repo,
          type: current.type,
          tags: current.tags,
          triggers: current.triggers,
          source: current.source,
          pinned: current.pinned,
          supersedes: current.supersedes,
          ...(current.checked === null ? { checked: null } : {}),
          ...(scope === 'repo' && repoId?.name === repo && repoId.hash
            ? { repoHash: repoId.hash }
            : {}),
        },
      });
      return;
    }

    byComp[targetComp].ops.push({
      ...op,
      opId,
      device: op.device ?? config.deviceId,
      hlc: opHlc,
      id: mappedId,
    });
  });

  /** @type {Record<string, string>} */
  const nextArtifacts = { ...cursors.pushedArtifacts };
  if (config.compartments.includes('personal')) {
    const persFile = path.join(memDir, 'personalization.json');
    const persRaw = readIfExists(persFile);
    if (persRaw !== null) {
      const secrets = findSecrets(persRaw);
      if (secrets.length > 0) {
        throw new SyncError(
          `Refused to sync personalization.json: matches secret rule (${secrets.join(', ')}).`
        );
      }
      const parsed = normalizePersonalization(JSON.parse(persRaw));
      const digest = sha256Hex(persRaw);
      if (nextArtifacts.personalization !== digest) {
        byComp.personal.personalization = parsed;
        nextArtifacts.personalization = digest;
      }
    }
    /** @type {Record<string, string>} */
    const changedPersonas = {};
    for (const key of PERSONA_KEYS) {
      const file = path.join(memDir, agentPersonaFile(key));
      const raw = readIfExists(file);
      if (raw === null || !personaFromMarkdown(raw)) continue;
      const secrets = findSecrets(raw);
      if (secrets.length > 0) {
        throw new SyncError(
          `Refused to sync ${agentPersonaFile(key)}: matches secret rule (${secrets.join(', ')}).`
        );
      }
      const digest = sha256Hex(raw);
      if (nextArtifacts[`persona:${key}`] !== digest) {
        changedPersonas[key] = raw;
        nextArtifacts[`persona:${key}`] = digest;
      }
    }
    if (Object.keys(changedPersonas).length > 0) {
      byComp.personal.personas = changedPersonas;
    }
  }

  return {
    byComp,
    nextLogOps: ops.length,
    nextArtifacts,
    nextLastHlc: currentHlc,
  };
}

/**
 * Encrypt and push Plane 2 memory/persona changes to the E2EE Git vault.
 * Refuses in `off` or `receive` mode.
 *
 * @param {string} rootDir
 * @param {{ dryRun?: boolean, now?: Date, run?: Spawn }} [options]
 */
export function pushSync(
  rootDir,
  { dryRun = false, now = new Date(), run = crossSpawn() } = {}
) {
  const config = readSyncConfig(rootDir);
  if (config.mode === 'off') {
    throw new SyncError(
      'Sync is currently off on this machine.',
      'Run pnpm sync mode full'
    );
  }
  if (config.mode === 'receive') {
    throw new SyncError(
      'This machine is in receive-only sync mode and cannot push.',
      'Switch to full mode only on trusted personal machines: pnpm sync mode full'
    );
  }
  const identity = readIdentity(rootDir);
  const cursors = readCursors(rootDir);
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const { registry } = loadVerifiedRegistry(rootDir, vDir, config);
  const me = registry.devices.find((d) => d.deviceId === config.deviceId);
  if (!me || me.revokedAt) {
    throw new SyncError(
      `This device (${config.deviceId}) is missing or revoked in the vault registry.`
    );
  }

  const { byComp, nextLogOps, nextArtifacts, nextLastHlc } = collectOutgoing(
    rootDir,
    config,
    cursors,
    now
  );

  /** @type {{ compartment: Compartment, seq: number, ops: number, hasPersonalization: boolean, personas: string[], recipients: string[] }[]} */
  const batches = [];
  /** @type {Record<string, StreamCursor>} */
  const nextPushed = { ...cursors.pushed };

  for (const comp of /** @type {Compartment[]} */ (Object.keys(byComp))) {
    const payload = byComp[comp];
    const hasChanges =
      payload.ops.length > 0 ||
      payload.personalization !== undefined ||
      payload.personas !== undefined;
    if (!hasChanges) continue;

    const recipients = registry.devices.filter(
      (d) => !d.revokedAt && d.compartments.includes(comp)
    );
    if (recipients.length === 0) continue;

    const prev = nextPushed[comp] ?? { seq: 0, lastHash: GENESIS_HASH };
    const seq = prev.seq + 1;
    const header = {
      version: 1,
      deviceId: config.deviceId,
      compartment: comp,
      epoch: registry.epoch,
      seq,
      prevHash: prev.lastHash,
      createdAt: now.toISOString(),
    };
    const envelope = encryptBatch({
      payload,
      header,
      recipients: recipients.map((r) => ({
        deviceId: r.deviceId,
        x25519PublicKey: r.x25519PublicKey,
      })),
      authorPrivateKey: identity.ed25519PrivateKey,
    });
    if (!dryRun) {
      const file = path.join(
        vDir,
        OPS_DIR,
        config.deviceId,
        `${String(seq).padStart(6, '0')}-${comp}.enc.json`
      );
      writeJson(file, envelope);
    }
    nextPushed[comp] = { seq, lastHash: envelope.batchHash };
    batches.push({
      compartment: comp,
      seq,
      ops: payload.ops.length,
      hasPersonalization: payload.personalization !== undefined,
      personas: Object.keys(payload.personas ?? {}),
      recipients: recipients.map((r) => r.deviceId),
    });
  }

  if (!dryRun && batches.length > 0) {
    gitCommitAndPush(
      run,
      vDir,
      `chore(sync): push ${batches.length} batch(es) from ${config.deviceId}`
    );
    writeJson(cursorsFile(rootDir), {
      ...cursors,
      pushedLogOps: nextLogOps,
      lastHlc: nextLastHlc,
      pushedArtifacts: nextArtifacts,
      pushed: nextPushed,
    });
  }

  return {
    dryRun,
    deviceId: config.deviceId,
    batches,
  };
}

/**
 * Pull, verify, decrypt, and quarantine-filter remote vault batches into local memory.
 * Works in both `full` and `receive` modes.
 *
 * @param {string} rootDir
 * @param {{ dryRun?: boolean, now?: Date, run?: Spawn }} [options]
 */
export function pullSync(
  rootDir,
  { dryRun = false, now = new Date(), run = crossSpawn() } = {}
) {
  const config = readSyncConfig(rootDir);
  if (config.mode === 'off') {
    throw new SyncError(
      'Sync is currently off on this machine.',
      'Run pnpm sync mode receive (or full)'
    );
  }
  const identity = readIdentity(rootDir);
  const cursors = readCursors(rootDir);
  const vDir = vaultDir(rootDir);
  gitPullIfReady(run, vDir);
  const { registry } = loadVerifiedRegistry(rootDir, vDir, config);
  const deviceMap = new Map(registry.devices.map((d) => [d.deviceId, d]));

  const opsRoot = path.join(vDir, OPS_DIR);
  const peerDirs = fs.existsSync(opsRoot)
    ? fs
        .readdirSync(opsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== config.deviceId)
        .map((d) => d.name)
        .sort()
    : [];

  /** @type {Op[]} */
  const safeOps = [];
  /** @type {Record<string, unknown>[]} */
  const quarantined = [];
  let refused = 0;
  /** @type {string[]} */
  const skippedCompartments = [];
  /** @type {string[]} */
  const peersPulled = [];
  /** @type {unknown} */
  let nextPersonalization = null;
  /** @type {Record<string, string>} */
  const nextPersonas = {};
  /** @type {Record<string, StreamCursor>} */
  const nextPulled = { ...cursors.pulled };
  let batchesDecrypted = 0;

  for (const peerId of peerDirs) {
    const author = deviceMap.get(peerId);
    if (!author) {
      throw new SyncError(`Unknown peer device "${peerId}" in vault ops/.`);
    }
    const peerDir = path.join(opsRoot, peerId);
    /** @type {Map<string, { seq: number, file: string }[]>} */
    const streams = new Map();
    for (const fileName of fs.readdirSync(peerDir)) {
      const m = BATCH_FILE_RE.exec(fileName);
      if (!m) continue;
      const seq = Number(m[1]);
      const comp = m[2];
      const list = streams.get(comp) ?? [];
      list.push({ seq, file: path.join(peerDir, fileName) });
      streams.set(comp, list);
    }

    for (const [comp, items] of [...streams.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      items.sort((a, b) => a.seq - b.seq);
      const streamKey = `${peerId}:${comp}`;
      const cursor = nextPulled[streamKey] ?? {
        seq: 0,
        lastHash: GENESIS_HASH,
      };
      for (const item of items) {
        if (item.seq <= cursor.seq) continue;
        if (item.seq !== cursor.seq + 1) {
          throw new SyncError(
            `Missing batch seq ${cursor.seq + 1} in stream ${streamKey} (found ${item.seq}).`
          );
        }
        const envelope = /** @type {any} */ (readJsonOrNull(item.file));
        if (author.revokedAt) {
          throw new SyncError(
            `Refused batch ${item.seq} from revoked device ${peerId} (revoked ${author.revokedAt}).`
          );
        }

        let decrypted;
        try {
          decrypted = decryptBatch({
            envelope,
            recipientDeviceId: config.deviceId,
            recipientX25519PrivateKey: identity.x25519PrivateKey,
            authorEd25519PublicKey: author.ed25519PublicKey,
            expectedPrevHash: cursor.lastHash,
          });
        } catch (error) {
          if (error instanceof SyncCryptoError && error.code === 'no-access') {
            if (!skippedCompartments.includes(streamKey)) {
              skippedCompartments.push(streamKey);
            }
            // Advance hash-less sequence cursor? No: stop processing this unreadable stream.
            break;
          }
          throw error;
        }
        if (
          decrypted.header.deviceId !== peerId ||
          decrypted.header.compartment !== comp ||
          decrypted.header.seq !== item.seq
        ) {
          throw new SyncError(
            `Batch header (${decrypted.header.deviceId}/${decrypted.header.compartment}#${decrypted.header.seq}) does not match vault path (${peerId}/${comp}#${item.seq}).`
          );
        }

        cursor.seq = item.seq;
        cursor.lastHash = decrypted.batchHash;
        nextPulled[streamKey] = { ...cursor };
        batchesDecrypted += 1;
        if (!peersPulled.includes(peerId)) peersPulled.push(peerId);

        const payload = /** @type {Record<string, any>} */ (
          decrypted.payload ?? {}
        );
        for (const op of Array.isArray(payload.ops) ? payload.ops : []) {
          if (!op || typeof op !== 'object') continue;
          const scope = op.op === 'add' ? op.note?.scope : op.set?.scope;
          if (scope === 'machine') {
            refused += 1;
            continue;
          }
          if (op.op === 'add' && op.note) {
            try {
              const fields = normalizeInput({
                ...op.note,
                unchecked: op.note.checked === null,
              });
              assertNoSecrets(fields);
              if (looksLikeInstruction(fields.text)) {
                quarantined.push({
                  at: op.at ?? now.toISOString(),
                  op: 'add',
                  id: op.note.id,
                  note: op.note,
                  reason: `sync: looks like an instruction (from ${peerId})`,
                });
                continue;
              }
              safeOps.push(op);
            } catch (error) {
              if (error instanceof MemoryError && error.code === 'secret') {
                refused += 1;
              }
            }
          } else if (op.op === 'update' && op.set) {
            const texts = [
              ...(typeof op.set.text === 'string' ? [op.set.text] : []),
              ...(Array.isArray(op.set.tags) ? op.set.tags : []),
              ...(Array.isArray(op.set.triggers) ? op.set.triggers : []),
            ].map(String);
            if (texts.some((t) => findSecrets(t).length > 0)) {
              refused += 1;
              continue;
            }
            if (
              typeof op.set.text === 'string' &&
              looksLikeInstruction(op.set.text)
            ) {
              quarantined.push({
                at: op.at ?? now.toISOString(),
                op: 'update',
                id: op.id,
                changes: op.set,
                reason: `sync: looks like an instruction (from ${peerId})`,
              });
              continue;
            }
            safeOps.push(op);
          } else {
            safeOps.push(op);
          }
        }

        if (payload.personalization !== undefined) {
          try {
            const candidate = normalizePersonalization(payload.personalization);
            const personaHits = candidate.persona
              ? injectionsIn(candidate.persona)
              : [];
            const otherTexts = [
              candidate.callMe,
              candidate.aboutMe,
              candidate.language,
              candidate.tone,
              candidate.extra,
              ...(candidate.traits ?? []),
            ].filter((v) => typeof v === 'string');
            const instructionHit = otherTexts.some((t) =>
              looksLikeInstruction(t)
            );
            if (personaHits.length > 0 || instructionHit) {
              quarantined.push({
                at: decrypted.header.createdAt,
                op: 'personalization',
                id: 'personalization',
                changes: candidate,
                reason: `sync: personalization looks like an instruction/override (${personaHits.join(', ') || 'instruction'}) from ${peerId}`,
              });
            } else {
              nextPersonalization = candidate;
            }
          } catch {
            refused += 1;
          }
        }
        if (payload.personas && typeof payload.personas === 'object') {
          for (const [key, rawText] of Object.entries(payload.personas)) {
            if (
              !PERSONA_KEYS.includes(/** @type {any} */ (key)) ||
              typeof rawText !== 'string'
            ) {
              continue;
            }
            if (findSecrets(rawText).length > 0) {
              refused += 1;
              continue;
            }
            const injections = injectionsIn(rawText);
            if (injections.length > 0) {
              quarantined.push({
                at: decrypted.header.createdAt,
                op: 'persona',
                id: key,
                changes: { text: rawText },
                reason: `sync: persona override (${injections.join(', ')}) from ${peerId}`,
              });
              continue;
            }
            nextPersonas[key] = rawText;
          }
        }
      }
    }
  }

  const memDir = memoryDir(rootDir);
  /** @type {import('../memory/personalize.js').Personalization | null} */
  let mergedPersonalization = null;
  /** @type {string[]} */
  const preWarnings = [];
  if (nextPersonalization !== null) {
    let local = {};
    try {
      local = readPersonalization(memDir);
    } catch {
      // broken local personalization is replaced
    }
    try {
      mergedPersonalization = normalizePersonalization({
        ...local,
        .../** @type {object} */ (nextPersonalization),
      });
    } catch (error) {
      preWarnings.push(
        `Skipped synced personalization: ${/** @type {Error} */ (error).message}`
      );
    }
  }

  const willPersonalize = mergedPersonalization !== null;
  const personaKeys = Object.keys(nextPersonas);
  const storeWillChange =
    safeOps.length > 0 || willPersonalize || personaKeys.length > 0;

  if (dryRun) {
    return {
      dryRun: true,
      batchesDecrypted,
      opsToApply: safeOps.length,
      applied: 0,
      quarantined: quarantined.length,
      refused,
      skippedCompartments,
      personalizationUpdated: willPersonalize,
      personasUpdated: personaKeys,
      snapshot: null,
      warnings: preWarnings,
    };
  }

  let snapshot = null;
  if (storeWillChange) {
    snapshot = takeSnapshot(rootDir, {
      reason: 'sync',
      now,
      detail: peersPulled.length
        ? `pull from ${peersPulled.join(', ')}`
        : 'sync pull',
      importedPersonas: personaKeys,
    }).id;
  }

  let applied = 0;
  let skippedOps = 0;
  if (safeOps.length > 0) {
    const merged = mergeSyncedOps(memDir, safeOps, { now });
    applied = merged.applied;
    skippedOps = merged.skipped;
    refused += merged.refused;
  }
  if (mergedPersonalization !== null) {
    const before = storedPersona(memDir);
    const written = writePersonalization(memDir, mergedPersonalization);
    if (written.persona !== before) {
      syncPersonaFile(memDir, written.persona);
    }
  }
  for (const key of personaKeys) {
    writeFileAtomic(
      path.join(memDir, agentPersonaFile(/** @type {any} */ (key))),
      nextPersonas[key]
    );
  }
  if (quarantined.length > 0) {
    appendInbox(memDir, quarantined);
  }
  const warnings = [
    ...preWarnings,
    ...(storeWillChange ? refreshAfterWrite(rootDir) : []),
  ];
  let nextLastHlc = cursors.lastHlc;
  const pulledMaxHlc = maxHlcFromOps(safeOps);
  if (
    pulledMaxHlc &&
    (!nextLastHlc || compareHlc(pulledMaxHlc, nextLastHlc) > 0)
  ) {
    nextLastHlc = pulledMaxHlc;
  }
  writeJson(cursorsFile(rootDir), {
    ...cursors,
    lastHlc: nextLastHlc,
    pulled: nextPulled,
  });

  return {
    dryRun: false,
    batchesDecrypted,
    opsToApply: safeOps.length,
    applied,
    skippedOps,
    quarantined: quarantined.length,
    refused,
    skippedCompartments,
    personalizationUpdated: willPersonalize,
    personasUpdated: personaKeys,
    snapshot,
    warnings,
  };
}
