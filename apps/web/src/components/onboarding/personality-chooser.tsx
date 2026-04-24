// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Personality quiz — 4 quick questions that configure agent persona,
 * communication style, and identity. Feels like a quiz, not a form.
 */

import { useState, useCallback } from 'react'
import { Check, Loader2, ChevronLeft, Sparkles } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

const API = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

// ── Data ─────────────────────────────────────────────────────────────────────

type CommStyle = 'casual' | 'professional' | 'technical'
type DetailLevel = 'essentials' | 'balanced' | 'everything'
type PersonalityPreset = 'operator' | 'partner' | 'enthusiast' | 'custom'

const COMM_STYLES: { id: CommStyle; emoji: string; name: string; sample: string; desc: string }[] = [
    { id: 'casual',       emoji: '💬', name: 'Casual',       sample: 'Hey! Got that done for you 👍',                            desc: 'Relaxed, emoji-friendly, brief' },
    { id: 'professional', emoji: '📋', name: 'Professional', sample: 'Task completed. Summary attached.',                         desc: 'Clear, structured, formal' },
    { id: 'technical',    emoji: '⚙️', name: 'Technical',    sample: 'Deployed to prod. 0 errors, 3 warnings. Logs attached.',   desc: 'Dense, precise, no fluff' },
]

const DETAIL_LEVELS: { id: DetailLevel; name: string; desc: string }[] = [
    { id: 'essentials', name: 'Just the essentials', desc: 'Headlines only, skip the details' },
    { id: 'balanced',   name: 'Balanced',            desc: 'Key info + brief context' },
    { id: 'everything', name: 'Everything',          desc: 'Full explanations, reasoning, alternatives' },
]

const PERSONALITIES: { id: PersonalityPreset; emoji: string; name: string; desc: string }[] = [
    { id: 'operator',   emoji: '🎯', name: 'The Operator',   desc: 'All business. Gets stuff done, reports results, moves on.' },
    { id: 'partner',    emoji: '🤝', name: 'The Partner',     desc: 'Collaborative. Thinks out loud, asks questions, suggests alternatives.' },
    { id: 'enthusiast', emoji: '🚀', name: 'The Enthusiast',  desc: 'Energetic. Celebrates wins, uses emoji, brings positive energy.' },
    { id: 'custom',     emoji: '✏️', name: 'Custom',          desc: 'Describe your ideal AI teammate.' },
]

const NAME_SUGGESTIONS = ['Plexo', 'Atlas', 'Nova', 'Sage', 'Bolt']

const AVATAR_OPTIONS = ['🤖', '🧠', '⚡', '🦾', '🌟', '👾', '🔱', '🦊', '🐉', '🔮']

// ── Persona text builders ────────────────────────────────────────────────────

function buildPersonaText(style: CommStyle, personality: PersonalityPreset, customPersonality: string): string {
    const base: Record<CommStyle, string> = {
        casual: 'You are friendly and casual. Use emoji occasionally. Keep responses brief and conversational. Address the user informally.',
        professional: 'You are professional and clear. Use structured responses with headers when appropriate. Be concise but thorough. No emoji.',
        technical: 'You are technical and precise. Include relevant metrics, logs, and technical details. Use code formatting. Skip pleasantries.',
    }

    const extension: Record<PersonalityPreset, string> = {
        operator: ' You are all business — get things done, report results clearly, and move on to the next task. No unnecessary chatter.',
        partner: ' You are collaborative — think out loud, ask clarifying questions when needed, and suggest alternatives when you see a better path.',
        enthusiast: ' You bring energy and positivity. Celebrate wins, keep momentum high, and make work feel exciting.',
        custom: '',
    }

    let persona = base[style]
    if (personality === 'custom' && customPersonality.trim()) {
        persona += ` ${customPersonality.trim()}`
    } else {
        persona += extension[personality]
    }
    return persona
}

