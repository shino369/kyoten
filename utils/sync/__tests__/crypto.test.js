import {
  GENESIS_HASH,
  SyncCryptoError,
  VAULT_CRYPTO_VERSION,
  canonicalJson,
  decryptBatch,
  encryptBatch,
  generateDeviceIdentity,
  sha256Hex,
  signObject,
  signRegistry,
  verifyObject,
  verifyRegistry,
} from '../crypto.js';

const NOW = new Date('2026-11-27T03:00:00.000Z');

describe('sync crypto', () => {
  test('canonicalJson sorts object keys recursively and handles arrays', () => {
    const a = canonicalJson({
      b: 1,
      a: { d: 2, c: [3, { z: 1, y: 2 }], u: undefined },
    });
    const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(canonicalJson([1, undefined, 'x'])).toBe('[1,null,"x"]');
  });

  test('generateDeviceIdentity creates Ed25519 + X25519 keys and signs/verifies objects', () => {
    const alice = generateDeviceIdentity({
      name: 'home-pc',
      zone: 'personal',
      compartments: ['personal', 'home-private'],
      now: NOW,
    });
    expect(alice.publicDevice.deviceId).toMatch(/^[0-9a-f]{8}$/);
    expect(alice.publicDevice.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(alice.publicDevice.revokedAt).toBeNull();

    const sig = signObject(
      { msg: 'hello', n: 1 },
      alice.privateKeys.ed25519PrivateKey
    );
    expect(
      verifyObject(
        { n: 1, msg: 'hello' },
        sig,
        alice.publicDevice.ed25519PublicKey
      )
    ).toBe(true);
    expect(
      verifyObject(
        { n: 2, msg: 'hello' },
        sig,
        alice.publicDevice.ed25519PublicKey
      )
    ).toBe(false);
    expect(verifyObject({ n: 1, msg: 'hello' }, 'bad', 'bad')).toBe(false);

    expect(() => generateDeviceIdentity({ name: '   ' })).toThrow(
      SyncCryptoError
    );
  });

  test('encryptBatch and decryptBatch enforce multi-recipient compartments, signature, and hash chain', () => {
    const home = generateDeviceIdentity({
      name: 'home',
      compartments: ['personal', 'home-private'],
      now: NOW,
    });
    const work = generateDeviceIdentity({
      name: 'work',
      zone: 'work',
      compartments: ['personal'],
      now: NOW,
    });

    const header = {
      version: VAULT_CRYPTO_VERSION,
      deviceId: home.publicDevice.deviceId,
      compartment: 'home-private',
      epoch: 1,
      seq: 1,
      prevHash: GENESIS_HASH,
      createdAt: NOW.toISOString(),
    };
    const payload = { ops: [{ op: 'add', opId: 'op-1' }] };

    const envelope = encryptBatch({
      payload,
      header,
      recipients: [
        {
          deviceId: home.publicDevice.deviceId,
          x25519PublicKey: home.publicDevice.x25519PublicKey,
        },
      ],
      authorPrivateKey: home.privateKeys.ed25519PrivateKey,
    });

    // Authorized recipient decrypts cleanly
    const decrypted = decryptBatch({
      envelope,
      recipientDeviceId: home.publicDevice.deviceId,
      recipientX25519PrivateKey: home.privateKeys.x25519PrivateKey,
      authorEd25519PublicKey: home.publicDevice.ed25519PublicKey,
      expectedPrevHash: GENESIS_HASH,
    });
    expect(decrypted.payload).toEqual(payload);
    expect(decrypted.batchHash).toBe(envelope.batchHash);

    // Unauthorized recipient gets fail-closed no-access error
    try {
      decryptBatch({
        envelope,
        recipientDeviceId: work.publicDevice.deviceId,
        recipientX25519PrivateKey: work.privateKeys.x25519PrivateKey,
        authorEd25519PublicKey: home.publicDevice.ed25519PublicKey,
        expectedPrevHash: GENESIS_HASH,
      });
      throw new Error('expected SyncCryptoError');
    } catch (err) {
      expect(err).toBeInstanceOf(SyncCryptoError);
      expect(/** @type {SyncCryptoError} */ (err).code).toBe('no-access');
    }

    // Wrong prevHash fails with chain error
    try {
      decryptBatch({
        envelope,
        recipientDeviceId: home.publicDevice.deviceId,
        recipientX25519PrivateKey: home.privateKeys.x25519PrivateKey,
        authorEd25519PublicKey: home.publicDevice.ed25519PublicKey,
        expectedPrevHash: sha256Hex('other'),
      });
      throw new Error('expected chain error');
    } catch (err) {
      expect(/** @type {SyncCryptoError} */ (err).code).toBe('chain');
    }

    // Tampered ciphertext fails before decrypt
    const tamperedCipher = {
      ...envelope,
      ciphertext: Buffer.from('tampered').toString('base64url'),
    };
    expect(() =>
      decryptBatch({
        envelope: tamperedCipher,
        recipientDeviceId: home.publicDevice.deviceId,
        recipientX25519PrivateKey: home.privateKeys.x25519PrivateKey,
        authorEd25519PublicKey: home.publicDevice.ed25519PublicKey,
      })
    ).toThrow(/digest mismatch/);

    // Wrong author public key fails signature check
    expect(() =>
      decryptBatch({
        envelope,
        recipientDeviceId: home.publicDevice.deviceId,
        recipientX25519PrivateKey: home.privateKeys.x25519PrivateKey,
        authorEd25519PublicKey: work.publicDevice.ed25519PublicKey,
      })
    ).toThrow(/Invalid Ed25519 signature/);

    // Wrong recipient X25519 private key fails unwrap
    expect(() =>
      decryptBatch({
        envelope,
        recipientDeviceId: home.publicDevice.deviceId,
        recipientX25519PrivateKey: work.privateKeys.x25519PrivateKey,
        authorEd25519PublicKey: home.publicDevice.ed25519PublicKey,
      })
    ).toThrow(/Failed to unwrap/);
  });

  test('encryptBatch and decryptBatch reject malformed inputs', () => {
    const home = generateDeviceIdentity({ name: 'home', now: NOW });
    expect(() =>
      encryptBatch({
        payload: {},
        header: /** @type {any} */ ({ version: 2 }),
        recipients: [],
        authorPrivateKey: home.privateKeys.ed25519PrivateKey,
      })
    ).toThrow(SyncCryptoError);

    expect(() =>
      encryptBatch({
        payload: {},
        header: {
          version: 1,
          deviceId: home.publicDevice.deviceId,
          compartment: 'personal',
          epoch: 1,
          seq: 1,
          prevHash: GENESIS_HASH,
          createdAt: NOW.toISOString(),
        },
        recipients: [],
        authorPrivateKey: home.privateKeys.ed25519PrivateKey,
      })
    ).toThrow(/At least one authorized recipient/);

    expect(() =>
      decryptBatch({
        envelope: null,
        recipientDeviceId: 'a',
        recipientX25519PrivateKey: 'a',
        authorEd25519PublicKey: 'a',
      })
    ).toThrow(/must be an object/);

    expect(() =>
      decryptBatch({
        envelope: { version: 99 },
        recipientDeviceId: 'a',
        recipientX25519PrivateKey: 'a',
        authorEd25519PublicKey: 'a',
      })
    ).toThrow(/Unsupported batch envelope version/);
  });

  test('signRegistry and verifyRegistry detect tampering', () => {
    const root = generateDeviceIdentity({ name: 'root', now: NOW });
    const registry = { version: 1, epoch: 1, devices: [root.publicDevice] };
    const sig = signRegistry(
      registry,
      root.privateKeys.ed25519PrivateKey,
      root.publicDevice.ed25519PublicKey,
      NOW
    );

    expect(
      verifyRegistry(registry, sig, root.publicDevice.ed25519PublicKey)
    ).toBe(true);
    expect(
      verifyRegistry(
        { ...registry, epoch: 2 },
        sig,
        root.publicDevice.ed25519PublicKey
      )
    ).toBe(false);
    expect(
      verifyRegistry(registry, null, root.publicDevice.ed25519PublicKey)
    ).toBe(false);
  });
});
