// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { 
    Code2, Search, Server, BarChart2, Send, RefreshCw, PenLine, Plus, 
    ArrowRight, Megaphone, FolderOpen, Mic, MicOff, ImageIcon, FileText, X, FileUp, Sparkles
} from 'lucide-react'
import { useSpeechInput } from '@web/hooks/use-speech-input'
import { VoiceWaveform } from '@web/components/voice-waveform'
import { type PastedImage, type PastedDocument, kindFromMime } from '@web/lib/attachments'
import { extractPdfText } from '@web/lib/pdf-extract'
import { checkAttachmentPrompt, recommendModelForInput } from '@web/lib/models'

export function QuickSend() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const [text, setText] = useState('')
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
    const [taskId, setTaskId] = useState<string | null>(null)
    const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
    const [pastedDocs, setPastedDocs] = useState<PastedDocument[]>([])
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
    const [showVoiceSetupPrompt, setShowVoiceSetupPrompt] = useState(false)
    const [wantsAttachment, setWantsAttachment] = useState(false)
    const [suggestion, setSuggestion] = useState<{ suggestedModel: string; reason: string } | null>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const workspaceId = ctxWorkspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
    const WS_ID = workspaceId || ''

    const handleVoiceResult = useCallback((transcript: string) => {
        setText(transcript)
        // Auto-send after brief delay if transcript is non-empty
        if (transcript.trim()) {
            setTimeout(() => {
                handleSubmit(undefined, transcript.trim())
            }, 500)
        }
    }, [workspaceId])

    const voice = useSpeechInput({
        workspaceId: WS_ID,
        onResult: handleVoiceResult,
        onSetupNeeded: () => setShowVoiceSetupPrompt(true),
    })

    const isListening = voice.status === 'listening'

    // Real-time hint for attachments
    useEffect(() => {
        if (!text.trim() || pastedImages.length > 0 || pastedDocs.length > 0) {
            setWantsAttachment(false)
            setSuggestion(null)
            return
        }
        const needs = checkAttachmentPrompt(text)
        setWantsAttachment(needs)
        if (needs) {
            const rec = recommendModelForInput(text, 'gpt-4o') // dummy model for checking
            setSuggestion(rec)
        }
    }, [text, pastedImages.length, pastedDocs.length])

    async function handleSubmit(e?: React.FormEvent | React.MouseEvent, overrideText?: string) {
        e?.preventDefault()
        const message = overrideText || text
        if (!message.trim() && pastedImages.length === 0 && pastedDocs.length === 0) return
        if (status === 'sending') return

        setStatus('sending')
        try {
            const apiUrl = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
            const wsId = workspaceId

            if (!wsId) throw new Error('No workspace found')

            const typeMap: Record<string, string> = {
                code: 'coding',
                research: 'research',
                ops: 'ops',
                data: 'report',
                writing: 'research',
                marketing: 'online',
                general: 'automation'
            }

            // Build attachments context
            const attachments = [
                ...pastedImages.map(img => ({
                    name: img.name,
                    kind: img.kind,
                    mimeType: img.mimeType,
                    data: img.kind === 'image' ? img.dataUrl : (img.extractedText || img.dataUrl),
                    isBinary: img.kind === 'image' || img.kind === 'pdf',
                })),
                ...pastedDocs.map(doc => ({
                    name: doc.name,
                    content: doc.content,
                    kind: 'text_doc',
                }))
            ]

            const res = await fetch(`${apiUrl}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: wsId,
                    type: selectedCategory ? typeMap[selectedCategory] || 'automation' : 'automation',
                    source: 'dashboard',
                    context: { 
                        description: message.trim(),
                        attachments: attachments.length > 0 ? attachments : undefined
                    },
                    priority: 5,
                }),
            })

            if (!res.ok) throw new Error('API error')
            const data = await res.json() as { id: string }
            setTaskId(data.id)
            setStatus('sent')
            setText('')
            setPastedImages([])
            setPastedDocs([])
            setSelectedCategory(null)
            setTimeout(() => setStatus('idle'), 4000)
        } catch {
            setStatus('error')
            setTimeout(() => setStatus('idle'), 3000)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
        }
    }

    const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? [])
        for (const file of files) {
            const kind = kindFromMime(file.type)
            if (!kind) continue
            const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const reader = new FileReader()
            reader.onload = async () => {
                const dataUrl = reader.result as string
                let extractedText: string | undefined
                if (kind === 'pdf') {
                    try {
                        const pdf = await extractPdfText(dataUrl)
                        extractedText = pdf.text
                    } catch { /* ignore */ }
                }
                setPastedImages(prev => [...prev, { id, dataUrl, mimeType: file.type, name: file.name, kind, extractedText }])
            }
            reader.readAsDataURL(file)
        }
    }

    const removeImage = (id: string) => setPastedImages(prev => prev.filter(img => img.id !== id))
    const removeDoc = (id: string) => setPastedDocs(prev => prev.filter(doc => doc.id !== id))

    return (
        <div className="w-full mx-auto flex flex-col gap-6 animate-in fade-in duration-700 delay-150 fill-mode-both">
            {/* Real-time Input Ingestion Helpers */}
            {(suggestion || wantsAttachment) && status === 'idle' && !isListening && (
                <div className="flex flex-col gap-2 animate-in slide-in-from-top-2 duration-300">
                    {suggestion && (
                        <div className="flex items-start gap-3 rounded-xl border border-azure/30 bg-azure-500/5 px-4 py-3 text-sm text-azure shadow-sm transition-all border-dashed">
                            <Sparkles className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                            <div className="flex-1">
                                <span className="font-semibold block text-azure-200 text-xs">Suggested: {suggestion.suggestedModel}</span>
                                <span className="text-azure/80 text-[11px] mt-0.5 block">{suggestion.reason}</span>
                            </div>
                        </div>
                    )}
                    {wantsAttachment && (
                        <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-300 shadow-sm transition-all border-dashed">
                            <FileUp className="h-4 w-4 shrink-0 text-amber" />
                            <span className="flex-1 text-amber/90 text-[11px] font-medium font-serif">
                                Forgot an attachment?
                            </span>
                            <button 
                                className="whitespace-nowrap rounded-lg bg-amber/20 hover:bg-amber/30 border border-amber-500/20 px-2 py-1 text-[10px] font-bold text-amber transition-colors uppercase tracking-wider"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                Attach
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Main Input Box */}
            <div className={`relative flex flex-col gap-2 p-1.5 rounded-[24px] border transition-all ${isListening ? 'border-red-500/40 bg-red-950/10 shadow-[0_0_24px_rgba(239,68,68,0.15)]' : 'border-border bg-surface-1/50 backdrop-blur-sm shadow-[0_2px_24px_-12px_rgba(0,0,0,0.5)]'}`}>
                {/* File Previews */}
                {(pastedImages.length > 0 || pastedDocs.length > 0) && (
                    <div className="flex flex-wrap gap-2 p-2 border-b border-border/50">
                        {pastedImages.map((img) => (
                            <div key={img.id} className="relative group">
                                {img.kind === 'image' ? (
                                    <img src={img.dataUrl} alt={img.name} className="h-14 w-14 rounded-lg border border-border object-cover" />
                                ) : (
                                    <div className="h-14 w-20 rounded-lg border border-zinc-600/60 bg-surface-2/60 flex flex-col items-center justify-center gap-1 px-1 text-center">
                                        <FileText className="h-4 w-4 text-azure" />
                                        <span className="text-[9px] text-text-secondary truncate w-full px-1">{img.name}</span>
                                    </div>
                                )}
                                <button onClick={() => removeImage(img.id)} className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-surface-2 border border-zinc-600 flex items-center justify-center text-text-secondary hover:text-red transition-all shadow-lg">
                                    <X className="h-2.5 w-2.5" />
                                </button>
                            </div>
                        ))}
                        {pastedDocs.map((doc) => (
                            <div key={doc.id} className="relative group flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-xs text-text-secondary">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                                <span className="font-medium truncate max-w-[120px]">{doc.name}</span>
                                <button onClick={() => removeDoc(doc.id)} className="h-4 w-4 rounded-full hover:text-red transition-colors ml-1">
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? "Listening..." : "Message your agent to start a task..."}
                    className="flex-1 resize-none bg-transparent px-4 py-3 text-[16px] md:text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50 min-h-[64px] leading-relaxed"
                    disabled={status === 'sending' || isListening}
                    rows={2}
                />

                {isListening && (
                    <div className="absolute top-4 right-4 h-5">
                        <VoiceWaveform active level={voice.level} />
                    </div>
                )}

                <div className="flex items-center justify-between px-2 pb-1.5">
                    <div className="flex gap-1">
                        {/* Mic Button */}
                        {voice.supported && (
                            <button
                                onClick={() => isListening ? voice.stop() : voice.start()}
                                disabled={status === 'sending'}
                                className={`flex shrink-0 items-center justify-center h-9 w-9 rounded-xl transition-all ${isListening ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'}`}
                                aria-label={isListening ? "Stop Recording" : "Voice Input"}
                            >
                                {isListening ? <MicOff className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
                            </button>
                        )}
                        {/* File Button */}
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={status === 'sending' || isListening}
                            className="flex shrink-0 items-center justify-center h-9 w-9 rounded-xl text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-all"
                            aria-label="Attach File"
                        >
                            <ImageIcon className="h-4 w-4" />
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*,image/svg+xml,application/pdf"
                            multiple
                            className="hidden"
                            onChange={handleFileInput}
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        {status === 'sent' && taskId && (
                            <Link href={`/tasks/${taskId}`} className="flex items-center gap-1.5 text-azure hover:text-azure-400 transition-colors bg-azure/10 px-2.5 py-1.5 rounded-lg border border-azure/20 text-[11px] font-medium tracking-wide">
                                <span>✓ Task queued</span>
                                <span>View task →</span>
                            </Link>
                        )}
                        {status === 'error' && (
                            <span className="text-red-400 bg-red-950/30 px-2.5 py-1.5 rounded-lg border border-red-900/50 flex items-center gap-1.5 text-[11px] font-medium">
                                Failed.
                            </span>
                        )}
                        <button
                            onClick={() => handleSubmit()}
                            disabled={(!text.trim() && pastedImages.length === 0 && pastedDocs.length === 0) || status === 'sending' || isListening}
                            className="flex shrink-0 items-center justify-center min-h-[36px] min-w-[36px] rounded-xl bg-text-primary text-canvas hover:bg-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                            aria-label="Send Task"
                        >
                            {status === 'sending' 
                                ? <RefreshCw className="h-4 w-4 animate-spin text-canvas" /> 
                                : <Send className="h-4 w-4 text-[var(--canvas)]" style={{ transform: 'translateX(-1px) translateY(1px)' }} />
                            }
                        </button>
                    </div>
                </div>
            </div>

            {/* Voice Setup Banner */}
            {showVoiceSetupPrompt && !voice.deepgramConfigured && (
                <div className="flex items-start gap-3 rounded-xl border border-azure/30 bg-azure-500/5 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-400">
                    <Mic className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-azure-200 uppercase tracking-wider">Better Voice Accuracy</p>
                        <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
                            Deepgram&apos;s Nova-3 is significantly more accurate.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Link href="/settings/voice" className="text-[10px] font-bold text-azure hover:text-azure-300 uppercase underline underline-offset-4 decoration-azure/40 transition-colors">
                            Settings
                        </Link>
                        <button onClick={() => setShowVoiceSetupPrompt(false)} className="text-text-muted hover:text-text-secondary transition-colors">
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                </div>
            )}

            {/* Prompt Chips */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full px-1">
                {[
                    { id: 'code', icon: Code2, label: 'Code', desc: 'Build or modify features', prompt: 'Write a React component that...' },
                    { id: 'research', icon: Search, label: 'Research', desc: 'Synthesize information', prompt: 'Research the latest developments in...' },
                    { id: 'ops', icon: Server, label: 'Ops', desc: 'Infrastructure & deployment', prompt: 'Audit all production servers for...' },
                    { id: 'data', icon: BarChart2, label: 'Data', desc: 'Query and analyze', prompt: 'Identify all users who converted...' },
                    { id: 'writing', icon: PenLine, label: 'Writing', desc: 'Draft and generate content', prompt: 'Write a technical blog post explaining...' },
                    { id: 'marketing', icon: Megaphone, label: 'Marketing', desc: 'Plan growth campaigns', prompt: 'Plan a product launch campaign for...' },
                    { id: 'general', icon: FolderOpen, label: 'General', desc: 'Other complex requests', prompt: 'Help me organize my upcoming...' },
                ].map((item) => {
                    const Icon = item.icon
                    const isSelected = selectedCategory === item.id
                    return (
                        <button
                            key={item.label}
                            onClick={() => { 
                                if (isSelected) {
                                    setSelectedCategory(null)
                                    setText('')
                                } else {
                                    setSelectedCategory(item.id)
                                    setText(item.prompt)
                                    setTimeout(() => inputRef.current?.focus(), 10)
                                }
                            }}
                            className={`group flex flex-col items-start gap-1.5 rounded-2xl border bg-surface-1/40 px-4 py-3.5 text-left transition-all duration-300 hover:border-azure/40 hover:bg-surface-2/60 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.2)] ${isSelected ? 'border-azure bg-azure/10 ring-1 ring-azure/30 shadow-[0_0_20px_-5px_rgba(99,102,241,0.15)]' : 'border-zinc-700/40'}`}
                        >
                            <div className="flex items-center gap-2.5 mb-0.5">
                                <div className={`rounded-lg p-1.5 transition-colors shadow-sm border ${isSelected ? 'bg-azure text-canvas border-azure shadow-md' : 'bg-zinc-800/80 text-text-secondary border-zinc-700/50 group-hover:text-azure group-hover:bg-azure/10'}`}>
                                    <Icon className="h-3.5 w-3.5" />
                                </div>
                                <span className={`text-[13px] font-semibold transition-colors tracking-wide ${isSelected ? 'text-azure' : 'text-text-secondary group-hover:text-text-primary'}`}>{item.label}</span>
                            </div>
                            <span className={`text-[12px] leading-relaxed line-clamp-1 ${isSelected ? 'text-azure/80' : 'text-text-muted'}`}>{item.desc}</span>
                        </button>
                    )
                })}
                {/* 6th Slot - Start a Project */}
                <Link
                    href="/projects/new"
                    className="group flex flex-col items-start gap-1.5 rounded-2xl border border-dashed border-zinc-700/40 bg-surface-1/20 px-4 py-3.5 text-left transition-all duration-300 hover:border-azure/40 hover:bg-azure/5 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.15)]"
                >
                    <div className="flex items-center gap-2.5 mb-0.5 w-full">
                        <div className="rounded-lg bg-zinc-800/40 p-1.5 text-text-secondary group-hover:text-azure transition-colors border border-transparent group-hover:border-azure/20">
                            <Plus className="h-3.5 w-3.5" />
                        </div>
                        <span className="text-[13px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors tracking-wide flex-1">More Options</span>
                        <ArrowRight className="h-3.5 w-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 group-hover:translate-x-0" />
                    </div>
                    <span className="text-[12px] text-text-muted leading-relaxed">Start a complex project</span>
                </Link>
            </div>
        </div>
    )
}

