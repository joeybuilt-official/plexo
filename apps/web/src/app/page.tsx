// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { getAuth } from '@web/lib/auth'
import { isMarketingEnabled } from '@web/lib/feature-flags'
import { PlexoMark } from '@web/components/plexo-logo'
import { ScrollReveal, CopyButton } from '@web/components/landing-client'
import { LandingThemeToggle } from '@web/components/landing-theme-toggle'

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
        : columns === 6
            ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-6'
            : 'grid-cols-2 sm:grid-cols-5'
    const compact = columns >= 6
    return (
        <div className={`grid ${gridClass} gap-2`}>
            {items.map(item => (
                <a key={item.name} href={item.href} target="_blank" rel="noopener noreferrer"
                    className={compact
                        ? 'flex items-center justify-center h-11 rounded-md bg-surface-1/20 border border-border/20 hover:border-accent-dim hover:bg-surface-1/50 transition-all group'
                        : 'flex items-center justify-center h-12 rounded-md bg-surface-1/30 border border-border/30 hover:border-accent-dim hover:bg-surface-1/60 transition-all group'
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

/* ── Stat Block ──────────────────────────────────────────────────────────── */

function StatBlock({ value, label }: { value: string; label: string }) {
    return (
        <div className="text-left">
            <p className="font-mono text-2xl font-medium text-accent tracking-tight">{value}</p>
            <p className="text-xs text-text-muted mt-0.5">{label}</p>
        </div>
    )
}

/* ── Landing Page ─────────────────────────────────────────────────────────── */

export default async function LandingPage() {
    // Authed users always go to the dashboard, regardless of marketing flag.
    let hasSession = false
    try {
        const h = await headers()
        const session = await getAuth().api.getSession({ headers: h })
        hasSession = !!session?.user
    } catch { /* no session -- treat as anon */ }

    if (hasSession) redirect('/app')

    // Self-host default: marketing is OFF, send anon visitors to /login.
    // getplexo.com opts in via PLEXO_MARKETING_ENABLED=true.
    if (!isMarketingEnabled()) redirect('/login')

    return (
        <div className="flex min-h-screen flex-col bg-canvas text-text-primary">
            {/* ── Nav ─────────────────────────────────────────────────── */}
            <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 border-b border-border/50 bg-canvas/90">
                <div className="flex items-center gap-2.5">
                    <PlexoMark className="h-6 w-6" />
                    <span className="font-display text-base font-semibold tracking-tight" style={{ letterSpacing: '-0.03em' }}>_plexo</span>
                </div>
                <nav className="flex items-center gap-5">
                    <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                        className="text-sm text-text-muted hover:text-text-primary transition-colors">GitHub</a>
                    <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer"
                        className="text-sm text-text-muted hover:text-text-primary transition-colors">Hub</a>
                    <Link href="/login" className="text-sm text-text-muted hover:text-text-primary transition-colors">Log in</Link>
                    <LandingThemeToggle />
                    <Link href="/register"
                        className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-dim transition-colors">
                        Get Started
                    </Link>
                </nav>
            </header>

            <main className="flex flex-1 flex-col items-center px-5 sm:px-8">
                {/* ── Hero ────────────────────────────────────────────── */}
                <section className="w-full max-w-6xl pt-20 pb-16 grid grid-cols-1 lg:grid-cols-5 gap-12 items-start">
                    {/* Left — 60% */}
                    <div className="lg:col-span-3">
                        <h1 className="font-display text-4xl sm:text-5xl md:text-[56px] font-medium leading-[1.08] text-text-primary"
                            style={{ letterSpacing: '-0.03em' }}>
                            Autonomous AI agents<br />
                            on your infrastructure.
                        </h1>

                        <p className="mt-5 text-lg text-text-secondary max-w-lg">
                            Plexo is the agent harness — tasks, schedules, channels, and one-way-door safety.
                            Connect Claude, GPT, or your own Ollama. Self-hosted. AGPL-3.0.
                        </p>

                        {/* CTAs */}
                        <div className="mt-8 flex items-center gap-4">
                            <Link href="/register"
                                className="rounded-md bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent-dim transition-colors">
                                Get Started
                            </Link>
                            <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                                className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
                                View Source &rarr;
                            </a>
                        </div>

                        {/* Install command */}
                        <div className="mt-6 w-full max-w-md rounded-md border border-border/40 bg-surface-1/60 overflow-hidden">
                            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
                                <span className="text-[11px] text-text-muted font-mono tracking-wide">self-host</span>
                                <CopyButton text="curl -fsSL https://getplexo.com/install.sh | bash" />
                            </div>
                            <div className="px-4 py-2.5 font-mono text-sm text-text-secondary">
                                <span className="text-accent/60 select-none">$ </span>
                                <span className="terminal-cursor">curl -fsSL https://getplexo.com/install.sh | bash</span>
                            </div>
                        </div>

                        {/* Stats row */}
                        <div className="mt-8 flex items-center gap-8">
                            <StatBlock value="17" label="Providers" />
                            <StatBlock value="6" label="Extension types" />
                            <StatBlock value="5" label="Channels" />
                            <StatBlock value="AGPL-3.0" label="License" />
                        </div>
                    </div>

                    {/* Right — 40% config block */}
                    <div className="lg:col-span-2 mt-2">
                        <div className="rounded-md border border-border/50 bg-surface-1/40 overflow-hidden">
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
                                <span className="w-2 h-2 rounded-full bg-signal-red/60" />
                                <span className="w-2 h-2 rounded-full bg-amber/60" />
                                <span className="w-2 h-2 rounded-full bg-signal-green/60" />
                                <span className="ml-2 text-[11px] text-text-muted font-mono">plexo.config</span>
                            </div>
                            <pre className="px-4 py-4 font-mono text-[13px] leading-relaxed text-text-secondary overflow-x-auto">
                                <code>{`agents:
  - name: research
    model: claude-sonnet-4-6
    memory: persistent
    tools: [web, github, notion]

  - name: ops
    model: gemini-2.5-flash
    schedule: "*/30 * * * *"
    tools: [docker, ssh, deploy]

  - name: writer
    model: gpt-4.1
    channels: [slack, telegram]
    tools: [docs, calendar]

routing:
  fallback: [anthropic, openai, groq]
  strategy: cost-optimized`}</code>
                            </pre>
                        </div>
                    </div>
                </section>

                {/* ── Core Capabilities ──────────────────────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="mb-8">
                        <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Capabilities</p>
                        <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                            What Plexo does
                        </h2>
                        <p className="text-sm text-text-secondary max-w-lg mt-3">
                            A self-hosted platform for running autonomous AI agents with full control over models, data, and cost.
                        </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {[
                            {
                                icon: 'R',
                                title: 'Intelligent Model Routing',
                                desc: 'Fallback chains across providers. If primary fails or hits rate limits, Plexo tries the next. Per-model reliability scoring learns which providers work best.',
                            },
                            {
                                icon: 'K',
                                title: 'Bring Your Own Keys',
                                desc: '17 providers: Anthropic, OpenAI, DeepSeek, Groq, Mistral, Google, xAI, Ollama, OpenRouter, Cerebras, Cohere, Fireworks, Together, Perplexity, SambaNova, Cloudflare, and any OpenAI-compatible endpoint.',
                            },
                            {
                                icon: 'C',
                                title: 'Multi-Channel',
                                desc: 'Same agent everywhere. Web, Telegram, Slack, Discord, REST API, embeddable widget. Voice transcribed via Deepgram. Images via vision-capable models.',
                            },
                            {
                                icon: 'Q',
                                title: 'Independent Quality Judge',
                                desc: 'Separate model evaluates every task output. Ensemble mode runs multiple local judges via Ollama with weighted consensus. Cross-provider judging prevents self-evaluation bias.',
                            },
                            {
                                icon: 'S',
                                title: 'Self-Extending Agent',
                                desc: 'Need an integration? The agent scrapes API docs and generates a working PEX extension -- credential UI and sandboxed execution included. No manual plugin dev.',
                            },
                            {
                                icon: 'P',
                                title: 'Project Decomposition',
                                desc: 'Describe a project. Plexo decomposes it into parallel tasks with dependency-aware wave scheduling. Each task gets its own branch, agent, and draft PR.',
                            },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="rounded-md border border-border/60 p-5 hover:border-accent-dim transition-colors"
                                style={{ transitionDelay: `${i * 60}ms` }}>
                                <div className="w-8 h-8 rounded-md flex items-center justify-center mb-3 bg-surface-2 text-accent">
                                    <span className="text-sm font-mono font-bold">{f.icon}</span>
                                </div>
                                <h3 className="font-display text-sm font-medium tracking-tight">{f.title}</h3>
                                <p className="mt-2 text-xs text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Safety & Intelligence ──────────────────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="flex items-end justify-between mb-8">
                        <div>
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Safety</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                                Built-in guardrails
                            </h2>
                        </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                            {
                                title: 'One-Way Door Approvals',
                                desc: 'Irreversible actions require human approval. Standing approvals for trusted ops. Risk-level classification from low to critical.',
                            },
                            {
                                title: 'Context Intelligence',
                                desc: 'Stale tool results auto-compressed. Per-model output ceilings prevent truncated tool calls. Truncation triggers automatic retry.',
                            },
                            {
                                title: 'Cost Ceilings',
                                desc: 'Per-task and per-project cost ceilings halt execution before runaway spending. Budget checks before every wave.',
                            },
                            {
                                title: 'Audit Trail',
                                desc: 'Every tool invocation, extension activation, and approval decision logged with SHA-256 payload hashing.',
                            },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="rounded-md border border-border/60 p-5 hover:border-accent-dim transition-colors"
                                style={{ transitionDelay: `${i * 60}ms` }}>
                                <h3 className="font-display text-sm font-medium">{f.title}</h3>
                                <p className="mt-2 text-xs text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Providers + Stack (merged, dense) ──────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="grid gap-12 lg:grid-cols-2">
                        {/* Providers */}
                        <div>
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Providers</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight mb-6" style={{ letterSpacing: '-0.02em' }}>
                                Model-agnostic
                            </h2>
                            <LogoStrip columns={5} items={[
                                { name: 'Anthropic', href: 'https://www.anthropic.com' },
                                { name: 'OpenAI', href: 'https://openai.com' },
                                { name: 'Google', href: 'https://ai.google.dev' },
                                { name: 'DeepSeek', href: 'https://deepseek.com' },
                                { name: 'Groq', href: 'https://groq.com' },
                                { name: 'Mistral', href: 'https://mistral.ai' },
                                { name: 'xAI', href: 'https://x.ai' },
                                { name: 'Ollama', href: 'https://ollama.com' },
                                { name: 'OpenRouter', href: 'https://openrouter.ai' },
                                { name: 'Together', href: 'https://together.ai' },
                            ]} />
                            <p className="text-[11px] text-text-muted mt-3">
                                + Cerebras, Cohere, Fireworks, Perplexity, SambaNova, Cloudflare, any OpenAI-compatible endpoint
                            </p>
                        </div>

                        {/* Stack + Interop */}
                        <div>
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Stack &amp; Interop</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight mb-6" style={{ letterSpacing: '-0.02em' }}>
                                Open foundations
                            </h2>
                            <LogoStrip columns={5} items={[
                                { name: 'Next.js', href: 'https://nextjs.org' },
                                { name: 'React', href: 'https://react.dev' },
                                { name: 'PostgreSQL', href: 'https://www.postgresql.org' },
                                { name: 'Valkey', href: 'https://valkey.io' },
                                { name: 'Docker', href: 'https://www.docker.com' },
                            ]} />
                            <div className="flex flex-wrap gap-2 mt-4">
                                {[
                                    { label: 'MCP', title: 'Model Context Protocol' },
                                    { label: 'A2A', title: 'Agent-to-Agent protocol' },
                                    { label: 'Skill+', title: 'Portable agent skills' },
                                    { label: 'AGENTS.md', title: 'Agent configuration standard' },
                                ].map(p => (
                                    <span key={p.label} title={p.title}
                                        className="px-3 py-1.5 rounded-md bg-surface-1/40 border border-border/40 font-mono text-[11px] text-accent tracking-wide">
                                        {p.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </ScrollReveal>

                {/* ── SCL (Semantic Context Lattice) ─────────────────── */}
                <ScrollReveal id="scl" className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="grid gap-10 lg:grid-cols-5 items-start">
                        <div className="lg:col-span-3">
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Semantic Context Lattice</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                                Knowledge that compounds.
                            </h2>
                            <p className="mt-4 text-sm text-text-secondary max-w-lg leading-relaxed">
                                SCL is a persistent knowledge graph built from completed work. Every task extracts
                                structured concepts -- entities, events, actions, claims -- embeds them as
                                vectors, and writes them into a Golden Record. The lattice self-modifies after every task.
                            </p>
                        </div>
                        <div className="lg:col-span-2">
                            <div className="grid gap-2">
                                {[
                                    { title: 'Concept Attractors', desc: 'Vector-positioned nodes with salience scoring, mutation tracking, and depth classes: spirit (drift-protected) and mechanics (freely evolving).' },
                                    { title: 'Domain Regions', desc: 'Semantic clusters with centroids, radius, density. 28+ relation types between regions.' },
                                    { title: 'Drift Detection', desc: 'Protected attractor mutations beyond threshold fire DriftWarning for human review.' },
                                    { title: 'Budget-Aware Retrieval', desc: 'Token-budget-constrained context retrieval. Priority-sorted, region-aware, budget-packed.' },
                                ].map(f => (
                                    <div key={f.title} className="rounded-md border border-border/60 p-4 hover:border-accent-dim transition-colors">
                                        <p className="text-xs font-display font-medium">{f.title}</p>
                                        <p className="mt-1 text-[11px] text-text-secondary leading-relaxed">{f.desc}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </ScrollReveal>

                {/* ── PEX Extensions ─────────────────────────────────── */}
                <ScrollReveal id="pex" className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="flex items-end justify-between mb-8">
                        <div>
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Extensions</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                                Six extension types. One runtime.
                            </h2>
                        </div>
                        <a href="https://github.com/joeybuilt-official/plexo/tree/main/docs/pex" target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium text-accent hover:text-accent-hover transition-colors hidden md:block">
                            Read the spec &rarr;
                        </a>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {[
                            { type: 'Skill', desc: 'Composite capability -- registers tools, schedules, widgets, and prompts.' },
                            { type: 'Channel', desc: 'Messaging bridge with onMessage and healthCheck. Telegram, Slack, Discord, or custom.' },
                            { type: 'Tool', desc: 'Stateless, single-purpose function. Called on demand by the agent or executor.' },
                            { type: 'Connector', desc: 'Bridges an external MCP server into the PEX sandbox. Translates tool definitions.' },
                            { type: 'Agent', desc: 'Autonomous actor with plan, executeStep, verifyStep, and escalation contract.' },
                            { type: 'MCP Server', desc: 'Model Context Protocol server -- stdio or SSE transport, standard tool discovery.' },
                        ].map(f => (
                            <div key={f.type} className="rounded-md border border-border/60 p-4 hover:border-accent-dim transition-colors">
                                <p className="text-xs font-mono font-medium text-accent">{f.type}</p>
                                <p className="mt-1.5 text-[11px] text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                    <p className="mt-4 text-[11px] text-text-muted">
                        Entity-scoped permissions (<code className="text-accent/70">memory:read:transaction</code>), three compliance levels (Core/Standard/Full),
                        mandatory escalation for irreversible actions.
                        Install from the <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Hub</a> or build your own.
                    </p>
                </ScrollReveal>

                {/* ── Why Self-Hosted ────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="flex items-end justify-between mb-8">
                        <div>
                            <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Self-hosted</p>
                            <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                                Why self-hosted
                            </h2>
                        </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                            { title: 'Your data never leaves', desc: 'Task history, agent memory, conversation logs -- all on your infrastructure. No telemetry phones home.' },
                            { title: 'No model lock-in', desc: 'Switch providers via dropdown. Fallback chains ensure uptime. Run local models via Ollama with zero external calls.' },
                            { title: 'AGPL-3.0 open source', desc: 'Every line inspectable. Free forever for self-hosted use. Commercial licensing for modified network services.' },
                            { title: 'One-command deploy', desc: 'Docker Compose. Install script generates secrets, writes env, running in 60 seconds. No Kubernetes required.' },
                        ].map((f, i) => (
                            <div key={f.title}
                                className="rounded-md border border-border/60 p-5 hover:border-accent-dim transition-colors"
                                style={{ transitionDelay: `${i * 60}ms` }}>
                                <h3 className="font-display text-xs font-medium">{f.title}</h3>
                                <p className="mt-2 text-[11px] text-text-secondary leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Social Proof ───────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <p className="text-[11px] text-text-muted font-mono tracking-wider uppercase mb-2">Community</p>
                    <h2 className="font-display text-[28px] font-medium tracking-tight mb-6" style={{ letterSpacing: '-0.02em' }}>
                        Early adopters
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-3">
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
                            <blockquote key={t.author} className="rounded-md border border-border/60 p-5">
                                <p className="text-xs text-text-secondary leading-relaxed">&ldquo;{t.quote}&rdquo;</p>
                                <footer className="mt-3 text-[11px] text-text-muted font-medium">{t.author}</footer>
                            </blockquote>
                        ))}
                    </div>
                </ScrollReveal>

                {/* ── Final CTA ──────────────────────────────────────── */}
                <ScrollReveal className="w-full max-w-6xl py-20 border-t border-border/30">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
                        <div>
                            <h2 className="font-display text-[28px] font-medium tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                                Ready to deploy
                            </h2>
                            <p className="mt-2 text-sm text-text-secondary">
                                One command. Your server. Full control over models, data, and cost.
                            </p>
                        </div>
                        <div className="flex items-center gap-4">
                            <Link href="/register"
                                className="rounded-md bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent-dim transition-colors">
                                Get Started Free
                            </Link>
                            <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                                className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
                                Star on GitHub &rarr;
                            </a>
                        </div>
                    </div>
                </ScrollReveal>

                {/* ── Footer ─────────────────────────────────────────── */}
                <footer className="w-full max-w-6xl mt-2 border-t border-border/30 py-8 flex flex-wrap items-center justify-between gap-4 text-[11px] text-text-muted">
                    <div className="flex items-center gap-2">
                        <PlexoMark className="h-3.5 w-3.5" />
                        <span>&copy; {new Date().getFullYear()} Joeybuilt LLC &middot; AGPL-3.0</span>
                    </div>
                    <div className="flex items-center gap-5">
                        <a href="https://joeybuilt.com" target="_blank" rel="noopener noreferrer"
                            className="hover:text-accent transition-colors">Joeybuilt</a>
                        <a href="https://github.com/joeybuilt-official/plexo" target="_blank" rel="noopener noreferrer"
                            className="hover:text-accent transition-colors">GitHub</a>
                        <a href="https://hub.getplexo.com" target="_blank" rel="noopener noreferrer"
                            className="hover:text-accent transition-colors">Hub</a>
                        <Link href="/login" className="hover:text-accent transition-colors">Log in</Link>
                        <a href="https://github.com/joeybuilt-official/plexo/blob/main/ANALYTICS.md" target="_blank" rel="noopener noreferrer"
                            className="hover:text-accent transition-colors">ANALYTICS.md</a>
                    </div>
                </footer>
            </main>
        </div>
    )
}
