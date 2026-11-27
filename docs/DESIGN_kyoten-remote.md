# Design — `kyoten-remote` (`agy`-First, Zero-Trust E2EE Sync & Remote Access)

Date: 2026-11-27
Task: `tasks/kyoten-remote-261127/`

## 1. Goals, Non-Goals & Confirmed Owner Decisions

### Goals

- Give one person's phone(s) and their own `kyoten` machines (home PC, personal laptop, company Mac) a consistent personal agent with shared memory, personalization, and per-harness personas under zero-trust E2EE.
- Require zero inbound port forwarding (outbound-only), zero runtime npm dependencies in core `kyoten`, and strict compliance with Google Antigravity (`agy`) ToS Section 6.

### Non-Goals

- Multi-user / team shared vaults or remote execution.
- Wake-on-LAN (unreliable on Wi-Fi laptops).
- Rebuilding a terminal PTY multiplexer (`node-pty` breaks `ignoreScripts` and Windows portability; **Rex** and **Herdr** already solve persistent PTYs).
- Automatically syncing code or harness files over remote channels.

### Confirmed Owner Decisions (2026-11-27)

1. **Sync-first scope (`receive`-only on company Mac; live access on personal machines only):**
   - The company Mac uses **Track 1 (`pnpm sync`)** in `receive` mode over standard HTTPS `git fetch` to a private Git vault. No VPN, no `tailscaled` tunnel, and no persistent outbound `wss` relay daemon run on MDM-managed corporate hardware.
   - Live interactive access (`kyoten agy`, `claude`, `codex`, `dsh`) runs on **personal machines only** via **Herdr + Tailscale**, augmented by **Track 2 (`utils/remote/hook.js` + OSC 7501)** and **Track 3 (host-direct RFC 8291/8292 Web Push + static subscribe PWA)**.
2. **Three-PR rollout from `main`:**
   - **PR 1 (`feat/e2ee-sync-vault`):** Store v2 global IDs + Hybrid Logical Clock (`hlc`) + Track 1 `pnpm sync` (with mandatory root-key/fingerprint pinning on enrollment and separate, backup-able, rotatable root Ed25519 keys) + design/user docs.
   - **PR 2 (`feat/remote-osc7501`):** Lightweight `utils/remote/hook.js` + OSC 7501 status interop (`pnpm remote osc7501 on|off`) across Claude Code, Codex, DSH, and `agy`.
   - **PR 3 (`feat/remote-webpush`):** Host-direct RFC 8291/8292 Web Push alerts + minimal static subscribe PWA (`utils/remote/subscribe-page.js`) with `#fragment` VAPID key and iOS Home Screen support.

---

## 2. Three-Plane Zero-Trust Separation

| Plane                   | Contents                                                                                                                                                              | Blast Radius if Tampered               | Isolation Mechanism                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Code / Harness**   | `AGENTS.md`, `.claude/`, `.codex/`, `.agents/`, `.dsh/`, `utils/`, `skills-lock.json`, `package.json`                                                                 | Immediate RCE                          | Git + signed commits + `kyoten update` / manual local review only. Never auto-synced.                                                                                                      |
| **2. Memory & Persona** | `user` notes, opted-in `repo` notes (with `repoIdentity()` remote-hash collision guard), `personalization.json`, `persona.<key>.md`                                   | Prompt injection / data leak           | **`pnpm sync`**: Ed25519-signed, compartmentalized E2EE op-logs + receive-side `assertNoSecrets()` refusal & `memory/inbox.jsonl` quarantine (`looksLikeInstruction()`, `injectionsIn()`). |
| **3. Machine-Local**    | `machine` notes, `dscc.env`, `memory/config.json`, `memory/sync/identity.json`, `memory/remote/config.json`, `extract/journal.jsonl`, `tools/local.json`, `.mcp.json` | Credential theft / cross-provider leak | Strictly local. Excluded from sync exports, ignored in `.gitignore`, and denied in `utils/kyoten/pack.js`.                                                                                 |

---

