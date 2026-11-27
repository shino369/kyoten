import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNote, memoryDir } from '../../memory/store.js';
import { HELP, runCli } from '../cli.js';
import { SyncError, syncDir } from '../vault.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-sync-cli-'))
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeBareVault() {
  const dir = path.join(tmp, 'vault.git');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', dir], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  return dir;
}

/** @param {string} root @param {string[]} argv */
function cli(root, argv) {
  /** @type {string[]} */
  const lines = [];
  const code = runCli(argv, {
    rootDir: root,
    cwd: root,
    out: (line) => lines.push(line),
  });
  return { code, lines, text: lines.join('\n') };
}

describe('sync cli', () => {
  test('prints Usage help with no args, help, or --help', () => {
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(memoryDir(ws), { recursive: true });

    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = cli(ws, args);
      expect(res.code).toBe(0);
      expect(res.text).toBe(HELP);
      expect(res.text.startsWith('Usage:')).toBe(true);
    }
  });

  test('runs init, status, mode, device, push, and pull commands', () => {
    const vault = makeBareVault();
    const home = path.join(tmp, 'home');
    const peer = path.join(tmp, 'peer');
    fs.mkdirSync(memoryDir(home), { recursive: true });
    fs.mkdirSync(memoryDir(peer), { recursive: true });

    expect(cli(home, ['status']).text).toContain('Sync is not initialized');

    const initHomeRes = cli(home, [
      'init',
      '--vault',
      vault,
      '--name',
      'home',
      '--mode',
      'full',
      '--compartments=personal,home-private',
    ]);
    expect(initHomeRes.code).toBe(0);
    expect(initHomeRes.text).toContain('Initialized sync device');
    expect(initHomeRes.text).toContain('Root key:');

    const rootShow = JSON.parse(cli(home, ['root', 'show', '--json']).text);
    expect(rootShow.holdsRootKey).toBe(true);
    expect(cli(home, ['root', 'show']).text).toContain(
      rootShow.rootFingerprint
    );

    const statusJson = cli(home, ['status', '--json']);
    expect(JSON.parse(statusJson.text).config.name).toBe('home');
    expect(cli(home, ['status']).text).toContain(
      'Compartments: personal, home-private'
    );

    const initPeerRes = cli(peer, [
      'init',
      '--vault',
      vault,
      '--name',
      'peer',
      '--zone',
      'work',
      '--root-fingerprint',
      rootShow.rootFingerprint,
      '--json',
    ]);
    const peerData = JSON.parse(initPeerRes.text);
    const peerId = peerData.config.deviceId;

    const addRes = cli(home, [
      'device',
      'add',
      '--pubkey',
      path.join(syncDir(peer), 'device-pub.json'),
    ]);
    expect(addRes.text).toContain(`Enrolled device ${peerId}`);
    expect(cli(home, ['device', 'list']).text).toContain(peerId);

    // Export root key backup, import on peer after enrolling, and rotate root key
    const backupFile = path.join(tmp, 'root-backup.json');
    const exportRes = cli(home, [
      'root',
      'export',
      '--out',
      backupFile,
      '--passphrase',
      'recovery-pass-123',
    ]);
    expect(exportRes.text).toContain('Exported encrypted root key backup');
    const importRes = cli(peer, [
      'root',
      'import',
      '--in',
      backupFile,
      '--passphrase',
      'recovery-pass-123',
    ]);
    expect(importRes.text).toContain('Imported root signing key');
    const rotateRes = cli(home, ['root', 'rotate']);
    expect(rotateRes.text).toContain('Rotated root key');
    expect(cli(peer, ['status']).text).toContain('Root fingerprint:');

    expect(cli(home, ['push']).text).toBe('Nothing new to push.');
    addNote(memoryDir(home), {
      scope: 'user',
      type: 'fact',
      text: 'Shared fact via sync CLI.',
    });
    expect(cli(home, ['push', '--dry-run']).text).toContain(
      '[dry-run] Would push'
    );
    expect(cli(home, ['push']).text).toContain('Pushed personal');

    const pullRes = cli(peer, ['pull']);
    expect(pullRes.text).toContain('Applied 1 op(s)');

    expect(cli(home, ['mode', 'receive']).text).toBe(
      'Sync mode set to receive.'
    );
    expect(cli(home, ['device', 'revoke', peerId]).text).toContain(
      `Revoked device ${peerId}`
    );
  });

  test('throws clear SyncError messages on invalid options or commands', () => {
    const ws = path.join(tmp, 'err-ws');
    fs.mkdirSync(memoryDir(ws), { recursive: true });

    expect(() => cli(ws, ['unknown'])).toThrow(SyncError);
    expect(() => cli(ws, ['status', '--bogus'])).toThrow(/Unknown option/);
    expect(() => cli(ws, ['init', '--vault'])).toThrow(/needs a value/);
    expect(() => cli(ws, ['mode'])).toThrow(/Mode is required/);
    expect(() => cli(ws, ['device', 'list'])).toThrow(/not initialized/);
    expect(() => cli(ws, ['device', 'add'])).toThrow(/--pubkey/);
    expect(() => cli(ws, ['device', 'revoke'])).toThrow(
      /Device id is required/
    );
    expect(() => cli(ws, ['device', 'bogus'])).toThrow(
      /Unknown device subcommand/
    );
    expect(() => cli(ws, ['root', 'show'])).toThrow(/not initialized/);
    expect(() => cli(ws, ['root', 'export'])).toThrow(/--out/);
    expect(() => cli(ws, ['root', 'export', '--out', 'b.json'])).toThrow(
      /passphrase is required/
    );
    expect(() => cli(ws, ['root', 'import'])).toThrow(/--in/);
    expect(() => cli(ws, ['root', 'import', '--in', 'b.json'])).toThrow(
      /passphrase is required/
    );
    expect(() => cli(ws, ['root', 'bogus'])).toThrow(/Unknown root subcommand/);
  });
});
