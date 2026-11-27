/**
 * Zero-dependency RFC 8291 (`aes128gcm`) Web Push + RFC 8292 (VAPID ES256)
 * using Node.js 24 native `node:crypto` and `fetch`.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { redactSecrets } from '../redact.js';

export const MAX_PUSH_PLAINTEXT_BYTES = 3993;
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const AUTH_BYTES = 16;
const PUBKEY_BYTES = 65;

const KNOWN_PUSH_EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
]);

const KNOWN_PUSH_SUFFIXES = [
  '.push.apple.com',
  '.notify.windows.com',
  '.push.services.mozilla.com',
];

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
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 RFC 1918
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local / metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 RFC 1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 168) || // 192.168.0.0/16 RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  );
}

/**
 * Expand a valid IPv6 literal into 16 bytes (supporting `::` and trailing IPv4).
 *
 * @param {string} ip
 * @returns {Uint8Array | null}
 */
function parseIpv6Bytes(ip) {
  let work = ip.toLowerCase();
  const zoneIdx = work.indexOf('%');
  if (zoneIdx >= 0) work = work.slice(0, zoneIdx);

  // Convert trailing dotted-quad IPv4 to two 16-bit hex groups.
  const lastColon = work.lastIndexOf(':');
  if (lastColon >= 0 && work.slice(lastColon + 1).includes('.')) {
    const v4 = work
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    if (
      v4.length !== 4 ||
      v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    work = `${work.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = work.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const val = Number.parseInt(groups[i], 16);
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
    out[i * 2] = val >> 8;
    out[i * 2 + 1] = val & 0xff;
  }
  return out;
}

/** @param {Uint8Array} bytes @param {number} offset */
function ipv4FromBytes(bytes, offset) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/** @param {string} ip */
function isPrivateIpv6(ip) {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return true;
  const allZeroPrefix12 = bytes.slice(0, 12).every((b) => b === 0);
  // :: (unspecified), ::1 (loopback), and ::a.b.c.d (IPv4-compatible)
  if (allZeroPrefix12) {
    if (
      bytes[12] === 0 &&
      bytes[13] === 0 &&
      bytes[14] === 0 &&
      (bytes[15] === 0 || bytes[15] === 1)
    ) {
      return true;
    }
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
  }
  // ::ffff:0:0/96 (IPv4-mapped)
  if (
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
  }
  // 64:ff9b::/96 (well-known NAT64) and 64:ff9b:1::/48 (local NAT64)
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  ) {
    if (bytes[4] === 0 && bytes[5] === 1) return true;
    if (bytes.slice(4, 12).every((b) => b === 0)) {
      return isPrivateIpv4(ipv4FromBytes(bytes, 12));
    }
  }
  // 100::/64 (discard-only)
  if (
    bytes[0] === 0x01 &&
    bytes[1] === 0x00 &&
    bytes.slice(2, 8).every((b) => b === 0)
  ) {
    return true;
  }
  // 2001:db8::/32 (documentation)
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return true;
  }
  // 2002::/16 (6to4 embedding IPv4 in bytes 2..5)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(ipv4FromBytes(bytes, 2));
  }
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast)
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

/** @param {string} host */
export function normalizeHostname(host) {
  return host
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/** @param {string} host */
export function isKnownPushHost(host) {
  const bare = normalizeHostname(host);
  if (KNOWN_PUSH_EXACT_HOSTS.has(bare)) return true;
  return KNOWN_PUSH_SUFFIXES.some(
    (suffix) => bare.endsWith(suffix) && bare.length > suffix.length
  );
}

/** @param {string} host */
export function isPrivateHost(host) {
  const bare = normalizeHostname(host);
  if (
    !bare ||
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal') ||
    bare.endsWith('.arpa')
  ) {
    return true;
  }
  const ipVer = net.isIP(bare);
  if (ipVer === 4) return isPrivateIpv4(bare);
  if (ipVer === 6) return isPrivateIpv6(bare);
  return false;
}

/**
 * Validate a Web Push endpoint URL against SSRF, host allow-list, and
 * plaintext-transport rules.
 *
 * @param {string} endpoint
 * @param {{ allowLocalhost?: boolean, allowCustomHost?: boolean }} [options]
 * @returns {URL}
 */
export function validatePushEndpoint(
  endpoint,
  { allowLocalhost = false, allowCustomHost = false } = {}
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
  const bareHost = normalizeHostname(url.hostname);
  const isLoopbackHttp =
    allowLocalhost &&
    url.protocol === 'http:' &&
    (bareHost === '127.0.0.1' ||
      bareHost === 'localhost' ||
      bareHost === '::1');
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
  if (!isLoopbackHttp && !allowCustomHost && !isKnownPushHost(bareHost)) {
    throw new WebPushError(
      'ssrf',
      `Refused untrusted push endpoint host "${url.hostname}". Expected a standard browser push service (FCM, Apple, Mozilla, WNS) or pass --allow-custom-host.`
    );
  }
  return url;
}

/**
 * Resolve `hostname` via DNS and ensure every returned address is public
 * (blocks DNS-rebinding / wildcard-DNS SSRF like `127.0.0.1.nip.io`).
 *
 * @param {string} hostname
 * @param {{ lookupFn?: (host: string, opts: { all: true }) => Promise<Array<{ address: string }>> }} [options]
 */
export async function assertPublicDns(
  hostname,
  { lookupFn = dns.lookup } = {}
) {
  const bare = normalizeHostname(hostname);
  if (net.isIP(bare)) {
    if (isPrivateHost(bare)) {
      throw new WebPushError(
        'ssrf',
        `Refused private push endpoint IP "${bare}".`
      );
    }
    return;
  }
  let records;
  try {
    records = await lookupFn(bare, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WebPushError(
      'ssrf',
      `Failed to resolve push endpoint host "${bare}": ${detail}`
    );
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new WebPushError(
      'ssrf',
      `Push endpoint host "${bare}" resolved to no addresses.`
    );
  }
  for (const record of records) {
    if (!record?.address || isPrivateHost(record.address)) {
      throw new WebPushError(
        'ssrf',
        `Refused push endpoint "${bare}" resolving to private IP "${record?.address ?? ''}".`
      );
    }
  }
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
 *   lookupFn?: (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>,
 *   ttl?: number,
 *   urgency?: 'very-low' | 'low' | 'normal' | 'high',
 *   timeoutMs?: number,
 *   allowLocalhost?: boolean,
 *   allowCustomHost?: boolean,
 *   now?: Date,
 * }} input
 * @returns {Promise<{ ok: boolean, status: number, gone: boolean }>}
 */
export async function sendWebPush({
  subscription,
  payload,
  vapid,
  fetchFn = globalThis.fetch,
  lookupFn = dns.lookup,
  ttl = 300,
  urgency = 'normal',
  timeoutMs = 4000,
  allowLocalhost = false,
  allowCustomHost = false,
  now = new Date(),
}) {
  const url = validatePushEndpoint(subscription.endpoint, {
    allowLocalhost,
    allowCustomHost,
  });
  if (allowCustomHost && !allowLocalhost) {
    await assertPublicDns(url.hostname, { lookupFn });
  }
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
