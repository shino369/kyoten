/**
 * Minimal static Web Push subscribe PWA generator & loopback server.
 *
 * Solves phone Web Push subscription creation without shipping standalone browser
 * `.js` files in the repository or storing secrets in URL query parameters:
 * - VAPID public key travels strictly in the `#vapid=<base64url>` fragment.
 * - Provides an explicit Copy VAPID Key button for iOS Safari "Add to Home Screen"
 *   (WebKit isolates Safari localStorage from the installed Home Screen app).
 * - Detects VAPID key rotation (`existing.options.applicationServerKey`) and
 *   unsubscribes stale subscriptions before re-subscribing.
 * - Outputs a clean JSON subscription payload for `pnpm remote push add --stdin`
 *   so auth secrets stay out of CLI arguments and shell expansion is impossible.
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
      .row { display: flex; gap: 0.5rem; align-items: center; }
      .row input { flex: 1; }
      button { margin-top: 0.75rem; padding: 0.65rem 1.1rem; border-radius: 6px; border: 0; background: #38bdf8; color: #0f172a; font-weight: 600; cursor: pointer; }
      .secondary { background: #334155; color: #f8fafc; margin-top: 0; white-space: nowrap; }
      .note { margin-top: 1rem; font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; }
      pre { background: #020617; padding: 0.8rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <h1>kyoten Web Push Subscribe</h1>
    <p class="note">
      <strong>iOS Safari:</strong> Home Screen web apps use separate storage from Safari, so tap
      <strong>Copy Key</strong> first, tap <strong>Share &rarr; Add to Home Screen</strong>, open the
      installed app, paste the VAPID key below, then tap Subscribe.
      On Android / desktop, <code>#vapid=...</code> fills the key automatically.
    </p>
    <label for="vapid">VAPID Public Key (base64url)</label>
    <div class="row">
      <input id="vapid" type="text" placeholder="Paste VAPID public key" autocomplete="off" />
      <button id="copyVapidBtn" class="secondary" type="button">Copy Key</button>
    </div>
    <label for="label">Device Label</label>
    <input id="label" type="text" value="phone" />
    <button id="subBtn" type="button">Subscribe &amp; Generate Payload</button>
    <p id="status" class="note"></p>
    <p id="importHint" class="note" hidden>
      Copy the JSON below and import it on your kyoten host via stdin (keeps auth out of shell history):
      <code>pnpm remote push add --stdin</code>
    </p>
    <pre id="payload" hidden></pre>
    <button id="copyBtn" type="button" hidden>Copy Subscription JSON</button>
    <script>
      const STORAGE_KEY = 'kyoten.vapidPublicKey';
      const vapidInput = document.getElementById('vapid');
      const labelInput = document.getElementById('label');
      const statusEl = document.getElementById('status');
      const importHintEl = document.getElementById('importHint');
      const payloadEl = document.getElementById('payload');
      const copyBtn = document.getElementById('copyBtn');
      const copyVapidBtn = document.getElementById('copyVapidBtn');

      function normalizeBase64Url(str) {
        return String(str || '').trim().replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      function readFragmentVapid() {
        const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
        const params = new URLSearchParams(hash);
        const fromHash = params.get('vapid');
        if (fromHash) {
          const clean = normalizeBase64Url(fromHash);
          try { localStorage.setItem(STORAGE_KEY, clean); } catch {}
          return clean;
        }
        try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
      }

      function urlBase64ToUint8Array(base64url) {
        const clean = normalizeBase64Url(base64url);
        const pad = '='.repeat((4 - (clean.length % 4)) % 4);
        const b64 = (clean + pad).replace(/-/g, '+').replace(/_/g, '/');
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

      function sanitizeLabel(value) {
        return String(value || '').replace(/[^\\w .-]/g, '').trim() || 'phone';
      }

      function existingKeyMatches(existing, expectedKey) {
        const appKey = existing && existing.options && existing.options.applicationServerKey;
        if (!appKey) return false;
        try {
          return bufToBase64Url(appKey) === normalizeBase64Url(expectedKey);
        } catch {
          return false;
        }
      }

      vapidInput.value = readFragmentVapid();

      copyVapidBtn.addEventListener('click', async () => {
        const key = vapidInput.value.trim();
        if (!key) {
          statusEl.textContent = 'Error: VAPID public key is empty.';
          return;
        }
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(key);
          statusEl.textContent = 'Copied VAPID public key. Paste it into the Home Screen app if installing on iOS.';
        }
      });

      document.getElementById('subBtn').addEventListener('click', async () => {
        try {
          const vapidKey = normalizeBase64Url(vapidInput.value);
          if (!vapidKey) throw new Error('VAPID public key is required.');
          try { localStorage.setItem(STORAGE_KEY, vapidKey); } catch {}
          if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            throw new Error('Web Push is not supported in this browser context.');
          }
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') throw new Error('Notification permission denied.');
          const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
          await navigator.serviceWorker.ready;
          let existing = await reg.pushManager.getSubscription();
          let rotated = false;
          if (existing && !existingKeyMatches(existing, vapidKey)) {
            await existing.unsubscribe();
            existing = null;
            rotated = true;
          }
          const sub = existing || await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
          });
          const p256dh = bufToBase64Url(sub.getKey('p256dh'));
          const auth = bufToBase64Url(sub.getKey('auth'));
          const label = sanitizeLabel(labelInput.value);
          const json = JSON.stringify(
            { endpoint: sub.endpoint, label, keys: { p256dh, auth } },
            null,
            2
          );
          payloadEl.textContent = json;
          payloadEl.hidden = false;
          importHintEl.hidden = false;
          copyBtn.hidden = false;
          statusEl.textContent = rotated
            ? 'Rotated subscription to the new VAPID key. Pipe this JSON into pnpm remote push add --stdin.'
            : 'Subscription created. Pipe this JSON into pnpm remote push add --stdin.';
        } catch (err) {
          statusEl.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
        }
      });

      copyBtn.addEventListener('click', async () => {
        if (navigator.clipboard && payloadEl.textContent) {
          await navigator.clipboard.writeText(payloadEl.textContent);
          statusEl.textContent = 'Copied subscription JSON to clipboard.';
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
  const url = validateSubscribeBaseUrl(baseUrl);
  url.search = '';
  url.hash = `vapid=${encodeURIComponent(vapidPublicKey.trim())}`;
  return url.toString();
}

/**
 * Validate a subscribe page base URL before writing any bundle files.
 *
 * @param {string} baseUrl
 * @returns {URL}
 */
export function validateSubscribeBaseUrl(baseUrl) {
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
  return url;
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
