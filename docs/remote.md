# Remote & E2EE Sync (`pnpm sync`)

Kyoten splits cross-machine continuity and mobile/remote ergonomics into three independent trust planes and decoupled tracks, preserving core `kyoten`'s zero-runtime-dependency, offline-by-default guarantee and strict Google Antigravity (`agy`) ToS compliance.

See [DESIGN_kyoten-remote.md](DESIGN_kyoten-remote.md) for the complete architecture, Hybrid Logical Clock (HLC) replay spec, key-rotation chain, and threat model.

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

- `devices.json` + `devices.json.sig`: dedicated-root-signed (`Ed25519`) device registry with trust zones (`personal`, `work`), allowed compartments (`personal`, `home-private`, `work`), `rootHistory` rotation chain, epoch, and revocation timestamps.
- `ops/<deviceId>/<seq>-<compartment>.enc.json`: per-device append-only encrypted batches (no Git merge conflicts), chained with SHA-256 (`prevHash` → `batchHash`), signed with the author's `Ed25519` device key, and multi-recipient wrapped via ephemeral `X25519` + `HKDF-SHA256` + `ChaCha20-Poly1305`.

### Quick Start

On your primary personal machine (vault owner):

```bash
pnpm sync init --vault git@github.com:<you>/kyoten-vault.git --name home-pc --compartments personal,home-private
pnpm sync root export --out /path/to/offline-backup/vault-root.enc.json --passphrase-env KYOTEN_SYNC_PASSPHRASE
pnpm sync root show
pnpm sync push
```

On a secondary or corporate machine (MDM detection suggests `receive` automatically; `--root-fingerprint` or `--root-key` prevents TOFU attacks):

```bash
pnpm sync init --vault https://github.com/<you>/kyoten-vault.git --name work-mac --zone work --mode receive --compartments personal --root-fingerprint <16-hex-from-owner>
# Copy memory/sync/device-pub.json to the owner machine, then enroll:
pnpm sync device add --pubkey /path/to/device-pub.json
# On work-mac:
pnpm sync pull --dry-run
pnpm sync pull
```

### Root Key Recovery & Rotation

- **Offline backup (`root export` / `root import`):** Encrypts the dedicated root Ed25519 private key with `scrypt` + `ChaCha20-Poly1305` so another enrolled device can recover admin authority if the original owner machine is lost.
- **Rotation (`root rotate`):** Publishes a dual-signed (`signedByOld` + `signedByNew`) record in `devices.json` (`rootHistory`), which peers verify and follow automatically.

### Receive-Side Zero-Trust Protections

- `scope === 'machine'` ops are always refused.
- Every note, personalization setting, and persona is checked against `findSecrets()` (`utils/redact.js`).
- Notes matching `looksLikeInstruction()` or personas matching `injectionsIn()` are **quarantined** into `memory/inbox.jsonl` for manual review instead of entering active context.
- Every `pull` that changes memory takes a snapshot (`reason: 'sync'`), so `pnpm memory undo` reverts the pull cleanly.
- Conflicting cross-machine edits resolve deterministically via Hybrid Logical Clock (`hlc`) + per-field LWW even when device wall clocks are skewed.
