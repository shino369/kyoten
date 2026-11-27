# Kyoten

![Kyoten](./docs/images/kyoten-logo.png)

> **Your personal home base for AI coding agents** — one shared workspace for programming, documentation, research, translation, and generative-AI work. ✨

[![Test CI](https://github.com/shino369/kyoten/actions/workflows/test.yml/badge.svg)](https://github.com/shino369/kyoten/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

🌐 **English** · [日本語](./README.ja.md) · [繁體中文](./README.zh-TW.md)

---

**Kyoten** (_拠点_, Japanese for "home base" or "operations hub") brings all of your AI-agent setup into one clean, portable repository. Instead of repeating rules, hooks, skills, and memory across every tool, you configure your home base once and work seamlessly with **Claude Code**, **Codex**, **Antigravity CLI (`agy`)**, and **DeepSeek Harness (`dsh`)**.

Everything runs on plain Node.js ESM with zero runtime dependencies and no build step. Use the kyoten launcher or work directly from a clone.

## ✨ Why Kyoten?

- **🤝 One Home Base, Four Harnesses** — Canonical instructions (`AGENTS.md`), shared hooks (`utils/harness/hooks.js`), and synced role prompts across Claude Code, Codex, Antigravity CLI (`agy`), and DeepSeek Harness (`dsh`), kept in sync with `pnpm harness sync`.
- **📝 Task Continuity & Clean-Context Reviews (`pnpm task`)** — Per-session active task tracking (`plan.md`, `state.json`, `NOTES.md`), step dependencies, verification gates, and an independent 2-round review + triage loop.
- **🧠 Local Personal Memory & Personalization (`pnpm memory`)** — Machine-local, git-ignored memory with core-block injection, prompt/failure recall, multi-agent background extraction and consolidation, and customizable agent voice (`pnpm memory personalize`).
- **🚀 Multi-Agent Orchestration (`pnpm agent`, `pnpm loop`, `pnpm swarm`)** — Ask another agent for a headless second opinion, run unattended fix-and-review loops in a git worktree, or parallelize ready steps across worktrees with a clean context.
- **🧩 Modular Skills Ecosystem (`skills-lock.json`)** — Tracked workspace skills plus pinned external skills (including portable skills from [`shino369/kyoten-skills`](https://github.com/shino369/kyoten-skills)), managed cleanly with `pnpm skills:install`, `pnpm skills:check`, and `pnpm skills:link`.
- **🛡️ Built-in Guardrails & Quality Gate (`pnpm check`)** — Secret protection, undoable deletion (`pnpm task rm`), supply-chain hardening, cross-harness git hooks, TypeScript typechecking, ESLint, Prettier, and Vitest with a 95% coverage floor.

> 📖 Looking for every command and flag? Check the generated [CLI Reference](docs/cli.md) and the full architecture walkthrough in [docs/harness.md](docs/harness.md).

## 📋 Requirements

- **Node.js 24 or later** (`.nvmrc` pins 24; `agent-browser` requires 24+)
- **pnpm 12.14.0**, pinned in `package.json` via Corepack — run `corepack enable`, or prefix commands with `corepack pnpm`
- **Chrome / Chromium** _(optional)_ — for Playwright e2e tests and browser-driving skills
- **`uv`** _(optional; `>= 0.9.17` for pinned creative skills)_ — for the `browser-use` runtime and Python 3.12 skill scripts (`skill-creator`, and optional creative skills: `transparent-background`, `game-image-extraction`, `psd-flats-cleanup`, `live2d-from-image`)
- **`gh` CLI** _(optional)_ — for GitHub workflows and PR reviews

## 🚀 Getting Started

With Node.js, Git, and pnpm available, initialize a managed home and launch your agent.

```bash
npx kyoten init
npx kyoten            # Claude Code (default), or: codex | dsh | dscc | agy
```

To work directly from a clone, run setup in the repository.

```bash
git clone https://github.com/shino369/kyoten.git
cd kyoten
corepack enable
pnpm workspace:setup   # install deps + pinned skills, link skills, enable git hooks, init memory
pnpm workspace:check   # verify setup; every failure prints a Fix command
```

Optional setup flags:

- `--with-browsers` — install `agent-browser` and Playwright Chromium
- `--skip-skills` — skip external skill downloads when offline
- `--target <dir>` — link skills into another harness's skill folder

See `.agents/skills/workspace-setup/SKILL.md` for troubleshooting.

Run the full quality gate for typechecking, linting, format checks, and tests with coverage.

```bash
pnpm check
```

Start the agent inside this directory or use `pnpm kyoten [<agent>]` to launch from the clone.

## The kyoten launcher

`kyoten` starts an agent **in the home** (a kyoten workspace: `~/.kyoten`, or a clone you register),
so the hooks, tasks, memory, skills, and roles work exactly as in a clone, whatever folder you start
it from. Everything after the agent word goes to the agent unchanged, and kyoten never adds a
permission-bypass flag. Full guide: [docs/kyoten.md](docs/kyoten.md).

| Command                                          | Does                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `kyoten [claude\|codex\|dsh\|dscc\|agy] [args…]` | Start the agent in the home (`claude` by default; `kyoten -c` is `claude -c`)                            |
| `kyoten init [<dir>] [--memory on\|off]`         | Create a home and install it; with `<dir>`, make it the default home (an existing clone is not copied)   |
| `kyoten update`                                  | Merge a newer snapshot into a home kyoten created; your own commits are kept (a clone uses `git pull`)   |
| `kyoten doctor`                                  | Check prerequisites, agents, trust, memory saving, DSH, the dscc key, then `pnpm workspace:check`        |
| `kyoten run <script> [args…]`                    | Run a workspace script in the home from any folder: `kyoten run task status`                             |
| `kyoten where` · `kyoten config …`               | Print the home and the rule that chose it · show or change the config (`home`, `args.<agent>`, `addDir`) |
| `kyoten reset [--all]`                           | Move a home kyoten created aside (renamed, never deleted; the undo is printed)                           |
| `kyoten backup` · `kyoten restore <dir>`         | A backup folder of memory, tasks, config, and local commits · bring it back, merging, never overwriting  |
| `kyoten dscc --set-key` · `--show`               | Save the DeepSeek API key outside every workspace · print the profile with the key masked                |

- **Projects outside the home.** Started inside another git repository, `kyoten`, `kyoten codex`,
  `kyoten dscc`, and `kyoten agy` add `--add-dir=<repository>` so the agent can edit it while its
  hooks, tasks, and memory stay in the home (`--no-add-dir` or `"addDir": false` turns it off; a
  repository at or above your user folder `~` is never added). For multi-step work there:
  `pnpm task new … --repo <path>`.
- **DSH:** in the Web UI, click **Choose workspace** and select the home (`kyoten dsh` prints it); a
  session in another workspace is told so at its start.
- **What it costs.** Hooks, the audit log, and the formatter are local. The Stop loop runs your
  tests on code tasks, review rounds use subagents on your plan, and memory extraction (only when
  saving is on) is one background call per session end.
- **Updates never overwrite.** A home kyoten created is a git repository: `kyoten/upstream` holds
  the snapshots, `main` holds them plus your commits, and `kyoten update` merges.

## 🗂️ Repository Layout

```text
.
├── .agents/
│   ├── agents/              # Generated Antigravity role prompts (pnpm harness sync)
│   ├── hooks.json           # Generated Antigravity hooks config
│   └── skills/              # Skills: project-owned (tracked) + external (git-ignored)
├── .claude/
│   ├── agents/              # Canonical role prompts / subagents
│   ├── hooks/               # Hook entry points (task brief, context monitor, audit, format)
│   ├── rules/               # Path-scoped rules (scripts, tests)
│   ├── skills/              # Links into .agents/skills (generated, git-ignored)
│   └── workflows/           # Saved Claude Code workflows (review, implement-plan, research)
├── .codex/                  # Generated Codex hooks, rules, and role prompts
├── .dsh/                    # Generated DSH hooks and workspace patch overlay
├── .githooks/               # pre-commit + commit-msg (all harnesses)
├── docs/
│   ├── cli.md               # Generated CLI reference (pnpm docs:cli)
│   ├── harness.md           # Full harness architecture & worked examples
│   ├── kyoten.md            # Launcher and managed-home guide
│   └── testing/             # Deep testing & mocking guides
├── e2e/                     # Playwright e2e tests
├── tasks/                   # Machine-local task folders (git-ignored)
├── templates/task/          # plan / NOTES / REVIEW / STUDIES templates for pnpm task
├── tools/                   # catalog.json (tracked) + local.json (this machine, git-ignored)
├── utils/                   # Shared Node ESM utilities (task, memory, harness, loop, swarm, agent, tools)
├── AGENTS.md                # Canonical instructions for every agent harness
├── CLAUDE.md                # @AGENTS.md + Claude-Code-only notes
├── skills-lock.json         # Pinned external skills lockfile (skills.sh)
└── ...
```

External skills are not committed to git. `pnpm skills:install` installs the recommended set from `skills-lock.json` into `.agents/skills/` (git-ignored), so you stay in control of what lands on your machine.

## 🤖 Supported Harnesses & Orchestration

| Harness                      | Instructions                                                | Skills & Integration                                                               |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Claude Code**              | `CLAUDE.md` → `@AGENTS.md`                                  | `.claude/skills/` links, `.claude/settings.json`, hooks, subagents                 |
| **Codex**                    | `AGENTS.md`                                                 | `.agents/skills/` (native), `.codex/hooks.json`, `.codex/rules/`, `.codex/agents/` |
| **Antigravity CLI (`agy`)**  | `AGENTS.md` (≤ 24,000 bytes)                                | `.agents/skills/` (native), `.agents/hooks.json` (6 events), `.agents/agents/`     |
| **DeepSeek Harness (`dsh`)** | `AGENTS.md` (start with `--patch .dsh/workspace.patch.yml`) | `.agents/skills/`, `.dsh/hooks.json`, Claude hooks bridge _(partly tested)_        |

Run `pnpm harness sync` to regenerate harness configs from the canonical sources and `pnpm harness check` to verify they match. The git hooks in `.githooks/` enforce formatting, linting, and Conventional Commits for every harness, and `pnpm task status` prints the same resume brief that `SessionStart` injects.

### 🛠️ Tools & Calling Other Agents

`pnpm tools scan` detects agents, CLIs, and runtimes installed on this machine and saves them to `tools/local.json` (git-ignored) against `tools/catalog.json`. `SessionStart` includes a one-line tool summary so every agent knows what it can delegate to.

```bash
pnpm tools list --all                                   # see installed tools and install hints
pnpm tools add dsh --kind agent --command "npx -y @deepseek-ai/dsh"
pnpm agent ask --agent codex "Review utils/task/loop.js for edge cases"   # read-only second opinion
pnpm loop my-task --agent codex --max 3                 # unattended fix-until-green in a worktree
pnpm loop my-task --agent codex --review --reviewer claude   # + independent review rounds & fixes
pnpm swarm my-task --agent claude --workers 2           # parallel workers, one worktree per step
```

Every headless child runs with `MEMORY_EXTRACT=1` (keeping memory hooks silent and sessions out of the extraction queue), and `pnpm loop` / `pnpm swarm` worktrees omit `AGENTS.local.md` and `CLAUDE.local.md` so reviews and fixes always start with a clean context.

## 📝 Tasks & Review Loop

Generated work lives in `tasks/<task-name-yymmdd>/`, managed via `pnpm task` so any agent — or you — can pause, hand off, and resume without losing the thread:

```bash
pnpm task new some-task --goal "Translate the X post" --step "Draft" --step "Proofread" --verify "pnpm check"
pnpm task step s1 start            # … work …
pnpm task step s1 done -m "draft in translated/"
pnpm task note --done "drafted" --next "proofread section 2"
pnpm task status                   # resume brief: goal, next step, last note, verify, git
```

```text
tasks/some-task-260101/
├── plan.md                        # goal, acceptance, generated steps, decisions
├── state.json                     # machine state (managed only via pnpm task)
├── NOTES.md                       # append-only progress log
├── reviews/REVIEW_some-task.md    # pnpm task template review
├── studies/STUDIES_some-task.md   # pnpm task template study
└── scripts/ docs/ translated/ tmp/
```

Each session binds its own active task (with `tasks/.active` as the default for new sessions). `SessionStart` injects the resume brief automatically across supported harnesses, and code tasks follow a structured quality loop: **plan → test-first build → clean-context review (`pnpm task review`) → independent triage → fix** (up to 2 rounds). Full details live in `AGENTS.md` §4 and [docs/harness.md](docs/harness.md). `tasks/` and `logs/` are git-ignored — tasks stay personal to each machine.

## 🧠 Local Personal Memory & Personalization

Agents remember lasting preferences, machine workarounds, and repo facts across sessions and harnesses — strictly on your machine (`memory/`, `AGENTS.local.md`, and `CLAUDE.local.md` are git-ignored; nothing is ever pushed):

```bash
pnpm memory init                    # once (pnpm workspace:setup runs it)
pnpm memory                         # status: notes, core block, saving on/off, extraction queue
pnpm memory add "The user prefers design first, then review." --scope user --type preference --tags design,review
pnpm memory recall "how do I merge this PR"   # preview what the hooks would inject
pnpm memory personalize --presets   # set how agents talk to you (chat only, never code/commits)
pnpm memory personalize --language "Japanese"   # keep your reply language even when writing in English
pnpm memory personalize --guard ja              # send a reply that slipped out of Japanese back once (ja|zh|off)
pnpm memory personalize --persona-file persona.md   # load a longer markdown persona
# or edit memory/persona.md directly: pnpm memory init (and workspace:setup) apply your edits
pnpm memory personalize --off       # pause saved response personalization
pnpm memory personalize --on        # resume in new sessions
pnpm memory off --session           # incognito session (no saving)
pnpm memory export                  # checksummed .tar.gz backup; restore via import <file> --dry-run
```

- **Multi-agent background jobs:** Extraction, weekly consolidation, and persona compact/audit run on the **session's own agent CLI** (`claude`, `codex`, `dsh`, or `agy`) by default — or on a chosen CLI via `pnpm memory set --extract-agent <agent>`.
- **Zero-tool isolation:** Memory jobs run in an empty temp folder with tools disabled. Codex runs out of the box when zero MCP servers are configured (if you configure Codex MCP servers, it fails closed and prints a `Fix:` command to switch `--extract-agent`); Claude, Codex, and Antigravity isolation flags avoid double quotes so Windows `.cmd` shims work cleanly.
- **Pausing saves:** Running `pnpm memory off` pauses both extraction and weekly consolidation (manual `pnpm memory consolidate` refuses unless `--force` is passed; `--dry-run` is always allowed).
- **Managed homes:** A new home starts with automatic saving off unless you opt in at setup. Enable it later with `kyoten run memory on`.
- **Per-agent personas:** Set one with `pnpm memory personalize --for <claude|codex|ds|agy> --persona-file persona.md`. The launcher's hooks apply the selected persona per session. The `ds` persona serves both DSH and dscc.

See `AGENTS.md` §13 and [docs/harness.md](docs/harness.md) for the full memory lifecycle.

## 🧩 Skills

### 🏠 Project-owned skills

| Skill             | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `workspace-setup` | Initialise or repair this workspace (deps, skills, links, hooks, memory).     |
| `context-manager` | Context-degradation prevention and recovery alongside the context monitor.    |
| `web-browsing`    | Tool selection and workflows for web interaction, real-browser sessions, e2e. |

### 📦 External skills (`skills-lock.json`)

External skills are not committed. Install the recommended set with `pnpm skills:install`; each skill is installed locally into the git-ignored `.agents/skills/`. Sources and hashes are pinned in `skills-lock.json`; each upstream repository ships its own license.

#### ✨ Kyoten Skills ([shino369/kyoten-skills](https://github.com/shino369/kyoten-skills), MIT)

Included by default (`skills-lock.json`):

| Skill                   | Category       | What it does                                                                                |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `dependency-update`     | `dependencies` | Dependabot-style pnpm updates with `analyze_deps.mjs`.                                      |
| `security-update`       | `dependencies` | CVE and audit patching with release-age checks.                                             |
| `translation-expertise` | `translation`  | EN ↔ JA ↔ zh-TW house styles, 1:1 structural parity, and Taiwan/JA terminology trap guards. |

Opt-in (`creative/*`, not included in `skills-lock.json` — install locally without modifying `skills-lock.json` using `pnpm skills:add shino369/kyoten-skills --skill <name>`):

| Skill                    | Category   | What it does                                                                                                                                                                                                    |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transparent-background` | `creative` | Flat-background image → transparent PNG with clean edges; specks and recolour.                                                                                                                                  |
| `game-image-extraction`  | `creative` | Extract, convert, and verify Unity (`*_Data`/Addressables) and KiriKiri2/Z (`.xp3`) art.                                                                                                                        |
| `psd-flats-cleanup`      | `creative` | Clean up rough flats in a layered 8-bit RGB PSD to follow lineart (editable PSD copy + review PNG). By [staryume](https://github.com/staryume) ([Coloring Helper](https://github.com/staryume/ColoringHelper)). |
| `live2d-from-image`      | `creative` | Turn character illustrations or sprite parts into Live2D Cubism v5 models (`.moc3`, VTube Studio, WebGL, GIF) via See-through + PSD2Live.                                                                       |

#### 🌐 Browser & Web

| Skill            | What it does                                                                   | Source                                                                    | Credit      |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------- |
| `agent-browser`  | Browser automation CLI: navigation, forms, screenshots, scraping, app testing. | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs |
| `browser-use`    | Direct browser control over CDP: automation, scraping, screenshots.            | [browser-use/browser-use](https://github.com/browser-use/browser-use)     | Browser Use |
| `playwright-cli` | Playwright browser automation and e2e test workflows.                          | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)   | Microsoft   |

> Browser-tool selection is defined in `AGENTS.md` §8: `agent-browser` is the default for ad-hoc interaction, `browser-use` covers autonomous / Python / real-Chrome / cloud work, and Playwright is reserved for e2e tests.

#### 🛠️ Engineering Workflow

| Skill             | What it does                                                                | Source                                                    | Credit      |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| `code-review`     | Two-axis review (repo standards + originating spec) in parallel sub-agents. | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `diagnosing-bugs` | Structured diagnosis loop for hard bugs and performance regressions.        | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `tdd`             | Test-driven development with red-green-refactor.                            | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |

#### 🎨 Meta & Tooling

| Skill           | What it does                                        | Source                                                    | Credit    |
| --------------- | --------------------------------------------------- | --------------------------------------------------------- | --------- |
| `skill-creator` | Create, edit, benchmark, and optimise agent skills. | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic |

Personal or optional skills (for example `i-have-adhd`) are not in the recommended lock. Install them individually with `pnpm dlx skills add ayghri/i-have-adhd --skill i-have-adhd --copy --agent claude-code`.

> All third-party skills remain under their upstream licenses. Installed copies do not include license files except `skill-creator`, which ships `LICENSE.txt` at `.agents/skills/skill-creator/LICENSE.txt`; check the source repositories above for the others.

### ⚙️ Managing skills

Project-owned skills live in `.agents/skills/` and are committed to this repository. To add one, follow "Adding a project-owned skill" in `.agents/skills/workspace-setup/SKILL.md`.

External skills are **not committed**. Install the recommended set from `skills-lock.json` with Vercel's [`skills` CLI](https://github.com/vercel-labs/skills) (the [skills.sh](https://skills.sh) ecosystem):

```bash
pnpm skills:install                                     # install everything in skills-lock.json (+ skills-lock.local.json)
pnpm skills:install --skip <name>                       # skip optional skills
pnpm skills:install --only <name>                       # install only the named skills (comma-separated)
pnpm skills:add <owner/repo> --skill <name>...          # install opt-in skills locally (skills-lock.local.json)
pnpm skills:update                                      # update installed skills
pnpm skills:check                                       # verify lock entries are installed
pnpm skills:link                                        # (re)link .agents/skills into .claude/skills
```

Installation uses skills.sh's default layout with `--agent claude-code codex`: the real files land in `.agents/skills/<name>/` (read natively by Codex and Antigravity) and `.claude/skills/<name>` is a relative symlink to them. `skills:link` creates the same links for project-owned skills, migrates old copied installs, prunes stale links, and falls back to directory junctions on Windows. External installs remain untracked; commit `skills-lock.json` whenever you intentionally change default workspace skills. `skills:check` verifies every entry in `skills-lock.json` (and git-ignored `skills-lock.local.json` if present) is installed with a matching frontmatter name.

The lock's hash is a source snapshot hash, not reproducible from the installed copy, so review content changes via `git diff`. On Windows, `skills:update` may exit 127 after a successful update due to an upstream crash — verify the files changed before treating it as a failure.

To install an opt-in skill locally without dirtying tracked `skills-lock.json`, run `pnpm skills:add <owner/repo> --skill <name>`. It records the entry in git-ignored `skills-lock.local.json`, restores `skills-lock.json`, and runs `pnpm skills:link` automatically (pass `--tracked` to keep it in `skills-lock.json` instead).

### 🔧 Skill runtime prerequisites

Most skills are instructions only. These require a local runtime:

| Skill                               | Runtime                                                                                                  | Check / install                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser`                     | `agent-browser` CLI                                                                                      | `pnpm exec agent-browser --version`; run `pnpm exec agent-browser install` once, then `pnpm exec agent-browser ...` (devDependency)                     |
| `browser-use`                       | `browser-use` CLI                                                                                        | `browser-use --version`; install with `uv tool install --python 3.12 browser-use`                                                                       |
| `playwright-cli`                    | local Playwright                                                                                         | `pnpm exec playwright --version`; run `pnpm exec playwright cli ...`                                                                                    |
| `skill-creator`                     | Python 3.12 + PyYAML                                                                                     | `uv run --with pyyaml --python 3.12 python ...` from the skill directory                                                                                |
| `transparent-background` _(opt-in)_ | `uv` >= 0.9.17 (Python 3.12 + Pillow, NumPy, SciPy)                                                      | Use the pinned `ia` helper in `.agents/skills/transparent-background/SKILL.md` (`ia --help`) from a trusted folder                                      |
| `game-image-extraction` _(opt-in)_  | `uv` >= 0.9.17 (Python 3.12 + Pillow, optional `UnityPy`)                                                | Use the pinned `ge` / `geu` helpers in `.agents/skills/game-image-extraction/SKILL.md` (`ge --help`) from a trusted folder                              |
| `psd-flats-cleanup` _(opt-in)_      | `uv` >= 0.9.17 (Python 3.12 + `psd-tools`, Pillow, NumPy, SciPy)                                         | Use the pinned `pfc` helper in `.agents/skills/psd-flats-cleanup/SKILL.md` (`pfc --help`) from a trusted folder                                         |
| `live2d-from-image` _(opt-in)_      | `uv` >= 0.9.17 (Python 3.12 + Pillow, NumPy, SciPy, `psd-tools`), See-through, PSD2Live 3.8.4+, Node 24+ | Use the pinned `l2d` helper in `.agents/skills/live2d-from-image/SKILL.md` (`l2d --help`) from a trusted folder; set `PSD2LIVE_DIR` or pass `--p2l-dir` |
| `dependency-update`                 | `gh` CLI                                                                                                 | `gh --version`; install from <https://cli.github.com/> (also used for PR attachments)                                                                   |
| Playwright e2e                      | Chromium                                                                                                 | `pnpm exec playwright install chromium`                                                                                                                 |

`npm` commands are blocked in this workspace. Use `pnpm dlx` for one-off CLIs, `pnpm add -D` + `pnpm exec` for project-local binaries, and `uv tool` / `uvx` for Python CLIs. Avoid `pnpm add -g`: global installs bypass the workspace lockfile and supply-chain settings.

The `browser-use` skill comes from [browser-use/browser-use](https://github.com/browser-use/browser-use) and requires its `browser-use` CLI (which pulls in `browser-harness` as a pinned dependency). The `agent-browser` skill is invoked via `pnpm exec agent-browser ...` because no global shim is installed.

Browser skills that attach to local Chrome need its CDP endpoint: either enable `chrome://inspect/#remote-debugging`, or launch an isolated Chrome with `--remote-debugging-port=9222 --user-data-dir=<profile>` and set `BU_CDP_URL=http://127.0.0.1:9222` for `browser-use`.

## 🎭 Agents & Rules

### Role Prompts (`.claude/agents/`)

Canonical role prompts live in `.claude/agents/*.md` and sync to `.codex/agents/*.toml` and `.agents/agents/*.md` via `pnpm harness sync`:

| Agent                   | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `planner`               | Turns a goal into small, verifiable steps with deps (`pnpm task`).    |
| `verifier`              | Independent PASS/FAIL: runs verify, checks acceptance and tests.      |
| `reviewer`              | Clean-context review round from a brief; findings for triage.         |
| `security-reviewer`     | Security-focused review: auth, injection, XSS, secrets, dependencies. |
| `test-runner`           | Runs tests and reports failures and coverage.                         |
| `trilingual-translator` | EN / JA / zh-TW translation in initial, proofread, and refine roles.  |

### Path-Scoped Rules (`.claude/rules/`)

Always-on guidance lives in `AGENTS.md` so every harness sees it. `.claude/rules/` keeps path-scoped rules that Claude Code auto-loads and `AGENTS.md` directs other agents to read:

| Rule                  | Scope      | Purpose                                    |
| --------------------- | ---------- | ------------------------------------------ |
| `testing`             | Test files | Vitest, 95% coverage floor, mocking.       |
| `working-with-script` | Scripts    | Node-first scripts, error handling, tests. |

## 🪝 Hooks

<p align="center">
  <img src="./docs/images/kyoten-hooks.png" alt="Gemini-chan laughing off a Stop hook coverage-lock collision" width="400" />
</p>

Shared hook logic lives in `utils/harness/hooks.js` and `.claude/hooks/`, wired into Claude Code, Codex, Antigravity CLI, and DSH via `pnpm harness sync`:

| Hook                   | Event                                                                                | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `session_start.js`     | `SessionStart`                                                                       | Injects the active task's resume brief and available tools summary.      |
| `pre_compact.js`       | `PreCompact`                                                                         | Appends a checkpoint to the task's `NOTES.md`.                           |
| `task_loop.js`         | `Stop`, `UserPromptSubmit`                                                           | Inner loop: verify, then guide through the clean-context review loop.    |
| `context_monitor.js`   | `UserPromptSubmit`                                                                   | Warns at 20% / 40% / 60% of the context window.                          |
| `audit_logger.js`      | `PostToolUse` (`*`)                                                                  | Logs tool use to `logs/<YYYYMMDD>/logging.jsonl`.                        |
| `auto_format.js`       | `PostToolUse` (`Edit\|Write`)                                                        | Runs Prettier on edited files.                                           |
| `guard.js`             | `PreToolUse`                                                                         | Blocks secret access, `rm`, `npm`, and destructive git commands.         |
| `utils/memory/hook.js` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `SessionEnd` | Memory core block, prompt/failure recall, announcements, and extraction. |

The context monitor defaults to a 1M window; set `CLAUDE_CONTEXT_WINDOW` to override it.

## 🌍 Translation

Ask your agent to translate, or invoke the `trilingual-translator` subagent. The `translation-expertise` skill supplies house styles, 1:1 structural parity rules, and JA / zh-TW terminology trap guards:

- English ↔ Japanese (`日本語`) ↔ Traditional Chinese (`繁體中文`, Taiwan defaults)
- Optional 3-stage **initial → proofread → refine** workflow writing drafts to the task's `translated/` folder
- File and URL sources: fetch tools for static pages; `agent-browser` / `browser-use` for JS-heavy pages (Playwright stays reserved for e2e tests)

## 🧪 Testing

Unit and integration tests use **Vitest**. Across the measured suite, including `utils/`, `.claude/hooks/`, and project-owned `.agents/skills/`, the coverage floor is **95%** for statements, branches, functions, and lines.

```bash
pnpm test
pnpm test:coverage   # enforces the 95% coverage floor
```

Test rules live in `.claude/rules/testing.md`, with deeper guides under `docs/testing/`.

Run `pnpm test:e2e` to pack the current commit and test the launcher with fake agent CLIs. The launcher suite uses the **Playwright** test runner and runs without a browser.

## 🛡️ Security & Configuration

### 📦 Package Management

pnpm **12.14.0** is pinned via `packageManager` and enforced by `engines.pnpm` / `engineStrict`. All dev dependencies use the `dev` catalog:

```bash
pnpm add -D some-package --save-catalog-name=dev
```

`pnpm-workspace.yaml` supply-chain hardening:

- `minimumReleaseAge: 10080` — wait 7 days before adopting a new package version
- `strictPeerDependencies: true`
- `engineStrict: true`
- `ignoreScripts: true` with explicit `allowBuilds` (`esbuild: true`, `agent-browser: false`)
- `trustPolicy: no-downgrade`

### 🔐 Permissions & Guardrails

Workspace permissions are configured in `.claude/settings.json` and mirrored across harnesses by `utils/harness/hooks.js`:

- **Allowed operations:** `pnpm` commands (including undoable `pnpm task rm`), local git (`status`, `diff`, `log`, `add`, `commit`, `switch -c`, `checkout -b`, `rev-parse`, `show`), `node` only for repo scripts (`utils/`, `.claude/hooks/`, `.agents/skills/`), and basic directory inspection (`ls`, `dir`, `cd`, `pwd`, `echo`, `type`, `mkdir`). Arbitrary `python`, `node`, `cat`, and `curl` are not pre-approved.
- **Requires confirmation:** `git push`, `rebase`, `merge`, `cherry-pick`, and force-kill signals (`kill -9`, `pkill`, `killall`).
- **Denied operations:** secret files (`.env*`, `secrets/`, `*.pem`, `*.key`, `credentials.json`, `~/.ssh/`, `~/.aws/`), `rm` (use `pnpm task rm` instead — moves files to `tasks/.trash/` for 7 days), `npm`, `sudo` / admin commands, destructive git (`force push`, `reset --hard`, `clean -fd`, `branch -D`, `tag -d`), and `pnpm publish`.

Local overrides belong in `.claude/settings.local.json` (git-ignored).

### 🔌 MCP Servers

MCP servers are configured per agent rather than synced by `pnpm harness sync`, because server entries often hold machine-local paths and credentials:

- **Claude Code (`claude` / `dscc`):** place project-local MCP servers in `.mcp.json` (git-ignored and excluded from npm packages). Copy `.mcp.json.example` and adjust the paths for your machine.
- **Codex (`codex`):** use Codex's own MCP config (`codex mcp add …` / `~/.codex/config.toml`). Note: if any Codex MCP server is configured, background memory jobs on Codex fail closed for tool isolation — switch them with `pnpm memory set --extract-agent claude` (or `agy` / `dsh`).
- **Antigravity CLI (`agy`) & DeepSeek Harness (`dsh`):** configure MCP servers in each tool's native user or profile settings.

## 🤝 Contributing

This is a personal workspace, but forks, ideas, and suggestions are always welcome! Before opening a PR, make sure `pnpm check` passes.

External skills are managed with skills.sh (`skills-lock.json`); project-owned skills live in `.agents/skills/`.

## 💖 Credits

- **External skills:** the [skills.sh](https://skills.sh) ecosystem, installed with [vercel-labs/skills](https://github.com/vercel-labs/skills). Individual authors are credited in the tables above.
- **Harnesses supported:** [Claude Code](https://claude.com/claude-code), [Codex](https://openai.com/codex/), [Antigravity CLI](https://antigravity.google/docs/cli/reference), and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## 📄 License

The original contents of this repository are licensed under [ISC](./LICENSE). External skills are not distributed here; when installed, they remain under their upstream licenses.
