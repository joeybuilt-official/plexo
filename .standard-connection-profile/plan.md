# Plexo Connection & Profile Standard — master plan

Canonical contract: apps carry a thin **Pex client** and connect to a single addressable Plexo resolved by topology; capability scoped per app via **profiles**; all intelligence executes in Plexo Core; **apps own domain tools** (registered at runtime), core stays domain-agnostic.

Read-only through Phase 3. NO source changes until the operator approves the ADR (Phase 3 hard stop).

## Order
- **Phase 0** — read-only audit of Plexo Core (current reality). → findings in progress.md. ✅
- **Phase 1** — OSS benchmark (LSP, Ollama, MCP, DB driver↔engine; +1 more). First principles.
- **Phase 2** — expert panel (Security/Perf/Maintainability/DX + distributed-systems). Surface conflicts → operator.
- **Phase 3** — pre-mortem (3 causes + fallbacks) + ADR. HARD STOP for operator approval.
- **Phase 4** — execution (reference Pex client + profile negotiation), post-approval only.

## Key invariant
"Routes through Plexo" = execution, not ownership. Core owns intelligence primitives + the agent/execution engine. Apps own domain logic + tools, registered over Pex per session, never persisted in core.

## Artifacts
- plan.md (this), checklist.md, adr/ (Phase 3 output).
- Findings → /workspace/plexo/progress.md (per hand-off).
