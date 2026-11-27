/**
 * Zero-dependency E2EE vault cryptography using Node.js 24 native `node:crypto`:
 * - Ed25519 signatures for device identity, registry integrity, and batch auth
 * - SHA-256 hash chain (`prevHash` -> `batchHash`) against rollback/truncation
 * - Ephemeral X25519 + HKDF-SHA256 + ChaCha20-Poly1305 multi-recipient envelopes
 */
import crypto from 'node:crypto';

export const VAULT_CRYPTO_VERSION = 1;
export const GENESIS_HASH = '0'.repeat(64);
export const ROOT_BACKUP_TYPE = 'kyoten-vault-root-backup';
const CEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 67_108_864;

/**
 * @typedef {'invalid' | 'signature' | 'chain' | 'no-access' | 'decrypt'} SyncCryptoCode
 *
 * @typedef {object} PublicDevice
 * @property {string} deviceId
 * @property {string} name
 * @property {'personal' | 'work'} zone
 * @property {string[]} compartments
 * @property {string} ed25519PublicKey
 * @property {string} x25519PublicKey
 * @property {string} fingerprint
 * @property {string} createdAt
 * @property {string | null} revokedAt
 *
 * @typedef {object} DevicePrivateKeys
 * @property {string} ed25519PrivateKey
 * @property {string} x25519PrivateKey
 *
 * @typedef {object} BatchHeader
 * @property {number} version
 * @property {string} deviceId
 * @property {string} compartment
 * @property {number} epoch
 * @property {number} seq
 * @property {string} prevHash
 * @property {string} createdAt
 *
 * @typedef {{ deviceId: string, x25519PublicKey: string }} RecipientKey
 *
 * @typedef {object} WrappedRecipient
 * @property {string} deviceId
 * @property {string} ephemeralPublicKey
 * @property {string} nonce
 * @property {string} wrappedKey
 * @property {string} tag
 *
 * @typedef {{
 *   version: number,
 *   type: string,
 *   kdf: 'scrypt',
 *   kdfParams: { N: number, r: number, p: number },
 *   salt: string,
 *   nonce: string,
 *   rootPublicKey: string,
 *   rootFingerprint: string,
 *   createdAt: string,
 *   ciphertext: string,
 *   tag: string,
 * }} EncryptedRootBackup
 *
 * @typedef {{
 *   fromRootPublicKey: string,
 *   toRootPublicKey: string,
 *   epoch: number,
 *   rotatedAt: string,
 *   signedByOld: string,
 *   signedByNew: string,
 * }} RootRotation
 *
 * @typedef {object} EncryptedBatch
 * @property {number} version
 * @property {BatchHeader} header
 * @property {string} bodyHash
 * @property {string} batchHash
 * @property {WrappedRecipient[]} recipients
 * @property {string} nonce
 * @property {string} ciphertext
 * @property {string} tag
 * @property {string} signature
 */

export class SyncCryptoError extends Error {
  /**
   * @param {SyncCryptoCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SyncCryptoError';
    this.code = code;
  }
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deterministic JSON serialization with sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(
      /** @type {Record<string, unknown>} */ (value)
    )
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {string | Buffer | Uint8Array} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** @param {string} str */
function decodeBase64Url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) {
    throw new SyncCryptoError('invalid', 'Expected base64url-encoded data.');
  }
  return Buffer.from(str, 'base64url');
}

/**
 * Generate a new device Ed25519 + X25519 identity.
 *
 * @param {{ name: string, zone?: 'personal' | 'work', compartments?: string[], now?: Date }} options
 * @returns {{ publicDevice: PublicDevice, privateKeys: DevicePrivateKeys }}
 */
