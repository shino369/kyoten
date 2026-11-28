# Repository Map

Quick index of kyoten's layout, `utils/` modules, `package.json` scripts, and documentation scopes. Check here before scanning the tree.

## Top-level layout

| Path                                  | Purpose                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `utils/`                              | Node.js ESM CLIs and libraries powering tasks, memory, hooks, launcher, loops, swarms, skills, and tools               |
| `.claude/`                            | First-class Claude Code config: `settings.json`, `hooks/*.js`, `agents/*.md` (canonical roles), `rules/`, `workflows/` |
| `.agents/`                            | Canonical skills (`.agents/skills/<name>/SKILL.md`) + generated Antigravity hooks/roles (`pnpm harness sync`)          |
| `.codex/`, `.dsh/`                    | Generated Codex and DeepSeek Harness configs (`pnpm harness sync`; never edit by hand)                                 |
| `.githooks/`, `.github/`              | Git hook shims (`pre-commit`, `commit-msg`), CI workflow (`test.yml`), templates, `CODEOWNERS`, `SECURITY.md`          |
| `docs/`, `templates/`, `tools/`       | Documentation, task/memory templates, committed `tools/catalog.json`                                                   |
| `e2e/`                                | Playwright end-to-end tests (`pnpm test:e2e`)                                                                          |
| `tasks/`, `memory/`, `logs/`, `dist/` | Git-ignored local state: active tasks, personal memory, audit logs, packed tarballs (`resources/` too)                 |

## `utils/` modules

### Top-level workspace utilities

- `cli-docs.js` — Generates and verifies `docs/cli.md` from workspace CLI `--help` output
- `git-hooks.js` — Implementation behind `.githooks/pre-commit` and `.githooks/commit-msg`
- `module-runner.js` — `runIfMain` guard so CLI modules stay importable in tests
- `paths.js` — POSIX path display helpers (`toPosix`) for cross-OS messages and Markdown
- `redact.js` — Shared secret-detection and redaction rules (audit log, memory, review diffs)
- `skills-add.js`, `skills-check.js`, `skills-install.js`, `skills-link.js`, `skills-lock.js` — Third-party and opt-in skill installation, lock verification, and `.claude/skills/` linking
- `spawn.js` — Cross-OS shell-free process spawner (Windows `.cmd` shim handling)
- `workspace-config.js` — Shared constants (`ROOT_DIR`, `OWNED_SKILLS`, `MIN_NODE_MAJOR`) and ignore globs (`vendoredGlobs`, `localGlobs`)
- `workspace-setup.js` — `pnpm workspace:setup` and `pnpm workspace:check` orchestrator

### Feature packages

| Package          | Entry & Modules                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `utils/agent/`   | `cli.js` — `pnpm agent ask` one-turn headless runner (`claude`, `codex`, `dsh`, `dscc`; excludes `agy`)                                                                                                                                                                                                                                                                                                                        |
| `utils/harness/` | `cli.js` (`sync`/`check`), `hooks.js` (manifest & renderers), `input.js` (hook payload parser), `format.js` (Codex format queue), `permissions.js` (guardrails), `roles.js` (Codex/agy role sync), `trust.js` (trust checks)                                                                                                                                                                                                   |
| `utils/kyoten/`  | `cli.js` (launcher), `home.js`, `init.js`, `update.js`, `doctor.js`, `launch.js`, `dscc.js` + `dscc.env.example`, `config-cmd.js`, `backup.js`, `reset.js`, `repo.js`, `memory.js`, `git-env.js`, `snapshot.js`, `pack.js` (`kyoten:pack`)                                                                                                                                                                                     |
| `utils/loop/`    | `cli.js` (`pnpm loop`), `adapters.js` (headless agent adapters & ToS guard), `worktree.js`, `driver.js` (verify loop), `review-loop.js` (unattended review/triage rounds)                                                                                                                                                                                                                                                      |
| `utils/memory/`  | `cli.js` (`pnpm memory`), `store.js`, `config.js`, `tokenize.js`, `recall.js`, `render.js`, `hook.js`, `instructions.js`, `context.js`, `digest.js`, `transcript.js`, `extract.js`, `extract-env.js`, `worker.js`, `queue.js`, `consolidate.js`, `agent-call.js`, `personalize.js`, `compact.js`, `dsh-persona.js` + `dsh-persona.patch.yml`, `language_guard.js`, `archive.js`, `tar.js`, `snapshot.js`, `repo.js`, `undo.js` |
| `utils/swarm/`   | `cli.js` (`pnpm swarm`), `dispatcher.js` (parallel step scheduling), `worker.js`, `git.js` (worktree & merge helpers)                                                                                                                                                                                                                                                                                                          |
| `utils/task/`    | `cli.js` (`pnpm task`), `state.js`, `store.js` (locks, atomic writes, sessions), `deps.js`, `markdown.js`, `brief.js`, `git.js`, `check.js`, `verify.js`, `loop.js`, `quality.js`, `review.js` (briefs & patches), `trash.js`                                                                                                                                                                                                  |
| `utils/tools/`   | `cli.js` (`pnpm tools`), `catalog.js`, `registry.js`, `scan.js`, `format.js`                                                                                                                                                                                                                                                                                                                                                   |

