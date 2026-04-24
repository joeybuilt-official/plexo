// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@web/context/workspace'
import {
    Send, RefreshCw, Mic, MicOff, Image as ImageIcon, FileText, X, FileUp, Sparkles, Volume2
} from 'lucide-react'
import { useSpeechInput } from '@web/hooks/use-speech-input'
import { VoiceWaveform } from '@web/components/voice-waveform'
import { type PastedImage, type PastedDocument, kindFromMime } from '@web/lib/attachments'
import { extractPdfText } from '@web/lib/pdf-extract'
import { checkAttachmentPrompt, recommendModelForInput } from '@web/lib/models'
import { looksLikeChat } from './quick-send-routing'

export function QuickSend() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const router = useRouter()
    const [text, setText] = useState('')
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
    const [taskId, setTaskId] = useState<string | null>(null)
    const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
    const [pastedDocs, setPastedDocs] = useState<PastedDocument[]>([])
    const [showVoiceSetupPrompt, setShowVoiceSetupPrompt] = useState(false)
    const [wantsAttachment, setWantsAttachment] = useState(false)
    const [suggestion, setSuggestion] = useState<{ suggestedModel: string; reason: string } | null>(null)
    const [isLiveMode, setIsLiveMode] = useState(false)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const workspaceId = ctxWorkspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
    const WS_ID = workspaceId || ''

    // Stable ref so the voice callback always calls the latest handleSubmit
    const handleSubmitRef = useRef(handleSubmit)
    handleSubmitRef.current = handleSubmit

    const handleVoiceResult = useCallback((transcript: string) => {
        setText(transcript)
        // Auto-send after brief delay if transcript is non-empty
        if (transcript.trim()) {
            setTimeout(() => {
                void handleSubmitRef.current(undefined, transcript.trim())
            }, 500)
        }
    }, [])

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

            // Mint a fresh sessionId up-front so both branches (chat
            // fastpath and full task) can share it with /app/chat. `new=1`
            // tells the chat page to wipe any stored state on mount.
            const newSid = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
                ? `web-${wsId}-${crypto.randomUUID()}`
                : `web-${wsId}-${Date.now()}-${Math.random().toString(36).slice(2)}`

            const trimmed = message.trim()
            const hasAttachments = attachments.length > 0
            // Chat fastpath: short conversational drafts with no
            // attachments get routed through /api/v1/chat/message so the
            // server's trivial-message fastpath can answer in ~1-2s
            // instead of 30-100s through the executor.
            if (!hasAttachments && looksLikeChat(trimmed)) {
                const chatRes = await fetch(`${apiUrl}/api/v1/chat/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        workspaceId: wsId,
                        message: trimmed,
                        sessionId: newSid,
                        newSession: true,
                    }),
                })
                if (!chatRes.ok) throw new Error('chat API error')
                const chatData = await chatRes.json() as {
                    reply?: string
                    status?: string
                    model?: string
                    taskId?: string
                    fastpath?: boolean
                }

                // If the server escalated to a task (e.g. returned
                // taskId + "On it."), redirect via the task path so the
                // chat page connects SSE and streams progress.
                if (chatData.taskId) {
                    try {
                        sessionStorage.setItem(`plexo-quicksend-message:${newSid}`, trimmed)
                    } catch { /* non-fatal */ }
                    const params = new URLSearchParams({
                        new: '1',
                        sessionId: newSid,
                        taskId: chatData.taskId,
                    })
                    if (isLiveMode) params.set('live', '1')
                    router.push(`/app/chat?${params.toString()}`)
                    return
                }

                // Stash the prefill payload so /app/chat can seed the UI
                // without refetching or running the message through the
                // pipeline a second time.
                try {
                    sessionStorage.setItem(
                        `plexo-quicksend-prefill:${newSid}`,
                        JSON.stringify({
                            message: trimmed,
                            reply: chatData.reply ?? '',
                            model: chatData.model ?? null,
                            taskId: null,
                            at: Date.now(),
                        }),
                    )
                } catch { /* sessionStorage may be unavailable; non-fatal */ }

                const params = new URLSearchParams({
                    new: '1',
                    sessionId: newSid,
                    prefill: '1',
                })
                if (isLiveMode) params.set('live', '1')
                router.push(`/app/chat?${params.toString()}`)
                return
            }

            // Task path: anything longer / imperative / with attachments
            // goes through the full executor as before.
            const res = await fetch(`${apiUrl}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: wsId,
                    type: 'automation',
                    source: 'dashboard',
                    context: {
                        description: trimmed,
                        attachments: hasAttachments ? attachments : undefined
                    },
                    priority: 5,
                }),
            })

            if (!res.ok) throw new Error('API error')
            const data = await res.json() as { id: string }

            // Stash message in sessionStorage to keep the URL short.
            // The chat page reads it back via plexo-quicksend-message:{sessionId}.
            try {
                sessionStorage.setItem(`plexo-quicksend-message:${newSid}`, trimmed)
            } catch { /* non-fatal */ }

            const params = new URLSearchParams({
                new: '1',
                sessionId: newSid,
                taskId: data.id,
            })
            if (isLiveMode) params.set('live', '1')
            router.push(`/app/chat?${params.toString()}`)
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
                    } catch { /* PDF text extraction is best-effort */ }
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
                            <span className="flex-1 text-amber/90 text-[11px] font-medium font-display">
                                Forgot an attachment?
                            </span>
                            <button
                                className="whitespace-nowrap rounded-lg bg-amber/20 hover:bg-amber/30 border border-amber-500/20 px-2 py-1 text-[11px] font-bold text-amber transition-colors uppercase tracking-wider"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                Attach
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Main Input Box */}
            <div className={`relative flex flex-col gap-2 p-3 rounded-[24px] border transition-all ${isListening ? 'border-red-500/40 bg-red-dim/10 shadow-[0_0_24px_rgba(239,68,68,0.15)]' : 'border-border bg-surface-1/50 backdrop-blur-sm shadow-[0_2px_24px_-12px_rgba(0,0,0,0.5)]'}`}>
                {/* File Previews */}
                {(pastedImages.length > 0 || pastedDocs.length > 0) && (
                    <div className="flex flex-wrap gap-2 p-2 border-b border-border/50">
                        {pastedImages.map((img) => (
                            <div key={img.id} className="relative group">
                                {img.kind === 'image' ? (
                                    <img src={img.dataUrl} alt={img.name} className="h-14 w-14 rounded-lg border border-border object-cover" />
                                ) : (
                                    <div className="h-14 w-20 rounded-lg border border-border/60 bg-surface-2/60 flex flex-col items-center justify-center gap-1 px-1 text-center">
                                        <FileText className="h-4 w-4 text-azure" />
                                        <span className="text-[10px] text-text-secondary truncate w-full px-1">{img.name}</span>
                                    </div>
                                )}
                                <button onClick={() => removeImage(img.id)} aria-label="Remove image" className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-surface-2 border border-border flex items-center justify-center text-text-secondary hover:text-red transition-all shadow-lg">
                                    <X className="h-2.5 w-2.5" />
                                </button>
                            </div>
                        ))}
                        {pastedDocs.map((doc) => (
                            <div key={doc.id} className="relative group flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                                <span className="font-medium truncate max-w-[120px]">{doc.name}</span>
                                <button onClick={() => removeDoc(doc.id)} aria-label="Remove document" className="h-4 w-4 rounded-full hover:text-red transition-colors ml-1">
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <div className="absolute top-4 right-4 z-10">
                    <button
                        onClick={() => {
                            const next = !isLiveMode
                            setIsLiveMode(next)
                            if (next) {
                                void voice.start()
                            } else {
                                voice.stop()
                            }
                        }}
                        className={`group relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-all ${
                            isLiveMode
                                ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/20'
                                : 'text-text-muted hover:text-text-secondary border border-transparent hover:border-border'
                        }`}
                    >
                        {isLiveMode && (
                           <span className="absolute -top-1 -right-1 flex h-2 w-2">
                               <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                               <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                           </span>
                        )}
                        <Volume2 className={`h-3 w-3 ${isLiveMode ? 'animate-pulse' : ''}`} />
                        <span>Live Mode</span>
                    </button>
                </div>

                <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? "Listening..." : "Message your agent to start a task..."}
                    className="flex-1 resize-none bg-transparent px-4 pr-24 py-4 text-[16px] md:text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-0 disabled:opacity-50 min-h-[64px] leading-relaxed"
                    disabled={status === 'sending' || isListening}
                    rows={2}
                    data-testid="task-input"
                />

                {isListening && (
                    <div className="absolute top-4 right-32 h-5">
                        <VoiceWaveform active level={voice.level} />
                    </div>
                )}

                <div className="flex items-center justify-between px-1 pb-1">
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
                        {/* Prompt optimizer button */}
                        <button
                            id="qs-optimize-prompt-btn"
                            onClick={() => {
                                const draft = text.trim()
                                if (draft) {
                                    setText(`Optimize this prompt for me: ${draft}`)
                                } else {
                                    setText('Optimize this prompt for me: ')
                                }
                                setTimeout(() => inputRef.current?.focus(), 10)
                            }}
                            disabled={status === 'sending' || isListening}
                            title={text.trim() ? 'Optimize this prompt' : 'Start prompt optimizer'}
                            className="flex shrink-0 items-center justify-center h-9 w-9 rounded-xl text-text-muted hover:text-azure hover:bg-azure/10 transition-all"
                            aria-label="Optimize prompt"
                        >
                            <Sparkles className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        {status === 'sent' && taskId && (
                            <Link href={`/app/tasks/${taskId}`} className="flex items-center gap-1.5 text-azure hover:text-azure-400 transition-colors bg-azure/10 px-2.5 py-1.5 rounded-lg border border-azure/20 text-[11px] font-medium tracking-wide">
                                <span>✓ Task queued</span>
                                <span>View task →</span>
                            </Link>
                        )}
                        {status === 'error' && (
                            <span className="text-red-400 bg-red-dim px-2.5 py-1.5 rounded-lg border border-red-900/50 flex items-center gap-1.5 text-[11px] font-medium">
                                Failed.
                            </span>
                        )}
                        <button
                            onClick={() => handleSubmit()}
                            disabled={(!text.trim() && pastedImages.length === 0 && pastedDocs.length === 0) || status === 'sending' || isListening}
                            className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-xl bg-text-primary text-canvas hover:bg-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                            aria-label="Send Task"
                            data-testid="submit-task"
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
                        <Link href="/app/settings/voice" className="text-[11px] font-bold text-azure hover:text-azure-300 uppercase underline underline-offset-4 decoration-azure/40 transition-colors">
                            Settings
                        </Link>
                        <button onClick={() => setShowVoiceSetupPrompt(false)} aria-label="Dismiss voice setup prompt" className="text-text-muted hover:text-text-secondary transition-colors">
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