## 3. Track 1 — Memory Store v2 & `pnpm sync` E2EE Git Vault

### 3.1 Memory Store v2 (`utils/memory/`)

- **Backward-compatible global IDs (`utils/memory/store.js`):**
  - `ID_RE = /^[mt](?:[1-9]\d*|-[0-9a-f]{4,8}-[1-9]\d*)$/` accepts legacy sequential IDs (`m1`, `t2`) and device-scoped v2 IDs (`m-<dev4>-<seq>`, `t-<dev4>-<seq>`).
  - `compareNoteIds()` sorts deterministically across legacy and v2 IDs (`render.js`, `consolidate.js`, `hook.js`).
  - Legacy local IDs (`m1`) map deterministically to `m-<dev4>-1` on sync export so pre-existing logs across machines never collide.
- **Hybrid Logical Clock (`hlc`) & Per-Field LWW (`replay()`, `mergeSyncedOps()`):**
  - Format: `<15-digit-ms>-<4-hex-counter>-<node>` (ASCII-sortable).
  - `nextHlc(lastSeenHlc, nowMs, node)` guarantees monotonic causal advancement even when a peer's wall clock lags behind another machine.
  - Legacy logs without `opId` or `hlc` preserve exact sequential `replay()`. When v2 ops are present, `replay()` deduplicates by `opId`, places `add` ops before mutations, orders mutations by `(hlc, opId)` via ASCII comparison, and applies per-field Last-Writer-Wins (`text`, `tags`, `triggers`, `type`, `scope`, `repo`, `pinned`, `checked`) while preserving `delete` tombstones.
  - Local writes (`addNote`, `updateNote`, `deleteNote`, `setPinned`, `checkNote`) automatically stamp `hlc` whenever `deviceId` is passed or the local log already contains v2 `hlc` ops (so synced workspaces stay monotonic without changing legacy local-only logs).
- **Repo collision guard & undo (`utils/memory/repo.js`, `utils/memory/undo.js`):**
  - `repoIdentity()` normalizes SSH/HTTPS `origin` URLs into `<host>/<path>` with a 12-hex SHA-256 `hash` alongside `name` to distinguish identically named repos (`web`, `app`).
  - `pullSync()` takes a `takeSnapshot(..., { reason: 'sync' })` snapshot before applying changes and stamps `syncedAt` on imported ops so `pnpm memory undo` cleanly reverts a sync pull.

### 3.2 Vault Format, Cryptography & Key Lifecycle (`utils/sync/`)

Implemented purely on Node.js 24 built-in `node:crypto` (zero external crypto dependencies, zero daemon, zero VPN):

- **Conflict-free per-device append-only layout:**
  - `devices.json` + `devices.json.sig`: root-Ed25519-signed registry (`version`, `epoch`, `updatedAt`, `rootHistory`, `devices[]` with `deviceId`, `name`, `zone`, `compartments`, `ed25519PublicKey`, `x25519PublicKey`, `fingerprint`, `createdAt`, `revokedAt`).
  - `ops/<deviceId>/<seq>-<compartment>.enc.json`: monotonic sequence-numbered batches per `(deviceId, compartment)`.
- **Cryptographic envelope (`utils/sync/crypto.js`):**
  - Payload encrypted with random 32-byte CEK + 12-byte nonce via `ChaCha20-Poly1305` with `canonicalJson(header)` as AAD.
  - Per-recipient CEK wrapping using ephemeral `X25519` ECDH + `HKDF-SHA256` (`kyoten-vault-v1-wrap:<compartment>`) + `ChaCha20-Poly1305` for only active, non-revoked devices authorized for that compartment.
  - `bodyHash` (`SHA-256(ciphertext || tag)`), `batchHash` (`SHA-256(canonicalJson(signedBody))`), `prevHash` chain (`GENESIS_HASH` at `seq = 1`), and author `Ed25519` signature verified fail-closed before any decryption.
