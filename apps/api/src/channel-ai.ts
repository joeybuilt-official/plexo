// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared AI helpers for channel adapters (Slack, Discord, Telegram).
 *
 * Consolidates the duplicated chatWithAI / classifyIntent / chat-history
 * logic that was previously copy-pasted across each adapter.
 */

import { generateText } from 'ai'
import { withFallback } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from './agent-loop.js'
import { emitToWorkspace } from './sse-emitter.js'
import { logger } from './logger.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: 'user' | 'assistant'
    content: string
}

export interface AiResult {
    text: string | null
    error: string | null
}

export type IntentLabel = 'TASK' | 'PROJECT' | 'CONVERSATION'

// ── chatWithAI ───────────────────────────────────────────────────────────────

/**
 * Fire a single-turn AI call using the workspace's configured provider.
 *
 * @param includeSnapshot  When true, appends the full introspection snapshot
 *   so the model can answer "what model are you?" accurately.
 */
export async function chatWithAI(
    workspaceId: string,
    messages: ChatMessage[],
    system?: string,
    includeSnapshot = false,
): Promise<AiResult> {
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) {
        return { text: null, error: 'No AI provider configured. Add your API key in Settings → AI Providers.' }
    }

    try {
        let finalSystem = system ?? 'You are Plexo, an AI agent assistant.'

        if (includeSnapshot) {
            const providerKey = aiSettings.primaryProvider
            const config = aiSettings.providers[providerKey]
            const { buildIntrospectionSnapshot } = await import('@plexo/agent/introspection')
            const resolvedModel = config?.model ?? '(unknown)'
            const snapshot = await buildIntrospectionSnapshot(workspaceId, providerKey, resolvedModel)
            finalSystem += `\n\nYour identity: you are Plexo, running on provider "${providerKey}", model "${resolvedModel}". If asked what model, AI, or system you are, answer truthfully using this information. Never claim to be a different model or say you don't know.\n\nHere is your full state and self-awareness snapshot (tools, agents, skills, memory, integrations, channels, exact model, provider, and workspace):\n${JSON.stringify(snapshot, null, 2)}`
        }

        const result = await withFallback(aiSettings, 'summarization', async (model) =>
            generateText({
                model,
                system: finalSystem,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                abortSignal: AbortSignal.timeout(30_000),
            }),
            {
                workspaceId,
                onAuthFailure: (provider, error) => {
                    logger.warn({ workspaceId, provider, error }, 'Provider auth failed — removed from fallback chain')
                    emitToWorkspace(workspaceId, {
                        type: 'provider_auth_error',
                        provider,
                        message: `API key for "${provider}" is invalid or expired. Update it in Settings → AI Providers.`,
                    })
                },
            },
        )
        return { text: result.text ?? null, error: null }
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const providerKey = aiSettings.primaryProvider
        logger.warn({ err, workspaceId, providerKey }, 'Channel AI chat call failed (all providers in fallback chain exhausted)')

        // Translate common API errors into actionable user-facing messages
        let userMsg: string
        if (raw.includes('Invalid API Key') || raw.includes('invalid_api_key') || raw.includes('Incorrect API key')) {
            userMsg = `API key for "${providerKey}" is invalid or expired. Update it in Settings → AI Providers.`
        } else if (raw.includes('insufficient_quota') || raw.includes('exceeded your current quota')) {
            userMsg = `API quota exhausted for "${providerKey}". Check your billing at the provider's dashboard.`
        } else if (raw.includes('Rate limit') || raw.includes('rate_limit') || raw.includes('429')) {
            userMsg = `Rate limited by "${providerKey}". Wait a moment and try again.`
        } else if (raw.includes('timeout') || raw.includes('ETIMEDOUT') || raw.includes('ECONNREFUSED')) {
            userMsg = `Could not reach "${providerKey}" — the provider may be down or unreachable. Try again shortly.`
        } else {
            userMsg = `AI provider "${providerKey}" returned an error: ${raw.slice(0, 150)}`
        }
        return { text: null, error: userMsg }
    }
}

// ── Intent classification ────────────────────────────────────────────────────

