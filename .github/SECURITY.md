# Security Policy

## Supported Versions

Security fixes are applied to the latest `0.x` release and the `main` branch.

| Version        | Supported |
| -------------- | --------- |
| `0.x` (latest) | Yes       |
| `main`         | Yes       |
| Older releases | No        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, use [GitHub Private Vulnerability Reporting](https://github.com/shino369/kyoten/security/advisories/new) to submit a confidential report directly to the maintainer.

When submitting a report, please include as much of the following as you can:

- The affected component or command (for example: hooks, secret guards, `kyoten` launcher, `dscc` key handling, `pnpm agent`/`loop`/`swarm`, or skill installation)
- The `kyoten` version or commit SHA, OS, and Node.js / harness versions
- Clear reproduction steps or a minimal proof of concept
- The potential impact and any suggested remediation

> Never include real API keys, tokens, credentials, or `.env` file contents in your report.

## Response Process

`kyoten` is maintained on a best-effort basis. You can expect an initial acknowledgment within 7 days. Once a report is confirmed, we will work on a fix and coordinate disclosure before publishing details.
