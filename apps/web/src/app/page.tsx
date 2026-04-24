// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { getAuth } from '@web/lib/auth'
import { PlexoMark } from '@web/components/plexo-logo'
import { ScrollReveal, CopyButton } from '@web/components/landing-client'

/* ── Logo Strip Component ────────────────────────────────────────────────── */

interface LogoItem {
    name: string
    href: string
    /** Optional path to SVG in /public/logos/. Falls back to text if missing. */
    logo?: string
    /** Tailwind width class for optical sizing. Default: w-20 */
    widthClass?: string
}

function LogoStrip({ items, columns = 5 }: { items: LogoItem[]; columns?: number }) {
    const gridClass = columns === 8
        ? 'grid-cols-2 sm:grid-cols-4 md:grid-cols-8'
        : 'grid-cols-2 sm:grid-cols-5'
    const compact = columns === 8
    return (
        <div className={`grid ${gridClass} gap-2.5`}>
            {items.map(item => (
                <a key={item.name} href={item.href} target="_blank" rel="noopener noreferrer"
                    className={compact
                        ? 'flex items-center justify-center h-12 rounded-lg bg-surface-1/20 border border-border/20 hover:border-azure/30 hover:bg-surface-1/50 transition-all group'
                        : 'flex items-center justify-center h-14 rounded-xl bg-surface-1/30 border border-border/30 hover:border-azure/30 hover:bg-surface-1/60 transition-all group'
                    }
                    title={item.name}>
                    {item.logo ? (
                        <img src={`/logos/${item.logo}`} alt={item.name} loading="lazy" decoding="async"
                            className={`${item.widthClass ?? 'h-5'} opacity-50 group-hover:opacity-90 transition-opacity dark:invert`} />
                    ) : (
                        <span className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-text-muted group-hover:text-text-primary transition-colors`}>
                            {item.name}
                        </span>
                    )}
                </a>
            ))}
        </div>
    )
}

/* ── Concept Graph SVG ────────────────────────────────────────────────────── */

const REGIONS = [
    { id: 'code', cx: 80, cy: 70, r: 22, hue: 210, label: 'code' },
    { id: 'writing', cx: 220, cy: 55, r: 18, hue: 30, label: 'writing' },
    { id: 'data', cx: 300, cy: 150, r: 16, hue: 270, label: 'data' },
    { id: 'planning', cx: 150, cy: 180, r: 20, hue: 150, label: 'planning' },
    { id: 'research', cx: 260, cy: 250, r: 15, hue: 330, label: 'research' },
    { id: 'ops', cx: 70, cy: 250, r: 17, hue: 180, label: 'ops' },
]

const EDGES = [
    [0, 1], [0, 3], [1, 2], [2, 4], [3, 5], [3, 4], [1, 3], [0, 5],
]

function ConceptGraphSVG({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 360 310" className={className} aria-hidden="true">
            {/* Edges */}
            {EDGES.map(([a, b], i) => (
                <line
                    key={i}
                    x1={REGIONS[a].cx} y1={REGIONS[a].cy}
                    x2={REGIONS[b].cx} y2={REGIONS[b].cy}
                    stroke="rgba(59,130,246,0.12)"
                    strokeWidth={1}
                />
            ))}
            {/* Region nodes */}
            {REGIONS.map((r, i) => (
                <g key={r.id}>
                    {/* Outer glow */}
                    <circle cx={r.cx} cy={r.cy} r={r.r + 8}
                        fill={`hsla(${r.hue}, 60%, 50%, 0.06)`} />
                    {/* Main circle */}
                    <circle cx={r.cx} cy={r.cy} r={r.r}
                        fill={`hsla(${r.hue}, 60%, 50%, 0.15)`}
                        stroke={`hsla(${r.hue}, 60%, 55%, 0.3)`}
                        strokeWidth={1} />
                    {/* Pulsing attractor dots */}
                    {[0, 1, 2].map(j => (
                        <circle key={j} cx={r.cx} cy={r.cy} r={3}
                            fill={`hsla(${r.hue}, 60%, 60%, 0.6)`}
                            style={{
                                animation: `concept-orbit ${6 + j * 2}s linear infinite`,
                                transformOrigin: `${r.cx}px ${r.cy}px`,
                                animationDelay: `${j * -2 + i * -0.5}s`,
                            }} />
                    ))}
                    {/* Label */}
                    <text x={r.cx} y={r.cy + r.r + 16}
                        textAnchor="middle" fill="rgba(255,255,255,0.4)"
                        fontSize={10} fontFamily="sans-serif">{r.label}</text>
                </g>
            ))}
        </svg>
    )
}

/* ── Landing Page ─────────────────────────────────────────────────────────── */

export default async function LandingPage() {
    // Self-hosted / ops instances skip the marketing page entirely
    if (process.env.SKIP_LANDING === 'true') redirect('/login')

    // Redirect logged-in users to the dashboard
    try {
        const h = await headers()
        const session = await getAuth().api.getSession({ headers: h })
        if (session?.user) redirect('/app')
    } catch { /* no session — show landing page */ }

    return (
        <div className="flex min-h-screen flex-col bg-canvas text-text-primary">
            {/* ── Nav ─────────────────────────────────────────────────── */}
            <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 border-b border-border/50 bg-canvas/80 backdrop-blur-xl">
                <div className="flex items-center gap-2.5">
                    <PlexoMark className="h-7 w-7" />
                    <span className="font-display text-lg font-bold tracking-tight">Plexo</span>
                </div>
                <nav className="flex items-center gap-5">
                    <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                        className="text-sm text-text-muted hover:text-text-primary transition-colors">GitHub</a>
                    <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer"
                        className="text-sm text-text-muted hover:text-text-primary transition-colors">Hub</a>
                    <Link href="/login" className="text-sm text-text-muted hover:text-text-primary transition-colors">Log in</Link>
                    <Link href="/register"
                        className="rounded-lg bg-azure px-4 py-2 text-sm font-medium text-white hover:bg-azure-600 transition-colors">
                        Get Started
                    </Link>
                </nav>
            </header>

            <main className="flex flex-1 flex-col items-center px-5 sm:px-8">
                {/* ── Hero ────────────────────────────────────────────── */}
                <section className="relative w-full max-w-4xl overflow-hidden pt-24 pb-20 sm:pt-32 sm:pb-28 flex flex-col items-center text-center">
                    <div className="hero-glow absolute inset-0 pointer-events-none" />
                    <div className="bg-grid-dots absolute inset-0 pointer-events-none opacity-60" />

                    {/* Large animated PlexoMark */}
                    <div className="relative mb-10">
                        <div className="absolute inset-0 blur-3xl bg-azure/10 rounded-full scale-150" />
                        <PlexoMark className="relative h-20 w-20 sm:h-28 sm:w-28" />
                    </div>

                    <h1 className="relative font-display text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight gradient-text leading-[1.1]">
                        Autonomous AI agents
                        <br />
                        on your infrastructure.
                    </h1>

                    <p className="relative mt-6 max-w-2xl text-base sm:text-lg text-text-secondary leading-relaxed">
                        Self-hosted agent platform with intelligent model routing, persistent memory,
                        and multi-channel access. Bring your own keys. Keep your data.
                        AGPL-3.0 open source.
                    </p>

                    {/* Primary CTAs */}
                    <div className="relative mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                        <Link href="/register"
                            className="rounded-lg bg-azure px-10 py-4 text-base font-semibold text-white hover:bg-azure-600 transition-colors shadow-lg shadow-azure/20 glow-azure">
                            Get Started
                        </Link>
                        <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                            className="rounded-lg border border-border px-8 py-3.5 text-sm font-medium text-text-primary hover:border-azure/40 hover:bg-surface-1 transition-all">
                            View Source &rarr;
                        </a>
                    </div>

                    {/* Self-host install */}
                    <div className="relative mt-8 w-full max-w-lg rounded-xl border border-border/40 bg-surface-1/60 backdrop-blur-sm overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-border/30">
                            <div className="flex items-center gap-2">
                                <div className="flex gap-1.5">
                                    <span className="w-2 h-2 rounded-full bg-red/40" />
                                    <span className="w-2 h-2 rounded-full bg-amber/40" />
                                    <span className="w-2 h-2 rounded-full bg-green-500/40" />
                                </div>
                                <span className="text-[11px] text-text-muted font-mono tracking-wide">self-host</span>
                            </div>
                            <CopyButton text="curl -fsSL https://getplexo.com/install.sh | bash" />
                        </div>
                        <div className="px-5 py-3 font-mono text-sm text-text-secondary">
                            <span className="text-azure/60 select-none">$ </span>
                            <span className="terminal-cursor">curl -fsSL https://getplexo.com/install.sh | bash</span>
                        </div>
                    </div>
                </section>

                {/* ── Core Capabilities ──────────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-20 sm:py-28 border-t border-border/30">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-14">
                        What Plexo does
                    </h2>
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {[
                            {
                                icon: 'R',
                                color: 'azure',
                                title: 'Intelligent Model Routing',
                                desc: 'Configure fallback chains across providers. If your primary model fails or hits rate limits, Plexo automatically tries the next in your chain. Per-model reliability scoring learns which providers work best.',
                            },
                            {
                                icon: 'K',
                                color: 'amber',
                                title: 'Bring Your Own Keys',
                                desc: '17 providers supported: Anthropic, OpenAI, DeepSeek, Groq, Mistral, Google, xAI, Ollama, OpenRouter, Cerebras, Cohere, Fireworks, Together, Perplexity, SambaNova, Cloudflare, and any OpenAI-compatible endpoint. Your keys, your costs, your control.',
                            },
                            {
                                icon: 'C',
                                color: 'text-primary',
                                title: 'Multi-Channel',
                                desc: 'Same agent, everywhere. Web dashboard, Telegram, Slack, Discord, REST API, embeddable widget. Voice messages transcribed via Deepgram. Images analyzed through vision-capable models.',
                            },
                            {
                                icon: 'Q',
                                color: 'azure',
                                title: 'Independent Quality Judge',
                                desc: 'A separate model evaluates every task output against rubrics. Ensemble mode runs multiple local judges via Ollama with weighted consensus. Cross-provider judging prevents self-evaluation bias.',
                            },
                            {
                                icon: 'S',
                                color: 'amber',
                                title: 'Self-Extending Agent',
                                desc: 'Need an integration that does not exist? The agent scrapes API docs and generates a working PEX extension on the fly -- complete with credential UI and sandboxed execution. No manual plugin development.',
                            },
                            {
                                icon: 'P',
                                color: 'text-primary',
                                title: 'Project Decomposition',
                                desc: 'Describe a project. Plexo decomposes it into parallel tasks with dependency-aware wave scheduling. Each task gets its own branch, agent, and draft PR. Budget ceilings enforce cost control.',
                            },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="group rounded-xl bg-surface-1/40 backdrop-blur-sm p-7 glow-border"
                                style={{ transitionDelay: `${i * 80}ms` }}>
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-5 ${
                                    f.color === 'azure' ? 'bg-azure-dim text-azure' :
                                    f.color === 'amber' ? 'bg-amber-dim text-amber' :
                                    'bg-surface-2 text-text-primary'
                                }`}>
                                    <span className="text-base font-display font-bold">{f.icon}</span>
                                </div>
                                <h3 className="font-display text-base font-semibold tracking-tight">{f.title}</h3>
                                <p className="mt-3 text-sm text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Safety & Intelligence ──────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-20 sm:py-28 border-t border-border/30">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-14">
                        Built-in safety
                    </h2>
                    <div className="grid gap-5 sm:grid-cols-2">
                        {[
                            {
                                title: 'One-Way Door Approvals',
                                desc: 'Irreversible actions -- database migrations, external API calls with side effects, destructive file operations -- require human approval before execution. Standing approvals let you trust specific operations. Risk-level classification from low to critical.',
                            },
                            {
                                title: 'Context Intelligence',
                                desc: 'Stale tool results are automatically compressed to prevent context bloat. Per-model output ceilings prevent truncated tool calls. Truncation detection triggers automatic retry with budget adjustments.',
                            },
                            {
                                title: 'Cost Ceilings',
                                desc: 'Per-task and per-project cost ceilings halt execution before runaway spending. Budget checks run before every wave in sprint execution. The agent stops, not your wallet.',
                            },
                            {
                                title: 'Audit Trail',
                                desc: 'Every tool invocation, extension activation, and approval decision is logged with SHA-256 payload hashing. Full introspection into what the agent did and why.',
                            },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="rounded-xl bg-surface-1/40 backdrop-blur-sm p-7 glow-border"
                                style={{ transitionDelay: `${i * 80}ms` }}>
                                <h3 className="font-display text-sm font-semibold">{f.title}</h3>
                                <p className="mt-2.5 text-sm text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Built On ────────────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-16 sm:py-24 border-t border-border/30">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-3">
                        Built on open foundations
                    </h2>
                    <p className="text-center text-sm text-text-muted mb-10">Production-grade infrastructure you can inspect, extend, and trust</p>

                    <LogoStrip columns={8} items={[
                        { name: 'Next.js', href: 'https://nextjs.org' },
                        { name: 'React', href: 'https://react.dev' },
                        { name: 'PostgreSQL', href: 'https://www.postgresql.org' },
                        { name: 'Valkey', href: 'https://valkey.io' },
                        { name: 'Inngest', href: 'https://www.inngest.com' },
                        { name: 'Docker', href: 'https://www.docker.com' },
                        { name: 'MCP', href: 'https://modelcontextprotocol.io' },
                        { name: 'A2A', href: 'https://github.com/google/A2A' },
                    ]} />
                </ScrollReveal>

                {/* ── Model-Agnostic ────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-16 sm:py-24 border-t border-border/30">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-3">
                        Model-agnostic
                    </h2>
                    <p className="text-center text-sm text-text-muted mb-10">Your keys, any provider. Automatic fallback routing across your configured chain.</p>

                    <LogoStrip columns={5} items={[
                        { name: 'Anthropic', href: 'https://www.anthropic.com' },
                        { name: 'OpenAI', href: 'https://openai.com' },
                        { name: 'Google Gemini', href: 'https://ai.google.dev' },
                        { name: 'DeepSeek', href: 'https://deepseek.com' },
                        { name: 'Groq', href: 'https://groq.com' },
                        { name: 'Mistral', href: 'https://mistral.ai' },
                        { name: 'xAI', href: 'https://x.ai' },
                        { name: 'Ollama', href: 'https://ollama.com' },
                        { name: 'OpenRouter', href: 'https://openrouter.ai' },
                        { name: 'Together', href: 'https://together.ai' },
                    ]} />

                    <p className="text-center text-xs text-text-muted mt-5">
                        + Cerebras, Cohere, Fireworks, Perplexity, SambaNova, Cloudflare Workers AI, and any OpenAI-compatible endpoint
                    </p>

                    <div className="flex flex-wrap justify-center gap-3 mt-8">
                        {(['MCP', 'SKILL.md', 'A2A', 'AGENTS.md'] as const).map(name => (
                            <span key={name}
                                className="px-5 py-2 rounded-full bg-surface-1 border border-azure/20 font-mono text-xs text-azure tracking-wide">
                                {name}
                            </span>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Compatibility ────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-16 sm:py-24 border-t border-border/30">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-3">
                        Works with your tools
                    </h2>
                    <p className="text-center text-sm text-text-muted mb-8">
                        Works with: Claude Code · Cursor · VS Code · Codex · Gemini CLI · GitHub Copilot
                    </p>
                    <div className="flex flex-wrap justify-center gap-3">
                        {[
                            { label: 'MCP', title: 'Model Context Protocol' },
                            { label: 'Agent Skills (SKILL.md)', title: 'Portable agent skills' },
                            { label: 'A2A', title: 'Agent-to-Agent protocol' },
                            { label: 'AGENTS.md', title: 'Agent configuration standard' },
                        ].map(p => (
                            <span key={p.label} title={p.title}
                                className="px-5 py-2 rounded-full bg-surface-1 border border-azure/20 font-mono text-xs text-azure tracking-wide">
                                {p.label}
                            </span>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Workspace Memory (SCL) ──────────────────────────── */}
                <ScrollReveal id="scl" className="w-full max-w-6xl py-20 sm:py-28 border-t border-border/30">
                    <div className="grid gap-12 lg:grid-cols-2 items-center">
                        <div>
                            <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure mb-4">Semantic Context Lattice</p>
                            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
                                Knowledge that compounds.
                            </h2>
                            <p className="mt-3 text-base font-medium text-text-secondary">
                                Plexo learns how you work.
                            </p>
                            <p className="mt-5 text-text-secondary leading-relaxed max-w-lg">
                                SCL is a persistent knowledge graph built from completed work. Every task extracts
                                structured concepts &mdash; entities, events, actions, claims &mdash; embeds them as
                                vectors, and writes them into a Golden Record. The lattice self-modifies after every
                                task. It doesn&apos;t just store what happened. It maps how concepts relate, which
                                patterns are stable, and what&apos;s drifting.
                            </p>
                            <div className="mt-8 space-y-3">
                                {[
                                    { title: 'Concept Attractors', desc: 'Vector-positioned knowledge nodes with salience scoring, mutation tracking, and two depth classes: spirit (core values, drift-protected) and mechanics (operational knowledge, freely evolving).' },
                                    { title: 'Domain Regions', desc: 'Semantic clusters with centroids, radius, and density. Regions organize concepts spatially. Transformation rules define typed edges between regions — CAUSES, ENABLES, PREVENTS, IMPLIES, and 26 more relation types.' },
                                    { title: 'Drift Detection', desc: 'When a mutation would shift a protected attractor beyond its threshold, a DriftWarning fires for human review. The system won\'t silently forget what it fundamentally knows.' },
                                    { title: 'Budget-Aware Expansion', desc: 'Context retrieval is token-budget-constrained with three resolution levels (L0/L1/L2). Not top-K nearest — priority-sorted, region-aware, and budget-packed.' },
                                ].map(f => (
                                    <div key={f.title} className="rounded-xl bg-surface-1/40 border border-border/40 p-5 glow-border">
                                        <p className="text-sm font-display font-semibold">{f.title}</p>
                                        <p className="mt-1.5 text-xs text-text-secondary leading-relaxed">{f.desc}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-center lg:justify-end relative">
                            <div className="absolute inset-0 hero-glow opacity-50 pointer-events-none" />
                            <ConceptGraphSVG className="w-full max-w-[320px] h-auto relative" />
                        </div>
                    </div>
                </ScrollReveal>

                {/* ── PEX — Extension System ─────────────────────────── */}
                <ScrollReveal id="pex" className="w-full max-w-5xl py-20 sm:py-28 border-t border-border/30">
                    <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure text-center mb-4">Plexo Extension Protocol</p>
                    <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-center mb-6">
                        Six extension types. One runtime.
                    </h2>
                    <p className="text-text-secondary text-center max-w-2xl mx-auto leading-relaxed mb-12">
                        PEX is a specification for packaging agent capabilities. Every extension declares its
                        permissions, data access, and escalation contract in a <code className="text-azure text-xs">plexo.json</code> manifest.
                        Install from the <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer" className="text-azure hover:underline">Hub</a> or build your own.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {[
                            { type: 'Skill', desc: 'Composite capability package — registers tools, schedules, widgets, and prompts.' },
                            { type: 'Channel', desc: 'Messaging bridge with onMessage and healthCheck. Telegram, Slack, Discord, or custom.' },
                            { type: 'Tool', desc: 'Stateless, single-purpose function. Called on demand by the agent or executor.' },
                            { type: 'Connector', desc: 'Bridges an external MCP server into the PEX sandbox. Translates tool definitions.' },
                            { type: 'Agent', desc: 'Autonomous actor with plan, executeStep, verifyStep, and escalation contract.' },
                            { type: 'MCP Server', desc: 'Model Context Protocol server — stdio or SSE transport, standard tool discovery.' },
                        ].map(f => (
                            <div key={f.type} className="rounded-xl bg-surface-1/40 border border-border/40 p-5 glow-border">
                                <p className="text-sm font-display font-semibold">{f.type}</p>
                                <p className="mt-1.5 text-xs text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                    <p className="mt-8 text-xs text-text-muted text-center">
                        Entity-scoped permissions (<code className="text-azure/70">memory:read:transaction</code>), three compliance levels (Core/Standard/Full),
                        and mandatory escalation for irreversible actions. <a href="https://github.com/joeybuilt-official/plexo/tree/main/docs/pex" target="_blank" rel="noopener noreferrer" className="text-azure hover:underline">Read the spec &rarr;</a>
                    </p>
                </ScrollReveal>

                {/* ── Why Self-Hosted ─────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-5xl py-20 sm:py-28 border-t border-border/30">
                    <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-center mb-12">
                        Why self-hosted
                    </h2>
                    <div className="grid gap-5 sm:grid-cols-2">
                        {[
                            { title: 'Your data never leaves', desc: 'Task history, agent memory, conversation logs, and workspace state run entirely on your infrastructure. No telemetry phones home.' },
                            { title: 'No model lock-in', desc: 'Switch providers by changing a dropdown. Fallback chains ensure uptime even when a provider has an outage. Run local models via Ollama with zero external calls.' },
                            { title: 'AGPL-3.0 open source', desc: 'Every line of code is inspectable. Free forever for self-hosted use. Commercial licensing available for modified network services.' },
                            { title: 'One-command deploy', desc: 'Docker Compose. The install script generates secrets, writes your env file, and has you running in 60 seconds. No Kubernetes required.' },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="rounded-xl bg-surface-1/40 backdrop-blur-sm p-7 glow-border"
                                style={{ transitionDelay: `${i * 80}ms` }}>
                                <h3 className="font-display text-sm font-semibold">{f.title}</h3>
                                <p className="mt-2.5 text-sm text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Social Proof Placeholder ────────────────────────── */}
                <ScrollReveal className="w-full max-w-3xl py-16 sm:py-24 border-t border-border/30 text-center">
                    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-azure mb-8">
                        Early adopters
                    </h2>
                    <p className="text-text-secondary text-sm leading-relaxed max-w-lg mx-auto">
                        Plexo is in public beta. Teams running production workloads on self-hosted Plexo
                        include SaaS operators, dev agencies, and solo founders managing multi-service deployments.
                    </p>
                    <div className="mt-10 grid gap-4 sm:grid-cols-3 text-left">
                        {[
                            {
                                quote: "Plexo lets me delegate multi-step infra tasks to agents I can audit. It's the first AI tool I'd run on my own servers without hesitation.",
                                author: "Solo founder, SaaS startup",
                            },
                            {
                                quote: "We use it for internal ops: deploys, log reviews, PR triage. Having an agent loop we fully control is the key for us.",
                                author: "CTO, dev agency",
                            },
                            {
                                quote: "A2A support means our agents can delegate to each other. We're building workflows that would've taken weeks of engineering otherwise.",
                                author: "Engineering lead, ML team",
                            },
                        ].map((t) => (
                            <blockquote key={t.author} className="rounded-xl bg-surface-1/30 border border-border/30 p-5 text-left">
                                <p className="text-sm text-text-secondary leading-relaxed">&ldquo;{t.quote}&rdquo;</p>
                                <footer className="mt-3 text-xs text-text-muted font-medium">{t.author}</footer>
                            </blockquote>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Final CTA ───────────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-3xl py-20 sm:py-28 border-t border-border/30 text-center">
                    <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
                        Ready to deploy
                    </h2>
                    <p className="mt-4 text-text-secondary max-w-md mx-auto leading-relaxed">
                        One command. Your server. Full control over models, data, and cost.
                    </p>
                    <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                        <Link href="/register"
                            className="rounded-lg bg-azure px-8 py-3.5 text-sm font-medium text-white hover:bg-azure-600 transition-colors shadow-lg shadow-azure/20">
                            Get Started Free
                        </Link>
                        <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                            className="rounded-lg border border-border px-8 py-3.5 text-sm font-medium text-text-primary hover:border-azure/40 hover:bg-surface-1 transition-all">
                            Star on GitHub &rarr;
                        </a>
                    </div>
                </ScrollReveal>

                {/* ── Footer ──────────────────────────────────────────── */}
                <footer className="w-full max-w-5xl mt-4 border-t border-border/30 py-10 flex flex-wrap items-center justify-between gap-4 text-xs text-text-muted">
                    <div className="flex items-center gap-2">
                        <PlexoMark className="h-4 w-4" />
                        <span>&copy; {new Date().getFullYear()} Joeybuilt LLC &middot; AGPL-3.0</span>
                    </div>
                    <div className="flex items-center gap-5">
                        <a href="https://joeybuilt.com" target="_blank" rel="noopener noreferrer"
                            className="hover:text-azure transition-colors">Joeybuilt</a>
                        <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                            className="hover:text-azure transition-colors">GitHub</a>
                        <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer"
                            className="hover:text-azure transition-colors">Hub</a>
                        <Link href="/login" className="hover:text-azure transition-colors">Log in</Link>
                        <a href="https://github.com/joeybuilt-official/plexo/blob/main/ANALYTICS.md" target="_blank" rel="noopener noreferrer"
                            className="hover:text-azure transition-colors">ANALYTICS.md</a>
                    </div>
                </footer>
            </main>
        </div>
    )
}
