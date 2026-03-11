// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { useState, useEffect, useRef, useCallback } from 'react'

export type SpeechStatus = 'idle' | 'listening' | 'processing'

export interface UseSpeechInputOptions {
    workspaceId: string
    onResult: (text: string) => void
    onSetupNeeded?: () => void
}

export function useSpeechInput({ workspaceId, onResult, onSetupNeeded }: UseSpeechInputOptions) {
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
            const ctx = new window.AudioContext()
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
