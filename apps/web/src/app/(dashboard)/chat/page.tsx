// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
    Send,
    RefreshCw,
    User,
    Clock,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
    Mic,
    MicOff,
    Volume2,
    VolumeX,
    ImageIcon,
    Video,
    Wrench,
    BrainCircuit,
    Type,
    FileUp,
    Sparkles,
    X,
    Copy,
    Check,
    Code2,
    Search,
    PenLine,
    Server,
    BarChart2,
    Megaphone,
    FolderOpen,
    Code2 as CodeIcon,
    FileText,
    Plus,
    ArrowRight,
} from 'lucide-react'
import { CodeModeShell, type CodeModeContext } from './_code-mode/code-mode-shell'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { getModelCapabilities, recommendModelForInput, checkAttachmentPrompt } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'
import { PlexoMark } from '@web/components/plexo-logo'
import { extractPdfText } from '@web/lib/pdf-extract'
import { CopyId } from '@web/components/copy-id'

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

/** 'image' = raster (jpeg/png/gif/webp), 'svg' = SVG text, 'pdf' = PDF binary */
type FileKind = 'image' | 'svg' | 'pdf'

interface PastedImage {
    id: string
    dataUrl: string
    mimeType: string
    name: string
    kind: FileKind
    /** For PDFs: text extracted by PDF.js. For SVG/raster: undefined. */
    extractedText?: string
}

interface PastedDocument {
    id: string
    name: string
    content: string
    lineCount: number
    charCount: number
}

// Characters threshold above which pasted text becomes a doc attachment
const LARGE_TEXT_THRESHOLD = 1000

interface TaskAsset {
    filename: string
    bytes: number
    isText: boolean
    content: string | null
}

interface Message {
    id: string
    role: 'user' | 'agent'
    content: string
    images?: PastedImage[]   // raster + svg + pdf previews
    docs?: PastedDocument[]
    taskId?: string
    status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending' | 'confirm_action'
    intent?: 'TASK' | 'PROJECT' | 'CONVERSATION'
    actionDescription?: string
    suggestedCategory?: string    // AI-suggested project category
    selectedCategory?: string     // user-selected category (overrides suggestedCategory)
    // Actionable error fields
    fixUrl?: string
    fixLabel?: string
    technicalDetail?: string
    // Assets produced by the agent's write_asset tool
    assets?: TaskAsset[]
    at: number
}

