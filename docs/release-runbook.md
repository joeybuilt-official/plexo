# Release runbook — `@joeybuilt/plexo-sdk`

Operator-facing. Walks a release engineer through cutting a tagged SDK
release end-to-end. Assumes `.github/workflows/release.yml` is in place
and the `NPM_TOKEN` repository secret exists.

---

## 1. Determine the version bump

Pick the bump type per SemVer:

- **Patch** (`1.3.0` → `1.3.1`) — bug fixes only. No public API change.
- **Minor** (`1.3.0` → `1.4.0`) — additive surface. New methods, new
  optional params, new types. Existing methods unchanged.
- **Major** (`1.3.0` → `2.0.0`) — breaking. Method removals, signature
  changes, behavioral changes consumers must adapt to. Requires a
  migration section in `MIGRATING.md`.

If unsure, default to **minor** for new surface and **patch** for
bug-only fixes.

## 2. Update `packages/sdk/package.json`

Bump the `version` field to the new value.

```bash
# Example: 1.3.0 -> 1.4.0
sed -i 's/"version": "1.3.0"/"version": "1.4.0"/' packages/sdk/package.json
```

(Or edit by hand — the workflow only cares about the final value.)

## 3. Update `packages/sdk/CHANGELOG.md`

Add a new top-level section above the current top entry. Follow the
existing format:

```markdown
## <version> — <YYYY-MM-DD>

### Added
- New methods, new types, new params.

### Changed
- Behavioral changes to existing methods.

### Fixed
- Bug fixes.

### Deprecated
- APIs slated for removal in the next major.

### Compatibility
- Prior surface unchanged (state the previous minor explicitly).
- Internal: Plexo Core min commit / required env vars / DB schema deps.
```

Use the same headings the existing CHANGELOG entries use. Be specific
about server-side dependencies — the matrix update in step 5 depends on
this section.

## 4. Update root `CHANGELOG.md`

Only if the SDK release reflects **cross-package** changes (e.g. a new
SDK method is paired with a new Plexo Core route). Add an entry under
`## [Unreleased]` with a one-line cross-reference to the SDK CHANGELOG.

If the SDK release is purely client-side polish, skip this step.

## 5. Update `docs/compatibility-matrix.md`

Add a new row **above** the previous row (newest first). See the "How to
update this doc" section of `compatibility-matrix.md` for the exact
column contents. Required fields:

- SDK version
- Plexo Core min commit / version
- DB schema state (Drizzle migration number)
- Notes

## 6. PR and merge

- Open a PR titled `release: @joeybuilt/plexo-sdk <version>`.
- The PR must change at minimum `packages/sdk/package.json` +
  `packages/sdk/CHANGELOG.md` + `docs/compatibility-matrix.md`.
- The CHANGELOG-check workflow gates this PR; missing CHANGELOG entry
  blocks merge (it's *desired* friction for releases).
- Get a review (or self-merge per repo policy).
- Merge to `main`.

## 7. Verify the auto-release

On merge, `.github/workflows/release.yml` triggers automatically. It will:

1. Detect that `packages/sdk/package.json`'s version changed vs. the
   previous commit.
2. Build the SDK.
3. Publish to npm via `pnpm publish --filter @joeybuilt/plexo-sdk --no-git-checks --access public`.
4. Create the `v<version>` git tag.
5. Create a GitHub Release with the CHANGELOG excerpt.

Watch the Actions tab for the run. If it fails, see the troubleshooting
section below.

## 8. Verify npm has the new version

```bash
npm view @joeybuilt/plexo-sdk version
# Expect: <new version>

npm view @joeybuilt/plexo-sdk versions --json | tail -5
# Expect the new version in the array
```

## 9. Verify the git tag exists

```bash
git fetch --tags
git tag -l "v<new-version>"
# Expect: v<new-version>
```

## 10. Verify the GitHub Release exists

```bash
gh release view v<new-version>
# Or visit https://github.com/joeybuilt-official/plexo/releases
```

The release body should contain the CHANGELOG excerpt for this version.
If it's empty or wrong, edit the release manually — the workflow's
CHANGELOG extraction can drift if the CHANGELOG format changes.

## 11. Communicate to downstream consumers

Notify the apps that depend on `@joeybuilt/plexo-sdk`. Today's known
consumers (per the SDK README + repo audit):

- `app-starter`
- `levio`
- `fonto`
- `nexalog`
- `pushd`
- `frame-forge`

**Operator decides the channel** (Slack, GitHub Issue in each consumer,
email digest, etc.). Include:

- New version + bump type (patch / minor / major)
- One-line summary of what changed
- Link to the GitHub Release
- For major bumps: link to the relevant section of `MIGRATING.md`

---

## Troubleshooting

### Workflow didn't trigger after merge

The trigger is `push: main` + `paths: packages/sdk/package.json`. If you
bumped the version via an Actions UI edit or some non-push pathway, the
workflow may not fire. Push a no-op commit that touches
`packages/sdk/package.json` (whitespace works) to re-trigger.

### Workflow ran but skipped publishing

The `bumped` step compares `HEAD`'s version to `HEAD~1`'s version. If
you bumped the version in an earlier commit and the merge SHA didn't
include the bump, the workflow sees no change. Fix: cherry-pick the
bump onto a fresh commit and push to main.

### npm publish failed with 401 / 403

`NPM_TOKEN` is missing, expired, or lacks publish rights to the
`@joeybuilt` scope. Rotate the token at npmjs.com and update the repo
secret. The workflow does not retry — re-run the failed job manually
after fixing.

### Tag already exists

The workflow's tag step skips with a warning if `v<version>` already
exists. This usually means a previous workflow run published to npm but
crashed before tagging, then someone manually tagged. Verify the npm
version + GitHub Release manually; if both are correct, no action
needed.

### CHANGELOG extraction produced empty release notes

The `awk` extractor looks for `## <version>` followed by a space, EOL,
or em-dash. If the CHANGELOG heading uses a different separator (e.g.
hyphen, comma), the extractor returns empty and the release body says
"(no CHANGELOG entry found for v<version>)". Edit the release body
manually with `gh release edit v<version> --notes-file <path>`.
