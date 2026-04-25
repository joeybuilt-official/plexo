// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { toast } from 'sonner'
import { useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'
import {
    AlertCircle, Sparkles, FileUp, Layout,
} from 'lucide-react'
import type { WorkbenchContext } from '@web/components/workbench/artifact-workbench'
import Link from 'next/link'
import { useWorkspace, useWorkspaceId } from '@web/context/workspace'
import { getModelCapabilities, recommendModelForInput, checkAttachmentPrompt, modelSupportsVision } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'
import { PlexoMark } from '@web/components/plexo-logo'
import { extractPdfText } from '@web/lib/pdf-extract'
import { CopyId } from '@web/components/copy-id'


import { type PastedImage, type PastedDocument, kindFromMime } from '@web/lib/attachments'
import { useSpeechInput } from '@web/hooks/use-speech-input'
import { VoiceWaveform } from '@web/components/voice-waveform'

import type { Message, TaskAsset } from './_components/types'
import { MessageBubble } from './_components/message-bubble'
import { normalizeEvents, type RawProgressEvent } from './_components/agent-thinking-panel'
import { Composer } from './_components/composer'
import { useTTS } from './_hooks/use-tts'

// Heavy workbench — lazy loaded, not on initial bundle. SSR disabled as the
// workbench is interactive-only and desktop-biased.
const ArtifactWorkbench = dynamicImport(
    () => import('@web/components/workbench/artifact-workbench').then(m => ({ default: m.ArtifactWorkbench })),
    { ssr: false, loading: () => null },
)

// Floating artifact preview — also lazy.
const ArtifactPanel = dynamicImport(
    () => import('@web/components/artifact-panel').then(m => ({ default: m.ArtifactPanel })),
    { ssr: false, loading: () => null },
)

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const LARGE_TEXT_THRESHOLD = 1000

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
    const { userName } = useWorkspace()
    const WS_ID = useWorkspaceId()
    const userInitial = userName ? userName.trim().charAt(0).toUpperCase() : ''
    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState('')
    const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
    const [pastedDocs, setPastedDocs] = useState<PastedDocument[]>([])
    const [sending, setSending] = useState(false)
    const [historyLoading, setHistoryLoading] = useState(false)
    const [historyError, setHistoryError] = useState(false)

    const [error, setError] = useState<string | null>(null)
    const [agentModel, setAgentModel] = useState<string | null>(null)
    const [, setShowVoiceSetupPrompt] = useState(false)
    const searchParams = useSearchParams()
    const [isLiveMode, setIsLiveMode] = useState(searchParams.get('live') === '1')
    const bottomRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const sessionId = useRef<string>(null as unknown as string)
    // Track whether the very first message of this page instance was sent
    // into a brand-new session — used to tell the API to bypass the
    // universal session resolver for that first turn.
    const hasSentFirstMessageRef = useRef(false)
    const startedAsNewRef = useRef(false)
    const sseRetryCountRef = useRef(0)
    if (!sessionId.current) {
        if (typeof window === 'undefined') {
            sessionId.current = `session-${Date.now()}`
        } else {
            const STORAGE_KEY = 'plexo-chat-session'
            const params = new URLSearchParams(window.location.search)
            const fromUrl = params.get('sessionId')
            const isNewChat = params.has('new')
            // Precedence order (fixes the "QuickSend hydrates unrelated chat"
            // bug): new=1 + URL sessionId → explicit fresh session; URL
            // sessionId alone → load that specific session; otherwise fall
            // back to persisted stored id.
            if (isNewChat) {
                const fresh = fromUrl || `session-${Date.now()}`
                localStorage.setItem(STORAGE_KEY, fresh)
                sessionId.current = fresh
                startedAsNewRef.current = true
            } else if (fromUrl) {
                localStorage.setItem(STORAGE_KEY, fromUrl)
                sessionId.current = fromUrl
            } else {
                const stored = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY)
                if (stored) {
                    localStorage.setItem(STORAGE_KEY, stored)
                    sessionId.current = stored
                } else {
                    const fresh = `session-${Date.now()}`
                    localStorage.setItem(STORAGE_KEY, fresh)
                    sessionId.current = fresh
                }
            }
        }
    }
    const [isDraggingOver, setIsDraggingOver] = useState(false)
    const dragCounterRef = useRef(0)
    const taskIdAttached = useRef(false)

    const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(searchParams.get('mode') === 'code')
    const [isPinned, setIsPinned] = useState(true)
    const [workbenchContext, setWorkbenchContext] = useState<WorkbenchContext>({})
    const [previewPath, setPreviewPath] = useState('index.html')
    const [activeTab, setActiveTab] = useState<'terminal' | 'tests' | 'diff' | 'preview' | 'browser'>('terminal')
    const [showBottom, setShowBottom] = useState(true)

    const lastRunningTaskId = messages.find((m) => m.status === 'running')?.taskId
    const [openArtifactData, setOpenArtifactData] = useState<{ asset: TaskAsset, taskId: string } | null>(null)

    useEffect(() => {
        if (!searchParams.has('new')) return
        // Honour the URL-provided sessionId when the caller pre-minted one
        // (QuickSend does this). Otherwise fall back to a fresh local id.
        const fromUrl = searchParams.get('sessionId')
        const fresh = fromUrl || `session-${Date.now()}`
        localStorage.setItem('plexo-chat-session', fresh)
        sessionId.current = fresh
        startedAsNewRef.current = true
        hasSentFirstMessageRef.current = false
        setMessages([])
    }, [searchParams.get('new'), searchParams.get('sessionId')])  // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const mode = searchParams.get('mode')
        if (mode === 'code') setIsWorkbenchOpen(true)
    }, [searchParams])

    useEffect(() => {
        if (!WS_ID) return
        void fetch(`${API}/api/v1/agent/status`)
            .then(res => res.json())
            .then(data => setAgentModel((data as { currentModel?: string | null }).currentModel || null))
            .catch((err) => { console.error('[chat] agent status fetch failed', err) })
    }, [WS_ID])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    useEffect(() => {
        if (!WS_ID || messages.length > 0) return
        const contextId = searchParams.get('context')
        const sessionIdParam = searchParams.get('sessionId')
        if (contextId || sessionIdParam) return
        // If this page was opened with ?new=1 (QuickSend / explicit fresh
        // chat), never hydrate stored history — the whole point of new=1
        // is to guarantee a blank slate.
        if (searchParams.has('new')) return
        // If we were handed a taskId but no explicit sessionId, this is a
        // drive-by navigation (e.g. "View task" link) that must not merge
        // into an unrelated prior session.
        if (searchParams.get('taskId')) return
        const stored = localStorage.getItem('plexo-chat-session') ?? sessionStorage.getItem('plexo-chat-session')
        if (!stored) return

        async function loadPersistedSession(retries = 2) {
            setHistoryLoading(true)
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const res = await fetch(
                        `${API}/api/v1/conversations?workspaceId=${encodeURIComponent(WS_ID!)}&sessionId=${encodeURIComponent(stored!)}&limit=100`
                    )
                    if (!res.ok) {
                        if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
                        setHistoryLoading(false)
                        setHistoryError(true)
                        return
                    }
                    const data = await res.json() as { items: Array<{ id: string; message: string; reply: string | null; errorMsg: string | null; status: string; intent: string | null; taskId: string | null }> }
                    const turns = data.items ?? []
                    if (turns.length === 0) { setHistoryLoading(false); return }
                    const loaded: Message[] = []
                    for (const turn of turns) {
                        loaded.push({ id: `ctx-user-${turn.id}`, role: 'user', content: turn.message, status: 'complete', at: Date.now() })
                        const body = turn.reply ?? turn.errorMsg ?? null
                        if (body) {
                            loaded.push({ id: `ctx-agent-${turn.id}`, role: 'agent', content: body, status: turn.status === 'failed' ? 'failed' : 'complete', taskId: turn.taskId ?? undefined, at: Date.now() + 1 })
                        }
                    }
                    if (loaded.length > 0) setMessages(loaded)
                    setHistoryLoading(false)
                    // Backfill assets for every historical agent bubble with
                    // a taskId. This is the primary fix for the disappearing
                    // chip regression on reload / revisit.
                    const agentMsgsWithTasks = loaded.filter(
                        m => m.role === 'agent' && m.taskId &&
                            (m.status === 'complete' || m.status === 'failed' || m.status === 'pending')
                    )
                    void Promise.all(
                        agentMsgsWithTasks.slice(0, 20).map(m => hydrateAssets(m.id, m.taskId!))
                    )
                    return
                } catch {
                    if (attempt < retries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue }
                }
            }
            setHistoryLoading(false)
            setHistoryError(true)
        }
        void loadPersistedSession()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        const contextId = searchParams.get('context')
        const sessionIdParam = searchParams.get('sessionId')
        if (!contextId && !sessionIdParam) return
        if (messages.length > 0) return
        // QuickSend prefill handoff owns the initial paint — skip the
        // context loader so we don't race against it and overwrite the
        // seeded bubbles with a stale empty history fetch.
        if (searchParams.get('prefill') === '1') return

        async function loadContext() {
            try {
                if (sessionIdParam && WS_ID) {
                    const res = await fetch(
                        `${API}/api/v1/conversations?workspaceId=${encodeURIComponent(WS_ID)}&sessionId=${encodeURIComponent(sessionIdParam)}&limit=100`
                    )
                    if (!res.ok) return
                    const data = await res.json() as { items: Array<{ id: string; message: string; reply: string | null; errorMsg: string | null; status: string; intent: string | null; taskId: string | null }> }
                    const turns = data.items ?? []
                    const loaded: Message[] = []
                    for (const turn of turns) {
                        const attachments = (turn as Record<string, unknown>).attachments as Array<{ type: string; url: string; alt?: string }> | null
                        // User uploads live on the conversations row. These
                        // belong on the user bubble only — NOT on the agent
                        // bubble. The agent's produced works are loaded
                        // separately via hydrateAssets below.
                        const turnImages: PastedImage[] | undefined = attachments?.filter(a => a.type === 'image').map(a => ({
                            id: a.url, dataUrl: a.url, kind: 'image' as const, name: a.alt || 'Image', mimeType: 'image/png',
                        }))

                        loaded.push({
                            id: `ctx-user-${turn.id}`, role: 'user', content: turn.message,
                            images: turn.reply ? undefined : turnImages,
                            status: 'complete', at: Date.now(),
                        })
                        const body = turn.reply ?? turn.errorMsg ?? null
                        if (body) {
                            loaded.push({
                                id: `ctx-agent-${turn.id}`, role: 'agent', content: body,
                                status: (turn.status === 'failed' && turn.errorMsg) ? 'failed' : 'complete',
                                taskId: turn.taskId ?? undefined,
                                at: Date.now() + 1,
                            })
                        }
                    }
                    if (loaded.length > 0) setMessages(loaded)
                    sessionId.current = sessionIdParam
                    sessionStorage.setItem('plexo-chat-session', sessionIdParam)
                    // Backfill agent-bubble works from the tasks assets
                    // endpoint (the right source), capped to avoid a
                    // thundering herd on long histories.
                    const agentMsgsWithTasks = loaded.filter(
                        m => m.role === 'agent' && m.taskId &&
                            (m.status === 'complete' || m.status === 'failed' || m.status === 'pending')
                    )
                    void Promise.all(
                        agentMsgsWithTasks.slice(0, 20).map(m => hydrateAssets(m.id, m.taskId!))
                    )
                    return
                }

                if (contextId) {
                    const res = await fetch(`${API}/api/v1/conversations/${contextId}`)
                    if (!res.ok) return
                    const data = await res.json() as {
                        id: string; message: string; reply: string | null; sessionId: string | null; status: string
                    }
                    const loaded: Message[] = []
                    if (data.message) {
                        loaded.push({
                            id: `ctx-user-${Date.now()}`, role: 'user', content: data.message,
                            status: 'complete', at: Date.now() - 1,
                        })
                    }
                    if (data.reply) {
                        loaded.push({
                            id: `ctx-agent-${Date.now()}`, role: 'agent', content: data.reply,
                            status: 'complete', at: Date.now(),
                        })
                    }
                    if (loaded.length > 0) setMessages(loaded)
                    if (data.sessionId) {
                        sessionId.current = data.sessionId
                        sessionStorage.setItem('plexo-chat-session', data.sessionId)
                    }
                }
            } catch { /* conversation context is optional; proceed without it */ }
        }
        void loadContext()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Stable ref so voice/TTS callbacks always call the latest sendMessageWith
    // without needing it in their dependency arrays.
    const sendMessageRef = useRef<(text: string) => Promise<void>>(null as unknown as (text: string) => Promise<void>)

    const tts = useTTS({
        enabled: isLiveMode,
        onEnd: () => {
            if (isLiveMode) {
                void voice.start()
            }
        }
    })

    const handleVoiceResult = useCallback((text: string) => {
        setInput(text)
        setTimeout(() => {
            setInput('')
            void sendMessageRef.current?.(text)
        }, 300)
    }, [])

    const voice = useSpeechInput({
        workspaceId: WS_ID,
        onResult: handleVoiceResult,
        onSetupNeeded: () => setShowVoiceSetupPrompt(true),
    })
    const isListening = voice.status === 'listening' || voice.status === 'processing'

    useEffect(() => {
        if (isLiveMode && !sending && !isListening && !tts.speaking) {
            const timer = setTimeout(() => {
                if (isLiveMode && !sending && !isListening && !tts.speaking) {
                    void voice.start()
                }
            }, 500)
            return () => clearTimeout(timer)
        }
    }, [isLiveMode, sending, isListening, tts.speaking, voice])

    // Single source of truth for populating `msg.assets` from the tasks
    // assets endpoint. Every path that produces an agent message with a
    // taskId (SSE terminal, inline-complete, history loaders, confirm-action)
    // should call this. Idempotent; silent on failure so it never blocks the
    // UI. Invariant: given (msgId, taskId) where taskId is set and the task
    // has reached a terminal state, `msg.assets` will reflect the current
    // `/tasks/:id/assets` payload after this resolves.
    const hydrateAssets = useCallback(async (msgId: string, taskId: string | undefined | null) => {
        if (!taskId) return
        try {
            const r = await fetch(`${API}/api/v1/tasks/${taskId}/assets`)
            if (!r.ok) return
            const data = await r.json() as { items?: TaskAsset[] }
            if (!data.items || data.items.length === 0) return
            setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, assets: data.items } : m
            ))
        } catch { /* swallow — chip stays absent, same as prior behaviour */ }
    }, [])

    const pollReply = useCallback(async (taskId: string, msgId: string): Promise<void> => {
        return new Promise((resolve) => {
            const url = `${API}/api/v1/chat/reply-stream/${taskId}`
            const es = new EventSource(url)

            let closed = false
            let stuckTimer: ReturnType<typeof setTimeout> | null = null
            const cleanup = () => { closed = true; if (stuckTimer) clearTimeout(stuckTimer); es.close() }

            es.addEventListener('tick', (ev) => {
                try {
                    const d = JSON.parse(ev.data) as {
                        status: string; elapsed: number; stepCount: number; lastAction: string | null
                        phases?: Array<{ index: number; total: number; label: string; status: 'pending' | 'running' | 'complete' }>
                        currentPhase?: string
                        progressEvents?: RawProgressEvent[]
                    }

                    const normalized = normalizeEvents(d.progressEvents)

                    setMessages((prev) => prev.map((m) => {
                        if (m.id !== msgId) return m
                        const lastStep = m.steps?.[m.steps.length - 1]
                        let nextSteps = m.steps || []
                        if (d.lastAction && lastStep?.label !== d.lastAction) {
                            nextSteps = [
                                ...nextSteps.map(s => ({ ...s, status: 'complete' as const })),
                                { id: `step-${Date.now()}`, label: d.lastAction, status: 'running' as const }
                            ]
                        }
                        return {
                            ...m, status: 'running', content: d.status, steps: nextSteps,
                            phases: d.phases ?? m.phases, currentPhase: d.currentPhase ?? m.currentPhase,
                            progressEvents: normalized.length > 0 ? normalized : m.progressEvents,
                        }
                    }))
                } catch { /* ignore parse errors */ }
            })

            const onTerminal = (e: MessageEvent, status: 'complete' | 'failed') => {
                try {
                    const d = JSON.parse(e.data) as { reply?: string }
                    const reply = d.reply ?? (status === 'complete' ? 'Done.' : 'Something went wrong.')
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status, content: reply } : m
                    ))
                    if (status === 'complete') {
                        tts.speak(reply)
                        void hydrateAssets(msgId, taskId)
                    }
                } catch { /* ignore */ }
                cleanup()
                resolve()
            }

            es.addEventListener('complete', (e) => onTerminal(e, 'complete'))
            es.addEventListener('failed', (e) => onTerminal(e, 'failed'))
            es.addEventListener('blocked', (e) => onTerminal(e, 'failed'))
            es.addEventListener('cancelled', (e) => onTerminal(e, 'failed'))
            es.addEventListener('timeout', (e) => onTerminal(e, 'failed'))

            stuckTimer = setTimeout(async () => {
                if (closed) return
                try {
                    const r = await fetch(`${API}/api/v1/tasks/${taskId}`)
                    if (r.ok) {
                        const task = await r.json() as { status?: string; outcomeSummary?: string }
                        if (task.status === 'complete' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') {
                            const s = task.status === 'complete' ? 'complete' as const : 'failed' as const
                            setMessages((prev) => prev.map((m) =>
                                m.id === msgId ? { ...m, status: s, content: task.outcomeSummary ?? (s === 'complete' ? 'Done.' : 'Something went wrong.') } : m
                            ))
                            cleanup(); resolve(); return
                        }
                    }
                } catch { /* non-fatal */ }
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId && m.status === 'running'
                        ? { ...m, content: 'Task may be stuck \u2014 check Tasks page for status.' }
                        : m
                ))
            }, 5 * 60 * 1000)

            es.onerror = () => {
                if (sseRetryCountRef.current < 1) {
                    sseRetryCountRef.current++
                    cleanup()
                    setTimeout(() => { void pollReply(taskId, msgId).then(resolve) }, 2000)
                    return
                }
                sseRetryCountRef.current = 0
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'pending', content: 'Lost connection. Check the Tasks page for status.' } : m
                ))
                cleanup(); resolve()
            }
        })
    }, [tts, hydrateAssets])

    const taskIdParam = searchParams.get('taskId')
    const modeParam = searchParams.get('mode')
    const prefillParam = searchParams.get('prefill')

    // Read the user's message from sessionStorage (stashed by quick-send)
    // instead of the URL to keep URLs short.
    const messageParam = (() => {
        const sid = searchParams.get('sessionId')
        if (!sid) return searchParams.get('message') // legacy fallback
        try {
            const stored = sessionStorage.getItem(`plexo-quicksend-message:${sid}`)
            if (stored) { sessionStorage.removeItem(`plexo-quicksend-message:${sid}`); return stored }
        } catch { /* sessionStorage unavailable */ }
        return searchParams.get('message') // legacy fallback
    })()

    // QuickSend fastpath handoff: when ?prefill=1 is present alongside a
    // sessionId, the composer has already POSTed to /api/v1/chat/message
    // and stashed the reply in sessionStorage. We just seed both bubbles
    // and skip the executor entirely. No taskId → no polling.
    //
    // NOTE: If the server escalated to a task, quick-send now redirects
    // via the task path (?taskId=...) instead of prefill, so data.taskId
    // should always be null here. The guard below is purely defensive.
    const prefillSeededRef = useRef(false)
    useEffect(() => {
        if (prefillParam !== '1' || prefillSeededRef.current) return
        const sid = searchParams.get('sessionId')
        if (!sid) return
        prefillSeededRef.current = true
        try {
            const raw = sessionStorage.getItem(`plexo-quicksend-prefill:${sid}`)
            if (!raw) return
            sessionStorage.removeItem(`plexo-quicksend-prefill:${sid}`)
            const data = JSON.parse(raw) as {
                message?: string
                reply?: string
                model?: string | null
                taskId?: string | null
                at?: number
            }
            if (!data?.message) return

            // Defensive: if a taskId leaked into prefill data, hand off to
            // the taskId effect instead of showing a dead "complete" bubble.
            if (data.taskId) {
                try { sessionStorage.setItem(`plexo-quicksend-message:${sid}`, data.message) } catch { /* */ }
                const url = new URL(window.location.href)
                url.searchParams.set('taskId', data.taskId)
                url.searchParams.delete('prefill')
                window.history.replaceState(null, '', url.toString())
                // The taskId effect will pick this up on the next render
                // cycle triggered by the URL change — but since we're using
                // searchParams from useSearchParams() (immutable snapshot),
                // we need to reload the component.  Safest: just navigate.
                window.location.replace(url.toString())
                return
            }

            const base = data.at ?? Date.now()
            const seeded: Message[] = [
                { id: `u-${base}`, role: 'user', content: data.message, status: 'complete', at: base },
            ]
            if (data.reply) {
                seeded.push({
                    id: `a-${base + 1}`,
                    role: 'agent',
                    content: data.reply,
                    status: 'complete',
                    model: data.model ?? undefined,
                    at: base + 1,
                })
            }
            setMessages(seeded)
            if (data.reply) tts.speak(data.reply)
        } catch { /* sessionStorage unavailable or parse error; show blank */ }
    }, [prefillParam, searchParams, tts])
    useEffect(() => {
        if (!taskIdParam || taskIdAttached.current) return
        taskIdAttached.current = true
        if (modeParam === 'code') setIsWorkbenchOpen(true)
        const now = Date.now()
        const agentMsgId = `a-${now}`
        const initial = messageParam
            ? [
                { id: `u-${now}`, role: 'user' as const, content: messageParam, status: 'complete' as const, at: now },
                { id: agentMsgId, role: 'agent' as const, content: '', status: 'running' as const, taskId: taskIdParam, at: now + 1 },
              ]
            : [{ id: agentMsgId, role: 'agent' as const, content: '', status: 'running' as const, taskId: taskIdParam, at: now }]
        setMessages(initial)
        setSending(true)
        void pollReply(taskIdParam, agentMsgId).finally(() => setSending(false))
    }, [taskIdParam, modeParam, messageParam, pollReply])

    async function executeConfirmedAction(msgId: string, intent: 'TASK' | 'PROJECT' | 'CONVERSATION', description: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'queued', content: '', intent: undefined, actionDescription: undefined } : m
        ))
        try {
            if (intent === 'CONVERSATION') {
                const res = await fetch(`${API}/api/v1/chat/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId: WS_ID, message: description, sessionId: sessionId.current, forceConversation: true }),
                })
                const data = await res.json() as { reply?: string; status?: string; model?: string; taskId?: string }
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? {
                        ...m,
                        status: 'complete',
                        content: data.reply ?? 'Here\'s what I know about that:',
                        taskId: data.taskId ?? m.taskId,
                        model: data.model,
                    } : m
                ))
                if (data.taskId) void hydrateAssets(msgId, data.taskId)
                return
            }

            const res = await fetch(`${API}/api/v1/chat/execute-action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, intent, description, sessionId: sessionId.current }),
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
                void pollReply(data.taskId, msgId)
            } else if (data.sprintId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? {
                        ...m, status: 'complete',
                        content: `Project created and running. Track progress →`,
                        fixUrl: `/app/projects/${data.sprintId}`,
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
        const imgs = extractImagesFromDataTransfer(e.clipboardData)
        if (imgs.length > 0) {
            e.preventDefault()
            void Promise.all(
                imgs.map((img) =>
                    fetch(img.dataUrl).then((r) => r.blob()).then(
                        (blob) => new Promise<PastedImage>((resolve) => {
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
            ).then((resolved) => { setPastedImages((prev) => [...prev, ...resolved]) })
                .catch((err) => { console.error('[chat] image paste failed', err) })
            return
        }

        const text = e.clipboardData.getData('text/plain')
        if (text.length >= LARGE_TEXT_THRESHOLD) {
            e.preventDefault()
            const lines = text.split('\n')
            const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const firstLine = lines.find(l => l.trim().length > 0)?.trim().slice(0, 60) ?? 'Pasted text'
            const name = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
            const doc: PastedDocument = { id, name, content: text, lineCount: lines.length, charCount: text.length }
            setPastedDocs((prev) => [...prev, doc])
        }
    }

    function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
        e.preventDefault()
    }

    async function processDroppedDataTransfer(dt: DataTransfer): Promise<void> {
        const imgs = extractImagesFromDataTransfer(dt)
        if (imgs.length === 0) return
        const resolved = await Promise.all(
            imgs.map((img) =>
                fetch(img.dataUrl).then((r) => r.blob()).then(
                    (blob) => new Promise<PastedImage>((resolve) => {
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
        void processDroppedDataTransfer(e.dataTransfer).catch((err) => { console.error('[chat] drop failed', err) })
    }

    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? [])
        const imgs: Promise<PastedImage>[] = files
            .filter((f) => kindFromMime(f.type) !== null)
            .map(
                (file) => new Promise<PastedImage>((resolve) => {
                    const reader = new FileReader()
                    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
                    const kind = kindFromMime(file.type)!
                    reader.onload = () => {
                        const dataUrl = reader.result as string
                        if (kind === 'pdf') {
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
        }).catch((err) => { console.error('[chat] file input failed', err) })
        e.target.value = ''
    }

    function removeImage(id: string) {
        setPastedImages((prev) => prev.filter((img) => img.id !== id))
    }

    async function sendMessageWith(text: string, images?: PastedImage[], docs?: PastedDocument[]) {
        if (!text.trim() && (!images || images.length === 0) && (!docs || docs.length === 0)) return
        if (sending) {
            toast.info('Please wait — processing your previous message')
            return
        }
        if (!WS_ID) {
            setError('No workspace configured. Set NEXT_PUBLIC_DEFAULT_WORKSPACE in .env.local.')
            return
        }

        setError(null)
        setSending(true)

        let effectiveText = text
        if (docs && docs.length > 0) {
            const docBlock = docs.map(d =>
                `--- ${d.name} (${d.lineCount} lines) ---\n${d.content}\n---`
            ).join('\n\n')
            effectiveText = text ? `${text}\n\n${docBlock}` : docBlock
        }

        const userMsg: Message = {
            id: `u-${Date.now()}`, role: 'user',
            content: text || (docs && docs.length > 0 ? `📄 ${docs.map(d => d.name).join(', ')}` : ''),
            images: images && images.length > 0 ? images : undefined,
            docs: docs && docs.length > 0 ? docs : undefined,
            at: Date.now(),
        }

        const pendingId = `a-${Date.now()}`
        const pendingMsg: Message = {
            id: pendingId, role: 'agent', content: '', status: 'queued', at: Date.now(),
        }

        setMessages((prev) => [...prev, userMsg, pendingMsg])

        try {
            const rasterImages = images?.filter(f => f.kind === 'image') ?? []
            const svgDocs = images?.filter(f => f.kind === 'svg') ?? []
            const pdfDocs = images?.filter(f => f.kind === 'pdf') ?? []

            let textWithAttachments = effectiveText

            if (svgDocs.length > 0) {
                const svgBlocks = await Promise.all(
                    svgDocs.map(async (f) => {
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

            // The first message sent from a page that was opened with ?new=1
            // should bypass the universal session resolver on the server so
            // we never silently merge into an unrelated prior thread.
            const isFirstNewSessionSend = startedAsNewRef.current && !hasSentFirstMessageRef.current
            const res = await fetch(`${API}/api/v1/chat/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream, application/json',
                },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    message: textWithAttachments,
                    sessionId: sessionId.current,
                    ...(isFirstNewSessionSend ? { newSession: true } : {}),
                    ...(isWorkbenchOpen && workbenchContext.repo ? {
                        repo: workbenchContext.repo,
                        branch: workbenchContext.branch,
                    } : {}),
                    images: rasterImages.length > 0
                        ? rasterImages.map((img) => ({ data: img.dataUrl, mimeType: img.mimeType, name: img.name }))
                        : undefined,
                }),
            })
            hasSentFirstMessageRef.current = true

            if (!res.ok) {
                const err = await res.json() as { error?: { message?: string } }
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, status: 'failed', content: err.error?.message ?? 'Failed to send.' } : m
                ))
                return
            }

            // ── SSE streaming path ──────────────────────────────────────────
            const contentType = res.headers.get('content-type') ?? ''
            if (contentType.includes('text/event-stream')) {
                const reader = res.body!.getReader()
                const decoder = new TextDecoder()
                let sseBuffer = ''
                let fullText = ''
                let streamModel: string | undefined

                // Mark as running so the user sees incremental text
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, status: 'running', content: '' } : m
                ))

                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break
                        sseBuffer += decoder.decode(value, { stream: true })

                        // SSE events are separated by \n\n
                        const parts = sseBuffer.split('\n\n')
                        sseBuffer = parts.pop() ?? ''

                        for (const part of parts) {
                            const line = part.trim()
                            if (!line.startsWith('data: ')) continue
                            try {
                                const ev = JSON.parse(line.slice(6)) as {
                                    chunk?: string; done?: boolean; model?: string
                                    error?: string; fixUrl?: string; fixLabel?: string
                                    visionDegraded?: boolean
                                }

                                if (ev.error) {
                                    setMessages((prev) => prev.map((m) =>
                                        m.id === pendingId ? {
                                            ...m, status: 'failed',
                                            content: ev.error!,
                                            fixUrl: ev.fixUrl, fixLabel: ev.fixLabel,
                                        } : m
                                    ))
                                    return
                                }

                                if (ev.chunk) {
                                    fullText += ev.chunk
                                    setMessages((prev) => prev.map((m) =>
                                        m.id === pendingId ? { ...m, content: fullText } : m
                                    ))
                                }

                                if (ev.done) {
                                    streamModel = ev.model
                                }
                            } catch { /* malformed SSE event — skip */ }
                        }
                    }
                } catch {
                    // Stream interrupted — use whatever text we accumulated
                }

                // Finalize the message
                if (fullText) {
                    setMessages((prev) => prev.map((m) =>
                        m.id === pendingId ? {
                            ...m, status: 'complete', content: fullText,
                            model: streamModel,
                        } : m
                    ))
                    if (tts.enabled) tts.speak(fullText)
                } else {
                    setMessages((prev) => prev.map((m) =>
                        m.id === pendingId ? { ...m, status: 'failed', content: 'Empty response from model.' } : m
                    ))
                }
                return
            }

            // ── Legacy JSON path (fallback for non-SSE responses) ───────────
            const data = await res.json() as { taskId?: string; status?: string; reply?: string; intent?: string; description?: string; fixUrl?: string; fixLabel?: string; technicalDetail?: string; model?: string }

            if (data.status === 'error') {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m, status: 'failed',
                        content: data.reply ?? 'Something went wrong.',
                        fixUrl: data.fixUrl, fixLabel: data.fixLabel,
                        technicalDetail: data.technicalDetail, model: data.model,
                    } : m
                ))
                return
            }

            if (data.status === 'confirm_action' && data.intent && data.description) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m, status: 'confirm_action',
                        content: 'What would you like to do with this?',
                        intent: data.intent as 'TASK' | 'PROJECT',
                        actionDescription: data.description,
                        model: data.model,
                    } : m
                ))
                return
            }

            if (data.status === 'complete' && data.reply) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        status: 'complete',
                        content: data.reply!,
                        taskId: data.taskId ?? m.taskId,
                        model: data.model,
                    } : m
                ))
                if (tts.enabled) tts.speak(data.reply)
                // Inline-complete path: the API answered synchronously and we
                // skipped SSE entirely. Must still populate works so the chip
                // renders.
                if (data.taskId) void hydrateAssets(pendingId, data.taskId)
                return
            }

            if (data.status === 'task_queued' && data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m, taskId: data.taskId!, status: 'running',
                        content: (data as { reply?: string }).reply ?? '',
                        model: data.model,
                    } : m
                ))
                void pollReply(data.taskId, pendingId)
                return
            }

            if (data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, taskId: data.taskId!, status: 'running' } : m
                ))
                await pollReply(data.taskId, pendingId)
                return
            }

            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, status: 'failed', content: 'Unexpected response from server.' } : m
            ))
        } catch {
            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, status: 'failed', content: 'Request timed out or lost connection. Your conversation is saved — just send your message again.' } : m
            ))
        } finally {
            setSending(false)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }

    // Keep ref in sync so voice callbacks always call the latest version
    sendMessageRef.current = sendMessageWith

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

    const modelToUse = agentModel ?? 'claude-sonnet-4-5'
    const caps = getModelCapabilities(modelToUse)
    const suggestion = recommendModelForInput(input, modelToUse)
    const wantsAttachment = checkAttachmentPrompt(input)
    const hasRasterImages = pastedImages.some(img => img.kind === 'image')
    const visionUnavailable = hasRasterImages && !modelSupportsVision(modelToUse)

    const chatPanel = (
        <div
            className="flex h-full flex-col relative bg-transparent"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handlePageDrop}
        >
            {isDraggingOver && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 rounded-sm border-2 border-dashed border-azure/60 bg-surface-0/90 pointer-events-none">
                    <div className="flex flex-col items-center gap-2">
                        <FileUp className="h-10 w-10 text-azure opacity-80" />
                        <p className="text-base font-medium text-text-primary">Drop files here</p>
                        <p className="text-xs text-text-muted">Images, SVG, PDF</p>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between px-3 md:px-6 py-3 md:py-4 border-b border-border shrink-0 bg-surface-1/20">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-medium text-text-primary">Chat</h1>
                        <button
                            id="workbench-toggle"
                            onClick={() => setIsWorkbenchOpen((v) => !v)}
                            aria-label={isWorkbenchOpen ? 'Hide Workbench' : 'Show Workbench'}
                            aria-pressed={isWorkbenchOpen}
                            className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-all ${
                                isWorkbenchOpen
                                    ? 'bg-azure/10 text-azure border border-azure/20 hover:bg-azure/20'
                                    : 'text-text-muted hover:text-text-secondary border border-transparent hover:border-border'
                            }`}
                        >
                            <Layout className="h-3.5 w-3.5" />
                            <span>Workbench</span>
                        </button>
                        {agentModel && (
                            <div className="hidden md:flex items-center gap-2">
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
                    {messages.length > 0 && (
                        <button
                            aria-label="Clear conversation"
                            onClick={() => {
                                setMessages([])
                                setHistoryError(false)
                                tts.stop()
                                const fresh = `session-${Date.now()}`
                                sessionId.current = fresh
                                sessionStorage.setItem('plexo-chat-session', fresh)
                            }}
                            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            <div className={`flex-1 overflow-y-auto px-3 md:px-6 py-4 md:py-8 flex flex-col gap-8 min-h-0 ${(!isWorkbenchOpen || !isPinned) ? 'items-center' : ''}`}>
                {/* aria-live="polite" announces new assistant messages to screen
                    readers as they stream in without interrupting the user.
                    role="log" is the semantic match for a chat transcript. */}
                <div
                    role="log"
                    aria-live="polite"
                    aria-atomic="false"
                    aria-relevant="additions"
                    className={`flex flex-col gap-8 w-full ${(!isWorkbenchOpen || !isPinned) ? 'max-w-3xl' : ''}`}
                >
                    {messages.length === 0 && historyLoading && (
                        <div className="flex items-center justify-center py-16 gap-3 text-text-tertiary animate-in fade-in duration-300" aria-live="polite" aria-label="Loading conversation">
                            <span className="font-mono text-azure animate-pulse">_</span>
                            <span className="text-sm">Loading conversation...</span>
                        </div>
                    )}
                    {messages.length === 0 && historyError && !historyLoading && (
                        <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center animate-in fade-in duration-300">
                            <AlertCircle className="h-5 w-5 text-red" />
                            <p className="text-sm text-text-muted">Could not load conversation history.</p>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => window.location.reload()}
                                    className="text-xs text-azure hover:underline"
                                >
                                    Retry
                                </button>
                                <span className="text-text-muted text-xs">·</span>
                                <button
                                    onClick={() => setHistoryError(false)}
                                    className="text-xs text-text-muted hover:text-text-secondary"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    )}
                    {messages.length === 0 && !historyLoading && !historyError && (
                        <div className="flex flex-col items-center justify-center py-10 gap-2 mx-auto w-full max-w-2xl animate-in fade-in duration-700">
                            <div className="relative flex items-center justify-center transition-all duration-500 mb-2">
                                <PlexoMark className="h-14 w-14" idle={!isListening} working={isListening} />
                                {isListening && <div className="absolute inset-0 rounded-full border border-azure/40 animate-ping" />}
                            </div>
                            <div className="text-center">
                                <h1 className="text-2xl md:text-[28px] font-display font-medium text-text-primary tracking-tight mb-2 text-text-primary">
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
                                    {isListening ? 'Speak now — I\'ll send when you\'re done.' : 'What are we working on today?'}
                                </p>
                            </div>
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
                            onOpenAsset={(taskId, asset) => { setOpenArtifactData({ asset, taskId }) }}
                        />
                    ))}
                    <div ref={bottomRef} />
                </div>
            </div>

            {error && (
                <div role="alert" className="shrink-0 flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 text-sm text-red mb-2 mx-3 md:mx-6">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {error}
                </div>
            )}

            {isListening && messages.length > 0 && (
                <div className="shrink-0 flex items-center justify-center gap-3 py-2 mb-1">
                    <VoiceWaveform active level={voice.level} />
                    <span className="text-xs text-azure font-medium animate-pulse">Listening…</span>
                    <VoiceWaveform active level={voice.level} />
                </div>
            )}

            {visionUnavailable && !sending && (
                <div className="shrink-0 px-3 md:px-6 mb-3">
                    <div className="flex items-start gap-3 rounded-sm border border-amber-500/30 bg-amber-dim px-4 py-3 text-sm text-amber-300">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber" />
                        <div className="flex-1 min-w-0">
                            <p className="text-amber/90 text-xs font-medium">
                                <span className="font-medium">{modelToUse}</span> does not support image recognition. If you have a vision-capable model configured (GPT-4o, Claude, Gemini, Grok, or Llama Vision), the system will route this image to it automatically.
                            </p>
                            <p className="text-amber/70 text-xs mt-1">
                                No vision model configured? Add a free <span className="font-medium">Groq</span> API key and set the model to <code className="font-mono bg-amber/10 px-1 rounded">llama-3.2-90b-vision-preview</code> — it&apos;s free.
                            </p>
                        </div>
                        <Link href="/app/settings/intelligence/providers" aria-label="Add Groq provider in settings" className="whitespace-nowrap rounded-sm bg-amber/20 hover:bg-amber/30 border border-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber transition-colors shrink-0">
                            Add Groq
                        </Link>
                    </div>
                </div>
            )}

            {(suggestion || wantsAttachment) && !sending && !isListening && (
                <div className="shrink-0 flex flex-col gap-2 mb-3 px-3 md:px-6">
                    {suggestion && (
                        <div className="flex items-start gap-3 rounded-sm border border-azure/30 bg-azure-dim px-4 py-3 text-sm text-azure transition-all">
                            <Sparkles className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                            <div className="flex-1">
                                <span className="font-medium block text-azure-200">Suggested Model: {suggestion.suggestedModel}</span>
                                <span className="text-azure/80 text-xs mt-0.5 block">{suggestion.reason}</span>
                            </div>
                            <Link href="/app/settings/intelligence/providers" aria-label="Change AI model in settings" className="whitespace-nowrap rounded-sm bg-azure-dim hover:bg-azure/90/30 border border-azure/20 px-3 py-1.5 text-sm font-medium text-azure transition-colors">
                                Change model →
                            </Link>
                        </div>
                    )}
                    {wantsAttachment && (
                        <div className="flex items-center gap-3 rounded-sm border border-amber-500/30 bg-amber-dim px-4 py-3 text-sm text-amber-300 transition-all">
                            <FileUp className="h-4 w-4 shrink-0 text-amber" />
                            <span className="flex-1 text-amber/90 text-xs font-medium">
                                Did you forget an attachment? We noticed you mentioned a file or image in your prompt.
                            </span>
                            <button aria-label="Attach a file to this message" className="whitespace-nowrap rounded-sm bg-amber/20 hover:bg-amber/30 border border-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber transition-colors"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                Attach file
                            </button>
                        </div>
                    )}
                </div>
            )}

            <div
                className="shrink-0 flex flex-col items-center gap-3 px-3 md:px-6 pt-4 md:pt-5 border-t border-border bg-surface-1/5"
                style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}
            >
                <div className={`flex flex-col gap-3 w-full ${(!isWorkbenchOpen || !isPinned) ? 'max-w-3xl' : ''}`}>
                    <Composer
                        ref={inputRef}
                        input={input}
                        setInput={setInput}
                        onSend={() => void sendMessage()}
                        sending={sending}
                        pastedImages={pastedImages}
                        pastedDocs={pastedDocs}
                        onRemoveImage={removeImage}
                        onRemoveDoc={(id) => setPastedDocs((prev) => prev.filter(d => d.id !== id))}
                        onPaste={handlePaste}
                        onDrop={handleDrop}
                        onKeyDown={handleKeyDown}
                        onFileInputClick={() => fileInputRef.current?.click()}
                        fileInputRef={fileInputRef}
                        onFileInputChange={handleFileInput}
                        voiceSupported={voice.supported}
                        isListening={isListening}
                        onVoiceToggle={() => isListening ? voice.stop() : (tts.stop(), void voice.start())}
                        isLiveMode={isLiveMode}
                        onLiveModeToggle={() => {
                            const next = !isLiveMode
                            setIsLiveMode(next)
                            if (!next) { tts.stop(); voice.stop() }
                            else if (!sending && !isListening) void voice.start()
                        }}
                    />
                </div>
            </div>
        </div>
    );

    return (
        <div className="flex h-full w-full overflow-hidden bg-canvas relative">
            <div className={`flex flex-col min-w-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                isWorkbenchOpen && isPinned
                    ? 'w-full md:w-[32%] md:shrink-0 md:border-r border-border/60'
                    : 'flex-1'
            }`}>
                <div className="flex-1 flex flex-col overflow-hidden h-full">
                    {chatPanel}
                </div>
            </div>

            {isWorkbenchOpen && (
                <div className={isPinned ? 'hidden md:block flex-1 min-w-0 h-full' : ''}>
                    <ArtifactWorkbench
                        workspaceId={WS_ID}
                        taskId={lastRunningTaskId}
                        isTaskRunning={!!lastRunningTaskId}
                        context={workbenchContext}
                        onRepoSelect={(sel) => setWorkbenchContext({ repo: sel.repo, branch: sel.branch, isNew: sel.isNew })}
                        onRerunTest={(testNames) => {
                            const text = testNames.length === 1
                                ? `Re-run the failing test: ${testNames[0]}`
                                : `Re-run these failing tests: ${testNames.join(', ')}`
                            void sendMessageWith(text)
                        }}
                        onClose={() => setIsWorkbenchOpen(false)}
                        isPinned={isPinned}
                        onTogglePin={() => setIsPinned((v) => !v)}
                        activeTab={activeTab}
                        setActiveTab={setActiveTab}
                        showBottom={showBottom}
                        setShowBottom={setShowBottom}
                        previewPath={previewPath}
                        setPreviewPath={setPreviewPath}
                    />
                </div>
            )}

            {openArtifactData && !isWorkbenchOpen && (
                <div className="absolute inset-0 md:inset-auto md:top-0 md:right-0 md:bottom-0 md:left-auto md:w-full md:max-w-[600px] z-50 bg-surface-2 border-l border-border/40 animate-in slide-in-from-right fade-in duration-500">
                    <ArtifactPanel
                        asset={openArtifactData.asset}
                        taskId={openArtifactData.taskId}
                        workspaceId={WS_ID}
                        onClose={() => setOpenArtifactData(null)}
                        mode="docked"
                    />
                </div>
            )}
        </div>
    )
}
