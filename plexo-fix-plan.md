# Plexo UI/Functionality Fix Plan
_Audit date: 2026-03-18 | Status: executing_

## Root Causes

The app is structurally sound — all 25 pages render, routing works, API + DB healthy. Issues are 4 code bugs + 1 operational problem.

## Confirmed Bugs

### P0 — Blocking
1. **Rate limiter too tight** (300 req/15min IP) → cascading 429s across skills, chat, intelligence after heavy page usage. Raise to 2000.
2. **Stuck running task** (70+ min) → "Create social media accounts" stuck in `running` state.

### P1 — Broken on Load
3. **SSE debug page** → 3x `useEffect(..., [])` with `WS_ID` used inside but not in deps. SSE errors on mount when workspace not yet hydrated, never reconnects.
4. **Intelligence page blank** → `fetch_` returns early when `WS_ID` empty but doesn't clear loading state → page stuck or shows error.

### P2 — UX/Correctness
5. **React hydration #418** → Server renders Angel workspace (first from DB), client hydrates Personal (from localStorage). Mismatch every page load.
6. **Intelligence shows wrong workspace** → Same cause as #5.
7. **Agent settings flash warning** → Same cause as #5.

## Execution Order
1. Clear Redis rate limit keys (no deploy needed)
2. Cancel stuck DB task
3. Rate limiter 300 → 2000
4. SSE debug deps fix
5. Intelligence page loading fix
6. Workspace hydration fix (stop server-side initialId)
7. Agent warning debounce
8. Deploy + verify