function fmt(ms: number): string {
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

// ── Category constants used in the bubble UI ───────────────────────────────────
const PROJECT_CATS = [
    { id: 'code',      label: 'Code',      Icon: Code2,     },
    { id: 'research',  label: 'Research',  Icon: Search,    },
    { id: 'writing',   label: 'Writing',   Icon: PenLine,   },
    { id: 'ops',       label: 'Ops',       Icon: Server,    },
    { id: 'data',      label: 'Data',      Icon: BarChart2, },
    { id: 'marketing', label: 'Marketing', Icon: Megaphone, },
    { id: 'general',   label: 'General',   Icon: FolderOpen,},
] as const

// ── AssetCard — renders a write_asset file inline in the chat ────────────────

function AssetCard({ asset }: { asset: TaskAsset }) {
    const [copied, setCopied] = useState(false)
    const sizeLabel = asset.bytes < 1024 ? `${asset.bytes}B` : asset.bytes < 1024 * 1024 ? `${(asset.bytes / 1024).toFixed(1)}KB` : `${(asset.bytes / (1024 * 1024)).toFixed(1)}MB`

    function copyContent() {
        if (!asset.content) return
        navigator.clipboard.writeText(asset.content).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <details className="group/asset rounded-lg border border-zinc-700/60 bg-zinc-800/50 overflow-hidden">
            <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-700/40 transition-colors list-none select-none">
                <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                <span className="flex-1 text-xs font-medium text-text-primary font-mono truncate">{asset.filename}</span>
                <span className="text-[10px] text-text-muted shrink-0">{sizeLabel}</span>
                <span className="text-[10px] text-text-muted shrink-0 group-open/asset:hidden">▸</span>
                <span className="text-[10px] text-text-muted shrink-0 hidden group-open/asset:inline">▾</span>
            </summary>
            {asset.isText && asset.content && (
                <div className="relative border-t border-zinc-700/60">
                    <button
                        onClick={copyContent}
                        className="absolute top-2 right-2 rounded-md bg-zinc-700 border border-zinc-600 p-1 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors z-10"
                        title="Copy content"
                    >
                        {copied ? <Check className="h-3 w-3 text-azure" /> : <Copy className="h-3 w-3" />}
                    </button>
                    <pre className="text-[11px] font-mono text-text-secondary leading-relaxed p-3 pr-10 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">{asset.content}</pre>
                </div>
            )}
            {!asset.isText && (
                <div className="border-t border-zinc-700/60 px-3 py-2 text-[11px] text-text-muted italic">Binary file — download from the Tasks page</div>
            )}
        </details>
    )
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
    msg,
    onExecute,
    onCancel,
    onSelectCategory,
    userInitial,
}: {
    msg: Message
    onExecute: (id: string, intent: 'TASK' | 'PROJECT' | 'CONVERSATION', desc: string, cat?: string) => void
    onCancel: (id: string) => void
    onSelectCategory: (id: string, cat: string) => void
    userInitial: string
}) {
    const [copied, setCopied] = useState(false)

    // File previews in user bubbles
    const imageStrip = msg.role === 'user' && msg.images && msg.images.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-2">
            {msg.images.map((img) => (
                img.kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        key={img.id}
                        src={img.dataUrl}
                        alt={img.name}
                        className="max-h-40 max-w-[200px] rounded-lg border border-border object-cover"
                    />
                ) : (
                    <div
                        key={img.id}
                        className="flex items-center gap-2 rounded-lg border border-zinc-600/60 bg-surface-2/60 px-3 py-2 text-xs text-text-secondary"
                    >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                        <span className="font-medium truncate max-w-[160px]">{img.name}</span>
                        <span className="text-text-muted shrink-0 uppercase text-[10px] font-bold">{img.kind}</span>
                    </div>
                )
            ))}
        </div>
    ) : null

    // Doc attachment pills in user bubbles
    const docStrip = msg.role === 'user' && msg.docs && msg.docs.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-2">
            {msg.docs.map((doc) => (
                <div
                    key={doc.id}
                    title={doc.content}
                    className="flex items-center gap-2 rounded-lg border border-zinc-600/60 bg-surface-2/60 px-3 py-2 text-xs text-text-secondary"
                >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    <span className="font-medium truncate max-w-[160px]">{doc.name}</span>
                    <span className="text-text-muted shrink-0">{doc.lineCount} lines</span>
                </div>
            ))}
        </div>
    ) : null
    function copyMsg() {
        const text = msg.actionDescription
            ? `${msg.content}\n${msg.actionDescription}`
            : msg.content
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    const sel = msg.selectedCategory ?? msg.suggestedCategory ?? 'general'

    return (
        <div
            key={msg.id}
            className={`group flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
        >
            {/* Avatar */}
            <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                ? 'bg-zinc-700'
                : ' '
                }`}>
                {msg.role === 'user'
                    ? userInitial
                        ? <span className="text-sm font-semibold text-text-primary select-none">{userInitial}</span>
                        : <User className="h-4 w-4 text-text-secondary" />
                    : <PlexoMark className="h-6 w-6" idle={msg.status !== 'queued' && msg.status !== 'running'} working={msg.status === 'queued' || msg.status === 'running'} />
                }
            </div>

            {/* Bubble */}
            <div className={`relative flex flex-col gap-1 max-w-[85%] md:max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                {imageStrip}
                {docStrip}
                <div className={`relative w-full overflow-x-auto rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === 'user'
                    ? 'bg-azure text-text-primary rounded-tr-md'
                    : msg.status === 'failed'
                        ? 'bg-red-950/30 border border-red-800/40 text-red-300 rounded-tl-md'
                        : 'bg-surface-2 text-text-primary rounded-tl-md'
                    }`}>
                    {msg.status === 'queued' ? (
                        <span className="text-text-muted text-sm italic py-0.5 block">Queued…</span>
                    ) : msg.status === 'running' ? (
                        <span className="text-text-secondary text-sm italic">
                            {msg.content || 'Working…'}
                        </span>
                    ) : msg.status === 'failed' ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-start gap-1.5">
                                <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                <span className="leading-snug">{msg.content || 'Failed.'}</span>
                            </div>
                            {msg.fixUrl && (
                                <Link
                                    href={msg.fixUrl}
                                    className="inline-flex items-center gap-1 self-start rounded-md bg-red-900/40 border border-red-700/40 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-900/60 hover:text-red-200 transition-colors"
                                >
                                    {msg.fixLabel ?? 'Fix this'} →
                                </Link>
                            )}
                            {msg.technicalDetail && (
                                <details className="group/td mt-0.5">
                                    <summary className="text-[10px] text-red/50 cursor-pointer hover:text-red/70 list-none flex items-center gap-1">
                                        <span className="group-open/td:hidden">▸ Technical details</span>
                                        <span className="hidden group-open/td:inline">▾ Technical details</span>
                                    </summary>
                                    <code className="block mt-1.5 text-[10px] text-red/50 font-mono break-all leading-relaxed bg-red-950/30 rounded p-2">
                                        {msg.technicalDetail}
                                    </code>
                                </details>
                            )}
                        </div>
                    ) : msg.status === 'confirm_action' && msg.intent === 'PROJECT' ? (
                        <div className="flex flex-col gap-3">
                            <span className="font-medium text-text-primary">
                                I can set this up as a coordinated project.
                            </span>

                            {/* Category picker */}
                            <div className="flex flex-wrap gap-1.5">
                                {PROJECT_CATS.map(({ id, label, Icon }) => (
                                    <button
                                        key={id}
                                        onClick={() => onSelectCategory(msg.id, id)}
                                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium border transition-all ${
                                            sel === id
                                                ? 'bg-azure border-azure text-text-primary'
                                                : 'bg-zinc-700/50 border-zinc-600/50 text-text-secondary hover:border-zinc-500 hover:text-text-primary'
                                        }`}
                                    >
                                        <Icon className="h-3 w-3" />
                                        {label}
                                    </button>
                                ))}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={() => onExecute(msg.id, 'PROJECT', msg.actionDescription!, sel)}
                                    className="rounded-lg bg-azure px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                                >
                                    Create Project
                                </button>
                                <button
                                    onClick={() => onCancel(msg.id)}
                                    className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <span className="whitespace-pre-wrap">{msg.content}</span>
                            {msg.fixUrl && (
                                <Link
                                    href={msg.fixUrl}
                                    className="inline-flex items-center gap-1 self-start rounded-md bg-zinc-700/60 border border-zinc-600/50 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                                >
                                    {msg.fixLabel ?? 'View'} →
                                </Link>
                            )}
                            {/* Asset files produced by write_asset */}
                            {msg.assets && msg.assets.length > 0 && (
                                <div className="flex flex-col gap-1.5 mt-1">
                                    {msg.assets.map((asset) => (
                                        <AssetCard key={asset.filename} asset={asset} />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                </div>

                {/* Copy button — hover-visible, outside the overflow-clipped bubble */}
                {msg.status !== 'queued' && msg.status !== 'running' && msg.status !== 'confirm_action' && msg.content && (
                    <button
                        onClick={copyMsg}
                        className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-md bg-zinc-700 border border-zinc-600 p-1 text-text-secondary hover:text-text-primary hover:bg-surface-3 z-10"
                        title="Copy"
                    >
                        {copied
                            ? <Check className="h-3 w-3 text-azure" />
                            : <Copy className="h-3 w-3" />
                        }
                    </button>
                )}

                {/* Meta */}
                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                    <span>{fmt(msg.at)}</span>
                    {msg.taskId && (
                        <Link
                            href={`/tasks/${msg.taskId}`}
                            className="hover:text-text-secondary transition-colors font-mono"
                        >
                            {msg.taskId.slice(0, 8)} ↗
                        </Link>
                    )}
                    {msg.status === 'complete' && (
                        <CheckCircle2 className="h-3 w-3 text-azure" />
                    )}
                </div>
            </div>
        </div>
    )
}

function StatusChip({ status }: { status: Message['status'] }) {
    if (!status || status === 'complete') return null
    if (status === 'running' || status === 'pending') {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-azure">
                {status === 'running' ? 'Working…' : 'Waiting…'}
            </span>
        )
    }
    const map = {
        queued: { icon: Clock, cls: 'text-text-muted', label: 'Queued' },
        failed: { icon: XCircle, cls: 'text-red', label: 'Failed' },
    } as const
    const cfg = map[status as keyof typeof map]
    if (!cfg) return null
    const Icon = cfg.icon
    return (
        <span className={`inline-flex items-center gap-1 text-[11px] ${cfg.cls}`}>
            <Icon className="h-3 w-3" />
            {cfg.label}
        </span>
    )
}

// ── Voice waveform bars (animated when listening) ──────────────────────────

function VoiceWaveform({ active, level }: { active: boolean; level: number }) {
    const bars = [0.4, 0.7, 1.0, 0.85, 0.6, 0.9, 0.5, 0.75, 0.45, 0.8, 0.55, 0.65]
    return (
        <div className="flex items-center justify-center gap-[3px] h-5">
            {bars.map((base, i) => (
                <div
                    key={i}
                    className="w-[3px] rounded-full bg-azure transition-all"
                    style={{
                        height: active
                            ? `${Math.max(3, Math.min(20, base * level * 20 + 3))}px`
                            : '4px',
                        opacity: active ? 0.9 : 0.3,
                        transitionDuration: `${80 + i * 20}ms`,
                    }}
                />
            ))}
        </div>
    )
}

// ── Hook: Deepgram-powered voice input ────────────────────────────────────────
// Falls back to browser SpeechRecognition if Deepgram is not configured.
// On first use without Deepgram, sets a flag so the UI can show a setup prompt.

type SpeechStatus = 'idle' | 'listening' | 'processing'

interface UseSpeechInputOptions {
    workspaceId: string
    onResult: (text: string) => void
    onSetupNeeded?: () => void
}

function useSpeechInput({ workspaceId, onResult, onSetupNeeded }: UseSpeechInputOptions) {
    const [status, setStatus] = useState<SpeechStatus>('idle')
    const [level, setLevel] = useState(0)
    const [supported, setSupported] = useState(false)
    const [deepgramConfigured, setDeepgramConfigured] = useState<boolean | null>(null) // null = unknown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recRef = useRef<any>(null)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<BlobPart[]>([])
    const analyserRef = useRef<AnalyserNode | null>(null)
    const animFrameRef = useRef<number>(0)
    const streamRef = useRef<MediaStream | null>(null)

    useEffect(() => {
        setSupported(
            typeof window !== 'undefined' &&
            (typeof navigator.mediaDevices?.getUserMedia === 'function' ||
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'SpeechRecognition' in window || 'webkitSpeechRecognition' in (window as any))
        )
    }, [])

    // Check if Deepgram is configured for this workspace
    useEffect(() => {
        if (!workspaceId) return
        fetch(`/api/v1/voice/settings?workspaceId=${workspaceId}`, { signal: AbortSignal.timeout(5000) })
            .then(r => r.ok ? r.json() as Promise<{ configured: boolean }> : null)
            .then(d => setDeepgramConfigured(d?.configured ?? false))
            .catch(() => setDeepgramConfigured(false))
    }, [workspaceId])

    const stopAll = useCallback(() => {
        recRef.current?.stop()
        recRef.current = null
        mediaRecorderRef.current?.stop()
        mediaRecorderRef.current = null
        chunksRef.current = []
        cancelAnimationFrame(animFrameRef.current)
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        analyserRef.current = null
        setLevel(0)
        setStatus('idle')
    }, [])

    const startWaveform = useCallback(async (stream: MediaStream) => {
        try {
            const ctx = new AudioContext()
            const source = ctx.createMediaStreamSource(stream)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)
            analyserRef.current = analyser
            const data = new Uint8Array(analyser.frequencyBinCount)
            const tick = () => {
                analyser.getByteFrequencyData(data)
                const avg = data.reduce((a, b) => a + b, 0) / data.length
                setLevel(avg / 128)
                animFrameRef.current = requestAnimationFrame(tick)
            }
            tick()
        } catch { /* non-fatal */ }
    }, [])

    const start = useCallback(async () => {
        if (!supported || status !== 'idle') return

        // Deepgram path
        if (deepgramConfigured) {
            let stream: MediaStream
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                streamRef.current = stream
            } catch {
                return // mic access denied
            }
            await startWaveform(stream)

            // Pick the best supported MIME type
            const mimeType = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/ogg',
                'audio/mp4',
            ].find(mt => MediaRecorder.isTypeSupported(mt)) ?? ''

            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
            chunksRef.current = []
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
            recorder.onstop = async () => {
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
                setStatus('processing')
                cancelAnimationFrame(animFrameRef.current)
                streamRef.current?.getTracks().forEach(t => t.stop())
                setLevel(0)

                try {
                    const r = await fetch(`/api/v1/voice/transcribe?workspaceId=${workspaceId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': recorder.mimeType || 'audio/webm' },
                        body: blob,
                        signal: AbortSignal.timeout(30_000),
                    })
                    const data = await r.json() as { transcript?: string; error?: { message?: string } }
                    if (data.transcript?.trim()) onResult(data.transcript.trim())
                } catch { /* ignore — user can try again */ }
                setStatus('idle')
            }

            mediaRecorderRef.current = recorder
            recorder.start()
            setStatus('listening')
            return
        }

        // No Deepgram — show setup prompt then fall back to browser SR
        if (deepgramConfigured === false) {
            onSetupNeeded?.()
            // Small delay so the prompt renders, then start browser SR anyway as immediate fallback
        }

        // Browser SpeechRecognition fallback
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream
            await startWaveform(stream)
        } catch { /* mic access denied — try SR without waveform */ }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
        if (!SR) { setStatus('idle'); return }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rec = new SR() as any
        rec.continuous = false
        rec.interimResults = false
        rec.lang = 'en-US'
        rec.onstart = () => setStatus('listening')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rec.onresult = (e: any) => {
            const text = e.results[0]?.[0]?.transcript ?? ''
            if (text.trim()) onResult(text.trim())
        }
        rec.onend = () => {
            setStatus('idle')
            cancelAnimationFrame(animFrameRef.current)
            streamRef.current?.getTracks().forEach(t => t.stop())
            setLevel(0)
        }
        rec.onerror = () => stopAll()
        recRef.current = rec
        rec.start()
    }, [supported, status, deepgramConfigured, workspaceId, onResult, onSetupNeeded, startWaveform, stopAll])

    const stop = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop() // triggers onstop → transcription
        } else {
            stopAll()
        }
    }, [stopAll])

    return { status, level, supported, start, stop, deepgramConfigured }
}

// ── Hook: Text-to-Speech ──────────────────────────────────────────────────

function useTTS() {
    const [speaking, setSpeaking] = useState(false)
    const [enabled, setEnabled] = useState(true)
    const utterRef = useRef<SpeechSynthesisUtterance | null>(null)

    const speak = useCallback((text: string) => {
        if (!enabled || typeof window === 'undefined' || !window.speechSynthesis) return
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.05
        utterance.pitch = 1.0
        // Prefer a natural-sounding voice
        const voices = window.speechSynthesis.getVoices()
        const preferred = voices.find(v =>
            v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Natural')
        ) ?? voices[0]
        if (preferred) utterance.voice = preferred
        utterRef.current = utterance
        utterance.onstart = () => setSpeaking(true)
        utterance.onend = () => setSpeaking(false)
        utterance.onerror = () => setSpeaking(false)
        window.speechSynthesis.speak(utterance)
    }, [enabled])

    const stop = useCallback(() => {
        window.speechSynthesis?.cancel()
        setSpeaking(false)
    }, [])

    const toggle = useCallback(() => {
        if (speaking) stop()
        setEnabled(e => !e)
    }, [speaking, stop])

    return { speaking, enabled, speak, stop, toggle }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ChatPage() {
    return (
        <Suspense fallback={
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-text-muted">
                <PlexoMark className="h-10 w-10" idle={false} working />
                <span className="text-sm">Loading chat…</span>
            </div>
        }>
            <ChatContent />
        </Suspense>
    )
}

function ChatContent() {
    const { workspaceId, userName } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const userInitial = userName ? userName.trim().charAt(0).toUpperCase() : ''
    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState('')
    const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
    const [pastedDocs, setPastedDocs] = useState<PastedDocument[]>([])
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [agentModel, setAgentModel] = useState<string | null>(null)
    const [showVoiceSetupPrompt, setShowVoiceSetupPrompt] = useState(false)
    const bottomRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const sessionId = useRef(`session-${Date.now()}`)
    const [isDraggingOver, setIsDraggingOver] = useState(false)
    /** Counter tracks nested dragenter/dragleave so child elements don't flicker the overlay */
    const dragCounterRef = useRef(0)
    const searchParams = useSearchParams()

    // ── Code Mode state ───────────────────────────────────────────────────────
    const [codeMode, setCodeMode] = useState(false)
    const [codeModeContext, setCodeModeContext] = useState<CodeModeContext>({})
    // Track last running task's taskId for Code Mode streaming
    const lastRunningTaskId = messages.find((m) => m.status === 'running')?.taskId

    // Fetch the active agent model
    useEffect(() => {
        if (!WS_ID) return
        void fetch(`${API}/api/v1/agent/status`)
            .then(res => res.json())
            .then(data => setAgentModel((data as { currentModel?: string | null }).currentModel || null))
            .catch(() => { })
    }, [WS_ID])

    // Scroll to bottom on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Load context from ?context=<conversationId> OR ?sessionId=<sessionId>
    // ?sessionId loads the full thread (all turns); ?context loads a single turn.
    // In both cases the session ID ref is set so new messages are correctly linked.
    useEffect(() => {
        const contextId = searchParams.get('context')
        const sessionIdParam = searchParams.get('sessionId')
        if (!contextId && !sessionIdParam) return
        if (messages.length > 0) return

        async function loadContext() {
            try {
                // ── Full session thread (preferred, from Telegram or multi-turn) ────
                if (sessionIdParam && WS_ID) {
                    const res = await fetch(
                        `${API}/api/v1/conversations?workspaceId=${encodeURIComponent(WS_ID)}&sessionId=${encodeURIComponent(sessionIdParam)}&limit=100`
                    )
                    if (!res.ok) return
                    const data = await res.json() as { items: Array<{ id: string; message: string; reply: string | null; errorMsg: string | null; status: string; intent: string | null; taskId: string | null }> }
                    const turns = data.items ?? []
                    const loaded: Message[] = []
                    for (const turn of turns) {
                        loaded.push({
                            id: `ctx-user-${turn.id}`,
                            role: 'user',
                            content: turn.message,
                            status: 'complete',
                            at: Date.now(),
                        })
                        const body = turn.reply ?? turn.errorMsg ?? null
                        if (body) {
                            loaded.push({
                                id: `ctx-agent-${turn.id}`,
                                role: 'agent',
                                content: body,
                                status: (turn.status === 'failed' && turn.errorMsg) ? 'failed' : 'complete',
                                taskId: turn.taskId ?? undefined,
                                at: Date.now() + 1,
                            })
                        }
                    }
                    if (loaded.length > 0) setMessages(loaded)
                    // Restore the session ID — new messages from web will be linked
                    // and relayed back to the originating channel (e.g. Telegram)
                    sessionId.current = sessionIdParam
                    return
                }

                // ── Single-turn context (legacy ?context= param) ─────────────────
                if (contextId) {
                    const res = await fetch(`${API}/api/v1/conversations/${contextId}`)
                    if (!res.ok) return
                    const data = await res.json() as {
                        id: string
                        message: string
                        reply: string | null
                        sessionId: string | null
                        status: string
                    }
                    const loaded: Message[] = []
                    if (data.message) {
                        loaded.push({
                            id: `ctx-user-${Date.now()}`,
                            role: 'user',
                            content: data.message,
                            status: 'complete',
                            at: Date.now() - 1,
                        })
                    }
                    if (data.reply) {
                        loaded.push({
                            id: `ctx-agent-${Date.now()}`,
                            role: 'agent',
                            content: data.reply,
                            status: 'complete',
                            at: Date.now(),
                        })
                    }
                    if (loaded.length > 0) setMessages(loaded)
                    if (data.sessionId) sessionId.current = data.sessionId
                }
            } catch { /* ignore */ }
        }
        void loadContext()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])



    const tts = useTTS()

    const handleVoiceResult = useCallback((text: string) => {
        setInput(text)
        // Auto-send after brief delay so user can see what was captured
        setTimeout(() => {
            setInput('')
            void sendMessageWith(text)
        }, 300)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const voice = useSpeechInput({
        workspaceId: WS_ID,
        onResult: handleVoiceResult,
        onSetupNeeded: () => setShowVoiceSetupPrompt(true),
    })

    // Stream live progress from the agent via SSE
    const pollReply = useCallback(async (taskId: string, msgId: string): Promise<void> => {
        return new Promise((resolve) => {
            const url = `${API}/api/v1/chat/reply-stream/${taskId}`
            const es = new EventSource(url)

            const cleanup = () => es.close()

            // Progress tick — update the bubble in place
            es.addEventListener('tick', (e) => {
                try {
                    const d = JSON.parse(e.data) as {
                        status: string
                        elapsed: number
                        stepCount: number
                        lastAction: string | null
                    }
                    const elapsed = d.elapsed < 60
                        ? `${d.elapsed}s`
                        : `${Math.floor(d.elapsed / 60)}m ${d.elapsed % 60}s`
                    const lines: string[] = [`Working… (${elapsed})`]
                    if (d.stepCount > 0) lines.push(`Step ${d.stepCount}`)
                    if (d.lastAction) lines.push(d.lastAction)
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status: 'running', content: lines.join(' · ') } : m
                    ))
                } catch { /* ignore parse errors */ }
            })

            // Terminal events
            const onTerminal = (e: MessageEvent, status: 'complete' | 'failed') => {
                try {
                    const d = JSON.parse(e.data) as { reply?: string }
                    const reply = d.reply ?? (status === 'complete' ? 'Done.' : 'Something went wrong.')
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status, content: reply } : m
                    ))
                    if (status === 'complete') {
                        tts.speak(reply)
                        // Fetch assets produced by write_asset and attach to this message
                        fetch(`${API}/api/v1/tasks/${taskId}/assets`)
                            .then(r => r.ok ? r.json() as Promise<{ items: TaskAsset[] }> : null)
                            .then(data => {
                                if (data && data.items.length > 0) {
                                    setMessages((prev) => prev.map((m) =>
                                        m.id === msgId ? { ...m, assets: data.items } : m
                                    ))
                                }
                            })
                            .catch(() => { /* non-fatal */ })
                    }
                } catch { /* ignore */ }
                cleanup()
                resolve()
            }

            es.addEventListener('complete', (e) => onTerminal(e, 'complete'))
            es.addEventListener('blocked', (e) => onTerminal(e, 'failed'))
            es.addEventListener('cancelled', (e) => onTerminal(e, 'failed'))
            es.addEventListener('timeout', (e) => onTerminal(e, 'failed'))

            es.onerror = () => {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'pending', content: 'Lost connection. Check the Tasks page for status.' } : m
                ))
                cleanup()
                resolve()
            }
        })
    }, [tts])


    async function executeConfirmedAction(msgId: string, intent: 'TASK' | 'PROJECT' | 'CONVERSATION', description: string, category?: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'queued', content: '', intent: undefined, actionDescription: undefined } : m
        ))
        try {
            // CONVERSATION: just answer, no task/project created
            if (intent === 'CONVERSATION') {
                const res = await fetch(`${API}/api/v1/chat/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId: WS_ID, message: description, sessionId: sessionId.current, forceConversation: true }),
                })
                const data = await res.json() as { reply?: string; status?: string }
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'complete', content: data.reply ?? 'Here\'s what I know about that:' } : m
                ))
                return
            }

            const res = await fetch(`${API}/api/v1/chat/execute-action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, intent, description, sessionId: sessionId.current, category }),
            })
            if (!res.ok) {
                const errBody = await res.json().catch(() => null) as { error?: { message?: string } } | null
                const errMsg = errBody?.error?.message ?? 'Failed to execute action.'
                throw new Error(errMsg)
            }
            const data = await res.json() as { taskId?: string; sprintId?: string; status?: string }
            if (data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, taskId: data.taskId, status: 'running' } : m
                ))
                // pollReply is long-running (SSE). Don't await — let it run async so the
                // input stays enabled and the user can send more messages while it works.
                void pollReply(data.taskId, msgId)
            } else if (data.sprintId) {
                // Project created — stay in chat, show a link. Don't redirect away blindly.
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? {
                        ...m,
                        status: 'complete',
                        content: `Project created and running. Track progress →`,
                        fixUrl: `/projects/${data.sprintId}`,
                        fixLabel: 'Open project',
                    } : m
                ))
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to start action.'
            setMessages((prev) => prev.map((m) =>
                m.id === msgId ? { ...m, status: 'failed', content: msg, intent: undefined, actionDescription: undefined } : m
            ))
        }
    }

    function cancelAction(msgId: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'complete', content: 'Action cancelled.', intent: undefined, actionDescription: undefined } : m
        ))
    }

    // ── File paste / drag-drop handling ───────────────────────────────────────

    function kindFromMime(mime: string): FileKind | null {
        if (mime === 'image/svg+xml') return 'svg'
        if (mime === 'application/pdf') return 'pdf'
        if (mime.startsWith('image/')) return 'image'
        return null
    }

    function extractImagesFromDataTransfer(dt: DataTransfer): PastedImage[] {
        const imgs: PastedImage[] = []
        for (const item of Array.from(dt.items)) {
            const kind = kindFromMime(item.type)
            if (!kind) continue
            const file = item.getAsFile()
            if (!file) continue
            const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const dataUrl = URL.createObjectURL(file)
            imgs.push({ id, dataUrl, mimeType: file.type, name: file.name || `file.${file.type.split('/')[1] ?? 'bin'}`, kind })
        }
        return imgs
    }

    function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
        // ── File paste (images, SVG, PDF) ─────────────────────────────────────
        const imgs = extractImagesFromDataTransfer(e.clipboardData)
        if (imgs.length > 0) {
            e.preventDefault()
            void Promise.all(
                imgs.map((img) =>
                    fetch(img.dataUrl)
                        .then((r) => r.blob())
                        .then(
                            (blob) =>
                                new Promise<PastedImage>((resolve) => {
                                    const reader = new FileReader()
                                    reader.onload = () => {
                                        URL.revokeObjectURL(img.dataUrl)
                                        const dataUrl = reader.result as string
                                        if (img.kind === 'pdf') {
                                            extractPdfText(dataUrl).then((r) => {
                                                resolve({ ...img, dataUrl, extractedText: r.text })
                                            }).catch(() => resolve({ ...img, dataUrl }))
                                        } else {
                                            resolve({ ...img, dataUrl })
                                        }
                                    }
                                    reader.readAsDataURL(blob)
                                })
                        )
                )
            ).then((resolved) => {
                setPastedImages((prev) => [...prev, ...resolved])
            })
            return
        }

        // ── Large-text → doc attachment ───────────────────────────────────────
        const text = e.clipboardData.getData('text/plain')
        if (text.length >= LARGE_TEXT_THRESHOLD) {
            e.preventDefault()
            const lines = text.split('\n')
            const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`
            // Try to infer a name from the first non-empty line or fall back to generic
            const firstLine = lines.find(l => l.trim().length > 0)?.trim().slice(0, 60) ?? 'Pasted text'
            const name = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
            const doc: PastedDocument = {
                id,
                name,
                content: text,
                lineCount: lines.length,
                charCount: text.length,
            }
            setPastedDocs((prev) => [...prev, doc])
        }
    }

    function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
        // Handled by the page-level drop zone
        e.preventDefault()
    }

    /** Shared: resolve blobs from a DataTransfer into PastedImage objects (with PDF extraction) */
    async function processDroppedDataTransfer(dt: DataTransfer): Promise<void> {
        const imgs = extractImagesFromDataTransfer(dt)
        if (imgs.length === 0) return
        const resolved = await Promise.all(
            imgs.map((img) =>
                fetch(img.dataUrl)
                    .then((r) => r.blob())
                    .then(
                        (blob) =>
                            new Promise<PastedImage>((resolve) => {
                                const reader = new FileReader()
                                reader.onload = () => {
                                    URL.revokeObjectURL(img.dataUrl)
                                    const dataUrl = reader.result as string
                                    if (img.kind === 'pdf') {
                                        extractPdfText(dataUrl)
                                            .then((r) => resolve({ ...img, dataUrl, extractedText: r.text }))
                                            .catch(() => resolve({ ...img, dataUrl }))
                                    } else {
                                        resolve({ ...img, dataUrl })
                                    }
                                }
                                reader.readAsDataURL(blob)
                            })
                    )
            )
        )
        setPastedImages((prev) => [...prev, ...resolved])
    }

    function handleDragEnter(e: React.DragEvent) {
        e.preventDefault()
        dragCounterRef.current += 1
        if (dragCounterRef.current === 1) setIsDraggingOver(true)
    }

    function handleDragLeave(e: React.DragEvent) {
        e.preventDefault()
        dragCounterRef.current -= 1
        if (dragCounterRef.current === 0) setIsDraggingOver(false)
    }

    function handlePageDrop(e: React.DragEvent) {
        e.preventDefault()
        dragCounterRef.current = 0
        setIsDraggingOver(false)
        void processDroppedDataTransfer(e.dataTransfer)
    }

    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? [])
        const imgs: Promise<PastedImage>[] = files
            .filter((f) => kindFromMime(f.type) !== null)
            .map(
                (file) =>
                    new Promise<PastedImage>((resolve) => {
                        const reader = new FileReader()
                        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
                        const kind = kindFromMime(file.type)!
                        reader.onload = () => {
                            const dataUrl = reader.result as string
                            if (kind === 'pdf') {
                                // Extract text asynchronously; store on the object
                                extractPdfText(dataUrl).then((result) => {
                                    resolve({ id, dataUrl, mimeType: file.type, name: file.name, kind, extractedText: result.text })
                                }).catch(() => {
                                    resolve({ id, dataUrl, mimeType: file.type, name: file.name, kind })
                                })
                            } else {
                                resolve({ id, dataUrl, mimeType: file.type, name: file.name, kind })
                            }
                        }
                        reader.readAsDataURL(file)
                    })
            )
        void Promise.all(imgs).then((resolved) => {
            setPastedImages((prev) => [...prev, ...resolved])
        })
        // reset so same file can be re-selected
        e.target.value = ''
    }

    function removeImage(id: string) {
        setPastedImages((prev) => prev.filter((img) => img.id !== id))
    }

    // ── Send ──────────────────────────────────────────────────────────────────

    async function sendMessageWith(text: string, images?: PastedImage[], docs?: PastedDocument[]) {
        if ((!text.trim() && (!images || images.length === 0) && (!docs || docs.length === 0)) || sending) return
        if (!WS_ID) {
            setError('No workspace configured. Set NEXT_PUBLIC_DEFAULT_WORKSPACE in .env.local.')
            return
        }

        setError(null)
        setSending(true)

        // If there are doc attachments, append them to the message text so the agent
        // sees the full content, while the UI only shows a compact pill.
        let effectiveText = text
        if (docs && docs.length > 0) {
            const docBlock = docs.map(d =>
                `--- ${d.name} (${d.lineCount} lines) ---\n${d.content}\n---`
            ).join('\n\n')
            effectiveText = text ? `${text}\n\n${docBlock}` : docBlock
        }

        const userMsg: Message = {
            id: `u-${Date.now()}`,
            role: 'user',
            content: text || (docs && docs.length > 0 ? `📄 ${docs.map(d => d.name).join(', ')}` : ''),
            images: images && images.length > 0 ? images : undefined,  // all kinds
            docs: docs && docs.length > 0 ? docs : undefined,
            at: Date.now(),
        }

        const pendingId = `a-${Date.now()}`
        const pendingMsg: Message = {
            id: pendingId,
            role: 'agent',
            content: '',
            status: 'queued',
            at: Date.now(),
        }

        setMessages((prev) => [...prev, userMsg, pendingMsg])

        try {
            // Separate attached files by kind for the API
            const rasterImages = images?.filter(f => f.kind === 'image') ?? []
            // SVGs are sent as text documents so any model can read them
            const svgDocs = images?.filter(f => f.kind === 'svg') ?? []
            // PDFs: use pre-extracted text (from PDF.js); never send raw binary to the API
            const pdfDocs = images?.filter(f => f.kind === 'pdf') ?? []

            // Build effective text with SVG and PDF content injected as doc blocks
            let textWithAttachments = effectiveText

            if (svgDocs.length > 0) {
                const svgBlocks = await Promise.all(
                    svgDocs.map(async (f) => {
                        // data URL → raw SVG text
                        const resp = await fetch(f.dataUrl)
                        const text = await resp.text()
                        return `--- ${f.name} (SVG) ---\n\`\`\`svg\n${text}\n\`\`\`\n---`
                    })
                ).catch(() => [] as string[])
                if (svgBlocks.length > 0) {
                    textWithAttachments = textWithAttachments
                        ? `${textWithAttachments}\n\n${svgBlocks.join('\n\n')}`
                        : svgBlocks.join('\n\n')
                }
            }

            if (pdfDocs.length > 0) {
                const pdfBlocks = pdfDocs.map((f) => {
                    const content = f.extractedText ?? '(PDF text extraction unavailable.)'
                    return `--- ${f.name} (PDF) ---\n${content}\n---`
                })
                textWithAttachments = textWithAttachments
                    ? `${textWithAttachments}\n\n${pdfBlocks.join('\n\n')}`
                    : pdfBlocks.join('\n\n')
            }

            const res = await fetch(`${API}/api/v1/chat/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    message: textWithAttachments,
                    sessionId: sessionId.current,
                    // Inject Code Mode repo context if active
                    ...(codeMode && codeModeContext.repo ? {
                        repo: codeModeContext.repo,
                        branch: codeModeContext.branch,
                    } : {}),
                    images: rasterImages.length > 0
                        ? rasterImages.map((img) => ({ data: img.dataUrl, mimeType: img.mimeType, name: img.name }))
                        : undefined,
                }),
            })

            if (!res.ok) {
                const err = await res.json() as { error?: { message?: string } }
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, status: 'failed', content: err.error?.message ?? 'Failed to send.' } : m
                ))
                return
            }

            const data = await res.json() as { taskId?: string; status?: string; reply?: string; intent?: string; description?: string; fixUrl?: string; fixLabel?: string; technicalDetail?: string }

            // Error from AI provider — surface structured, actionable message
            if (data.status === 'error') {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        status: 'failed',
                        content: data.reply ?? 'An error occurred.',
                        fixUrl: data.fixUrl,
                        fixLabel: data.fixLabel,
                        technicalDetail: data.technicalDetail,
                    } : m
                ))
                return
            }

            // Action needs confirmation
            if (data.status === 'confirm_action' && data.intent && data.description) {
                const typedData = data as { status: string; intent?: string; description?: string; suggestedCategory?: string }
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        status: 'confirm_action',
                        content: 'What would you like to do with this?',
                        intent: data.intent as 'TASK' | 'PROJECT',
                        actionDescription: data.description,
                        suggestedCategory: typedData.suggestedCategory ?? 'general',
                        selectedCategory: typedData.suggestedCategory ?? 'general',
                    } : m
                ))
                return
            }

            // Direct conversational reply — no polling needed
            if (data.status === 'complete' && data.reply) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, status: 'complete', content: data.reply! } : m
                ))
                return
            }

            // Task auto-queued (no confirmation needed) — show reply + start polling
            if (data.status === 'task_queued' && data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        taskId: data.taskId!,
                        status: 'running',
                        content: (data as { reply?: string }).reply ?? 'On it.',
                    } : m
                ))
                void pollReply(data.taskId, pendingId)
                return
            }

            // Task queued via legacy path
            if (data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, taskId: data.taskId!, status: 'running' } : m
                ))
                await pollReply(data.taskId, pendingId)
                return
            }

            // Unexpected response
            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, status: 'failed', content: 'Unexpected response from server.' } : m
            ))
        } catch {
            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, status: 'failed', content: 'Network error.' } : m
            ))
        } finally {
            // Release the input immediately — don't hold it for the duration of task polling.
            // Task polling runs async via SSE; the user should be able to send more messages.
            setSending(false)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }

    async function sendMessage() {
        const text = input.trim()
        const imgs = pastedImages.slice()
        const docs = pastedDocs.slice()
        if (!text && imgs.length === 0 && docs.length === 0) return
        setInput('')
        setPastedImages([])
        setPastedDocs([])
        await sendMessageWith(text, imgs, docs)
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void sendMessage()
        }
    }

    // Also update voice result to clear images (voice has no images)
    const handleVoiceResultWithClear = useCallback((text: string) => {
        setPastedImages([])
        handleVoiceResult(text)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleVoiceResult])

    const isListening = voice.status === 'listening' || voice.status === 'processing'

    const modelToUse = agentModel ?? 'claude-sonnet-4-5'
    const caps = getModelCapabilities(modelToUse)
    const suggestion = recommendModelForInput(input, modelToUse)
    const wantsAttachment = checkAttachmentPrompt(input)

    const chatPanel = (
        <div
            className="flex h-full flex-col relative"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handlePageDrop}
        >
            {/* Page-wide drop overlay */}
            {isDraggingOver && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-azure/60 bg-surface-0/90 backdrop-blur-sm pointer-events-none">
                    <div className="flex flex-col items-center gap-2">
                        <FileUp className="h-10 w-10 text-azure opacity-80" />
                        <p className="text-base font-semibold text-text-primary">Drop files here</p>
                        <p className="text-xs text-text-muted">Images, SVG, PDF</p>
                    </div>
                </div>
            )}
            {/* Header */}

            <div className="flex items-center justify-between pb-4 border-b border-border shrink-0">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-xl font-bold text-zinc-50">Chat</h1>
                        {agentModel && (
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono font-medium text-text-secondary bg-surface-1 border border-border px-2 py-0.5 rounded-full">
                                    {agentModel}
                                </span>
                                <CapabilityList caps={caps} />
                            </div>
                        )}
                    </div>
                    <p className="text-sm text-text-muted mt-1">
                        Talk directly with your agent
                        <CopyId id={sessionId.current} label="session" className="ml-2 align-middle" />
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {/* TTS toggle */}
                    <button
                        id="tts-toggle"
                        onClick={tts.toggle}
                        title={tts.enabled ? 'Voice responses on' : 'Voice responses off'}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${tts.enabled
                            ? 'bg-azure-dim text-azure border border-azure/20 hover:bg-azure-dim'
                            : 'text-text-muted hover:text-text-secondary border border-transparent'
                            }`}
                    >
                        {tts.enabled
                            ? <Volume2 className="h-3.5 w-3.5" />
                            : <VolumeX className="h-3.5 w-3.5" />
                        }
                        <span>Voice</span>
                    </button>

                    {messages.length > 0 && (
                        <button
                            onClick={() => { setMessages([]); tts.stop() }}
                            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                        >
                            Clear
                        </button>
                    )}
                    <Link
                        href="/conversations"
                        className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                        History →
                    </Link>

                    {/* Code Mode toggle */}
                    <button
                        id="code-mode-toggle"
                        onClick={() => setCodeMode((v) => !v)}
                        title={codeMode ? 'Exit code mode' : 'Enter code mode'}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                            codeMode
                                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20'
                                : 'text-text-muted hover:text-text-secondary border border-transparent hover:border-border'
                        }`}
                    >
                        <CodeIcon className="h-3.5 w-3.5" />
                        <span>Code</span>
                    </button>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-4 min-h-0">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full gap-2 mx-auto w-full max-w-2xl px-4 animate-in fade-in duration-700">
                        {/* Brand mark — idle breathe at rest, working pulse while listening */}
                        <div className={`relative flex items-center justify-center transition-all duration-500 mb-2 ${
                            isListening
                                ? 'drop-shadow-[0_0_28px_rgba(99,102,241,0.6)]'
                                : 'drop-shadow-[0_0_12px_rgba(99,102,241,0.2)]'
                        }`}>
                            <PlexoMark
                                className="h-14 w-14"
                                idle={!isListening}
                                working={isListening}
                            />
                            {isListening && (
                                <div className="absolute inset-0 rounded-full border border-azure/40 animate-ping" />
                            )}
                        </div>
                        <div className="text-center mb-6">
                            <h1 className="text-2xl md:text-[28px] font-serif font-medium text-text-primary tracking-tight mb-2 text-transparent bg-clip-text bg-gradient-to-br from-zinc-100 to-zinc-400">
                                {isListening 
                                    ? 'Listening…' 
                                    : (() => {
                                        const h = new Date().getHours()
                                        const time = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
                                        return userName ? `${time}, ${userName.split(' ')[0]}` : time
                                    })()
                                }
                            </h1>
                            <p className="text-sm md:text-base text-text-muted">
                                {isListening
                                    ? 'Speak now — I\'ll send when you\'re done.'
                                    : 'What are we working on today?'
                                }
                            </p>
                        </div>
                        {!isListening && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                {[
                    { icon: Code2, label: 'Code', desc: 'Build or modify features', prompt: 'Write a React component that...' },
                    { icon: Search, label: 'Research', desc: 'Synthesize information', prompt: 'Research the latest developments in...' },
                    { icon: Server, label: 'Ops', desc: 'Infrastructure & deployment', prompt: 'Audit all production servers for...' },
                    { icon: BarChart2, label: 'Data', desc: 'Query and analyze', prompt: 'Identify all users who converted...' },
                    { icon: PenLine, label: 'Writing', desc: 'Draft and generate content', prompt: 'Write a technical blog post explaining...' },
                ].map((item) => {
                                    const Icon = item.icon
                                    return (
                                        <button
                                            key={item.label}
                                            onClick={() => { setInput(item.prompt); inputRef.current?.focus() }}
                                            className="group flex flex-col items-start gap-1.5 rounded-2xl border border-zinc-700/40 bg-surface-1/40 px-5 py-4 text-left transition-all duration-300 hover:border-azure/40 hover:bg-surface-2/60 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.2)]"
                                        >
                                            <div className="flex items-center gap-2.5 mb-0.5">
                                                <div className="rounded-lg bg-zinc-800/80 p-1.5 text-text-secondary group-hover:text-azure group-hover:bg-azure/10 transition-colors shadow-sm border border-zinc-700/50">
                                                    <Icon className="h-4 w-4" />
                                                </div>
                                                <span className="text-[13px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors tracking-wide">{item.label}</span>
                                            </div>
                                            <span className="text-[13px] text-text-muted leading-relaxed max-w-[90%]">{item.desc}</span>
                                        </button>
                                    )
                                })}
                                {/* 6th Slot - Start a Project */}
                                <Link
                                    href="/projects/new"
                                    className="group flex flex-col items-start gap-1.5 rounded-2xl border border-dashed border-zinc-700/40 bg-surface-1/20 px-5 py-4 text-left transition-all duration-300 hover:border-azure/40 hover:bg-azure/5 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.15)]"
                                >
                                    <div className="flex items-center gap-2.5 mb-0.5 w-full">
                                        <div className="rounded-lg bg-zinc-800/40 p-1.5 text-text-secondary group-hover:text-azure transition-colors border border-transparent group-hover:border-azure/20">
                                            <Plus className="h-4 w-4" />
                                        </div>
                                        <span className="text-[13px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors tracking-wide flex-1">More Options</span>
                                        <ArrowRight className="h-4 w-4 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 group-hover:translate-x-0" />
                                    </div>
                                    <span className="text-[13px] text-text-muted leading-relaxed max-w-[90%]">Start a complex project</span>
                                </Link>
                            </div>
                        )}
                        {isListening && (
                            <div className="mt-4">
                                <VoiceWaveform active={isListening} level={voice.level} />
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg) => (
                    <MessageBubble
                        key={msg.id}
                        msg={msg}
                        userInitial={userInitial}
                        onExecute={executeConfirmedAction}
                        onCancel={cancelAction}
                        onSelectCategory={(id, cat) => setMessages((prev) => prev.map((m) =>
                            m.id === id ? { ...m, selectedCategory: cat } : m
                        ))}
                    />
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Error banner */}
            {error && (
                <div className="shrink-0 flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-sm text-red mb-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {/* Voice setup prompt — shown on first click if Deepgram not configured */}
            {showVoiceSetupPrompt && !voice.deepgramConfigured && (
                <div className="shrink-0 flex items-start gap-3 mb-2 rounded-xl border border-azure/30 bg-azure-500/8 px-4 py-3">
                    <Mic className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-azure-200">Get better voice accuracy with Deepgram</p>
                        <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                            Currently using browser speech recognition. Deepgram&apos;s Nova-3 model is significantly more accurate
                            and works across all channels including Telegram. Free $200 in credits.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-0.5">
                        <Link
                            href="/settings/voice"
                            className="rounded-lg bg-azure-dim hover:bg-azure/90/30 border border-azure/20 px-3 py-1.5 text-xs font-medium text-azure transition-colors whitespace-nowrap"
                        >
                            Set up →
                        </Link>
                        <button
                            onClick={() => setShowVoiceSetupPrompt(false)}
                            className="rounded-lg p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                            aria-label="Dismiss"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            )}

            {/* Voice listening indicator above input */}
            {isListening && messages.length > 0 && (
                <div className="shrink-0 flex items-center justify-center gap-3 py-2 mb-1">
                    <VoiceWaveform active level={voice.level} />
                    <span className="text-xs text-azure font-medium animate-pulse">Listening…</span>
                    <VoiceWaveform active level={voice.level} />
                </div>
            )}

            {/* Real-time Input Ingestion Helpers */}
            {(suggestion || wantsAttachment) && !sending && !isListening && (
                <div className="shrink-0 flex flex-col gap-2 mb-3 px-2">
                    {suggestion && (
                        <div className="flex items-start gap-3 rounded-xl border border-azure/30 bg-azure-dim px-4 py-3 text-sm text-azure shadow-sm shadow-azure-500/5 transition-all">
                            <Sparkles className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                            <div className="flex-1">
                                <span className="font-semibold block text-azure-200">Suggested Model: {suggestion.suggestedModel}</span>
                                <span className="text-azure/80 text-xs mt-0.5 block">{suggestion.reason}</span>
                            </div>
                            <Link href="/settings/ai-providers" className="whitespace-nowrap rounded-lg bg-azure-dim hover:bg-azure/90/30 border border-azure/20 px-3 py-1.5 text-xs font-medium text-azure transition-colors">
                                Change model →
                            </Link>
                        </div>
                    )}
                    {wantsAttachment && (
                        <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-dim px-4 py-3 text-sm text-amber-300 shadow-sm shadow-amber-500/5 transition-all">
                            <FileUp className="h-4 w-4 shrink-0 text-amber" />
                            <span className="flex-1 text-amber/90 text-xs font-medium">
                                Did you forget an attachment? We noticed you mentioned a file or image in your prompt.
                            </span>
                            <button className="whitespace-nowrap rounded-lg bg-amber/20 hover:bg-amber/30 border border-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber transition-colors shadow-sm"
                                onClick={() => document.getElementById('file-upload-invisible')?.click()}
                            >
                                Attach file
                            </button>
                            <input type="file" id="file-upload-invisible" className="hidden" />
                        </div>
                    )}
                </div>
            )}

            {/* Input area */}
            <div className="shrink-0 flex flex-col gap-2 pt-3 border-t border-border">
                {/* Pasted file previews (images, SVG, PDF) */}
                {pastedImages.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-1">
                        {pastedImages.map((img) => (
                            <div key={img.id} className="relative group">
                                {img.kind === 'image' ? (
                                    <>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={img.dataUrl}
                                            alt={img.name}
                                            className="h-20 w-20 rounded-lg border border-border object-cover"
                                        />
                                    </>
                                ) : (
                                    <div className="h-20 w-28 rounded-lg border border-zinc-600/60 bg-surface-2/60 flex flex-col items-center justify-center gap-1 px-2">
                                        <FileText className="h-6 w-6 text-azure shrink-0" />
                                        <span className="text-[10px] text-text-muted font-bold uppercase tracking-wide">{img.kind}</span>
                                        <span className="text-[10px] text-text-secondary truncate max-w-full px-1 text-center leading-tight">{img.name}</span>
                                    </div>
                                )}
                                <button
                                    onClick={() => removeImage(img.id)}
                                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-surface-2 border border-zinc-600 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-red hover:border-red-400 transition-all opacity-0 group-hover:opacity-100"
                                    aria-label="Remove attachment"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Pasted doc pills */}
                {pastedDocs.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-1">
                        {pastedDocs.map((doc) => (
                            <div key={doc.id} className="relative group flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-xs text-text-secondary max-w-[320px]">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate leading-tight">{doc.name}</p>
                                    <p className="text-text-muted text-[10px] leading-tight">{doc.lineCount} lines · {(doc.charCount / 1000).toFixed(1)}k chars</p>
                                </div>
                                <button
                                    onClick={() => setPastedDocs((prev) => prev.filter(d => d.id !== doc.id))}
                                    className="shrink-0 h-5 w-5 rounded-full bg-zinc-700 border border-zinc-600 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-red hover:border-red-400 transition-all opacity-0 group-hover:opacity-100 ml-1"
                                    aria-label="Remove document"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Input row */}
                <div className="flex gap-2 items-end">
                    {/* Mic button */}
                    {voice.supported && (
                        <button
                            id="voice-input-btn"
                            onClick={() => isListening ? voice.stop() : void voice.start()}
                            disabled={sending}
                            title={isListening ? 'Stop recording' : 'Voice input'}
                            className={`flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-xl p-3 transition-all duration-200 ${isListening
                                ? 'bg-red/20 border border-red-500/40 text-red shadow-[0_0_16px_rgba(239,68,68,0.3)] animate-pulse'
                                : 'border border-border text-text-muted hover:text-text-secondary hover:border-zinc-500 bg-surface-1'
                                } disabled:opacity-40 disabled:cursor-not-allowed`}
                            aria-label={isListening ? 'Stop recording' : 'Start voice input'}
                        >
                            {isListening
                                ? <MicOff className="h-4 w-4" />
                                : <Mic className="h-4 w-4" />
                            }
                        </button>
                    )}

                    {/* File attach button (images, SVG, PDF) */}
                    <button
                        id="image-attach-btn"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={sending || isListening}
                        title="Attach image, SVG, or PDF"
                        className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-xl p-3 border border-border text-text-muted hover:text-text-secondary hover:border-zinc-500 bg-surface-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        aria-label="Attach file"
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

                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onDrop={handleDrop}
                        onDragOver={(e) => e.preventDefault()}
                        placeholder={isListening ? 'Listening…' : pastedImages.length > 0 ? 'Add a message or just send the image…' : pastedDocs.length > 0 ? 'Add a note or just send the document…' : 'Message your agent… (paste images, Enter to send)'}
                        rows={1}
                        disabled={sending || isListening}
                        className="flex-1 resize-none rounded-xl border border-border bg-surface-1 px-4 py-3 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none disabled:opacity-50 max-h-32 leading-relaxed transition-colors"
                        style={{ minHeight: '48px' }}
                    />

                    <button
                        id="send-btn"
                        onClick={() => void sendMessage()}
                        disabled={sending || (!input.trim() && pastedImages.length === 0 && pastedDocs.length === 0) || isListening}
                        className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-xl bg-azure p-3 text-text-primary hover:bg-azure/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        aria-label="Send"
                    >
                        {sending
                            ? <RefreshCw className="h-4 w-4 animate-spin" />
                            : <Send className="h-4 w-4" />
                        }
                    </button>
                </div>
            </div>
        </div>
    )

    if (codeMode) {
        return (
            <CodeModeShell
                workspaceId={WS_ID}
                taskId={lastRunningTaskId}
                isTaskRunning={!!lastRunningTaskId}
                context={codeModeContext}
                onRepoSelect={(sel) => {
                    setCodeModeContext({ repo: sel.repo, branch: sel.branch, isNew: sel.isNew })
                }}
                onRerunTest={(testNames) => {
                    const text = testNames.length === 1
                        ? `Re-run the failing test: ${testNames[0]}`
                        : `Re-run these failing tests: ${testNames.join(', ')}`
                    void sendMessageWith(text)
                }}
                onClose={() => setCodeMode(false)}
            >
                {chatPanel}
            </CodeModeShell>
        )
    }

    return chatPanel
}
