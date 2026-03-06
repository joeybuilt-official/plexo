'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
    Send,
    RefreshCw,
    Bot,
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
} from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { getModelCapabilities, recommendModelForInput, checkAttachmentPrompt } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
    id: string
    role: 'user' | 'agent'
    content: string
    taskId?: string
    status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending' | 'confirm_action'
    intent?: 'TASK' | 'PROJECT'
    actionDescription?: string
    // Actionable error fields
    fixUrl?: string
    fixLabel?: string
    technicalDetail?: string
    at: number
}

function fmt(ms: number): string {
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

function StatusChip({ status }: { status: Message['status'] }) {
    if (!status || status === 'complete') return null
    const map = {
        queued: { icon: Clock, cls: 'text-zinc-500', label: 'Queued' },
        running: { icon: Loader2, cls: 'text-blue-400 animate-spin', label: 'Working…' },
        pending: { icon: Loader2, cls: 'text-zinc-500 animate-spin', label: 'Waiting…' },
        failed: { icon: XCircle, cls: 'text-red-400', label: 'Failed' },
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
                    className="w-[3px] rounded-full bg-indigo-400 transition-all"
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
        const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
        fetch(`${apiBase}/api/voice/settings?workspaceId=${workspaceId}`, { signal: AbortSignal.timeout(5000) })
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
            const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
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
                    const r = await fetch(`${apiBase}/api/voice/transcribe?workspaceId=${workspaceId}`, {
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
            <div className="flex items-center justify-center py-16 text-zinc-600">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
        }>
            <ChatContent />
        </Suspense>
    )
}

function ChatContent() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [agentModel, setAgentModel] = useState<string | null>(null)
    const [showVoiceSetupPrompt, setShowVoiceSetupPrompt] = useState(false)
    const bottomRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const sessionId = useRef(`session-${Date.now()}`)
    const searchParams = useSearchParams()

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

    // Load context from ?context=<taskId> (continue conversation from Conversations page)
    useEffect(() => {
        const contextTaskId = searchParams.get('context')
        if (!contextTaskId || messages.length > 0) return
        async function loadContext() {
            try {
                const res = await fetch(`${API}/api/v1/chat/reply/${contextTaskId}`)
                if (!res.ok) return
                const data = await res.json() as { status: string; reply: string | null }
                if (data.reply) {
                    setMessages([{
                        id: `ctx-${Date.now()}`,
                        role: 'agent',
                        content: `*Previous conversation:*\n\n${data.reply}`,
                        status: 'complete',
                        at: Date.now(),
                    }])
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
                    if (status === 'complete') tts.speak(reply)
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


    async function executeConfirmedAction(msgId: string, intent: 'TASK' | 'PROJECT', description: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'queued', content: '', intent: undefined, actionDescription: undefined } : m
        ))
        try {
            const res = await fetch(`${API}/api/v1/chat/execute-action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, intent, description, sessionId: sessionId.current }),
            })
            if (!res.ok) throw new Error('Failed to execute')
            const data = await res.json() as { taskId?: string; sprintId?: string; status?: string }
            if (data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, taskId: data.taskId, status: 'running' } : m
                ))
                await pollReply(data.taskId, msgId)
            } else if (data.sprintId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'complete', content: '' } : m
                ))
                window.location.href = `/projects/${data.sprintId}`
            }
        } catch {
            setMessages((prev) => prev.map((m) =>
                m.id === msgId ? { ...m, status: 'failed', content: 'Failed to start action.', intent: undefined, actionDescription: undefined } : m
            ))
        }
    }

    function cancelAction(msgId: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'complete', content: 'Action cancelled.', intent: undefined, actionDescription: undefined } : m
        ))
    }

    async function sendMessageWith(text: string) {
        if (!text.trim() || sending) return
        if (!WS_ID) {
            setError('No workspace configured. Set NEXT_PUBLIC_DEFAULT_WORKSPACE in .env.local.')
            return
        }

        setError(null)
        setSending(true)

        const userMsg: Message = {
            id: `u-${Date.now()}`,
            role: 'user',
            content: text,
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
            const res = await fetch(`${API}/api/v1/chat/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, message: text, sessionId: sessionId.current }),
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
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        status: 'confirm_action',
                        content: 'Please confirm creation of this ' + data.intent!.toLowerCase() + ':',
                        intent: data.intent as 'TASK' | 'PROJECT',
                        actionDescription: data.description
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

            // Task queued — poll for reply
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
            setSending(false)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }

    async function sendMessage() {
        const text = input.trim()
        if (!text) return
        setInput('')
        await sendMessageWith(text)
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void sendMessage()
        }
    }

    const isListening = voice.status === 'listening' || voice.status === 'processing'

    const modelToUse = agentModel ?? 'claude-sonnet-4-5'
    const caps = getModelCapabilities(modelToUse)
    const suggestion = recommendModelForInput(input, modelToUse)
    const wantsAttachment = checkAttachmentPrompt(input)

    return (
        <div className="flex flex-col h-[calc(100vh-100px)]">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800 shrink-0">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-xl font-bold text-zinc-50">Chat</h1>
                        {agentModel && (
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono font-medium text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-full">
                                    {agentModel}
                                </span>
                                <CapabilityList caps={caps} />
                            </div>
                        )}
                    </div>
                    <p className="text-sm text-zinc-500 mt-1">Talk directly with your agent</p>
                </div>
                <div className="flex items-center gap-3">
                    {/* TTS toggle */}
                    <button
                        id="tts-toggle"
                        onClick={tts.toggle}
                        title={tts.enabled ? 'Voice responses on' : 'Voice responses off'}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${tts.enabled
                            ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20'
                            : 'text-zinc-600 hover:text-zinc-400 border border-transparent'
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
                            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                        >
                            Clear
                        </button>
                    )}
                    <Link
                        href="/conversations"
                        className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                        History →
                    </Link>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-4 min-h-0">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                        {/* Idle agent orb */}
                        <div className={`relative h-16 w-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center transition-all duration-300 ${isListening ? 'scale-110 shadow-[0_0_32px_rgba(99,102,241,0.5)]' : ''
                            }`}>
                            <Bot className="h-8 w-8 text-white" />
                            {isListening && (
                                <div className="absolute inset-0 rounded-full border-2 border-indigo-400 animate-ping opacity-40" />
                            )}
                        </div>
                        <div>
                            <p className="text-base font-semibold text-zinc-300">
                                {isListening ? 'Listening…' : 'Your agent is ready'}
                            </p>
                            <p className="text-sm text-zinc-600 mt-1">
                                {isListening
                                    ? 'Speak now — I\'ll send when you\'re done'
                                    : 'Ask anything — or tap the mic to speak'
                                }
                            </p>
                        </div>
                        {!isListening && (
                            <div className="flex flex-wrap justify-center gap-2 max-w-md">
                                {[
                                    'Summarize recent task activity',
                                    'What tools do you have?',
                                    'Review my last failed task',
                                    'What is in my memory store?',
                                ].map((suggestion) => (
                                    <button
                                        key={suggestion}
                                        onClick={() => { setInput(suggestion); inputRef.current?.focus() }}
                                        className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-indigo-500/50 hover:text-zinc-200 transition-colors"
                                    >
                                        {suggestion}
                                    </button>
                                ))}
                            </div>
                        )}
                        {isListening && (
                            <div className="mt-2">
                                <VoiceWaveform active={isListening} level={voice.level} />
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                    >
                        {/* Avatar */}
                        <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                            ? 'bg-zinc-700'
                            : 'bg-gradient-to-br from-indigo-500 to-purple-600'
                            }`}>
                            {msg.role === 'user'
                                ? <User className="h-4 w-4 text-zinc-300" />
                                : <Bot className="h-4 w-4 text-white" />
                            }
                        </div>

                        {/* Bubble */}
                        <div className={`flex flex-col gap-1 max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === 'user'
                                ? 'bg-indigo-600 text-white rounded-tr-md'
                                : msg.status === 'failed'
                                    ? 'bg-red-950/30 border border-red-800/40 text-red-300 rounded-tl-md'
                                    : 'bg-zinc-800 text-zinc-200 rounded-tl-md'
                                }`}>
                                {msg.status === 'queued' ? (
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                                        <span className="text-zinc-500 text-sm italic">Queued…</span>
                                    </div>
                                ) : msg.status === 'running' ? (
                                    <div className="flex items-start gap-2">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0 mt-0.5" />
                                        <span className="text-zinc-400 text-sm italic">
                                            {msg.content || 'Working…'}
                                        </span>
                                    </div>

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
                                            <details className="group mt-0.5">
                                                <summary className="text-[10px] text-red-400/50 cursor-pointer hover:text-red-400/70 list-none flex items-center gap-1">
                                                    <span className="group-open:hidden">▸ Technical details</span>
                                                    <span className="hidden group-open:inline">▾ Technical details</span>
                                                </summary>
                                                <code className="block mt-1.5 text-[10px] text-red-400/50 font-mono break-all leading-relaxed bg-red-950/30 rounded p-2">
                                                    {msg.technicalDetail}
                                                </code>
                                            </details>
                                        )}
                                    </div>
                                ) : msg.status === 'confirm_action' && msg.intent ? (
                                    <div className="flex flex-col gap-2">
                                        <span className="font-semibold text-zinc-100">{msg.content}</span>
                                        <span className="text-sm text-zinc-300 italic">&quot;{msg.actionDescription}&quot;</span>
                                        <div className="flex items-center gap-2 mt-2">
                                            <button
                                                onClick={() => executeConfirmedAction(msg.id, msg.intent!, msg.actionDescription!)}
                                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                                            >
                                                Confirm {msg.intent === 'TASK' ? 'Task' : 'Project'}
                                            </button>
                                            <button
                                                onClick={() => cancelAction(msg.id)}
                                                className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-600 transition-colors"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (

                                    <span className="whitespace-pre-wrap">{msg.content}</span>
                                )}
                            </div>

                            {/* Meta */}
                            <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                                <span>{fmt(msg.at)}</span>
                                {msg.taskId && (
                                    <Link
                                        href={`/tasks/${msg.taskId}`}
                                        className="hover:text-zinc-400 transition-colors font-mono"
                                    >
                                        {msg.taskId.slice(0, 8)} ↗
                                    </Link>
                                )}
                                {msg.status === 'complete' && (
                                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Error banner */}
            {error && (
                <div className="shrink-0 flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-sm text-red-400 mb-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {/* Voice setup prompt — shown on first click if Deepgram not configured */}
            {showVoiceSetupPrompt && !voice.deepgramConfigured && (
                <div className="shrink-0 flex items-start gap-3 mb-2 rounded-xl border border-indigo-500/30 bg-indigo-500/8 px-4 py-3">
                    <Mic className="h-4 w-4 shrink-0 mt-0.5 text-indigo-400" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-indigo-200">Get better voice accuracy with Deepgram</p>
                        <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                            Currently using browser speech recognition. Deepgram&apos;s Nova-3 model is significantly more accurate
                            and works across all channels including Telegram. Free $200 in credits.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-0.5">
                        <Link
                            href="/settings/voice"
                            className="rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/20 px-3 py-1.5 text-xs font-medium text-indigo-300 transition-colors whitespace-nowrap"
                        >
                            Set up →
                        </Link>
                        <button
                            onClick={() => setShowVoiceSetupPrompt(false)}
                            className="rounded-lg p-1.5 text-zinc-600 hover:text-zinc-400 transition-colors"
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
                    <span className="text-xs text-indigo-400 font-medium animate-pulse">Listening…</span>
                    <VoiceWaveform active level={voice.level} />
                </div>
            )}

            {/* Real-time Input Ingestion Helpers */}
            {(suggestion || wantsAttachment) && !sending && !isListening && (
                <div className="shrink-0 flex flex-col gap-2 mb-3 px-2">
                    {suggestion && (
                        <div className="flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-300 shadow-sm shadow-indigo-500/5 transition-all">
                            <Sparkles className="h-4 w-4 shrink-0 mt-0.5 text-indigo-400" />
                            <div className="flex-1">
                                <span className="font-semibold block text-indigo-200">Suggested Model: {suggestion.suggestedModel}</span>
                                <span className="text-indigo-400/80 text-xs mt-0.5 block">{suggestion.reason}</span>
                            </div>
                            <Link href="/settings/ai-providers" className="whitespace-nowrap rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/20 px-3 py-1.5 text-xs font-medium text-indigo-300 transition-colors">
                                Change model →
                            </Link>
                        </div>
                    )}
                    {wantsAttachment && (
                        <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 shadow-sm shadow-amber-500/5 transition-all">
                            <FileUp className="h-4 w-4 shrink-0 text-amber-400" />
                            <span className="flex-1 text-amber-500/90 text-xs font-medium">
                                Did you forget an attachment? We noticed you mentioned a file or image in your prompt.
                            </span>
                            <button className="whitespace-nowrap rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors shadow-sm"
                                onClick={() => document.getElementById('file-upload-invisible')?.click()}
                            >
                                Attach file
                            </button>
                            <input type="file" id="file-upload-invisible" className="hidden" />
                        </div>
                    )}
                </div>
            )}

            {/* Input row */}
            <div className="shrink-0 flex gap-2 items-end pt-3 border-t border-zinc-800">
                {/* Mic button */}
                {voice.supported && (
                    <button
                        id="voice-input-btn"
                        onClick={() => isListening ? voice.stop() : void voice.start()}
                        disabled={sending}
                        title={isListening ? 'Stop recording' : 'Voice input'}
                        className={`shrink-0 rounded-xl p-3 transition-all duration-200 ${isListening
                            ? 'bg-red-500/20 border border-red-500/40 text-red-400 shadow-[0_0_16px_rgba(239,68,68,0.3)] animate-pulse'
                            : 'border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 bg-zinc-900'
                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                        aria-label={isListening ? 'Stop recording' : 'Start voice input'}
                    >
                        {isListening
                            ? <MicOff className="h-4 w-4" />
                            : <Mic className="h-4 w-4" />
                        }
                    </button>
                )}

                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? 'Listening…' : 'Message your agent… (Enter to send, Shift+Enter for newline)'}
                    rows={1}
                    disabled={sending || isListening}
                    className="flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50 max-h-32 leading-relaxed transition-colors"
                    style={{ minHeight: '48px' }}
                />

                <button
                    id="send-btn"
                    onClick={() => void sendMessage()}
                    disabled={sending || !input.trim() || isListening}
                    className="shrink-0 rounded-xl bg-indigo-600 p-3 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Send"
                >
                    {sending
                        ? <RefreshCw className="h-4 w-4 animate-spin" />
                        : <Send className="h-4 w-4" />
                    }
                </button>
            </div>
        </div>
    )
}
