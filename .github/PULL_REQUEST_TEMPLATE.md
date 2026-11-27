## What & Why

<!-- Summarize what changed and why it is needed. Link related issues if any (e.g. Closes #123). -->

## How to Verify

<!-- List the commands run or manual steps needed to verify this change. -->

- `pnpm check`

## Breaking Changes

<!-- Describe any breaking changes and migration steps, or leave as "None." -->

None.

## Checklist

- [ ] PR title follows Conventional Commits (`<type>(<scope>): <description>`)
- [ ] `pnpm check` passes locally
- [ ] `pnpm harness check` passes (if rules, hooks, or agent roles changed)
- [ ] No local files or secrets are committed (`tasks/`, `memory/`, `logs/`, `*.local.*`, `.env*`)
