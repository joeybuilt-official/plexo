import Link from 'next/link'
import { Zap, Wrench, Bot, Radio, Globe, GitBranch } from 'lucide-react'

const TYPES = [
    { icon: Zap, label: 'Skills', desc: 'Procedural knowledge modules the agent can invoke. Written as SKILL.md files with structured frontmatter.', color: 'text-azure' },
    { icon: Wrench, label: 'Tools', desc: 'Callable functions that give the agent new abilities. API integrations, data transforms, system actions.', color: 'text-amber' },
    { icon: Bot, label: 'Agents', desc: 'Autonomous actors with their own planning loops. Delegate complex tasks to specialized sub-agents.', color: 'text-violet-400' },
    { icon: Radio, label: 'Channels', desc: 'Messaging adapters that connect your workspace to Telegram, Slack, Discord, and more.', color: 'text-green-400' },
]

export default function AboutPage() {
    return (
        <div>
            {/* Hero */}
            <section className="relative overflow-hidden">
                <div className="absolute inset-0 hero-glow" />
                <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
                    <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">
                        The extension ecosystem for AI workspaces
                    </h1>
                    <p className="mt-4 text-base text-text-secondary max-w-xl mx-auto leading-relaxed">
                        Plexo Hub is the public registry for everything that extends what Plexo can do.
                        Think VS Code Marketplace or Docker Hub — but for AI workspace capabilities.
                    </p>
                </div>
            </section>

            <div className="max-w-5xl mx-auto px-4 sm:px-6">
                {/* Extension Types */}
                <section className="py-16 border-t border-border/30">
                    <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-azure mb-8">What you&apos;ll find here</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {TYPES.map((t) => (
                            <div key={t.label} className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-6">
                                <div className="flex items-center gap-3 mb-3">
                                    <t.icon className={`h-5 w-5 ${t.color}`} />
                                    <h3 className="font-display text-base font-semibold text-text-primary">{t.label}</h3>
                                </div>
                                <p className="text-sm text-text-secondary leading-relaxed">{t.desc}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Open Source + Publishing */}
                <section className="py-16 border-t border-border/30">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        <div className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-7">
                            <div className="flex items-center gap-3 mb-4">
                                <GitBranch className="h-5 w-5 text-azure" />
                                <h2 className="font-display text-lg font-semibold text-text-primary">Open source</h2>
                            </div>
                            <p className="text-sm text-text-secondary leading-relaxed">
                                Plexo is open source under the MIT license. The Hub is part of the
                                Plexo monorepo and can be self-hosted by anyone running their own instance.
                            </p>
                            <a
                                href="https://github.com/joeybuilt-official/plexo"
                                className="inline-flex items-center gap-1.5 mt-5 text-sm text-azure hover:text-azure-600 transition-colors"
                            >
                                View on GitHub &rarr;
                            </a>
                        </div>

                        <div className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-7">
                            <div className="flex items-center gap-3 mb-4">
                                <Globe className="h-5 w-5 text-azure" />
                                <h2 className="font-display text-lg font-semibold text-text-primary">Publishing</h2>
                            </div>
                            <p className="text-sm text-text-secondary leading-relaxed">
                                Anyone can publish skills, tools, and agents to the Hub. Create a SKILL.md
                                or plexo.json manifest and publish via URL or API.
                            </p>
                            <Link
                                href="/submit"
                                className="inline-flex items-center gap-1.5 mt-5 text-sm text-azure hover:text-azure-600 transition-colors"
                            >
                                Publishing guide &rarr;
                            </Link>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )
}
