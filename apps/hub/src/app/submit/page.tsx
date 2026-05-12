import { FileText, Package, Terminal } from 'lucide-react'

const METHODS = [
    {
        icon: FileText,
        title: 'Publish a Skill',
        desc: 'Create a SKILL.md file in your GitHub repo. Skills are procedural knowledge modules written in markdown with structured frontmatter.',
        code: `---
name: my-skill
description: A short description of what this skill does
version: "1.0.0"
invocation: auto
tags: [automation, code]
author: your-name
---

## Instructions

Describe what the agent should do when this skill is invoked...`,
        hint: 'Install via URL:',
        command: 'plexo install https://github.com/you/repo',
    },
    {
        icon: Package,
        title: 'Publish an Extension',
        desc: 'For agents, tools, channels, and connectors, create a plexo.json manifest. Extensions run as persistent workers with full lifecycle management. Set `type` to `agent`, `tool`, `channel`, `connector`, — agents add specialized behaviors; tools provide discrete functions.',
        code: `{
  "plexo": "0.4.0",
  "name": "@your-org/my-tool",
  "type": "tool",
  "version": "1.0.0",
  "description": "What this tool does",
  "entry": "dist/index.js",
  "functions": [{ "name": "my_function", "description": "..." }]
}`,
    },
    {
        icon: Terminal,
        title: 'Publish via API',
        desc: 'Use the registry API to publish programmatically. Great for CI/CD pipelines and automated releases.',
        code: `POST /api/v1/registry
Content-Type: application/json
X-User-Id: your-user-id

{
  "manifest": { ... },
  "displayName": "My Skill",
  "tags": ["automation"],
  "category": "automation",
  "readme": "# My Skill\\n\\nFull description...",
  "repositoryUrl": "https://github.com/you/repo"
}`,
    },
]

export default function SubmitPage() {
    return (
        <div>
            {/* Hero */}
            <section className="relative overflow-hidden">
                <div className="absolute inset-0 hero-glow" />
                <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
                    <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">
                        Publish to the Hub
                    </h1>
                    <p className="mt-4 text-base text-text-secondary max-w-xl mx-auto leading-relaxed">
                        Share your skills, tools, and agents with the Plexo community.
                        Three ways to publish — pick the one that fits your workflow.
                    </p>
                </div>
            </section>

            <div className="max-w-3xl mx-auto px-4 sm:px-6 pb-16">
                <div className="space-y-6">
                    {METHODS.map((m, i) => (
                        <section key={i} className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-6 sm:p-7">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="h-8 w-8 rounded-lg bg-azure-dim flex items-center justify-center">
                                    <m.icon className="h-4 w-4 text-azure" />
                                </div>
                                <h2 className="font-display text-lg font-semibold text-text-primary">{m.title}</h2>
                            </div>
                            <p className="text-sm text-text-secondary leading-relaxed mb-5">{m.desc}</p>
                            <div className="bg-surface-2 rounded-lg border border-border/60 p-4 sm:p-5 code-glow">
                                <pre className="font-mono text-xs text-text-secondary overflow-x-auto">{m.code}</pre>
                            </div>
                            {m.hint && (
                                <p className="text-xs text-text-muted mt-4">
                                    {m.hint}{' '}
                                    <code className="text-azure font-mono">{m.command}</code>
                                </p>
                            )}
                        </section>
                    ))}
                </div>
            </div>
        </div>
    )
}
