/**
 * Minimal static Web Push subscribe PWA generator & loopback server.
 *
 * Solves phone Web Push subscription creation without shipping standalone browser
 * `.js` files in the repository or storing secrets in URL query parameters:
 * - VAPID public key travels strictly in the `#vapid=<base64url>` fragment.
 * - Persists the key in `localStorage` so iOS Safari "Add to Home Screen" keeps
 *   it even when iOS strips URL fragments on launch (plus manual input fallback).
 * - Loopback-only `startSubscribeServer()` pairs cleanly with `tailscale serve`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { writeFileAtomic } from '../task/store.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CSP_HEADER =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

/**
 * Render the minimal static PWA bundle (`index.html`, `sw.js`, `manifest.webmanifest`).
 *
 * @returns {{ 'index.html': string, 'sw.js': string, 'manifest.webmanifest': string }}
 */
export function renderSubscribeBundle() {
  const manifest = `${JSON.stringify(
    {
      name: 'kyoten push',
      short_name: 'kyoten',
      description: 'Subscribe this phone to host-direct E2EE kyoten alerts',
      start_url: './index.html',
      scope: './',
      display: 'standalone',
      background_color: '#0f172a',
      theme_color: '#0f172a',
    },
    null,
    2
  )}\n`;

  const sw = `self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'kyoten', body: 'Agent update', tag: 'kyoten' };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'kyoten', {
      body: payload.body || '',
      tag: payload.tag || 'kyoten',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0 && 'focus' in clients[0]) {
        return clients[0].focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <title>kyoten Web Push Subscribe</title>
    <link rel="manifest" href="./manifest.webmanifest" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; background: #0f172a; color: #e2e8f0; }
      label { display: block; margin: 1rem 0 0.25rem; font-size: 0.9rem; color: #94a3b8; }
      input, textarea { width: 100%; box-sizing: border-box; padding: 0.6rem; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #f8fafc; font-family: monospace; }
      button { margin-top: 1rem; padding: 0.7rem 1.2rem; border-radius: 6px; border: 0; background: #38bdf8; color: #0f172a; font-weight: 600; cursor: pointer; }
      .note { margin-top: 1rem; font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; }
      pre { background: #020617; padding: 0.8rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <h1>kyoten Web Push Subscribe</h1>
    <p class="note">
      On iOS Safari: tap <strong>Share &rarr; Add to Home Screen</strong>, open the installed app, then tap Subscribe.
      The VAPID public key is read from <code>#vapid=...</code> (never sent in query strings) and saved locally.
    </p>
    <label for="vapid">VAPID Public Key (base64url)</label>
    <input id="vapid" type="text" placeholder="Paste VAPID public key" autocomplete="off" />
    <label for="label">Device Label</label>
    <input id="label" type="text" value="phone" />
    <button id="subBtn" type="button">Subscribe &amp; Generate Command</button>
    <p id="status" class="note"></p>
    <pre id="cmd" hidden></pre>
    <button id="copyBtn" type="button" hidden>Copy Command</button>
    <script>
      const STORAGE_KEY = 'kyoten.vapidPublicKey';
      const vapidInput = document.getElementById('vapid');
      const labelInput = document.getElementById('label');
      const statusEl = document.getElementById('status');
      const cmdEl = document.getElementById('cmd');
      const copyBtn = document.getElementById('copyBtn');

      function readFragmentVapid() {
        const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
        const params = new URLSearchParams(hash);
        const fromHash = params.get('vapid');
        if (fromHash) {
          try { localStorage.setItem(STORAGE_KEY, fromHash); } catch {}
          return fromHash;
        }
        try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
      }

      function urlBase64ToUint8Array(base64url) {
        const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
        const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
        return out;
      }

      function bufToBase64Url(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      vapidInput.value = readFragmentVapid();

      document.getElementById('subBtn').addEventListener('click', async () => {
        try {
          const vapidKey = vapidInput.value.trim();
          if (!vapidKey) throw new Error('VAPID public key is required.');
          try { localStorage.setItem(STORAGE_KEY, vapidKey); } catch {}
          if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            throw new Error('Web Push is not supported in this browser context.');
          }
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') throw new Error('Notification permission denied.');
          const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
          await navigator.serviceWorker.ready;
          const existing = await reg.pushManager.getSubscription();
          const sub = existing || await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
          });
          const p256dh = bufToBase64Url(sub.getKey('p256dh'));
          const auth = bufToBase64Url(sub.getKey('auth'));
          const label = (labelInput.value.trim() || 'phone').replace(/"/g, '');
          const cmd =
            'pnpm remote push add --endpoint "' + sub.endpoint +
            '" --p256dh "' + p256dh +
            '" --auth "' + auth +
            '" --label "' + label + '"';
          cmdEl.textContent = cmd;
          cmdEl.hidden = false;
          copyBtn.hidden = false;
          statusEl.textContent = 'Subscription created. Run this command on your kyoten host:';
        } catch (err) {
          statusEl.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
        }
      });

      copyBtn.addEventListener('click', async () => {
        if (navigator.clipboard && cmdEl.textContent) {
          await navigator.clipboard.writeText(cmdEl.textContent);
          statusEl.textContent = 'Copied command to clipboard.';
        }
      });
    </script>
  </body>
</html>
`;

  return {
    'index.html': html,
    'sw.js': sw,
    'manifest.webmanifest': manifest,
  };
}

