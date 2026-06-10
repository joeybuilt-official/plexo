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

## Phase 3 — Fix (post-approval)
- [ ] Fixes applied in severity order, verified in running app
- [ ] Findings-doc status updated per issue
- [ ] Ship Gate green before any push
