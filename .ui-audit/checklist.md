# Plexo UI Audit — Checklist (durable plan)

## Phase 0 — Scope inventory  ✅ DONE 2026-06-09
- [x] Route/screen map crawled (79 page.tsx + API routes), auth-gating per route — see .ui-audit/inventory-routes.md
- [x] Component catalog (~34 reusable; modal×4 / error×4 / badge×6 dup flagged)
- [x] User-flow inventory (auth, CRUD, settings, onboarding, subscription, error recovery)
- [x] Role/permission-state inventory (public / authed / workspace-owner / operator-only)

### Inventory audit-against list (routes by section)
Auth/onboarding: / login register signup verify-email forgot-password reset-password onboarding setup setup/github invite/[token]
/app core: home chat conversations conversations/[id] conversations/thread tasks tasks/[id] works projects projects/[id] approvals escalations agents memory
Platform: connections connections/gmessages/pair channels channels/[id] channels/[id]/[threadId] extensions hub intelligence intelligence/wizard
Settings: settings + agent app-grants behavior channels connections context federation privacy search users voice + intelligence{,/providers,/models,/routing,/routing/tasks,/embeddings,/memory,/self-hosted}
Ops: account account/subscription logs logs/[id] scheduling cron(→sched) debug marketplace(→hub) functions(→ext) revisions outcomes
Dashboard grp: insights routines
Public: s/[shareId] embed/[type] privacy terms
Known stubs to verify live: subscription Stripe portal "coming soon"; scheduling "more channels coming soon"; embed connections-panel "coming soon"; auth/handshake token-exchange TODO; circular /setup↔/app/home redirect; invite first-user fallback; no optimistic UI on mutations

## Phase 1 — Seven-lens audit (per inventory)  ✅ DONE (lens 6 deferred)
- [x] Lens 1 Functionality — dead routes live-verified (/app/audit, scl =404; sprints=redirect OK)
- [x] Lens 2 States — 15 gaps (silent fetch-fail no-error cluster)
- [x] Lens 3 Interaction — covered via a11y/static (live interaction limited by webtop)
- [x] Lens 4 Visual consistency — hex/spacing token violations + modal/error/badge dup
- [x] Lens 5 Accessibility — 4 P1 + 23 P2 (labels, roles, reduced-motion)
- [~] Lens 6 Responsive — DEFERRED: webtop Chrome won't reflow; needs Playwright 360/768 harness
- [x] Lens 7 Performance & polish — copy/terminology/stubs/typos (no typos found)

## Phase 2 — Findings + GATE  ✅ DONE — AWAITING APPROVAL
- [x] /workspace/plexo/audit-findings.md written (P0–P3)
- [ ] Operator approval — HARD STOP (here now)

## Phase 3 — Fix — ALL P0 + ALL P1 DONE (branch ui-audit-fixes, 5 commits, NOT pushed)
- [x] P0 #1 dead /app/audit links removed (9f6e501)
- [x] P0 #2 SCL flow-step repointed (9f6e501)
- [x] P1 silent fetch-failure → PageError+retry: channels/memory/memory-search/connections/intelligence-logs/approvals; agents/extensions already scoped (47f27fb)
- [x] P1 invite first-user fallback → authClient.getSession() (b8f2725) — NEEDS live invite smoke
- [x] P1 inert href="#" → disabled on null blobUrl (b73d738)
- [x] P1 a11y aria-labels: users copy, integrations Eye, behavior-card all inputs (b73d738, db75d7e)
- [~] P1 channels empty-state CTA → DOWNGRADED (already guided; no change)
- [x] P2 non-gated actionable: projects "Loading…" (071c015). Verified FALSE-POSITIVE/intentional (no action, would be churn): reduced-motion (already global globals.css:425), clickable-div stopProp wrappers, global-error inline styles (intentional root-boundary fallback).
- [~] P2 REMAINING = not-worth-churning or gated: hex swaps in ChartRenderer(#3b82f6 series color)/code-renderers(#0d0d0d intentional dark)/spacing micro-nudges = intentional, leave. modal/error dedup = refactor, out of "not a redesign" scope. orphan routes = need operator intent. GATED: terminology, Stripe stubs.
- [~] P3 = intentional/marginal (badge radius valid, landing fonts intentional, handshake TODO=feature stub, no-optimistic-UI=design choice). Only maybe: cause line on generic error boundaries — low value.
- [ ] Lens 6 responsive: stand up Playwright 360/768 mobile harness, then audit — REAL remaining COVERAGE gap, needs fresh context budget
- [x] Ship Gate: typecheck exit 0 every commit + full `@plexo/web build` exit 0 (68 routes).
- [x] MERGED to main (ff, 24cc98e) + PUSHED to origin (public joeybuilt-official/plexo) — operator authorized.
- [x] DEPLOYED + LIVE-VERIFIED on app.getplexo.com: P0#2 SCL link now /app/settings/intelligence (DOM confirmed, no /scl); P0#1 no /app/audit href anywhere in DOM. App home + getplexo.com both healthy.
  - DEPLOY GOTCHA (cost me a wrong rebuild): app.getplexo.com = `plexo-saas` (compose /srv/plexo, `docker compose build plexo-saas && docker compose up -d --no-deps plexo-saas`). `plexo-web` is RETIRED (I rebuilt+recreated it by mistake — harmless, same patched code; it's an orphan, operator may stop it). Already in memory [[reference_plexo_deploy_migrations]] L30 — CHECK MEMORY BEFORE DEPLOY.
  - Version label still shows de0c7f8 (cosmetic — git HEAD on the prod-snapshot tree unchanged; overlay deploy).
- [ ] Lens 6 responsive — STILL the one real coverage gap; use the existing Playwright E2E system at mobile viewports (next session).
- NOTE: live-verify blocked — deployed app is OLD build; in-app verification of fixes needs a (gated) deploy. Per-commit typecheck = exit 0 throughout.
- DECISIONS OPEN: terminology noun; Tasks vs Works nav (merge?); Stripe scope; dedicated SCL settings page y/n
