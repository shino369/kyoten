/**
 * Zero-dependency RFC 8291 (`aes128gcm`) Web Push + RFC 8292 (VAPID ES256)
 * using Node.js 24 native `node:crypto` and `fetch`.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { redactSecrets } from '../redact.js';

export const MAX_PUSH_PLAINTEXT_BYTES = 3993;
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const AUTH_BYTES = 16;
const PUBKEY_BYTES = 65;

/**
 * @typedef {'invalid' | 'ssrf' | 'crypto' | 'http'} WebPushCode
 *
 * @typedef {{ publicKey: string, privateKey: string }} VapidKeyPair
 *
 * @typedef {object} PushSubscription
 * @property {string} id
 * @property {string} [label]
 * @property {string} endpoint
 * @property {{ p256dh: string, auth: string }} keys
 * @property {string} addedAt
 *
 * @typedef {object} AlertPayload
 * @property {string} title
 * @property {string} body
 * @property {string} tag
 * @property {string} event
 * @property {string} harness
 * @property {string} host
 * @property {string} timestamp
 */

export class WebPushError extends Error {
  /**
   * @param {WebPushCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WebPushError';
    this.code = code;
  }
}

/**
 * Generate a P-256 VAPID keypair (`publicKey`: 65-byte uncompressed base64url,
 * `privateKey`: PKCS8 DER base64url).
 *
 * @returns {VapidKeyPair}
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const uncompressed = publicKey.subarray(-PUBKEY_BYTES);
  if (uncompressed.length !== PUBKEY_BYTES || uncompressed[0] !== 0x04) {
    throw new WebPushError('crypto', 'Unexpected P-256 SPKI key format.');
  }
  return {
    publicKey: uncompressed.toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

/** @param {string} ip */
function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** @param {string} host */
function isPrivateHost(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal')
  ) {
    return true;
  }
  const ipVer = net.isIP(bare);
  if (ipVer === 4) return isPrivateIpv4(bare);
  if (ipVer === 6) {
    if (bare === '::1' || bare === '::') return true;
    if (bare.startsWith('::ffff:')) return isPrivateIpv4(bare.slice(7));
    if (/^(fc|fd|fe[89ab])/i.test(bare)) return true;
  }
  return false;
}

/**
 * Validate a Web Push endpoint URL against SSRF and plaintext-transport rules.
 *
 * @param {string} endpoint
 * @param {{ allowLocalhost?: boolean }} [options]
 * @returns {URL}
 */
export function validatePushEndpoint(
  endpoint,
  { allowLocalhost = false } = {}
) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebPushError('invalid', 'Push endpoint is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new WebPushError(
      'ssrf',
      'Push endpoint must not contain embedded credentials.'
    );
  }
  const isLoopbackHttp =
    allowLocalhost &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]');
  if (!isLoopbackHttp && url.protocol !== 'https:') {
    throw new WebPushError(
      'ssrf',
      `Push endpoint must use https:// (got ${url.protocol}).`
    );
  }
  if (!isLoopbackHttp && isPrivateHost(url.hostname)) {
    throw new WebPushError(
      'ssrf',
      `Refused private/loopback push endpoint host "${url.hostname}".`
    );
  }
  return url;
}

/**
 * Build an RFC 8292 VAPID `Authorization` header (`vapid t=<jwt>, k=<pub>`).
 *
 * @param {{
 *   endpoint: string,
 *   subject: string,
 *   publicKey: string,
 *   privateKey: string,
 *   expirationSec?: number,
 *   now?: Date,
 * }} input
 * @returns {string}
 */
export function createVapidAuthHeader({
  endpoint,
  subject,
  publicKey,
  privateKey,
  expirationSec = 43200,
  now = new Date(),
}) {
  const url = new URL(endpoint);
  const header = Buffer.from(
    JSON.stringify({ typ: 'JWT', alg: 'ES256' }),
    'utf-8'
  ).toString('base64url');
  const exp = Math.floor(now.getTime() / 1000) + expirationSec;
  const claims = Buffer.from(
    JSON.stringify({ aud: url.origin, exp, sub: subject }),
    'utf-8'
  ).toString('base64url');
  const signingInput = `${header}.${claims}`;

  const keyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto
    .sign('sha256', Buffer.from(signingInput, 'utf-8'), {
      key: keyObj,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
  return `vapid t=${signingInput}.${sig}, k=${publicKey}`;
}

/**
 * Derive RFC 8291 CEK (16 bytes) and nonce (12 bytes).
 *
 * @param {Buffer} sharedSecret
 * @param {Buffer} authSecret
 * @param {Buffer} uaPublic
 * @param {Buffer} asPublic
 * @param {Buffer} salt
 */
function derivePushKeys(sharedSecret, authSecret, uaPublic, asPublic, salt) {
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf-8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32)
  );
  const cek = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      ikm,
      salt,
      Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8'),
      16
    )
  );
  const nonce = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      ikm,
      salt,
      Buffer.from('Content-Encoding: nonce\0', 'utf-8'),
      12
    )
  );
  return { cek, nonce };
}

