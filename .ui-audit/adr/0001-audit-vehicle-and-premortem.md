# ADR 0001 — Audit vehicle + pre-mortem

## Status
Accepted 2026-06-09. Operator chose **live prod, all lenses** (getplexo.com incl CRUD). Auth: user@example.com (creds provided). Scope: apps/web only (hub/cli/android excluded).
**Test-data hygiene (operator-authorized prod mutation):** for CRUD/destructive lenses, prefer create-then-delete of self-made test artifacts; do NOT delete the operator's existing real records to satisfy a lens. Tag any mutation in findings.

## Context
Plexo `apps/web` is live at https://getplexo.com backed by real production user data (`plexo-web` → `postgres`/pushd, search_path `plexo_web`). The audit's render/responsive/a11y/visual lenses need a real authenticated browser. The functionality lens needs CRUD round-trip and optimistic-rollback tests, which mutate data.

## Decision (proposed, pending operator)
**Vehicle split:**
- Read-only + navigation + render + responsive + a11y + visual lenses → run against **live getplexo.com** (faithful prod data/state, no mutation).
- CRUD / state / optimistic-rollback / destructive-action lenses → run against the existing **`.e2e-phased` ephemeral throwaway stack** (already has a bring-up recipe), so no prod data is touched.

**Auth:** browser work runs server-side per CLAUDE.md §0-A (webtop Chrome or headless Playwright on the container). Needs getplexo.com credentials once at job start.

## Pre-mortem — 3 likely failure causes + fallbacks
1. **Source drift: file:line refs in findings don't match the live deploy** (deployed image is ~20h old; `main` has newer commits). → Fallback: pin findings to `/workspace/plexo` `main` HEAD and note "live deploy may lag"; verify each cited file exists/contains the cited code before filing, per CLAUDE.md memory-verify rule.
2. **Can't authenticate / no creds → browser lenses blocked, audit degrades to static-only.** → Fallback: ask operator once for creds at gate; if still blocked, stand up the ephemeral stack with a seeded test user and audit there for ALL lenses (lower prod fidelity, full coverage).
3. **Scope blowout: 79 routes × 7 lenses overruns context mid-audit, partial findings.** → Fallback: lenses are independently checkpointable; raw notes land under `.ui-audit/` per route as produced, so a resumed session continues from the last unaudited checkbox. Static lenses parallelized to subagents to keep main context lean.

## Consequences
- Findings carry an evidence-source tag (live vs ephemeral vs static) so the operator knows fidelity.
- No mutation ever runs against getplexo.com prod.
