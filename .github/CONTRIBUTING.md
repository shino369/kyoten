# Contributing to Kyoten

Thanks for your interest in contributing to **kyoten**!

This repository is a shared home base for AI coding agents built on plain Node.js ESM with zero runtime dependencies. For the full engineering rules and command reference, see [AGENTS.md](../AGENTS.md) and [docs/harness.md](../docs/harness.md).

## Prerequisites

- **Node.js 24+** (`.nvmrc` pins `24`)
- **pnpm 12.14.0**, managed via Corepack (`corepack enable`) — do not use `npm`

## Local Setup

```bash
git clone https://github.com/shino369/kyoten.git
cd kyoten
corepack enable
pnpm workspace:setup
pnpm workspace:check
```

## Making Changes

1. **Branch from `main`** using `<type>/<brief-description>` (for example, `fix/hook-windows-path` or `docs/cli-examples`). Never commit directly on `main`.
2. **Write tests alongside code changes.** The measured Vitest suite requires at least 95% statements, branches, functions, and lines overall. See [.claude/rules/working-with-script.md](../.claude/rules/working-with-script.md) and [.claude/rules/testing.md](../.claude/rules/testing.md).
3. **Keep harness configs in sync.** If you edit canonical role prompts under `.claude/agents/` or harness settings, run `pnpm harness sync` and verify with `pnpm harness check`.
4. **Keep dependencies minimal and safe.** Runtime dependencies are zero by design. Add dev dependencies to the `dev` catalog via `pnpm add -D <pkg> --save-catalog-name=dev`, and respect `minimumReleaseAge` (7 days) and `ignoreScripts`.
5. **Never commit local state or secrets.** `tasks/`, `logs/`, `memory/`, `*.local.*`, `.mcp.json`, and third-party skills are machine-local and must stay untracked.

## Quality Gate

Before opening a pull request, run the full check suite and make sure it passes cleanly:

```bash
pnpm check
```

(`pnpm check` runs `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:coverage`.)

## Commit & Pull Request Conventions

- **Conventional Commits** are enforced by `.githooks/commit-msg`:
  - Format: `<type>(<scope>): <description>` (for example, `feat(hooks): add stop-time guard` or `fix(tasks): handle empty state`)
  - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`, `ci`, `build`
  - Description: imperative mood, lowercase, ≤50 characters, no trailing period
- Do not add attribution lines (`Co-Authored-By`, `Generated with …`) to commits or PRs.
- Use a Conventional Commit title for your PR and fill out the pull request template (what/why, how to verify, breaking changes).

## Security

To report a security issue, please follow [.github/SECURITY.md](./SECURITY.md) instead of opening a public issue.
