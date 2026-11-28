---
name: kyoten-release
description: Release a new version of kyoten to GitHub and npm — version bump, refreshing docs/cli.md, PR/merge to main, creating the GitHub Release, packing the verified npm tarball with pnpm kyoten:pack, smoke-testing via npx, and preparing the manual npm publish command with the required ./ or .\ path prefix. Use when asked to release kyoten, cut a new version, bump the version, create a GitHub release, pack a release tarball, or publish kyoten to npm.
---

# kyoten Release Workflow

Release `kyoten` on GitHub and npm safely, keeping the root repository private and shipping only a verified tarball built from `HEAD`.

## Boundaries (read first)

- **Never push, merge, tag, or create a GitHub Release unless the user explicitly asks** (`AGENTS.md` §1, §5).
- **npm publishing is always a manual step run by the user.** Agents must never run `npm publish` or `pnpm publish` (`AGENTS.md` §1); prepare and smoke-test the tarball, then hand the user the exact publish command.
- **Root `package.json` stays `"private": true` without `bin`.** Never publish directly from the repo root. `pnpm kyoten:pack` generates the public manifest, embeds `docs/kyoten.md` as `README.md`, bundles tracked `HEAD` files (excluding `docs/images/`) into `snapshot.kyoten.gz`, checks the deny list and 2 MiB size cap, and writes `dist/kyoten-<ver>.tgz`.

## Procedure

### 1. Inspect changes since the last release

```bash
git fetch origin
git tag -l --sort=-creatordate | head -n 5
git log <prev-tag>..origin/main --oneline
```

Confirm the target semver `<ver>` (for example, `0.2.5`) and list user-facing changes, PR numbers, and any breaking changes for the release notes.

### 2. Bump version on a feature branch

Never commit directly on `main`.

1. Branch from up-to-date `main`:
   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b chore/bump-version-<ver>
   ```
2. Update `"version"` in `package.json` to `<ver>`.
3. Refresh `docs/cli.md` (its `pnpm kyoten` section embeds the package version):
   ```bash
   pnpm docs:cli
   ```
4. Run the full validation gate:
   ```bash
   pnpm check
   pnpm harness check
   pnpm workspace:check
   pnpm docs:cli --check
   ```
5. Commit locally with a Conventional Commit message:
   ```bash
   git add package.json docs/cli.md
   git commit -m "chore(config): bump version to <ver>"
   ```
6. When the user asks to open the PR, push the branch and create a PR into `main`, wait for `Test on Node.js 24.x` (Ubuntu + Windows) to pass, and merge to `main`.

### 3. Sync `main` and create the GitHub Release

After the version-bump PR is merged into `main`:

1. Sync local `main` and verify a clean working tree at the bump commit:
   ```bash
   git checkout main
   git pull --ff-only
   git status --short
   ```
2. Draft release notes matching the repository format:
   - Heading: `# kyoten v<ver>`
   - One-paragraph summary of the release
   - `## ✨ What's Changed` grouped by theme with PR numbers (`#NN`)
   - `## ⚠️ Breaking Changes` (include only if applicable)
   - `## 🔗 Full Changelog` with `https://github.com/shino369/kyoten/compare/<prev-tag>...v<ver>`
3. Create the GitHub Release (only when asked; add `--draft` if the user wants to review in the browser first):
   ```bash
   gh release create v<ver> --target main --title "kyoten v<ver>" --notes-file <notes.md>
   ```

### 4. Pack and smoke-test the npm tarball

Run on the clean, merged `main` commit (`pnpm kyoten:pack` always packs `HEAD`, never uncommitted working-tree edits):

```bash
pnpm kyoten:pack
```

Expect `dist/kyoten-<ver>.tgz` and a summary line showing the version, short commit SHA, snapshot file count, and size.

Smoke-test the exact tarball via `npx`:

```bash
# macOS / Linux / Git Bash
npx --yes --package ./dist/kyoten-<ver>.tgz -- kyoten version
npx --yes --package ./dist/kyoten-<ver>.tgz -- kyoten doctor
```

```powershell
# Windows PowerShell
npx --yes --package .\dist\kyoten-<ver>.tgz -- kyoten version
npx --yes --package .\dist\kyoten-<ver>.tgz -- kyoten doctor
```

Confirm `kyoten version` prints `<ver>` and `kyoten doctor` runs cleanly.

### 5. Manual npm publish (user step)

Hand the user the exact publish command for their shell.

> **Required path prefix:** Always pass `./dist/...` (POSIX) or `.\dist\...` (Windows). Without a leading `./` or `.\`, `npm publish dist/kyoten-<ver>.tgz` misparses `dist/kyoten-<ver>.tgz` as a `github:` owner/repo shorthand and fails.

```bash
# macOS / Linux / Git Bash (run by user)
npm publish ./dist/kyoten-<ver>.tgz --access public
```

```powershell
# Windows PowerShell / cmd (run by user)
npm publish .\dist\kyoten-<ver>.tgz --access public
```

Optional post-publish verification (run by user):

```bash
npm view kyoten version dist-tags
```

## Common pitfalls

| Pitfall                                                       | Prevention                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/cli.md` still shows the previous version                | Run `pnpm docs:cli` after editing `package.json`, then verify `pnpm docs:cli --check`     |
| Tarball packs the wrong commit                                | Merge the bump PR, `git checkout main && git pull --ff-only`, then run `pnpm kyoten:pack` |
| `npm publish dist/kyoten-<ver>.tgz` fails as a `github:` spec | Always include the leading `./` (POSIX) or `.\` (Windows) prefix                          |
| Publishing from repo root instead of the tarball              | Root `package.json` is `"private": true`; always publish the `dist/*.tgz` artifact        |
