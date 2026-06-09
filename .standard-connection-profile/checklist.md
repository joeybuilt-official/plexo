# Standard — checklist

## Phase 0 — read-only audit ✅ 2026-06-09
- [x] Q1 Pex client/SDK surface — EXISTS (`@joeybuilt/plexo-sdk` `./connect` = real HTTP RPC `PlexoClient`)
- [x] Q1b in-repo direct-core access — 365 `@plexo/*` vs 5 SDK (expected: in-repo apps ARE core; SDK is for external apps). GAP: external-app SDK usage is cross-repo, unverified here
- [x] Q2 domain-logic drift — MOSTLY CLEAN; 2 instances (Levio timezone in executor BLATANT; Levio calendar prompt rule MINOR)
- [x] Q3 tool registration — PARTIAL (PEX extensions runtime-register per session; native connectors static/compiled)
- [x] Q4 discovery/connection-resolution — ABSENT (well-known spec defined, unused; plexoUrl hardcoded)
- [x] Q5 capability profiles — ABSENT (workspace all-or-nothing; no per-app scoping)
- [x] Q6 core/integration boundary — LEAKING in places (route layer imports CONNECTION_REGISTRY etc.)
- [x] Q7 auth — Better Auth (users) + PLEXO_SERVICE_KEY/X-App-Id (app↔core) + HMAC (inbound). Clean, not Better-Auth-only by design
- [x] findings → progress.md; STOP + summarize before Phase 1

## Phase 1 — OSS benchmark ✅ 2026-06-09
- [x] LSP, Ollama, MCP, DB driver↔engine + hashicorp/go-plugin (Terraform). Findings → progress.md
- [x] first principles named P1–P6 (resolution ladder / advertise-negotiate / explicit-version-fail-loud / service-absent-non-fatal / thin-client / server-side-scoping)
- [x] deliberate deviations documented (inverted-MCP topology; multi-tenant×app; dial-remote default)

## Phase 2 — expert panel ✅ 2026-06-09
- [x] Sec/Perf/Maint/DX + Dist-sys, 5 mandatory answers → progress.md
- [x] 4 conflicts surfaced + escalated; operator decided: full launch-local / explicit-approval grant / two-tier tools / per-op-class service-absent

## Phase 3 — pre-mortem + ADR (OPERATOR GATE) — DRAFTED, awaiting approval
- [x] pre-mortem: 3 causes + fallback each (launch-local split-brain; grant friction; two-tier ossification)
- [x] ADR: adr/0001-connection-profile-standard.md (connection / Pex client / profile / tool-registration / version / service-absent contracts + binding dependency statement)
- [ ] **HARD STOP — operator approval before any code (Phase 4)**

## Phase 4 — execution (post-approval)
- [ ] reference Pex client + profile negotiation; progress.md at each boundary; ship gate before push
