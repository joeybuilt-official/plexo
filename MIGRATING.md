# Migrating between Plexo SDK versions

This document is for **consumers of `@joeybuilt/plexo-sdk`** — apps and
services that depend on the published npm package. If you maintain a fork
of Plexo itself, see `docs/release-runbook.md` instead.

## Support window

We keep **the latest 2 minor versions** of `@joeybuilt/plexo-sdk` patched
for security fixes and critical bugs.

Example: when `1.5.x` is current, both `1.5.x` and `1.4.x` receive security
patches. `1.3.x` and earlier are end-of-life and will not receive fixes.

When a new major version ships, the previous major's last minor receives
patches for **6 months** to give consumers time to migrate.

## Versioning

Plexo follows [SemVer](https://semver.org/):

- **Patch** (`1.3.0` → `1.3.1`) — bug fixes, no API surface changes. Always
  safe to bump.
- **Minor** (`1.3.0` → `1.4.0`) — additive surface changes. Existing methods
  keep their signatures + semantics. New methods, new optional params, new
  types. Safe to bump after reading `packages/sdk/CHANGELOG.md`.
- **Major** (`1.x.0` → `2.0.0`) — breaking changes. Method removals,
  signature changes, behavioral changes that callers must adapt to. **Read
  the migration section in this doc before bumping.**

Breaking changes are announced in both `CHANGELOG.md` (project-wide) and
`packages/sdk/CHANGELOG.md` (SDK-specific) **and** tagged with a major bump.
We do not ship breaking changes in a minor or patch release.

## Recommended pinning strategy

Pin to a **caret range** on the current major:

```json
{
  "dependencies": {
    "@joeybuilt/plexo-sdk": "^1.3.0"
  }
}
```

This accepts any future `1.x.y` (minor + patch) automatically, but never
crosses a major boundary. When `2.0.0` ships, your install resolver will
**not** silently pick it up — you must consciously bump the range.

**Do not use `*` or `latest`.** Plexo ships breaking changes regularly enough
that an unpinned consumer will eventually break in production.

**Do not pin to an exact version (`1.3.0` without caret)** unless you have
a specific reason — you'll miss security patches.

## Before bumping a minor version

1. Read `packages/sdk/CHANGELOG.md` for the new version's section.
2. Look for `### Changed` entries — these are behavior changes that are
   technically non-breaking but may shift performance, response shape, or
   error semantics.
3. Look for `### Deprecated` entries — these flag APIs slated for removal
   in the next major. Migrate now while the old API still works.
4. Run your test suite. If anything fails, file an issue (see below).

## Before bumping a major version

1. Read the migration section in this doc for the target major.
2. Read `packages/sdk/CHANGELOG.md` for **every** version between your
   current and target — breaking changes can accumulate across multiple
   majors.
3. Plan a dedicated migration sprint. Don't bundle a major SDK bump with
   unrelated work.
4. Pin to the **first** minor of the new major (e.g. `^2.0.0`, not `^2.3.0`)
   for the initial cutover, so you can adopt subsequent minors at your own
   pace.

## Filing an issue when a release breaks you

If a **patch or minor** release breaks your consumer, that's a Plexo bug —
please file an issue at:

> https://github.com/joeybuilt-official/plexo/issues

Include:

- SDK version you were on
- SDK version that broke you
- Minimal reproduction (a short snippet that worked before and throws now)
- Stack trace + Plexo Core version you're pointing at

We treat patch/minor regressions as P0. Expect a same-week fix.

If a **major** release breaks you and the migration steps in this doc are
unclear or missing, that's also a doc bug — please file an issue with the
"migration" label.

## Migration sections

### v1.x → v2.x

*(reserved — no v2 released yet)*

When v2 ships, this section will document:

- Method renames + removals (`oldMethod` → `newMethod`)
- Signature changes (param order, types, optional vs required)
- Behavioral changes (error semantics, return shapes, timeouts)
- Required Plexo Core version (the server-side surface v2 SDK expects)
- A code-level diff example for each non-trivial change
- A rough timeline for v1.x security-only patches

### v1.0 → v1.x

No migration required. v1.x is purely additive over v1.0:

- v1.1 added `addEpisode` / `searchFacts` (graph methods).
- v1.2 added `tools.gmessages.*` (synchronous gmessages bridge).
- v1.3 added `agents.runCustom` (caller-supplied tools + system prompt).

Each minor bump kept v1.0's surface intact. Bumping `^1.0.0` → `^1.3.0` is
safe and recommended.
