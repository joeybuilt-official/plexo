'use client'

import { useState, useEffect, useCallback } from 'react'
import {
    Zap,
    RefreshCw,
    Save,
    Check,
    AlertCircle,
    Brain,
    DollarSign,
    Shield,
    Settings,
    Sparkles,
    User,
} from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const WS_ID = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentStatus {
    status: 'idle' | 'running'
    currentTask: string | null
    currentModel: string | null
    sessionCount: number
    lastActivity: string | null
}

interface WorkspaceSettings {
    agentModel?: string
    maxStepsPerTask?: number
    maxTokensPerTask?: number
    costCeilingUsd?: number
    autoApproveThreshold?: number
    safeMode?: boolean
    systemPromptExtra?: string
    // Personality
    agentName?: string
    agentTagline?: string
    agentAvatar?: string   // emoji
    agentPersona?: string  // free-text soul/persona description
}

// ── Section component ─────────────────────────────────────────────────────────

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-center gap-2 mb-4">
                <Icon className="h-4 w-4 text-zinc-500" />
                <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
            </div>
            <div className="flex flex-col gap-4">
                {children}
            </div>
        </div>
    )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-300">{label}</label>
            {children}
            {description && <p className="text-xs text-zinc-600">{description}</p>}
        </div>
    )
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 disabled:opacity-40"
        />
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentSettingsPage() {
    const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
    const [settings, setSettings] = useState<WorkspaceSettings>({})
    const [workspaceName, setWorkspaceName] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const [statusRes, wsRes] = await Promise.all([
                fetch(`${API_BASE}/api/agent/status`),
                WS_ID ? fetch(`${API_BASE}/api/workspaces/${WS_ID}`) : Promise.resolve(null),
            ])

            if (statusRes.ok) {
                setAgentStatus(await statusRes.json() as AgentStatus)
            }
            if (wsRes?.ok) {
                const ws = await wsRes.json() as { id: string; name: string; settings: WorkspaceSettings }
                setWorkspaceId(ws.id)
                setWorkspaceName(ws.name)
                setSettings(ws.settings ?? {})
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchData() }, [fetchData])

    async function handleSave() {
        if (!workspaceId) return
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: workspaceName, settings }),
            })
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    function updateSetting<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) {
        setSettings((s) => ({ ...s, [key]: value }))
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Agent Settings</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Configure agent behaviour, safety limits, and execution parameters.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchData()}
                        disabled={loading}
                        className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => void handleSave()}
                        disabled={saving || loading || !workspaceId}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                    >
                        {saving
                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            : saved
                                ? <Check className="h-3.5 w-3.5 text-emerald-400" />
                                : <Save className="h-3.5 w-3.5" />
                        }
                        {saved ? 'Saved' : 'Save changes'}
                    </button>
                </div>
            </div>

            {/* Agent status banner */}
            {agentStatus && (
                <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${agentStatus.status === 'running'
                    ? 'border-green-800/40 bg-green-950/20'
                    : 'border-zinc-800 bg-zinc-900/40'
                    }`}>
                    <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${agentStatus.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'
                        }`} />
                    <div className="text-sm">
                        <span className="font-medium text-zinc-200 capitalize">{agentStatus.status}</span>
                        {agentStatus.currentTask && (
                            <span className="text-zinc-500 ml-2">· task {agentStatus.currentTask.slice(0, 8)}</span>
                        )}
                        {agentStatus.currentModel && (
                            <span className="text-zinc-600 ml-2">via {agentStatus.currentModel}</span>
                        )}
                    </div>
                    <div className="ml-auto text-xs text-zinc-600">
                        {agentStatus.sessionCount} sessions
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-zinc-600">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : !workspaceId ? (
                <div className="flex items-center gap-2 rounded-xl border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-400">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    NEXT_PUBLIC_DEFAULT_WORKSPACE not configured — settings cannot be saved.
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    {/* Personality */}
                    <Section title="Personality" icon={Sparkles}>
                        <div className="flex items-start gap-4">
                            {/* Avatar picker */}
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-zinc-300">Avatar</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['🤖', '🧠', '⚡', '🦾', '🌟', '👾', '🔱', '🦊', '🐉', '🔮'].map((emoji) => (
                                        <button
                                            key={emoji}
                                            onClick={() => updateSetting('agentAvatar', emoji)}
                                            className={`h-9 w-9 rounded-lg text-lg transition-all ${(settings.agentAvatar ?? '🤖') === emoji
                                                    ? 'bg-indigo-600/30 ring-1 ring-indigo-500'
                                                    : 'bg-zinc-800 hover:bg-zinc-700'
                                                }`}
                                        >{emoji}</button>
                                    ))}
                                </div>
                            </div>
                            {/* Preview */}
                            <div className="flex flex-col items-center gap-1.5 ml-auto">
                                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-3xl shadow-lg shadow-indigo-500/20">
                                    {settings.agentAvatar ?? '🤖'}
                                </div>
                                <span className="text-xs text-zinc-500 font-medium">{settings.agentName || 'Plexo'}</span>
                                {settings.agentTagline && <span className="text-[10px] text-zinc-600 italic max-w-[100px] text-center truncate">{settings.agentTagline}</span>}
                            </div>
                        </div>
                        <Field label="Agent name" description="How the agent refers to itself in messages.">
                            <Input
                                value={settings.agentName ?? ''}
                                onChange={(e) => updateSetting('agentName', e.target.value || undefined)}
                                placeholder="Plexo"
                            />
                        </Field>
                        <Field label="Tagline" description="Short descriptor shown under the agent name (optional).">
                            <Input
                                value={settings.agentTagline ?? ''}
                                onChange={(e) => updateSetting('agentTagline', e.target.value || undefined)}
                                placeholder="Your autonomous ops agent"
                            />
                        </Field>
                        <Field
                            label="Persona / soul"
                            description="Character text injected at the top of the system prompt. Sets the agent's tone, personality, and expertise emphasis."
                        >
                            <textarea
                                value={settings.agentPersona ?? ''}
                                onChange={(e) => updateSetting('agentPersona', e.target.value || undefined)}
                                rows={3}
                                placeholder="You are a calm, methodical senior engineer. You prefer to verify before acting. You ask clarifying questions rather than making assumptions."
                                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 resize-none"
                            />
                        </Field>
                    </Section>

                    {/* Model */}
                    <Section title="Model" icon={Brain}>
                        <Field
                            label="Default model override"
                            description="Overrides the provider registry default. Leave blank to use the registry's model routing."
                        >
                            <Input
                                value={settings.agentModel ?? ''}
                                onChange={(e) => updateSetting('agentModel', e.target.value || undefined)}
                                placeholder="claude-sonnet-4-5"
                            />
                        </Field>
                        <Field
                            label="System prompt addition"
                            description="Text appended to the end of the system prompt on every task."
                        >
                            <textarea
                                value={settings.systemPromptExtra ?? ''}
                                onChange={(e) => updateSetting('systemPromptExtra', e.target.value || undefined)}
                                rows={3}
                                placeholder="Always respond in British English."
                                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 resize-none"
                            />
                        </Field>
                    </Section>

                    {/* Execution limits */}
                    <Section title="Execution limits" icon={Zap}>
                        <div className="grid grid-cols-2 gap-4">
                            <Field label="Max steps per task" description="Hard stop after N agentic steps.">
                                <Input
                                    type="number"
                                    min={1}
                                    max={100}
                                    value={settings.maxStepsPerTask ?? 20}
                                    onChange={(e) => updateSetting('maxStepsPerTask', parseInt(e.target.value) || 20)}
                                />
                            </Field>
                            <Field label="Max tokens per task" description="Total input+output token limit.">
                                <Input
                                    type="number"
                                    min={1000}
                                    step={1000}
                                    value={settings.maxTokensPerTask ?? 50000}
                                    onChange={(e) => updateSetting('maxTokensPerTask', parseInt(e.target.value) || 50000)}
                                />
                            </Field>
                        </div>
                    </Section>

                    {/* Cost + safety */}
                    <Section title="Cost & safety" icon={Shield}>
                        <div className="grid grid-cols-2 gap-4">
                            <Field label="Weekly cost ceiling (USD)" description="Tasks pause when this is reached.">
                                <Input
                                    type="number"
                                    min={0}
                                    step={0.5}
                                    value={settings.costCeilingUsd ?? 10}
                                    onChange={(e) => updateSetting('costCeilingUsd', parseFloat(e.target.value) || 10)}
                                />
                            </Field>
                            <Field label="Auto-approve quality threshold" description="Tasks below this score require manual OWD approval.">
                                <Input
                                    type="number"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={settings.autoApproveThreshold ?? 0.7}
                                    onChange={(e) => updateSetting('autoApproveThreshold', parseFloat(e.target.value))}
                                />
                            </Field>
                        </div>
                        <Field label="Safe mode" description="When enabled, all file-write tools require OWD approval before executing.">
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => updateSetting('safeMode', !settings.safeMode)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.safeMode ? 'bg-indigo-600' : 'bg-zinc-700'
                                        }`}
                                >
                                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${settings.safeMode ? 'translate-x-4.5' : 'translate-x-0.5'
                                        }`} />
                                </button>
                                <span className="text-sm text-zinc-400">{settings.safeMode ? 'Enabled' : 'Disabled'}</span>
                            </div>
                        </Field>
                    </Section>

                    {/* Cost impact note */}
                    <div className="flex items-start gap-2 text-xs text-zinc-600 px-1">
                        <DollarSign className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        Settings are stored in the workspace settings blob and read by the agent at task start. Changes take effect on the next task.
                    </div>
                </div>
            )}
        </div>
    )
}
