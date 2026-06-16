# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via GitHub's
[private vulnerability reporting](https://github.com/quickbits-io/openqueue/security/advisories/new)
(Security → Advisories → "Report a vulnerability"), or email
**security@quickbits.io**.

We aim to acknowledge reports within a few business days and will keep you
updated on remediation. Once a fix is released we're happy to credit you unless
you prefer to remain anonymous.

## Supported versions

OpenQueue is pre-1.0; security fixes land on the latest published minor of the
`@openqueue/*` packages.

## Scope notes for maintainers

- Secrets (e.g. `NPM_TOKEN`) live only in the `Release` workflow, which runs on
  `push` to `main` — fork pull requests cannot trigger it and never receive
  secrets.
- CI runs untrusted pull-request code with a read-only token, no secrets, and
  `persist-credentials: false`; Bun does not run dependency lifecycle scripts
  unless allow-listed.
- GitHub Actions are pinned to commit SHAs and updated by Dependabot.