export function generateDeviceIdentity({
  name,
  zone = 'personal',
  compartments = ['personal'],
  now = new Date(),
}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new SyncCryptoError('invalid', 'Device name must not be empty.');
  }
  const ed = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const x = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pubDigest = sha256Hex(ed.publicKey);
  return {
    publicDevice: {
      deviceId: pubDigest.slice(0, 8),
      name: name.trim(),
      zone,
      compartments: [...compartments],
      ed25519PublicKey: ed.publicKey.toString('base64url'),
      x25519PublicKey: x.publicKey.toString('base64url'),
      fingerprint: pubDigest.slice(0, 16),
      createdAt: now.toISOString(),
      revokedAt: null,
    },
    privateKeys: {
      ed25519PrivateKey: ed.privateKey.toString('base64url'),
      x25519PrivateKey: x.privateKey.toString('base64url'),
    },
  };
}

/**
 * Sign any JSON-serializable object with an Ed25519 PKCS8 private key.
 *
 * @param {unknown} obj
 * @param {string} ed25519PrivateKeyB64
 * @returns {string}
 */
export function signObject(obj, ed25519PrivateKeyB64) {
  const key = crypto.createPrivateKey({
    key: decodeBase64Url(ed25519PrivateKeyB64),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto
    .sign(null, Buffer.from(canonicalJson(obj), 'utf-8'), key)
    .toString('base64url');
}

/**
 * Verify an Ed25519 signature over `canonicalJson(obj)`. Returns false on any mismatch or malformed key.
 *
 * @param {unknown} obj
 * @param {string} signatureB64
 * @param {string} ed25519PublicKeyB64
 * @returns {boolean}
 */
export function verifyObject(obj, signatureB64, ed25519PublicKeyB64) {
  try {
    const key = crypto.createPublicKey({
      key: decodeBase64Url(ed25519PublicKeyB64),
      format: 'der',
      type: 'spki',
    });
    const sig = decodeBase64Url(signatureB64);
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(obj), 'utf-8'),
      key,
      sig
    );
  } catch {
    return false;
  }
}

/**
 * @param {unknown} header
 * @returns {BatchHeader}
 */
function validateHeader(header) {
  if (!isObject(header)) {
    throw new SyncCryptoError('invalid', 'Batch header must be an object.');
  }
  const h = /** @type {Record<string, unknown>} */ (header);
  if (h.version !== VAULT_CRYPTO_VERSION) {
    throw new SyncCryptoError(
      'invalid',
      `Unsupported batch version ${String(h.version)}.`
    );
  }
  if (
    typeof h.deviceId !== 'string' ||
    !h.deviceId ||
    typeof h.compartment !== 'string' ||
    !h.compartment ||
    typeof h.createdAt !== 'string' ||
    !h.createdAt
  ) {
    throw new SyncCryptoError(
      'invalid',
      'Batch header is missing required fields.'
    );
  }
  if (!Number.isInteger(h.epoch) || /** @type {number} */ (h.epoch) < 1) {
    throw new SyncCryptoError(
      'invalid',
      'Batch epoch must be a positive integer.'
    );
  }
  if (!Number.isInteger(h.seq) || /** @type {number} */ (h.seq) < 1) {
    throw new SyncCryptoError(
      'invalid',
      'Batch seq must be a positive integer.'
    );
  }
  if (typeof h.prevHash !== 'string' || !HEX64_RE.test(h.prevHash)) {
    throw new SyncCryptoError(
      'invalid',
      'Batch prevHash must be a 64-char hex digest.'
    );
  }
  return /** @type {BatchHeader} */ (header);
}

/**
 * Derive a 32-byte key-wrapping key using X25519 ECDH + HKDF-SHA256.
 *
 * @param {crypto.KeyObject} privateKey
 * @param {crypto.KeyObject} publicKey
 * @param {string} senderDeviceId
 * @param {string} recipientDeviceId
 * @param {string} compartment
 * @returns {Buffer}
 */
function deriveWrapKey(
  privateKey,
  publicKey,
  senderDeviceId,
  recipientDeviceId,
  compartment
) {
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  const raw = crypto.hkdfSync(
    'sha256',
    shared,
    Buffer.from(`${senderDeviceId}:${recipientDeviceId}`, 'utf-8'),
    Buffer.from(`kyoten-vault-v1-wrap:${compartment}`, 'utf-8'),
    CEK_BYTES
  );
  return Buffer.from(raw);
}

