/** @type {import('dependency-cruiser').IConfiguration} */
// ADR-0045 Clean Architecture enforcement gate.
// Enforces the Dependency Rule: inner rings (domain, sdk, agent core) must not
// import outer rings (drizzle ORM, express, apps, higher packages). Existing
// violations are grandfathered via .dependency-cruiser-baseline.json (strangler
// adoption) — the gate prevents NEW violations, the backlog is fixed over time.
//
// to.path patterns match the RESOLVED path: workspace @plexo/* deps resolve to
// packages/<name> (pnpm symlinks), external deps to node_modules/.pnpm/.../<name>.
module.exports = {
    forbidden: [
        // ── Dependency Rule: lower packages must not import higher ───────────
        {
            name: 'db-imports-agent-or-api',
            comment: 'packages/db is an inner adapter — must not depend on agent/api/apps',
            severity: 'error',
            from: { path: '^packages/db/src/' },
            to: { path: '^packages/(agent|api)/' },
        },
        {
            name: 'sdk-imports-outer',
            comment: 'packages/sdk is the innermost contract — no ORM/framework/app deps',
            severity: 'error',
            from: { path: '^packages/sdk/src/' },
            to: { path: '(drizzle-orm|(^|/)express/|packages/(agent|api|db|queue|logger|storage|session-fabric|mcp-server|ui)/)' },
        },
        {
            name: 'logger-imports-outer',
            comment: 'logger is a low adapter — no domain/app deps',
            severity: 'error',
            from: { path: '^packages/logger/src/' },
            to: { path: 'packages/(agent|api|db|ui|sdk)/' },
        },
        {
            name: 'storage-imports-outer',
            comment: 'storage adapter — no domain/app deps',
            severity: 'error',
            from: { path: '^packages/storage/src/' },
            to: { path: 'packages/(agent|api|ui|sdk)/' },
        },
        {
            name: 'queue-imports-outer',
            comment: 'queue adapter — no domain/app deps',
            severity: 'error',
            from: { path: '^packages/queue/src/' },
            to: { path: 'packages/(agent|api|ui|sdk)/' },
        },
        {
            name: 'mcp-server-imports-app',
            comment: 'mcp-server adapter — no app deps',
            severity: 'error',
            from: { path: '^packages/mcp-server/src/' },
            to: { path: '^apps/' },
        },

        // ── agent core must not import the ORM / db adapter directly ──────────
        // Inner-ring business rules reach drizzle/db via repository PORTS, not
        // the ORM. Existing violations grandfathered in the baseline.
        {
            name: 'agent-core-imports-orm',
            comment: 'agent core must not import drizzle-orm or @plexo/db — use a repository port',
            severity: 'error',
            from: { path: '^packages/agent/src/(executor|providers|memory|tasks|prompts|principles|behavior|escalation|capabilities|planner)/' },
            to: { path: '(drizzle-orm|packages/db/)' },
        },

        // ── apps/api layer rules ─────────────────────────────────────────────
        {
            name: 'api-domain-imports-orm',
            comment: 'apps/api/src/domain is framework-free — no drizzle/express/@plexo/db',
            severity: 'error',
            from: { path: '^apps/api/src/domain/' },
            to: { path: '(drizzle-orm|(^|/)express/|packages/db/)' },
        },
        {
            name: 'api-application-imports-orm',
            comment: 'apps/api/src/application depends on ports — no drizzle/express directly',
            severity: 'error',
            from: { path: '^apps/api/src/application/' },
            to: { path: '(drizzle-orm|(^|/)express/)' },
        },
        {
            name: 'api-routes-imports-drizzle',
            comment: 'routes are thin controllers — DB access via repositories, not drizzle directly',
            severity: 'error',
            from: { path: '^apps/api/src/routes/' },
            to: { path: 'drizzle-orm' },
        },

        // ── generic ──────────────────────────────────────────────────────────
        { name: 'not-circular', severity: 'error', from: {}, to: { circular: true } },
        { name: 'not-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
    ],
    options: {
        doNotFollow: ['node_modules'],
        tsPreCompilationDeps: true,
        tsConfig: { fileName: 'tsconfig.arch.json' },
        exclude: {
            dynamic: true,
        },
    },
}