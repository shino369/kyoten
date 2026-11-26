# Remote & E2EE Sync (`pnpm sync` and `pnpm remote`)

Kyoten splits cross-machine continuity and mobile/remote ergonomics into three independent planes and decoupled tracks, preserving core `kyoten`'s zero-runtime-dependency, offline-by-default guarantee and strict Google Antigravity (`agy`) ToS compliance.

## Architecture: Three Trust Planes

| Plane                   | Contents                                                                                                                             | Mechanism                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Code / Harness**   | `AGENTS.md`, `.claude/`, `.codex/`, `.agents/`, `.dsh/`, `utils/`, `package.json`                                                    | Git + signed commits + `kyoten update` / manual review only. Never auto-synced.                                                                                 |
| **2. Memory & Persona** | `user` notes, opted-in `repo` notes, `personalization.json`, `persona.<agent>.md`                                                    | **`pnpm sync`**: signed, compartmentalized E2EE Git Vault (`Ed25519` + `X25519` + `ChaCha20-Poly1305`) with secret refusal and `memory/inbox.jsonl` quarantine. |
| **3. Machine-Local**    | `machine` notes, `dscc.env`, `memory/config.json`, `memory/sync/identity.json`, `memory/remote/config.json`, `extract/`, `.mcp.json` | Strictly local. Never exported or pushed.                                                                                                                       |

---

## Track 1: `pnpm sync` — Zero-Trust E2EE Git Vault

Pure Node.js 24 native crypto (`node:crypto`): zero external packages, zero background daemon, zero VPN requirement. Safe on corporate Macs in `receive` mode over standard HTTPS `git fetch`.

### Vault Layout

- `devices.json` + `devices.json.sig`: root-signed (`Ed25519`) device registry with trust zones (`personal`, `work`), allowed compartments (`personal`, `home-private`, `work`), epoch, and revocation timestamps.
- `ops/<deviceId>/<seq>-<compartment>.enc.json`: per-device append-only encrypted batches (no Git merge conflicts), chained with SHA-256 (`prevHash` → `batchHash`), signed with the author's `Ed25519` device key, and multi-recipient wrapped via ephemeral `X25519` + `HKDF-SHA256` + `ChaCha20-Poly1305`.

### Quick Start

On your primary personal machine (vault owner):

```bash
pnpm sync init --vault git@github.com:<you>/kyoten-vault.git --name home-pc --compartments personal,home-private
pnpm sync push
```

On a secondary or corporate machine (MDM detection suggests `receive` automatically):

```bash
pnpm sync init --vault https://github.com/<you>/kyoten-vault.git --name work-mac --zone work --mode receive --compartments personal
# Copy memory/sync/device-pub.json to the owner machine, then enroll:
pnpm sync device add --pubkey /path/to/device-pub.json
# On work-mac:
pnpm sync pull --dry-run
pnpm sync pull
```

### Receive-Side Zero-Trust Protections

- `scope === 'machine'` ops are always refused.
- Every note, personalization setting, and persona is checked against `findSecrets()` (`utils/redact.js`).
- Notes matching `looksLikeInstruction()` or personas matching `injectionsIn()` are **quarantined** into `memory/inbox.jsonl` for manual review instead of entering active context.
- Every `pull` that changes memory takes a snapshot (`reason: 'sync'`), so `pnpm memory undo` reverts the pull cleanly.

---

## Track 2 + 3: `pnpm remote` — OSC 7501 & Host-Direct Web Push (`agy`-First)

Instead of wrapping `agy -p` or `agy acp` (prohibited by Google Antigravity ToS for third-party harnesses), `kyoten` pairs **unmodified interactive `kyoten agy`** with official lifecycle hooks (`utils/remote/hook.js`) for:

1. **OSC 7501 Status Interop** (`working` / `idle` / `blocked` / `done`) for **Herdr** / **Rex** over **Tailscale**.
2. **Host-Direct E2EE Web Push (RFC 8291 `aes128gcm` + RFC 8292 VAPID ES256)** sent directly from the host to the phone's push endpoint with no central relay server.

### Setup for Unmodified `kyoten agy` + Herdr + Tailscale

1. Enable OSC 7501 status emission (or export `KYOTEN_OSC7501=1` inside Herdr/Rex):
   ```bash
   pnpm remote osc7501 on
   ```
2. Optional host-direct Web Push alerts when an agent stops or blocks for input:
   ```bash
   pnpm remote vapid init --subject mailto:you@example.com
   pnpm remote push add --endpoint <push-url> --p256dh <key> --auth <secret> --label phone
   pnpm remote push on
   pnpm remote push test --dry-run
   ```
3. Run `kyoten agy` interactively inside a Herdr workspace over Tailscale. `utils/remote/hook.js` stays completely silent unless OSC 7501 or Web Push is explicitly enabled, never logs secrets (payloads run through `redactSecrets()`), validates push endpoints against SSRF, and prunes expired `404`/`410` subscriptions automatically.

---

## Deferred Optional Scope

The optional custom structured chat PWA (`claude`/`dscc`/`codex` stdio adapters + Noise_IK over Tailscale Serve in a separate companion package) remains deferred and out of core `kyoten` until needed.
