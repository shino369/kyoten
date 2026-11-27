import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSubscribeUrl,
  exportSubscribeBundle,
  renderSubscribeBundle,
  startSubscribeServer,
} from '../subscribe-page.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-subpage-'))
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('remote subscribe-page PWA', () => {
  test('renderSubscribeBundle includes fragment VAPID handling, localStorage fallback, and standalone manifest', () => {
    const bundle = renderSubscribeBundle();
    expect(Object.keys(bundle).sort()).toEqual([
      'index.html',
      'manifest.webmanifest',
      'sw.js',
    ]);
    expect(bundle['index.html']).toContain('#vapid=');
    expect(bundle['index.html']).toContain('localStorage');
    expect(bundle['index.html']).toContain('userVisibleOnly: true');
    expect(bundle['index.html']).toContain('pnpm remote push add');
    expect(bundle['sw.js']).toContain('showNotification');
    expect(JSON.parse(bundle['manifest.webmanifest']).display).toBe(
      'standalone'
    );
  });

  test('buildSubscribeUrl places VAPID public key strictly in fragment and rejects insecure URLs', () => {
    expect(
      buildSubscribeUrl({
        baseUrl: 'https://shino369.github.io/kyoten-push/?old=1#ignored',
        vapidPublicKey: 'BFooBar123',
      })
    ).toBe('https://shino369.github.io/kyoten-push/#vapid=BFooBar123');

    expect(
      buildSubscribeUrl({
        baseUrl: 'http://127.0.0.1:8787/',
        vapidPublicKey: 'BFooBar123',
      })
    ).toBe('http://127.0.0.1:8787/#vapid=BFooBar123');

    expect(() =>
      buildSubscribeUrl({
        baseUrl: 'http://example.com/push',
        vapidPublicKey: 'BFooBar123',
      })
    ).toThrow(/https:\/\//);

    expect(() =>
      buildSubscribeUrl({
        baseUrl: 'not a url',
        vapidPublicKey: 'BFooBar123',
      })
    ).toThrow(/Invalid subscribe base URL/);

    expect(() =>
      buildSubscribeUrl({
        baseUrl: 'https://example.com',
        vapidPublicKey: '  ',
      })
    ).toThrow(/VAPID public key is required/);
  });

  test('exportSubscribeBundle writes all 3 static PWA files', () => {
    const dest = path.join(tmp, 'pwa');
    const res = exportSubscribeBundle(dest);
    expect(res.outDir).toBe(dest);
    expect(res.files).toEqual(['index.html', 'sw.js', 'manifest.webmanifest']);
    for (const file of res.files) {
      expect(fs.existsSync(path.join(dest, file))).toBe(true);
    }
    expect(() => exportSubscribeBundle('')).toThrow(/Output directory/);
  });

  test('startSubscribeServer serves bundle on loopback only and enforces GET/HEAD + 404/405', async () => {
    expect(() => startSubscribeServer({ host: '0.0.0.0' })).toThrow(
      /non-loopback/
    );

    const srv = await startSubscribeServer({
      port: 0,
      host: '127.0.0.1',
      vapidPublicKey: 'BTestVapidKey',
    });
    try {
      expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/#vapid=BTestVapidKey`);

      const idx = await fetch(`http://127.0.0.1:${srv.port}/`);
      expect(idx.status).toBe(200);
      expect(idx.headers.get('cache-control')).toBe('no-store');
      expect(idx.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await idx.text()).toContain('kyoten Web Push Subscribe');

      const sw = await fetch(`http://127.0.0.1:${srv.port}/sw.js`);
      expect(sw.status).toBe(200);
      expect(sw.headers.get('content-type')).toContain('javascript');

      const manifest = await fetch(
        `http://127.0.0.1:${srv.port}/manifest.webmanifest`
      );
      expect(manifest.status).toBe(200);

      const head = await fetch(`http://127.0.0.1:${srv.port}/index.html`, {
        method: 'HEAD',
      });
      expect(head.status).toBe(200);

      const notFound = await fetch(`http://127.0.0.1:${srv.port}/secret`);
      expect(notFound.status).toBe(404);

      const badMethod = await fetch(`http://127.0.0.1:${srv.port}/`, {
        method: 'POST',
      });
      expect(badMethod.status).toBe(405);
    } finally {
      await srv.close();
    }
  });
});
