# Git Workflow: Commits, PRs, Branching

> **Applies when:** the project is version-controlled with git and changes land through pull requests.
> **Delete this file (and its `@` import in CLAUDE.md) if:** the project is not in git, or has no PR/review process at all.

## Commits

- Use conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`. They make the history greppable and let release tooling derive changelogs without human curation.
- **Keep commits atomic — one logical change per commit.** A commit that does two things cannot be reverted, cherry-picked, or bisected without dragging the other one along.
- **Do not mix a domain change and an infrastructure change in one commit.** A commit that alters a business rule *and* swaps an adapter, ORM call, or vendor client leaves the reviewer no way to tell which half changed the behaviour — and if it has to be reverted, both halves go. Split them along the layer boundary (see `clean-architecture.md`); the domain commit is the one that needs real scrutiny.
- **Never push directly to `main`.** All work lands via a branch and a PR, so every change has a reviewable diff and a revert point.
- **Remind the user to commit at the end of each feature or milestone** — they forget, and uncommitted work is the one kind of work that a crashed machine or a bad `git checkout` can delete outright.

## Pre-commit gates (both, every time)

- **Run the FULL typecheck before committing: `pnpm typecheck`.** Every package, unfiltered - do not grep the output, and do not spot-check only the files you changed. A type error in an untouched package that your change broke through a shared type is exactly the failure this catches, and partial checks have shipped broken CI more than once.
- **Run the full unit/integration/package suite before committing: `pnpm test:all`.** For UI or live-stack changes also run `pnpm test:e2e`. All applicable tests must pass. Do not skip, `.only`, or comment out a failing test to get a commit through - fix the code, or stop and report the failure.
- If a change alters query structure, response shapes, or call ordering, update the corresponding test fixtures and mocks in the same commit — see "Sequentially-consumed mocks go stale" in `testing.md` for the failure mode and how to spot it.
- Both gates run before the commit, not before the push. A local commit you have not verified is a commit you will push at 6pm without rechecking.

## Branching

- **Always branch from an up-to-date `main`.** Fetch first: `git fetch origin && git switch -c <branch> origin/main`. Branching from a stale local copy imports every conflict that landed since you last pulled.
- **Do not branch from another feature branch or an open PR's branch (no stacked PRs) — the default with exactly one exception, below.** PRs are squash-merged, which rewrites the base PR's commits into a single new SHA. The stacked branch still carries the *original* commits, so after the base merges, your branch will conflict with its own already-merged changes — a conflict that looks impossible and wastes an afternoon.
- If new work depends on an unmerged PR, the rule is: wait for it to merge, then branch fresh from `main`. The one exception: you are truly blocked and waiting is not an option - then stack, flag it prominently in the PR description so the reviewer knows the base is moving, and expect to run the recovery below after the base squash-merges.

### Recovery: already stacked on a squash-merged branch

Do not run a plain `git rebase main` - it replays the duplicated commits and recreates every conflict. Drop the old base's commits instead:

```
git fetch origin
git rebase --onto origin/main <old-base-branch-tip>
```

`<old-base-branch-tip>` is the last commit that belonged to the base branch (its SHA before the squash-merge, or `origin/<old-base>` if the ref still exists). Everything after that point replays cleanly onto the new base.

## Keeping branches fresh

- **Rebase open PR branches onto `main` every 1-2 days.** Small, frequent rebases produce one or two trivial conflicts; a week of drift produces a wall of them, and a wall of conflicts is where correct code gets resolved away by accident.
- Rebase before requesting review, so the reviewer reads the diff that will actually merge.
- After rebasing a pushed branch, force-push with `git push --force-with-lease` — never a bare `--force`, which will silently discard a collaborator's commits pushed since your last fetch.

## Pull requests

- The PR description states what changed and why, and links the plan doc under `docs/claude/` when there is one.
- Keep the PR scoped to the approved change. Unrelated drive-by fixes belong in their own PR, where they can be reviewed on their own merits.
- Never merge your own PR past a failing CI job by re-running it until it goes green — a flaky test is a bug report, not an obstacle.
