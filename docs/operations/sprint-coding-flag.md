# Sprint Coding Tasks — Beta Safety Flag

## What the flag gates

`ENABLE_SPRINT_CODING_TASKS` (default `false`) gates the `category: 'code'`
sprint path. When a code sprint runs, `runSprint` plans tasks and the API host
executes `git clone --depth=1` and `pnpm install` per task into a
`mkdtempSync()` directory, then the agent edits files and pushes a draft PR.
All other sprint categories (research, writing, ops, data, marketing, general)
are unaffected by this flag and remain available either way.

## Why it ships off

The current path has no container, chroot, or namespace isolation. A malicious
or buggy `pnpm install` lifecycle script runs as the API process — same uid,
same filesystem, same secrets, same outbound network as the rest of Plexo.
Auditor finding (`ops/coreaudit/06-STABILIZATION.md` fix #7) flagged this as
the largest unmitigated risk for self-hosters.

## When it's safe to enable

- Dedicated VM or container running just the API.
- No other tenants on the host.
- Outbound network policy you trust.
- You've reviewed every workspace's GitHub permissions.

## How to enable

Set `ENABLE_SPRINT_CODING_TASKS=true` in `.env`, then:

```
docker compose restart api
```

## What happens when off

- `POST /api/sprints` with `category: 'code'` returns
  `503 SPRINT_CODING_DISABLED`.
- `POST /api/sprints/:id/run` and `/:id/retry` on existing code sprints return
  the same.
- The runner fails-closed if a code sprint is somehow already enqueued.
