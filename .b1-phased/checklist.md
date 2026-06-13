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
- [x] deploy Phases 3+4 to prod + verify — 78c48f6, tasks/memory/extensions 401

## Phase 5 — heavies
- [x] chat.ts → chat.repository (preserve SSE/job/executor side-effects)
- [x] connections.ts → connections.repository
- [x] tsc clean + grep clean
- [x] commit + push Phase 5
- [ ] deploy Phase 5 to prod + verify

## Phase 6 — discovered multi-line-style files (16)
- [x] Batch A (8): agents-run, app-grants, audit, escalation, webhooks, agents-active-stream, clarification, code
- [x] Batch B (8): outcomes, revision-decision, users, webhooks-github, task-inject, task-stream, billing, profiles
- [x] tsc clean + multi-line-aware grep clean (both batches)
- [x] commit + push Phase 6
- [ ] deploy Phase 6 to prod + verify

## Phase 7 — close-out
- [x] final multi-line-aware sweep: zero non-test route files with direct db usage
- [x] PLAN.md B1 row → ✅ done (final count + counting-method-fix note)
- [ ] commit + push + final prod deploy/verify

## Gated (do NOT do without operator sign-off)
- [ ] ⚠ A2 activation
- [ ] ⚠ A3 per-app keys
- [ ] ⚠ A5 DRAFT_0124 migration
- [ ] ⚠ A6 money numeric
- [ ] ⚠ B3 SSE Redis fan-out
