# B1 tail — checklist

## Phase 1 — small tail
- [x] sprints.ts → sprints.repository (extend) — migrate 6 db ops
- [x] health.ts → health.repository — migrate db ops
- [x] intelligence.ts → intelligence.repository — migrate db ops
- [x] pax.ts → pax.repository — migrate db ops
- [x] tsc clean (apps/api) + per-file grep shows no query calls
- [x] commit + push Phase 1

## Phase 2 — mid tail
- [x] intelligence-dashboard.ts → repository
- [x] stabilization.ts → repository
- [x] channels.ts → extend channels.repository
- [x] tsc clean + grep clean
- [x] commit + push Phase 2
- [x] deploy Phases 1+2 to prod + verify (health + gate-check) — eb386d2, sprints route 401

## Phase 3 — memory + tasks
- [x] memory.ts → memory.repository
- [x] tasks.ts → tasks.repository
- [x] tsc clean + grep clean
- [x] commit + push Phase 3

## Phase 4 — auth + extensions
- [x] auth.ts → auth.repository
- [x] extensions.ts → extensions.repository
- [x] tsc clean + grep clean
- [x] commit + push Phase 4
- [ ] deploy Phases 3+4 to prod + verify

## Phase 5 — heavies
- [ ] chat.ts → chat.repository (preserve SSE/job/executor side-effects)
- [ ] connections.ts → connections.repository
- [ ] tsc clean + grep clean
- [ ] commit + push Phase 5
- [ ] deploy Phase 5 to prod + verify

## Phase 6 — close-out
- [ ] final sweep: zero route files with direct query calls
- [ ] PLAN.md B1 row → ✅ done (final count)
- [ ] commit + push + final prod deploy/verify

## Gated (do NOT do without operator sign-off)
- [ ] ⚠ A2 activation
- [ ] ⚠ A3 per-app keys
- [ ] ⚠ A5 DRAFT_0124 migration
- [ ] ⚠ A6 money numeric
- [ ] ⚠ B3 SSE Redis fan-out