function buildDetailRuleValue(level: DetailLevel): { verbosity: string; includeReasoning: boolean; includeAlternatives?: boolean } {
    switch (level) {
        case 'essentials': return { verbosity: 'minimal', includeReasoning: false }
        case 'balanced':   return { verbosity: 'balanced', includeReasoning: true }
        case 'everything': return { verbosity: 'verbose', includeReasoning: true, includeAlternatives: true }
    }
}

// ── Component ────────────────────────────────────────────────────────────────

interface PersonalityChooserProps {
    onComplete: () => void
    onSkip?: () => void
    /** Hide the skip button (e.g. when reopened from settings) */
    hideSkip?: boolean
}

export function PersonalityChooser({ onComplete, onSkip, hideSkip }: PersonalityChooserProps) {
    const { workspaceId } = useWorkspace()

    // Quiz state
    const [step, setStep] = useState(1)
    const [commStyle, setCommStyle] = useState<CommStyle | null>(null)
    const [detailLevel, setDetailLevel] = useState<DetailLevel | null>(null)
    const [personality, setPersonality] = useState<PersonalityPreset | null>(null)
    const [customPersonality, setCustomPersonality] = useState('')
    const [agentName, setAgentName] = useState('')
    const [agentAvatar, setAgentAvatar] = useState('🤖')

    const [saving, setSaving] = useState(false)
    const [done, setDone] = useState(false)

    const totalSteps = 4

    const canAdvance = useCallback((): boolean => {
        switch (step) {
            case 1: return commStyle !== null
            case 2: return detailLevel !== null
            case 3: return personality !== null && (personality !== 'custom' || customPersonality.trim().length > 0)
            case 4: return true
            default: return false
        }
    }, [step, commStyle, detailLevel, personality, customPersonality])

    // Save everything
    const handleFinish = useCallback(async () => {
        if (!workspaceId || !commStyle || !detailLevel || !personality) return
        setSaving(true)

        try {
            const persona = buildPersonaText(commStyle, personality, customPersonality)
            const name = agentName.trim() || 'Plexo'

            // 1. Patch workspace settings
            await fetch(`${API}/api/v1/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    settings: {
                        agentName: name,
                        agentAvatar,
                        agentPersona: persona,
                        personalityConfigured: true,
                    },
                }),
            })

            // 2. Create communication_style behavior rule
            const detailValue = buildDetailRuleValue(detailLevel)
            await fetch(`${API}/api/v1/behavior/${workspaceId}/rules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'communication_style',
                    key: 'default_communication_style',
                    label: 'Communication Style',
                    description: `Set via personality quiz: ${commStyle} style, ${detailLevel} detail`,
                    value: { type: 'json', value: detailValue },
                    source: 'workspace',
                    tags: ['personality-quiz'],
                }),
            }).catch(() => { /* non-fatal — workspace settings are the primary store */ })

            // 3. Create persona_trait behavior rule
            const traitLabel = personality === 'custom'
                ? 'Custom personality'
                : `The ${personality.charAt(0).toUpperCase() + personality.slice(1)}`
            await fetch(`${API}/api/v1/behavior/${workspaceId}/rules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'persona_trait',
                    key: 'default_persona_trait',
                    label: traitLabel,
                    description: persona,
                    value: { type: 'text_block', value: persona },
                    source: 'workspace',
                    tags: ['personality-quiz'],
                }),
            }).catch(() => { /* non-fatal */ })

            setDone(true)
            setTimeout(onComplete, 800)
        } catch {
            // Still mark configured so user isn't stuck
            try {
                await fetch(`${API}/api/v1/workspaces/${workspaceId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ settings: { personalityConfigured: true } }),
                })
            } catch { /* truly non-fatal */ }
            onComplete()
        } finally {
            setSaving(false)
        }
    }, [workspaceId, commStyle, detailLevel, personality, customPersonality, agentName, agentAvatar, onComplete])

    const nextStep = () => {
        if (step < totalSteps) setStep(s => s + 1)
        else void handleFinish()
    }

    const prevStep = () => {
        if (step > 1) setStep(s => s - 1)
    }

    return (
        <div className="flex flex-col gap-0 w-full max-w-lg">
            {/* Progress dots */}
            <div className="flex items-center justify-center gap-2 mb-6">
                {Array.from({ length: totalSteps }, (_, i) => (
                    <div
                        key={i}
                        className={`h-2 rounded-full transition-all duration-300 ${
                            i + 1 === step ? 'w-6 bg-azure' :
                            i + 1 < step ? 'w-2 bg-azure/60' :
                            'w-2 bg-surface-2'
                        }`}
                    />
                ))}
                <span className="ml-2 text-[11px] text-text-muted">{step} of {totalSteps}</span>
            </div>

            {/* ── Step 1: Communication style ── */}
            {step === 1 && (
                <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-2 duration-200">
                    <div className="text-center mb-2">
                        <h2 className="text-lg font-bold text-text-primary">How should Plexo talk to you?</h2>
                        <p className="text-sm text-text-muted mt-1">Pick the vibe that feels right.</p>
                    </div>
                    <div className="flex flex-col gap-2.5">
                        {COMM_STYLES.map(s => (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => setCommStyle(s.id)}
                                className={`group relative flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                                    commStyle === s.id
                                        ? 'border-azure bg-azure/5 ring-1 ring-azure/30'
                                        : 'border-border hover:border-border bg-surface-1/40 hover:bg-surface-1/60'
                                }`}
                            >
                                <span className="text-2xl shrink-0 mt-0.5">{s.emoji}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold text-text-primary">{s.name}</span>
                                        {commStyle === s.id && <Check className="h-3.5 w-3.5 text-azure" />}
                                    </div>
                                    <p className="text-xs text-text-muted mt-0.5 italic">&ldquo;{s.sample}&rdquo;</p>
                                    <p className="text-xs text-text-secondary mt-1">{s.desc}</p>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Step 2: Detail level ── */}
            {step === 2 && (
                <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-2 duration-200">
                    <div className="text-center mb-2">
                        <h2 className="text-lg font-bold text-text-primary">How much detail do you want?</h2>
                        <p className="text-sm text-text-muted mt-1">You can always change this later.</p>
                    </div>
                    <div className="flex flex-col gap-2.5">
                        {DETAIL_LEVELS.map(d => (
                            <button
                                key={d.id}
                                type="button"
                                onClick={() => setDetailLevel(d.id)}
                                className={`group flex items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                                    detailLevel === d.id
                                        ? 'border-azure bg-azure/5 ring-1 ring-azure/30'
                                        : 'border-border hover:border-border bg-surface-1/40 hover:bg-surface-1/60'
                                }`}
                            >
                                <div className={`flex h-5 w-5 items-center justify-center rounded-full border-2 shrink-0 transition-colors ${
                                    detailLevel === d.id ? 'border-azure bg-azure' : 'border-border'
                                }`}>
                                    {detailLevel === d.id && <Check className="h-3 w-3 text-white" />}
                                </div>
                                <div className="flex-1">
                                    <span className="text-sm font-semibold text-text-primary">{d.name}</span>
                                    <p className="text-xs text-text-muted mt-0.5">{d.desc}</p>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Step 3: Personality preset ── */}
            {step === 3 && (
                <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-2 duration-200">
                    <div className="text-center mb-2">
                        <h2 className="text-lg font-bold text-text-primary">Give your agent a personality</h2>
                        <p className="text-sm text-text-muted mt-1">What kind of teammate do you want?</p>
                    </div>
                    <div className="flex flex-col gap-2.5">
                        {PERSONALITIES.map(p => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => setPersonality(p.id)}
                                className={`group flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                                    personality === p.id
                                        ? 'border-azure bg-azure/5 ring-1 ring-azure/30'
                                        : 'border-border hover:border-border bg-surface-1/40 hover:bg-surface-1/60'
                                }`}
                            >
                                <span className="text-2xl shrink-0">{p.emoji}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold text-text-primary">{p.name}</span>
                                        {personality === p.id && <Check className="h-3.5 w-3.5 text-azure" />}
                                    </div>
                                    <p className="text-xs text-text-muted mt-0.5">{p.desc}</p>
                                </div>
                            </button>
                        ))}
                    </div>
                    {personality === 'custom' && (
                        <textarea
                            value={customPersonality}
                            onChange={e => setCustomPersonality(e.target.value)}
                            placeholder="Describe your ideal AI teammate in a sentence..."
                            rows={2}
                            className="w-full resize-none rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring focus:ring-1 focus:ring-azure/30 leading-relaxed"
                            autoFocus
                        />
                    )}
                </div>
            )}

            {/* ── Step 4: Name & avatar ── */}
            {step === 4 && (
                <div className="flex flex-col gap-5 animate-in fade-in slide-in-from-right-2 duration-200">
                    <div className="text-center mb-2">
                        <h2 className="text-lg font-bold text-text-primary">What should we call your agent?</h2>
                        <p className="text-sm text-text-muted mt-1">Pick a name and face.</p>
                    </div>

                    {/* Avatar preview */}
                    <div className="flex flex-col items-center gap-2">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full text-3xl shadow-lg shadow-azure/20">
                            {agentAvatar}
                        </div>
                        <span className="text-sm font-medium text-text-primary">{agentName || 'Plexo'}</span>
                    </div>

                    {/* Avatar picker */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary">Avatar</label>
                        <div className="flex gap-1.5 justify-center flex-wrap">
                            {AVATAR_OPTIONS.map(emoji => (
                                <button
                                    key={emoji}
                                    type="button"
                                    onClick={() => setAgentAvatar(emoji)}
                                    aria-label={`Select avatar ${emoji}`}
                                    aria-pressed={agentAvatar === emoji}
                                    className={`min-h-[44px] min-w-[44px] shrink-0 rounded-lg text-lg transition-all ${
                                        agentAvatar === emoji
                                            ? 'bg-azure/30 ring-1 ring-azure'
                                            : 'bg-surface-2 hover:bg-surface-2/80'
                                    }`}
                                >
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Name input with suggestions */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary">Name</label>
                        <input
                            type="text"
                            value={agentName}
                            onChange={e => setAgentName(e.target.value)}
                            placeholder="Plexo"
                            className="w-full rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring focus:ring-1 focus:ring-azure/30"
                        />
                        <div className="flex gap-1.5 flex-wrap">
                            {NAME_SUGGESTIONS.map(name => (
                                <button
                                    key={name}
                                    type="button"
                                    onClick={() => setAgentName(name)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                        agentName === name
                                            ? 'bg-azure/20 text-azure border border-azure/30'
                                            : 'bg-surface-2 text-text-secondary hover:text-text-primary border border-transparent'
                                    }`}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Navigation ── */}
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-border/40">
                <div>
                    {step > 1 ? (
                        <button
                            type="button"
                            onClick={prevStep}
                            className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" /> Back
                        </button>
                    ) : !hideSkip && onSkip ? (
                        <button
                            type="button"
                            onClick={onSkip}
                            className="text-sm text-text-muted hover:text-text-primary transition-colors"
                        >
                            Skip for now
                        </button>
                    ) : <div />}
                </div>

                <button
                    type="button"
                    onClick={nextStep}
                    disabled={!canAdvance() || saving || done}
                    className="flex items-center gap-2 rounded-xl bg-azure px-5 py-2.5 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40"
                >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {done && <Check className="h-4 w-4" />}
                    {done ? 'Done!' : step === totalSteps ? (
                        <>
                            <Sparkles className="h-4 w-4" />
                            {saving ? 'Saving...' : 'Finish'}
                        </>
                    ) : 'Next'}
                </button>
            </div>
        </div>
    )
}