- **Compartments & provider-side isolation:**
  - `personal`: `user` notes, `personalization.json`, `persona.<key>.md` → wrapped for personal + work devices (`work-mac` receives only this).
  - `home-private`: personal `repo` notes → wrapped for personal devices only (`work-mac` cryptographically lacks the keys).
  - `work`: work-zone exports when `mode === 'full'`.
  - Consolidation remains single-host (owner personal PC) with existing provider-side isolation (`dscc` / `agy` / `normal` in `utils/memory/consolidate.js`).
- **Root key separation, enrollment pinning, backup & rotation:**
  - Owner initialization generates a **dedicated vault root Ed25519 keypair** (`generateRootKeyPair()`), distinct from the owner device's `ed25519` key.
  - Non-owner `pnpm sync init` **requires** `--root-key <b64>` or `--root-fingerprint <16-hex>` out-of-band verification (silent TOFU is refused; explicit `--trust-vault-root` is required to accept TOFU).
  - `pnpm sync root export` / `import` encrypts/decrypts the root private key offline with `scrypt` (`N=32768, r=8, p=1`) + `ChaCha20-Poly1305` for disaster recovery.
  - `pnpm sync root rotate` publishes a dual-signed (`signedByOld` + `signedByNew`) entry in `registry.rootHistory`; `verifyRegistryChain()` verifies the full chain and automatically pins peers to the new root key.

### 3.3 Company Mac `receive` Workflow

1. Owner initializes vault on personal PC (`pnpm sync init --vault <private-repo> --compartments personal,home-private`) and backs up the root key (`pnpm sync root export`).
2. Company Mac initializes with MDM auto-suggested `receive` mode and explicit root verification (`pnpm sync init --vault https://... --zone work --compartments personal --root-fingerprint <16-hex>`).
3. Owner enrolls the company Mac (`pnpm sync device add --pubkey ...`).
4. Company Mac pulls on demand via standard HTTPS `git fetch` (`pnpm sync pull --dry-run` / `pnpm sync pull`). `push` is refused in `receive` mode; `home-private` batches are skipped; `machine` notes and secrets are refused; instruction-like payloads go to `memory/inbox.jsonl`.

---

## 4. Track 2 & Track 3 — OSC 7501 Interop & Host-Direct Web Push (`agy`-First)

### 4.1 Google Antigravity (`agy`) ToS Boundary

Google Antigravity ToS Section 6 prohibits third-party harnesses/wrappers or client impersonation. `kyoten` keeps `kyoten agy` strictly unmodified and interactive inside **Herdr** (or **Rex**) over **Tailscale**, integrating only through official lifecycle hooks (`utils/remote/hook.js`).

### 4.2 Track 2: OSC 7501 Status Hook (`utils/remote/osc7501.js`)

- Emits `\x1b]7501;state=<working|idle|blocked|done>:app=kyoten\x1b\\` to `stderr` only when `stream.isTTY` and explicitly enabled (`pnpm remote osc7501 on` or `KYOTEN_OSC7501=1`).
- Wired across Claude Code (`.claude/settings.json`), Codex (`.codex/hooks.json`), DSH (`.dsh/hooks.json`), and Antigravity (`.agents/hooks.json`) via `utils/harness/hooks.js`.
- Maps `agy` `Stop` with non-normal `terminationReason` to `blocked` and `NO_TOOL_CALL` / `model_stop` to `done`. Always fails open.

### 4.3 Track 3: Host-Direct E2EE Web Push & Static Subscribe PWA

- **Protocol (`utils/remote/webpush.js`, `notify-worker.js`):** Pure Node 24 RFC 8291 (`aes128gcm` ECDH P-256 + HKDF-SHA256) and RFC 8292 (VAPID ES256 JWT) delivered directly from the host via a detached background worker on `Stop` (throttled by `quietMs`, redacting secrets via `redactSecrets()`, blocking SSRF endpoints via `validatePushEndpoint()`, and pruning `404`/`410` subscriptions).
- **Visible alerts only:** iOS Safari and Android PWAs require user-visible notifications (`userVisibleOnly: true`); no silent background pushes are sent.
- **Static subscribe PWA (`utils/remote/subscribe-page.js`):**
  - Generates a self-contained static bundle (`index.html`, `sw.js`, `manifest.webmanifest`) via `pnpm remote push subscribe-page --out <dir>` or serves it strictly on loopback (`pnpm remote push subscribe-serve` behind `tailscale serve`).
  - Carries the VAPID public key exclusively in the URL `#fragment` (`#vapid=...`) so it never hits static host server logs, and persists it in `localStorage` so iOS Safari's "Add to Home Screen" preserves it when `#fragment` is stripped.

