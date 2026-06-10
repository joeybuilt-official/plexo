# Plexo UI/UX/Functionality Audit & Fix — Master Plan

**Goal:** Audit the Plexo `apps/web` application end-to-end across seven lenses, produce a severity-ranked `audit-findings.md`, gate for approval, then fix in severity order without redesigning.

**Scope target:** `/workspace/plexo/apps/web` (Next.js 15 / React 19, app router). 79 route files, 86 component files. Live instance: https://getplexo.com (`plexo-web`). Source of truth for file:line: `/workspace/plexo` on `main`.

**Out of scope (unless operator extends):** `apps/hub`, `apps/cli`, `apps/android`, API-only behavior except where it surfaces a UI bug. Backend/schema changes are stop-and-ask per the operator spec.

## Artifact locations (namespaced — do NOT touch the root plan.md/checklist.md, which belong to a separate in-flight initiative)
- This plan: `/workspace/plexo/.ui-audit/plan.md`
- Checklist: `/workspace/plexo/.ui-audit/checklist.md`
- ADRs: `/workspace/plexo/.ui-audit/adr/`
- Findings (operator-spec mandated location): `/workspace/plexo/audit-findings.md`

## Audit vehicle decision (OPERATOR GATE — see ADR 0001)
getplexo.com is **live production with real user data**. Destructive/CRUD lens tests (create/edit/delete round-trip, optimistic rollback) must NOT run against prod. Resolution pending operator: (A) read-only + navigation audit on live prod, CRUD/state tests on the existing `.e2e-phased` ephemeral throwaway stack; or (B) audit entirely on a freshly stood-up ephemeral stack. Either way, render/responsive/a11y/visual lenses run against a real authenticated browser, never static review alone.

## Expert-panel conflicts surfaced (must escalate, not self-resolve)
1. **Coverage vs context budget (Maintainability ⨯ Pragmatist).** 79 routes × 7 lenses is too large for one main-thread browser walk. Resolution: static-analyzable lenses (visual one-offs, a11y attributes, copy/typo, dead links) delegate to parallel subagents over source; render/responsive/interaction lenses run on the live browser in batched route sweeps. No screen skipped, but evidence source differs per lens.
2. **Prod-fidelity vs safety (UX ⨯ Security).** UX wants the audit on the real prod surface (faithful data/state); Security forbids mutation tests there. Resolved by the vehicle split above — escalated to operator as ADR 0001.
3. **Audit depth vs "not a redesign" (UX ⨯ Restraint).** Tempting to log aspirational redesign items. Rule: findings are defects against the app's OWN existing design language, not net-new design opinions. P3 is the ceiling for subjective polish; anything implying a redesign is dropped, not filed.

## Phases

## Phase 0 — Scope inventory
- Scope: Crawl router config (not nav links) for every route/screen; catalog every reusable component + variants; enumerate user flows (auth, CRUD, settings, onboarding, error recovery, payment/subscription); identify role/permission states. Emit as a checklist in `.ui-audit/checklist.md` (the audit-against list).
- Deps: none
- Subagents: 3 parallel Explore — (a) route+layout map with auth-guard/role gating per route, (b) component catalog with variants/props, (c) user-flow tracing across the app.
- Exit: `checklist.md` lists every route, every component, every flow as a checkbox. Operator-visible inventory.
- Status: pending

## Phase 1 — Seven-lens audit
- Scope: Run inventory through lenses 1–7 (functionality, states, interaction, visual consistency, a11y, responsive, performance/polish). Live authenticated browser for render/responsive/interaction/state lenses at 360/768/1024/1440; parallel source subagents for static-analyzable lenses.
- Deps: Phase 0 inventory; operator-resolved vehicle (ADR 0001) + auth creds.
- Subagents: parallel general-purpose/Explore for static lenses (a11y attribute sweep, visual one-off-value sweep, copy/typo/terminology sweep, dead-link/orphan-route sweep, console-error-prone pattern sweep). Main thread drives the browser sweeps.
- Exit: Per-route lens results captured (raw notes under `.ui-audit/`); every inventory checkbox audited.
- Status: pending

## Phase 2 — Findings + GATE ⚠
- Scope: Synthesize raw notes into `/workspace/plexo/audit-findings.md`, one entry per issue (severity P0–P3, screen, repro, expected, actual, files, fix approach). De-dupe; rank.
- Deps: Phase 1
- Subagents: none
- Exit: `audit-findings.md` written; findings presented to operator. ⚠ **HARD STOP — no fixes until operator approves the list.**
- Status: pending

## Phase 3 — Fix in severity order
- Scope: Post-approval. Fix P0→P3, one issue at a time, smallest change that resolves it. Verify each in the running app; re-test adjacent screens for regressions. Update findings-doc status per issue. Design/schema/new-dep needs → stop and ask.
- Deps: Phase 2 operator approval ⚠
- Subagents: general-purpose for isolated fixes where helpful.
- Exit: All approved findings resolved + verified; Ship Gate green (tests pass, types clean, build green) before any push.
- Status: pending

## One-way doors / gates
- ⚠ Phase 2 → Phase 3: operator approval of findings (operator-spec mandated + skill Step 6).
- ⚠ Any push/deploy: authorization gate (CLAUDE.md §0.5).
- ⚠ Any backend/schema change or new dependency surfaced during fixes: stop and ask.