/**
 * Build a subscribe page URL with the VAPID public key placed strictly in `#fragment`.
 *
 * @param {{ baseUrl: string, vapidPublicKey: string }} input
 * @returns {string}
 */
export function buildSubscribeUrl({ baseUrl, vapidPublicKey }) {
  if (typeof vapidPublicKey !== 'string' || !vapidPublicKey.trim()) {
    throw new Error('VAPID public key is required to build a subscribe URL.');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid subscribe base URL "${String(baseUrl)}".`);
  }
  const isLoopbackHttp =
    url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (!isLoopbackHttp && url.protocol !== 'https:') {
    throw new Error(
      `Subscribe page base URL must use https:// (got ${url.protocol}).`
    );
  }
  url.search = '';
  url.hash = `vapid=${encodeURIComponent(vapidPublicKey.trim())}`;
  return url.toString();
}

/**
 * Write the minimal static Web Push subscribe PWA bundle into `outDir`.
 *
 * @param {string} outDir
 * @returns {{ outDir: string, files: string[] }}
 */
export function exportSubscribeBundle(outDir) {
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new Error('Output directory (--out) is required.');
  }
  const resolved = path.resolve(outDir);
  fs.mkdirSync(resolved, { recursive: true });
  const bundle = renderSubscribeBundle();
  const files = Object.keys(bundle);
  for (const [name, content] of Object.entries(bundle)) {
    writeFileAtomic(path.join(resolved, name), content);
  }
  return { outDir: resolved, files };
}

/**
 * Start a loopback-only HTTP server for the subscribe PWA (intended to sit
 * behind `tailscale serve --https=443 http://127.0.0.1:<port>`).
 *
 * @param {{ port?: number, host?: string, vapidPublicKey?: string }} [options]
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startSubscribeServer({
  port = 0,
  host = '127.0.0.1',
  vapidPublicKey,
} = {}) {
  const bareHost = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(bareHost)) {
    throw new Error(
      `Refused non-loopback subscribe server host "${host}"; bind to 127.0.0.1 and expose via tailscale serve.`
    );
  }
  const bundle = renderSubscribeBundle();
  /** @type {Record<string, { type: string, body: string }>} */
  const routes = {
    '/': { type: 'text/html; charset=utf-8', body: bundle['index.html'] },
    '/index.html': {
      type: 'text/html; charset=utf-8',
      body: bundle['index.html'],
    },
    '/sw.js': {
      type: 'application/javascript; charset=utf-8',
      body: bundle['sw.js'],
    },
    '/manifest.webmanifest': {
      type: 'application/manifest+json; charset=utf-8',
      body: bundle['manifest.webmanifest'],
    },
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const reqPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const entry = Object.hasOwn(routes, reqPath) ? routes[reqPath] : null;
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : entry.body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      const boundPort =
        addr && typeof addr === 'object' ? addr.port : Number(port);
      const urlHost = bareHost === '::1' ? '[::1]' : host;
      const base = `http://${urlHost}:${boundPort}/`;
      const url = vapidPublicKey
        ? buildSubscribeUrl({ baseUrl: base, vapidPublicKey })
        : base;
      resolve({
        server,
        port: boundPort,
        url,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
