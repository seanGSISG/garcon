# Bundled ticket workflows

Workflow definitions Garcon inlines into a ticket launch prompt. Bundling them
keeps ticket launches working where no host skill library is reachable: a
compiled executable, a container, or a fresh machine.

Each workflow is a directory holding a `SKILL.md` plus any supporting documents,
the same layout Garcon reads from a host skill root. `SKILL.md` supplies the
instruction body; the resolver strips its frontmatter before inlining.

A project, user, or host skill definition of the same name takes precedence, so
bundling a workflow never overrides what a machine already has installed. See
`server/workflows/resolver.ts` for the resolution order.

## Regenerating

`server/workflows/bundled-content.ts` is generated from this directory and is
committed so the server needs no filesystem access to read a bundled workflow.
Regenerate it after changing any file here:

```bash
bun run build:workflows
```

## Provenance

The definitions in this directory are vendored from
[mattpocock/skills](https://github.com/mattpocock/skills) at commit
`959a8e9f1edc3adbe2f7e3054bb6fbefa6696260`, licensed MIT. The upstream licence
is retained alongside them in `LICENSE`, and its terms cover these files rather
than Garcon's own GPL-3.0 licence.

To refresh them, copy the upstream `skills/<id>/*.md` files over the matching
directory here, update the commit recorded above, and regenerate.
