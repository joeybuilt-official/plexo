// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

export function useTTS(options?: { onEnd?: () => void; enabled?: boolean }) {
    const [speaking, setSpeaking] = useState(false)
    const enabledRef = useRef(options?.enabled ?? true)
    const utterRef = useRef<SpeechSynthesisUtterance | null>(null)
    const onEndRef = useRef(options?.onEnd)
    const voiceRef = useRef<SpeechSynthesisVoice | null>(null)

    useEffect(() => {
        enabledRef.current = options?.enabled ?? true
        onEndRef.current = options?.onEnd
    }, [options?.enabled, options?.onEnd])

    useEffect(() => {
        if (typeof window === 'undefined' || !window.speechSynthesis) return
        const pickVoice = () => {
            const voices = window.speechSynthesis.getVoices()
            if (voices.length > 0) {
                voiceRef.current = voices.find(v =>
                    v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Natural')
                ) ?? voices[0]
            }
        }
        pickVoice()
        window.speechSynthesis.addEventListener('voiceschanged', pickVoice)
        return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice)
    }, [])

    // Chrome pauses speechSynthesis after ~15s. A periodic resume() keeps it alive.
    const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const clearKeepAlive = useCallback(() => {
        if (keepAliveRef.current) { clearInterval(keepAliveRef.current); keepAliveRef.current = null }
    }, [])

    const speak = useCallback((text: string) => {
        if (!enabledRef.current || typeof window === 'undefined' || !window.speechSynthesis) return
        window.speechSynthesis.cancel()
        clearKeepAlive()

        // Strip markdown fences, code blocks, URLs, and excessive formatting
        // so TTS reads clean prose instead of "backtick backtick backtick".
        const clean = text
            .replace(/```[\s\S]*?```/g, ' (code omitted) ')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/[#*_~>|]/g, '')
            .replace(/\n{2,}/g, '. ')
            .replace(/\n/g, ' ')
            .trim()

        if (!clean) return

        const utterance = new SpeechSynthesisUtterance(clean)
        utterance.rate = 1.05
        utterance.pitch = 1.0
        if (voiceRef.current) utterance.voice = voiceRef.current
        utterRef.current = utterance
        utterance.onstart = () => {
            setSpeaking(true)
            // Chrome bug workaround: call resume() every 10s to prevent pause
            keepAliveRef.current = setInterval(() => {
                if (window.speechSynthesis.speaking) window.speechSynthesis.resume()
            }, 10_000)
        }
        utterance.onend = () => {
            clearKeepAlive()
            setSpeaking(false)
            onEndRef.current?.()
        }
        utterance.onerror = () => {
            clearKeepAlive()
            setSpeaking(false)
            onEndRef.current?.()
        }
        window.speechSynthesis.speak(utterance)
    }, [clearKeepAlive])

    const stop = useCallback(() => {
        clearKeepAlive()
        window.speechSynthesis?.cancel()
        setSpeaking(false)
    }, [clearKeepAlive])

    return { speaking, enabled: options?.enabled ?? true, speak, stop }
}