/**
 * Encrypt and sign an op-log/config batch for one or more authorized devices.
 *
 * @param {{ payload: unknown, header: BatchHeader, recipients: RecipientKey[], authorPrivateKey: string }} input
 * @returns {EncryptedBatch}
 */
export function encryptBatch({
  payload,
  header,
  recipients,
  authorPrivateKey,
}) {
  const validHeader = validateHeader(header);
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new SyncCryptoError(
      'invalid',
      'At least one authorized recipient is required to encrypt a batch.'
    );
  }
  const cek = crypto.randomBytes(CEK_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const headerAad = Buffer.from(canonicalJson(validHeader), 'utf-8');
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');

  const cipher = /** @type {crypto.CipherGCM} */ (
    crypto.createCipheriv('chacha20-poly1305', cek, nonce, {
      authTagLength: TAG_BYTES,
    })
  );
  cipher.setAAD(headerAad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  /** @type {WrappedRecipient[]} */
  const wrappedRecipients = recipients.map((recipient) => {
    const recipPub = crypto.createPublicKey({
      key: decodeBase64Url(recipient.x25519PublicKey),
      format: 'der',
      type: 'spki',
    });
    const eph = crypto.generateKeyPairSync('x25519');
    const ephPubDer = eph.publicKey.export({ type: 'spki', format: 'der' });
    const wrapKey = deriveWrapKey(
      eph.privateKey,
      recipPub,
      validHeader.deviceId,
      recipient.deviceId,
      validHeader.compartment
    );
    const wrapNonce = crypto.randomBytes(NONCE_BYTES);
    const wrapCipher = /** @type {crypto.CipherGCM} */ (
      crypto.createCipheriv('chacha20-poly1305', wrapKey, wrapNonce, {
        authTagLength: TAG_BYTES,
      })
    );
    wrapCipher.setAAD(
      Buffer.from(`${recipient.deviceId}:${validHeader.compartment}`, 'utf-8')
    );
    const wrappedKey = Buffer.concat([
      wrapCipher.update(cek),
      wrapCipher.final(),
    ]);
    const wrapTag = wrapCipher.getAuthTag();
    return {
      deviceId: recipient.deviceId,
      ephemeralPublicKey: ephPubDer.toString('base64url'),
      nonce: wrapNonce.toString('base64url'),
      wrappedKey: wrappedKey.toString('base64url'),
      tag: wrapTag.toString('base64url'),
    };
  });

  const bodyHash = sha256Hex(Buffer.concat([ciphertext, tag]));
  const signedBody = {
    header: validHeader,
    bodyHash,
    recipients: wrappedRecipients,
  };
  const batchHash = sha256Hex(canonicalJson(signedBody));
  const signature = signObject(signedBody, authorPrivateKey);

  return {
    version: VAULT_CRYPTO_VERSION,
    header: validHeader,
    bodyHash,
    batchHash,
    recipients: wrappedRecipients,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: tag.toString('base64url'),
    signature,
  };
}

/**
 * Verify signature, hash chain, and decrypt an encrypted batch for `recipientDeviceId`.
 * Fails closed before attempting decryption.
 *
 * @param {{
 *   envelope: unknown,
 *   recipientDeviceId: string,
 *   recipientX25519PrivateKey: string,
 *   authorEd25519PublicKey: string,
 *   expectedPrevHash?: string,
 * }} input
 * @returns {{ header: BatchHeader, payload: unknown, batchHash: string }}
 */
export function decryptBatch({
  envelope,
  recipientDeviceId,
  recipientX25519PrivateKey,
  authorEd25519PublicKey,
  expectedPrevHash,
}) {
  if (!isObject(envelope)) {
    throw new SyncCryptoError('invalid', 'Encrypted batch must be an object.');
  }
  const env = /** @type {Record<string, any>} */ (envelope);
  if (env.version !== VAULT_CRYPTO_VERSION) {
    throw new SyncCryptoError(
      'invalid',
      `Unsupported batch envelope version ${String(env.version)}.`
    );
  }
  const header = validateHeader(env.header);
  if (
    !Array.isArray(env.recipients) ||
    typeof env.bodyHash !== 'string' ||
    typeof env.batchHash !== 'string' ||
    typeof env.nonce !== 'string' ||
    typeof env.ciphertext !== 'string' ||
    typeof env.tag !== 'string' ||
    typeof env.signature !== 'string'
  ) {
    throw new SyncCryptoError('invalid', 'Encrypted batch is malformed.');
  }
  const ciphertext = decodeBase64Url(env.ciphertext);
  const tag = decodeBase64Url(env.tag);
  const nonce = decodeBase64Url(env.nonce);
  if (tag.length !== TAG_BYTES || nonce.length !== NONCE_BYTES) {
    throw new SyncCryptoError(
      'invalid',
      'Invalid batch nonce or auth tag size.'
    );
  }
  const actualBodyHash = sha256Hex(Buffer.concat([ciphertext, tag]));
  if (actualBodyHash !== env.bodyHash) {
    throw new SyncCryptoError('decrypt', 'Batch ciphertext digest mismatch.');
  }
  const signedBody = {
    header,
    bodyHash: env.bodyHash,
    recipients: env.recipients,
  };
  const actualBatchHash = sha256Hex(canonicalJson(signedBody));
  if (actualBatchHash !== env.batchHash) {
    throw new SyncCryptoError('decrypt', 'Batch envelope digest mismatch.');
  }
  if (!verifyObject(signedBody, env.signature, authorEd25519PublicKey)) {
    throw new SyncCryptoError(
      'signature',
      `Invalid Ed25519 signature on batch from device ${header.deviceId}.`
    );
  }
  if (expectedPrevHash !== undefined && header.prevHash !== expectedPrevHash) {
    throw new SyncCryptoError(
      'chain',
      `Hash chain mismatch for ${header.deviceId}/${header.compartment}: expected ${expectedPrevHash.slice(0, 12)}, got ${header.prevHash.slice(0, 12)}.`
    );
  }
  const entry = env.recipients.find(
    (/** @type {any} */ r) => r?.deviceId === recipientDeviceId
  );
  if (!entry) {
    throw new SyncCryptoError(
      'no-access',
      `Device ${recipientDeviceId} is not an authorized recipient for compartment "${header.compartment}".`
    );
  }
  let cek;
  try {
    const recipPriv = crypto.createPrivateKey({
      key: decodeBase64Url(recipientX25519PrivateKey),
      format: 'der',
      type: 'pkcs8',
    });
    const ephPub = crypto.createPublicKey({
      key: decodeBase64Url(entry.ephemeralPublicKey),
      format: 'der',
      type: 'spki',
    });
    const wrapKey = deriveWrapKey(
      recipPriv,
      ephPub,
      header.deviceId,
      recipientDeviceId,
      header.compartment
    );
    const wrapDecipher = /** @type {crypto.DecipherGCM} */ (
      crypto.createDecipheriv(
        'chacha20-poly1305',
        wrapKey,
        decodeBase64Url(entry.nonce),
        { authTagLength: TAG_BYTES }
      )
    );
    wrapDecipher.setAAD(
      Buffer.from(`${recipientDeviceId}:${header.compartment}`, 'utf-8')
    );
    wrapDecipher.setAuthTag(decodeBase64Url(entry.tag));
    cek = Buffer.concat([
      wrapDecipher.update(decodeBase64Url(entry.wrappedKey)),
      wrapDecipher.final(),
    ]);
  } catch {
    throw new SyncCryptoError(
      'decrypt',
      `Failed to unwrap compartment "${header.compartment}" key.`
    );
  }

  try {
    const decipher = /** @type {crypto.DecipherGCM} */ (
      crypto.createDecipheriv('chacha20-poly1305', cek, nonce, {
        authTagLength: TAG_BYTES,
      })
    );
    decipher.setAAD(Buffer.from(canonicalJson(header), 'utf-8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');
    return {
      header,
      payload: JSON.parse(plaintext),
      batchHash: actualBatchHash,
    };
  } catch {
    throw new SyncCryptoError(
      'decrypt',
      'Batch payload authentication failed.'
    );
  }
}

/**
 * Compute the 16-hex SHA-256 fingerprint of a base64url SPKI Ed25519 public key.
 *
 * @param {string} ed25519PublicKeyB64
 * @returns {string}
 */
export function keyFingerprint(ed25519PublicKeyB64) {
  return sha256Hex(decodeBase64Url(ed25519PublicKeyB64)).slice(0, 16);
}

/**
 * Derive the base64url SPKI Ed25519 public key from a PKCS8 private key.
 *
 * @param {string} ed25519PrivateKeyB64
 * @returns {string}
 */
export function deriveEd25519PublicKey(ed25519PrivateKeyB64) {
  const privKey = crypto.createPrivateKey({
    key: decodeBase64Url(ed25519PrivateKeyB64),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto
    .createPublicKey(privKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64url');
}

/**
 * Generate a dedicated vault root Ed25519 keypair, separate from device keys.
 *
 * @returns {{ publicKey: string, privateKey: string, fingerprint: string }}
 */
export function generateRootKeyPair() {
  const ed = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const publicKey = ed.publicKey.toString('base64url');
  return {
    publicKey,
    privateKey: ed.privateKey.toString('base64url'),
    fingerprint: sha256Hex(ed.publicKey).slice(0, 16),
  };
}

/**
 * Encrypt the vault root Ed25519 private key for offline disaster-recovery backup
 * using Node 24 `scrypt` + `chacha20-poly1305`.
 *
 * @param {{
 *   rootPrivateKey: string,
 *   rootPublicKey: string,
 *   passphrase: string,
 *   now?: Date,
 * }} input
 * @returns {EncryptedRootBackup}
 */
export function encryptRootKeyBackup({
  rootPrivateKey,
  rootPublicKey,
  passphrase,
  now = new Date(),
}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new SyncCryptoError(
      'invalid',
      'Backup passphrase must be at least 8 characters.'
    );
  }
  let derivedPub;
  try {
    derivedPub = deriveEd25519PublicKey(rootPrivateKey);
  } catch {
    throw new SyncCryptoError('invalid', 'Root private key is malformed.');
  }
  if (derivedPub !== rootPublicKey) {
    throw new SyncCryptoError(
      'invalid',
      'Root private key does not match rootPublicKey.'
    );
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const rootFingerprint = keyFingerprint(rootPublicKey);
  const kdfParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const key = crypto.scryptSync(passphrase, salt, CEK_BYTES, {
    ...kdfParams,
    maxmem: SCRYPT_MAXMEM,
  });

  const aad = {
    version: VAULT_CRYPTO_VERSION,
    type: ROOT_BACKUP_TYPE,
    kdf: /** @type {const} */ ('scrypt'),
    kdfParams,
    salt: salt.toString('base64url'),
    rootPublicKey,
    rootFingerprint,
  };
  const cipher = /** @type {crypto.CipherGCM} */ (
    crypto.createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: TAG_BYTES,
    })
  );
  cipher.setAAD(Buffer.from(canonicalJson(aad), 'utf-8'));
  const plaintext = Buffer.from(
    JSON.stringify({ rootPrivateKey, rootPublicKey }),
    'utf-8'
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ...aad,
    nonce: nonce.toString('base64url'),
    createdAt: now.toISOString(),
    ciphertext: ciphertext.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

/**
 * Decrypt an offline vault root key backup and verify key consistency.
 *
 * @param {{ backup: unknown, passphrase: string }} input
 * @returns {{ rootPrivateKey: string, rootPublicKey: string, rootFingerprint: string }}
 */
export function decryptRootKeyBackup({ backup, passphrase }) {
  if (!isObject(backup)) {
    throw new SyncCryptoError('invalid', 'Root key backup must be an object.');
  }
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new SyncCryptoError('invalid', 'Backup passphrase is required.');
  }
  const b = /** @type {Record<string, any>} */ (backup);
  if (
    b.version !== VAULT_CRYPTO_VERSION ||
    b.type !== ROOT_BACKUP_TYPE ||
    b.kdf !== 'scrypt' ||
    !isObject(b.kdfParams) ||
    typeof b.salt !== 'string' ||
    typeof b.nonce !== 'string' ||
    typeof b.rootPublicKey !== 'string' ||
    typeof b.ciphertext !== 'string' ||
    typeof b.tag !== 'string'
  ) {
    throw new SyncCryptoError('invalid', 'Root key backup format is invalid.');
  }
  const { N, r, p } = b.kdfParams;
  if (
    !Number.isInteger(N) ||
    N < 1024 ||
    N > 131072 ||
    (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 16 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4
  ) {
    throw new SyncCryptoError('invalid', 'Unsupported backup KDF parameters.');
  }
  const salt = decodeBase64Url(b.salt);
  const nonce = decodeBase64Url(b.nonce);
  const ciphertext = decodeBase64Url(b.ciphertext);
  const tag = decodeBase64Url(b.tag);
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new SyncCryptoError('invalid', 'Invalid backup nonce or auth tag.');
  }
  const expectedFingerprint = keyFingerprint(b.rootPublicKey);
  const key = crypto.scryptSync(passphrase, salt, CEK_BYTES, {
    N,
    r,
    p,
    maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r),
  });
  const aad = {
    version: VAULT_CRYPTO_VERSION,
    type: ROOT_BACKUP_TYPE,
    kdf: 'scrypt',
    kdfParams: { N, r, p },
    salt: b.salt,
    rootPublicKey: b.rootPublicKey,
    rootFingerprint:
      typeof b.rootFingerprint === 'string'
        ? b.rootFingerprint
        : expectedFingerprint,
  };

  try {
    const decipher = /** @type {crypto.DecipherGCM} */ (
      crypto.createDecipheriv('chacha20-poly1305', key, nonce, {
        authTagLength: TAG_BYTES,
      })
    );
    decipher.setAAD(Buffer.from(canonicalJson(aad), 'utf-8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');
    const parsed = JSON.parse(plain);
    if (
      typeof parsed?.rootPrivateKey !== 'string' ||
      parsed.rootPublicKey !== b.rootPublicKey ||
      deriveEd25519PublicKey(parsed.rootPrivateKey) !== b.rootPublicKey
    ) {
      throw new Error('Key mismatch');
    }
    return {
      rootPrivateKey: parsed.rootPrivateKey,
      rootPublicKey: b.rootPublicKey,
      rootFingerprint: expectedFingerprint,
    };
  } catch {
    throw new SyncCryptoError(
      'decrypt',
      'Failed to decrypt root key backup (wrong passphrase or corrupted file).'
    );
  }
}

/**
 * Create a dual-signed root key rotation record (`signedByOld` + `signedByNew`).
 *
 * @param {{
 *   oldRootPrivateKey: string,
 *   oldRootPublicKey: string,
 *   newRootPrivateKey: string,
 *   newRootPublicKey: string,
 *   epoch: number,
 *   now?: Date,
 * }} input
 * @returns {RootRotation}
 */
export function createRootRotation({
  oldRootPrivateKey,
  oldRootPublicKey,
  newRootPrivateKey,
  newRootPublicKey,
  epoch,
  now = new Date(),
}) {
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new SyncCryptoError('invalid', 'Rotation epoch must be positive.');
  }
  const body = {
    fromRootPublicKey: oldRootPublicKey,
    toRootPublicKey: newRootPublicKey,
    epoch,
    rotatedAt: now.toISOString(),
  };
  return {
    ...body,
    signedByOld: signObject(body, oldRootPrivateKey),
    signedByNew: signObject(body, newRootPrivateKey),
  };
}

/**
 * Sign a vault `devices.json` registry with the root Ed25519 key.
 *
 * @param {unknown} registry
 * @param {string} rootPrivateKey
 * @param {string} rootPublicKey
 * @param {Date} [now]
 * @returns {{ version: number, rootPublicKey: string, signedAt: string, signature: string }}
 */
export function signRegistry(
  registry,
  rootPrivateKey,
  rootPublicKey,
  now = new Date()
) {
  return {
    version: VAULT_CRYPTO_VERSION,
    rootPublicKey,
    signedAt: now.toISOString(),
    signature: signObject(registry, rootPrivateKey),
  };
}

/**
 * Verify `devices.json` + `devices.json.sig` against `pinnedRootPublicKey`,
 * following any valid dual-signed `rootHistory` rotation chain.
 *
 * @param {unknown} registry
 * @param {unknown} sigObj
 * @param {string} pinnedRootPublicKey
 * @returns {{ valid: boolean, currentRootPublicKey: string | null, rotated: boolean }}
 */
export function verifyRegistryChain(registry, sigObj, pinnedRootPublicKey) {
  if (!isObject(registry) || !isObject(sigObj)) {
    return { valid: false, currentRootPublicKey: null, rotated: false };
  }
  const sig = /** @type {Record<string, unknown>} */ (sigObj);
  if (
    sig.version !== VAULT_CRYPTO_VERSION ||
    typeof sig.rootPublicKey !== 'string' ||
    !sig.rootPublicKey ||
    typeof sig.signature !== 'string'
  ) {
    return { valid: false, currentRootPublicKey: null, rotated: false };
  }
  if (sig.rootPublicKey === pinnedRootPublicKey) {
    const valid = verifyObject(registry, sig.signature, pinnedRootPublicKey);
    return {
      valid,
      currentRootPublicKey: valid ? pinnedRootPublicKey : null,
      rotated: false,
    };
  }

  const history = /** @type {Record<string, unknown>} */ (registry).rootHistory;
  if (!Array.isArray(history) || history.length === 0) {
    return { valid: false, currentRootPublicKey: null, rotated: false };
  }

  const seenKeys = new Set([pinnedRootPublicKey]);
  let currentKey = pinnedRootPublicKey;
  let lastEpoch = 0;

  while (currentKey !== sig.rootPublicKey) {
    const link = history.find(
      (item) =>
        isObject(item) &&
        /** @type {Record<string, unknown>} */ (item).fromRootPublicKey ===
          currentKey
    );
    if (!link) {
      return { valid: false, currentRootPublicKey: null, rotated: false };
    }
    const r = /** @type {Record<string, unknown>} */ (link);
    if (
      typeof r.toRootPublicKey !== 'string' ||
      !r.toRootPublicKey ||
      seenKeys.has(r.toRootPublicKey) ||
      !Number.isInteger(r.epoch) ||
      /** @type {number} */ (r.epoch) <= lastEpoch ||
      typeof r.rotatedAt !== 'string' ||
      typeof r.signedByOld !== 'string' ||
      typeof r.signedByNew !== 'string'
    ) {
      return { valid: false, currentRootPublicKey: null, rotated: false };
    }
    const body = {
      fromRootPublicKey: r.fromRootPublicKey,
      toRootPublicKey: r.toRootPublicKey,
      epoch: r.epoch,
      rotatedAt: r.rotatedAt,
    };
    if (
      !verifyObject(body, r.signedByOld, currentKey) ||
      !verifyObject(body, r.signedByNew, r.toRootPublicKey)
    ) {
      return { valid: false, currentRootPublicKey: null, rotated: false };
    }
    seenKeys.add(r.toRootPublicKey);
    currentKey = r.toRootPublicKey;
    lastEpoch = /** @type {number} */ (r.epoch);
  }

  const valid = verifyObject(registry, sig.signature, currentKey);
  return {
    valid,
    currentRootPublicKey: valid ? currentKey : null,
    rotated: valid,
  };
}

/**
 * Verify a vault `devices.json` + `devices.json.sig` pair against the pinned root public key
 * (including any valid dual-signed rotation chain).
 *
 * @param {unknown} registry
 * @param {unknown} sigObj
 * @param {string} pinnedRootPublicKey
 * @returns {boolean}
 */
export function verifyRegistry(registry, sigObj, pinnedRootPublicKey) {
  return verifyRegistryChain(registry, sigObj, pinnedRootPublicKey).valid;
}