---

## 5. Deferred Optional Future Track — Structured Chat PWA Companion

If full structured mobile chat/approval UX outside Herdr is desired later, it will live in a separate opt-in companion package (`packages/remote` or dedicated repo) so core `kyoten` keeps its zero-dependency, offline-by-default guarantee and 2 MiB tarball budget:

- **Transport:** Tailscale Serve (`*.ts.net`) + Tailnet Lock + inner `Noise_IK` handshake (`@noble/curves` + `@noble/ciphers` + `@noble/hashes`) with periodic DH re-handshake; pluggable transport interface allowing an optional Nostr ephemeral relay plugin (explicit 64-bit counters + anti-replay window) if non-Tailscale hosts are ever needed.
- **Authorization & adapters:** Structured stdio adapters (`claude`/`dscc` via `--permission-prompt-tool` or `PermissionRequest` approval bridge, `codex app-server`, DSH), hard-blocking remote `--dangerously-skip-permissions`, scoped allowed directories, audit log, and local kill switch. `agy` remains excluded from remote wrapper execution.

---

## 6. Threat Model Summary

| Threat                                         | Mitigation & Residual Risk                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Git vault host compromise**                  | Vault stores only ChaCha20-Poly1305 ciphertext and non-secret metadata (`deviceId`, `compartment`, `seq`, `createdAt`). Ed25519 signatures + SHA-256 `prevHash` chain detect tampering, rollback, or truncation.                                                                                                         |
| **Enrollment MITM on vault repo**              | Non-owner `init` refuses silent TOFU and requires out-of-band `--root-key` or `--root-fingerprint` verification (`--trust-vault-root` must be passed explicitly).                                                                                                                                                        |
| **Root key loss or compromise**                | Root Ed25519 key is separate from device keys, exportable via `scrypt`-encrypted offline backup (`root export`/`import`), and rotatable via dual-signed `rootHistory` (`root rotate`).                                                                                                                                   |
| **Stolen or compromised work Mac**             | Work Mac is `receive`-only and restricted to `personal` compartment; it cryptographically cannot decrypt `home-private` notes, and cannot push poisoned ops unless enrolled with `full` mode.                                                                                                                            |
| **Revoked / stolen active device**             | `devices.json.sig` revocation excludes the device from future CEK wrapping and peers reject post-revocation batches. _Residual trade-off:_ an offline-readable vault does not provide retroactive forward secrecy for already-synced historical batches; periodic snapshot compaction + rotation limits future exposure. |
| **Prompt injection over sync**                 | `pullSync()` runs `assertNoSecrets()`, `looksLikeInstruction()`, and `injectionsIn()`, quarantining suspicious ops/personas into `memory/inbox.jsonl` for human review.                                                                                                                                                  |
| **Web Push SSRF / secret leak**                | `validatePushEndpoint()` refuses non-HTTPS, embedded credentials, localhost, and RFC1918/link-local/CGNAT IPs; `buildAlertPayload()` runs `redactSecrets()`.                                                                                                                                                             |
| **Static subscribe page host trust**           | Serving locally via `pnpm remote push subscribe-serve` + `tailscale serve` avoids third-party static-host JS trust; if hosted publicly (e.g. GitHub Pages), the VAPID public key in `#fragment` is public by design and contains no private material.                                                                    |
| **Corporate EDR/DLP & LLM provider plaintext** | `receive` mode uses only standard HTTPS `git fetch` on demand; local inference/provider plaintext visibility remains governed by existing provider-side isolation (`dscc`/`agy`/`normal`).                                                                                                                               |
