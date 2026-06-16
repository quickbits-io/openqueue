# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It is how releases of the `@openqueue/*` packages are versioned and published.

## Adding a changeset

When you make a change that should be released, run:

```bash
bun run changeset
```

Pick the affected packages, choose a bump type (`patch` / `minor` / `major`),
and write a short, user-facing summary. This creates a markdown file under
`.changeset/` — commit it alongside your change.

All `@openqueue/*` packages are versioned together (`fixed` group), so a bump
to one bumps them all to the same version.

## How releases happen

On every push to `main`, the **Release** workflow runs `changeset version`.
If there are pending changesets, it opens (or updates) a **"Version Packages"**
pull request. Merging that PR builds the packages and publishes them to npm with
provenance.

See [the Changesets docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
for more.
