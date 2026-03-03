---
description: update README and commit with every push
---

Before every `git push origin main`, update the README to reflect current state.

## What to update

1. **Build badges** — update the phase badge (`phase-N-complete`) and test count
2. **Roadmap** — mark completed items `[x]`, add the commit hash and date to the "Last updated" line
3. **API surface** — add any new routes
4. **Channel adapters table** — update status column
5. **Testing section** — update test counts

## Steps

1. Open `README.md`
2. Update the `![Phase]` badge line near the top — change the phase number
3. Update the `![Tests]` badge — update the test count
4. In the **Roadmap** section, find the current phase block and:
   - Mark all newly completed items `[x]`
   - Update the commit hash in the "Last updated" line to match the current HEAD
5. Add any new API routes to the **API surface** section
6. Update the **Channel adapters** table status column
7. Commit the README change as part of the same commit or a follow-up:

```bash
git add README.md
git commit -m "docs: update README — phase N complete [commit-hash]"
git push origin main
```

## Checklist before pushing

- [ ] Phase badge reflects completed phase
- [ ] Test count in badge matches `pnpm test:unit` output
- [ ] All completed roadmap items marked `[x]`
- [ ] "Last updated" line has current commit hash + date
- [ ] New API routes listed
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