/**
 * Encrypt a Web Push payload using RFC 8291 (`aes128gcm`) + RFC 8188 single-record framing.
 *
 * @param {{
 *   payload: string | Buffer,
 *   p256dh: string,
 *   auth: string,
 *   salt?: Buffer,
 * }} input
 * @returns {Buffer}
 */
export function encryptWebPush({ payload, p256dh, auth, salt }) {
  const uaPub = Buffer.from(p256dh, 'base64url');
  const authBuf = Buffer.from(auth, 'base64url');
  if (uaPub.length !== PUBKEY_BYTES || uaPub[0] !== 0x04) {
    throw new WebPushError(
      'invalid',
      'Subscription p256dh must be a 65-byte uncompressed P-256 public key.'
    );
  }
  if (authBuf.length !== AUTH_BYTES) {
    throw new WebPushError(
      'invalid',
      'Subscription auth secret must be 16 bytes.'
    );
  }
  const plaintext =
    typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new WebPushError(
      'invalid',
      `Push payload exceeds ${MAX_PUSH_PLAINTEXT_BYTES} bytes.`
    );
  }

  const recordSalt = salt ?? crypto.randomBytes(SALT_BYTES);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(undefined, 'uncompressed');
  const shared = ecdh.computeSecret(uaPub);

  const { cek, nonce } = derivePushKeys(
    shared,
    authBuf,
    uaPub,
    asPub,
    recordSalt
  );
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(SALT_BYTES + 4 + 1 + PUBKEY_BYTES);
  recordSalt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(PUBKEY_BYTES, SALT_BYTES + 4);
  asPub.copy(header, SALT_BYTES + 5);

  return Buffer.concat([header, ciphertext, tag]);
}

/**
 * Decrypt an RFC 8291 (`aes128gcm`) body (used for round-trip verification).
 *
 * @param {{ body: Buffer, privateKey: Buffer, publicKey: Buffer, auth: string }} input
 * @returns {Buffer}
 */
export function decryptWebPush({ body, privateKey, publicKey, auth }) {
  const minLen = SALT_BYTES + 4 + 1 + PUBKEY_BYTES + 16 + 1;
  if (!Buffer.isBuffer(body) || body.length < minLen) {
    throw new WebPushError('crypto', 'Encrypted Web Push body is too short.');
  }
  const salt = body.subarray(0, SALT_BYTES);
  const keyLen = body.readUInt8(SALT_BYTES + 4);
  if (keyLen !== PUBKEY_BYTES) {
    throw new WebPushError(
      'crypto',
      'Unexpected keyid length in aes128gcm header.'
    );
  }
  const headerLen = SALT_BYTES + 5 + keyLen;
  const asPub = body.subarray(SALT_BYTES + 5, headerLen);
  const encrypted = body.subarray(headerLen);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const shared = ecdh.computeSecret(asPub);
  const authBuf = Buffer.from(auth, 'base64url');
  const { cek, nonce } = derivePushKeys(
    shared,
    authBuf,
    publicKey,
    asPub,
    salt
  );

  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0x00) end -= 1;
    if (end < 0 || plain[end] !== 0x02) {
      throw new Error('Missing record delimiter');
    }
    return plain.subarray(0, end);
  } catch {
    throw new WebPushError('crypto', 'Failed to decrypt Web Push payload.');
  }
}

/**
 * Build a secret-redacted visible alert payload (iOS/Android PWA compatible).
 *
 * @param {{ title: string, body: string, event: string, harness: string, host: string, at?: Date }} input
 * @returns {AlertPayload}
 */
export function buildAlertPayload({
  title,
  body,
  event,
  harness,
  host,
  at = new Date(),
}) {
  const safeTitle = redactSecrets(title).slice(0, 120);
  const safeBody = redactSecrets(body).slice(0, 400);
  return {
    title: safeTitle,
    body: safeBody,
    tag: `kyoten-${harness}-${event}`.toLowerCase(),
    event,
    harness,
    host,
    timestamp: at.toISOString(),
  };
}

/**
 * Encrypt and send one Web Push notification directly from the host to the browser push endpoint.
 *
 * @param {{
 *   subscription: PushSubscription,
 *   payload: AlertPayload | string,
 *   vapid: VapidKeyPair & { subject: string },
 *   fetchFn?: typeof globalThis.fetch,
 *   ttl?: number,
 *   urgency?: 'very-low' | 'low' | 'normal' | 'high',
 *   timeoutMs?: number,
 *   allowLocalhost?: boolean,
 *   now?: Date,
 * }} input
 * @returns {Promise<{ ok: boolean, status: number, gone: boolean }>}
 */
export async function sendWebPush({
  subscription,
  payload,
  vapid,
  fetchFn = globalThis.fetch,
  ttl = 300,
  urgency = 'normal',
  timeoutMs = 4000,
  allowLocalhost = false,
  now = new Date(),
}) {
  const url = validatePushEndpoint(subscription.endpoint, { allowLocalhost });
  const jsonPayload =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = encryptWebPush({
    payload: jsonPayload,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  });
  const authorization = createVapidAuthHeader({
    endpoint: url.toString(),
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    now,
  });

  const response = await fetchFn(url.toString(), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body: /** @type {any} */ (body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  };
}
