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

## Preview deployments (Vercel)

The docs site (`site/`) deploys to Vercel, which builds preview deployments for
pull requests — including from forks. Preview builds run untrusted PR code, so:

- **Keep all real secrets scoped to the Production environment only.** Vercel
  env vars are scoped per environment (Production / Preview / Development); never
  put a secret in the Preview scope, so preview builds are secret-free by
  construction. (Today the site reads only `NEXT_PUBLIC_OPENPANEL_CLIENT_ID`,
  which is public.)
- Vercel does **not** share environment variables with deployments built from
  **forked** PRs by default, and serves preview deployments with
  `X-Robots-Tag: noindex` (so a malicious preview can't be indexed/abused).
- For stricter control, enable Vercel's **fork build authorization** (Project →
  Settings → Git) so a maintainer must approve a fork's deployment before it
  builds, and/or **Deployment Protection** to require auth to view previews.
- Fork previews stay on `*.vercel.app` — don't point a custom preview domain at
  fork PRs.

Vercel's fork protection is configured in the Vercel dashboard and is separate
from the GitHub Actions controls above.