/**
 * System prompt shared by all channel adapters for 3-way intent classification.
 */
export const CHANNEL_CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, or CONVERSATION.

TASK: The user is explicitly asking to start a clear, immediate, actionable task. Or the user is confirming (e.g. "yes", "do it") a previous proposal to create a task.
PROJECT: The user is explicitly asking to start a large, multi-step goal requiring planning (e.g., "Build a new features"). Or the user is confirming a proposal to create a project.
CONVERSATION: Vague requests, troubleshooting, requests needing clarification, greetings, checks, small talk, or rejecting proposals.

<examples>
<example><input>Fix the broken import in auth.ts</input>
<output>{"classification":"TASK","confidence":0.96}</output></example>
<example><input>What's wrong with auth.ts?</input>
<output>{"classification":"CONVERSATION","confidence":0.92}</output></example>
<example><input>Can you look into the login issue?</input>
<output>{"classification":"TASK","confidence":0.66}</output></example>
<example><input>Build a complete user onboarding flow with email verification</input>
<output>{"classification":"PROJECT","confidence":0.94}</output></example>
<example><input>Deploy the latest build to staging</input>
<output>{"classification":"TASK","confidence":0.95}</output></example>
<example><input>How does the auth middleware work?</input>
<output>{"classification":"CONVERSATION","confidence":0.91}</output></example>
<example><input>Yes, do it</input>
<output>{"classification":"TASK","confidence":0.88}</output></example>
<example><input>Create a marketing website with blog, pricing page, and contact form</input>
<output>{"classification":"PROJECT","confidence":0.93}</output></example>
</examples>

Reply with JSON: {"classification":"TASK"|"PROJECT"|"CONVERSATION","confidence":0.0-1.0}
If confidence is below 0.72, classify as CONVERSATION to avoid misrouting.`

/**
 * Classify the last user message in a conversation history as TASK / PROJECT / CONVERSATION.
 * Falls back to CONVERSATION on any error.
 */
export async function classifyIntent(
    workspaceId: string,
    history: ChatMessage[],
): Promise<IntentLabel> {
    const result = await chatWithAI(workspaceId, history, CHANNEL_CLASSIFY_SYSTEM)
    if (result.error) return 'CONVERSATION'
    const resText = result.text?.trim() ?? ''

    // Try JSON parse first (new format with confidence)
    try {
        const parsed = JSON.parse(resText) as { classification?: string; confidence?: number }
        const classification = parsed.classification?.toUpperCase()
        const confidence = parsed.confidence ?? 0

        // Below confidence threshold → default to CONVERSATION
        if (confidence < 0.72 && classification !== 'CONVERSATION') {
            logger.info({ workspaceId, classification, confidence }, 'Intent below confidence threshold — defaulting to CONVERSATION')
            return 'CONVERSATION'
        }

        if (classification === 'TASK') return 'TASK'
        if (classification === 'PROJECT') return 'PROJECT'
        return 'CONVERSATION'
    } catch {
        // Fallback: legacy single-word response
        const upper = resText.toUpperCase()
        if (upper.startsWith('TASK')) return 'TASK'
        if (upper.startsWith('PROJECT')) return 'PROJECT'
        return 'CONVERSATION'
    }
}

// ── Chat history helper ──────────────────────────────────────────────────────

/** Maximum messages kept per conversation thread (in-memory warm cache). */
const MAX_HISTORY = 20

/**
 * Lightweight in-memory chat history scoped by an arbitrary string key.
 *
 * Each channel adapter composes its own key (e.g. `slack:team:channel:ts`,
 * `discord:guild:channel`, `telegram:channelId:chatId`) but the storage
 * mechanics are identical and shared here.
 */
export class ChannelChatHistory {
    private store = new Map<string, ChatMessage[]>()

    get(key: string): ChatMessage[] | undefined {
        return this.store.get(key)
    }

    add(key: string, role: 'user' | 'assistant', content: string): void {
        const hist = this.store.get(key) ?? []
        hist.push({ role, content })
        if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY)
        this.store.set(key, hist)
    }

    delete(key: string): void {
        this.store.delete(key)
    }
}