Tests sit beside each package in `__tests__/*.test.js` (shared fixtures in `utils/__tests__/support/`).

## Hooks, roles, and workflows

| Area                 | Files                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/hooks/`     | `session_start.js`, `pre_compact.js`, `task_loop.js`, `context_monitor.js`, `audit_logger.js`, `auto_format.js`, `guard.js`                  |
| `.claude/agents/`    | Canonical role prompts (`planner`, `reviewer`, `verifier`, `security-reviewer`, `test-runner`, `trilingual-translator`); synced to Codex/agy |
| `.claude/workflows/` | `implement-plan.js`, `review-changes.js`, `research.js` (smoke-tested in `.claude/workflows/__tests__/workflows.test.js`)                    |
| `templates/`         | `templates/task/` (`plan`, `NOTES`, `REVIEW`, `STUDIES`) and `templates/memory/` (`AGENTS.local.md`, `personas/*.json`)                      |

## `package.json` scripts

| Category        | Scripts                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality & tests | `check` (full gate), `typecheck`, `lint`, `lint:fix`, `format`, `format:check`, `test`, `test:watch`, `test:coverage`, `test:ui`, `test:e2e` |
| Setup & harness | `workspace:setup`, `workspace:check`, `harness` (`sync`/`check`)                                                                             |
| Skills          | `skills:install`, `skills:add`, `skills:check`, `skills:link`, `skills:update`                                                               |
| Workspace CLIs  | `task`, `memory`, `loop`, `swarm`, `agent`, `tools`, `docs:cli`                                                                              |
| Launcher & pack | `kyoten` (run launcher from clone), `kyoten:pack` (build & verify `dist/kyoten-<ver>.tgz` from `HEAD`)                                       |

## Documentation scope index

| Document                                         | Scope — open when you need…                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                                      | Always-loaded workspace rules shared by every harness (must stay under 24,000 bytes for `agy`)                                 |
| `CLAUDE.md`                                      | Claude Code-only behavior (`@AGENTS.md` + hooks, workflows, path-scoped rules)                                                 |
| `README.md`, `README.ja.md`, `README.zh-TW.md`   | Public trilingual repository overview and quick start                                                                          |
| `docs/repo-map.md`                               | This index of modules, scripts, and docs                                                                                       |
| `docs/cli.md`                                    | Exact CLI usage and options (generated by `pnpm docs:cli`; verified with `--check`)                                            |
| `docs/harness.md`                                | Harness architecture, 4-harness behavior matrix, quality loop walkthroughs, limits, and gotchas                                |
| `docs/kyoten.md`                                 | `kyoten` CLI launcher user guide (`init`, `update`, `dscc`, `backup`, `restore`, security; ships as npm `README.md`)           |
| `docs/testing/coverage-strategies.md`            | Patterns for keeping the measured suite at or above the 95% coverage floor                                                     |
| `docs/testing/mocking-guide.md`                  | Vitest mocking conventions and examples                                                                                        |
| `.claude/rules/working-with-script.md`           | Node.js ESM script conventions (`runIfMain`, error handling)                                                                   |
| `.claude/rules/testing.md`                       | Test writing standards, coverage rules, and test isolation                                                                     |
| `.claude/hooks/README.md`                        | Hook scripts overview (`session_start`, `task_loop`, `guard`, `auto_format`, `audit_logger`, `context_monitor`, `pre_compact`) |
| `.agents/skills/*/SKILL.md`                      | On-demand procedures (project-owned: `workspace-setup`, `web-browsing`, `context-manager`)                                     |
| `.github/CONTRIBUTING.md`, `.github/SECURITY.md` | Contributor workflow and security disclosure policy                                                                            |
