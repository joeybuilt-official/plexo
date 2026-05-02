// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// SEC-035: Exfil-pattern detection — skip persisting messages that attempt to exfiltrate secrets

/**
 * Conversation Memory Bridge
 *
 * Extracts actionable knowledge from conversation turns and persists it.
 * This bridges the gap between stateless conversation responses and
 * persistent workspace memory.
 *
 * Three-tier behavior rule persistence (per operator decision):
 * 1. Explicit instructions → upsert to behavior_rules immediately
 * 2. Explicit with revocation condition → behavior_rules with revocation trigger
 * 3. Inferred patterns → reflectAndPromote pipeline only (not handled here)
 *
 * Called fire-and-forget AFTER the response is sent to the user.
 * Must not add latency to the conversation response path.
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import {
    isSafetyBypass,
    extractRevocationTrigger,
    hasRevocationCondition,
} from './instruction-detect.js'
import { emitMemoryUserWrite } from '../analytics/memory-events.js'

// Re-export detection functions for consumers
export { hasInstructionIntent, hasRevocationCondition } from './instruction-detect.js'

const logger = pino({ name: 'conversation-bridge' })

// ── Exfil-pattern detection ─────────────────────────────────────────────────

const EXFIL_PATTERNS = [
    /\b(env|environment)\s*(var|variable)/i,
    /\b(database|db)[\s_]*(url|connection|string)/i,
    /\b(api|secret|private)[\s_]*(key|token|secret)/i,
    /\bencryption[\s_]*secret/i,
    /\bpassword\b/i,
    /\bcredential/i,
    /\b(include|show|print|output|reveal|display)\b.*(secret|key|token|password|credential|env)/i,
    /\bprocess\.env\b/i,
]

function containsExfilAttempt(text: string): boolean {
    return EXFIL_PATTERNS.some((p) => p.test(text))
}

// ── Instruction Persistence ──────────────────────────────────────────────────

/**
 * Extract and persist an explicit user instruction as a behavior_rule.
 * Runs fire-and-forget after response is sent.
 */
export async function persistInstruction(params: {
    workspaceId: string
    userMessage: string
    assistantReply: string
    sessionId: string
}): Promise<void> {
    const { workspaceId, userMessage, assistantReply, sessionId } = params

    // Safety gate: reject attempts to modify safety constraints
    if (isSafetyBypass(userMessage)) {
        logger.warn({ workspaceId, msg: userMessage.slice(0, 100) }, 'Blocked safety bypass instruction')
        return
    }

    // Exfil gate: don't persist instructions that attempt to exfiltrate secrets
    if (containsExfilAttempt(userMessage)) {
        logger.warn({ workspaceId, msg: userMessage.slice(0, 100) }, 'Blocked exfil-pattern instruction from persisting as behavior rule')
        return
    }

    const hasRevocation = hasRevocationCondition(userMessage)
    const ruleKey = `conv.${Date.now().toString(36)}.${hashCode(userMessage.slice(0, 50))}`

    // Determine rule type
    const ruleType = /\b(tone|style|respond|reply|talk|speak|communicate|format)\b/i.test(userMessage)
        ? 'communication_style'
        : 'operational_rule'

    const ruleValue: Record<string, unknown> = {
        type: 'text_block',
        value: `User instruction: ${userMessage.slice(0, 500)}`,
        source_session: sessionId,
    }

    if (hasRevocation) {
        ruleValue.revocation_trigger = extractRevocationTrigger(userMessage)
        ruleValue.conditional = true
    }

    try {
        await db.execute(sql`
            INSERT INTO behavior_rules
                (id, workspace_id, type, key, label, description, value, source, tags)
            VALUES
                (gen_random_uuid(), ${workspaceId}::uuid,
                 ${ruleType}, ${ruleKey},
                 ${userMessage.slice(0, 100)},
                 '',
                 ${JSON.stringify(ruleValue)}::jsonb,
                 'conversation',
                 ARRAY['auto', 'conversation']::text[])
            ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
            DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = now()
        `)

        logger.info({
            workspaceId,
            key: ruleKey,
            type: ruleType,
            conditional: hasRevocation,
        }, 'Persisted conversation instruction as behavior rule')
        emitMemoryUserWrite({ workspaceId, ruleKey, ruleType, conditional: hasRevocation })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to persist conversation instruction')
    }
}

function hashCode(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString(36)
}

// ── Conversation Memory Extraction ───────────────────────────────────────────

/**
 * Extract memory from a conversation turn and persist as memory_entries.
 * Runs fire-and-forget after response is sent.
 *
 * This creates a 'session' type memory entry summarizing the exchange.
 * Unlike task memories, these capture conversational knowledge — preferences,
 * corrections, domain context, and user identity signals.
 */
export async function extractConversationMemory(params: {
    workspaceId: string
    userMessage: string
    assistantReply: string
    sessionId: string
    source: string
}): Promise<void> {
    const { workspaceId, userMessage, assistantReply, sessionId, source } = params

    // Skip trivial exchanges
    if (userMessage.length < 20 && assistantReply.length < 50) return

    // Check if this is a substantive exchange worth remembering
    if (!isSubstantive(userMessage, assistantReply)) return

    try {
        const content = `User: ${userMessage.slice(0, 500)}\nAssistant: ${assistantReply.slice(0, 500)}`

        // Load workspace AI settings so summarization can use the configured
        // provider chain (e.g. DeepSeek → Groq → Mistral) instead of falling
        // through to the env-var fallback path which can stall on unreachable
        // providers. Safe to swallow — if settings fail to load, storeMemory
        // skips shorthand and still persists + embeds the row.
        let aiSettings: Awaited<ReturnType<typeof import('../providers/settings-from-instances.js').loadSettingsFromInstances>> = null
        try {
            const { loadSettingsFromInstances } = await import('../providers/settings-from-instances.js')
            aiSettings = await loadSettingsFromInstances(workspaceId)
        } catch (err) {
            logger.debug({ err, workspaceId }, 'Failed to load workspace AI settings — storeMemory will skip shorthand')
        }

        // Route through storeMemory() so the fire-and-forget embedding +
        // shorthand summarization paths run for conversation memories.
        const { storeMemory } = await import('./store.js')
        await storeMemory({
            workspaceId,
            type: 'session',
            content,
            metadata: {
                session_id: sessionId,
                source,
                extracted_at: new Date().toISOString(),
            },
            aiSettings: aiSettings ?? undefined,
        })

        // Extract personal facts as dedicated pattern entries for high-quality retrieval.
        // Session entries embed poorly against factual queries ("where do I live?")
        // because they contain full conversation turns. Fact entries are tight and
        // specific ("User lives in Orem, Utah") so vector search ranks them highly.
        void extractPersonalFacts(workspaceId, userMessage, assistantReply, aiSettings ?? undefined)
            .catch((e: unknown) => logger.debug({ err: e }, 'Personal fact extraction skipped'))

        // Phase 3: extract structured facts fire-and-forget after response is sent
        void import('./extract-worker.js').then(m => m.extractTurn({ workspaceId, userMessage, assistantReply, sessionId, source }))
            .catch((e: unknown) => logger.warn({ err: e, workspaceId }, 'extract-worker: fire-and-forget failed'))
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to extract conversation memory')
    }
}

/**
 * Determine if a conversation turn is worth persisting as memory.
 * Filters out greetings, confirmations, and other low-information exchanges.
 */
function isSubstantive(userMessage: string, assistantReply: string): boolean {
    const msg = userMessage.toLowerCase().trim()

    // Skip pure greetings/acks
    if (/^(hi|hey|hello|yo|sup|thanks|ok|yes|no|sure|cool|nice|good|great|fine)\b/.test(msg) && msg.length < 30) {
        return false
    }

    // Skip single-word messages
    if (msg.split(/\s+/).length <= 2 && msg.length < 15) return false

    // Skip if assistant reply is very short (error or trivial)
    if (assistantReply.length < 30) return false

    return true
}

// ── Personal Fact Extraction ────────────────────────────────────────────────

/**
 * Patterns that indicate the user is sharing a personal fact.
 * Each pattern maps to a category for the extracted fact.
 */
const FACT_PATTERNS: Array<{ re: RegExp; category: string; extract: (m: RegExpMatchArray, msg: string) => string | null }> = [
    // Location: "I live in X", "I'm in X", "I'm from X", "I'm based in X"
    { re: /\bi (?:live|reside|am based|stay|am) (?:in|at|near)\s+(.{3,60})/i, category: 'location', extract: (m) => `User lives in ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    { re: /\bi(?:'m| am) from\s+(.{3,60})/i, category: 'origin', extract: (m) => `User is from ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    // Work: "I work at X", "I'm a X at Y", "my job is X", "I'm the X"
    { re: /\bi work (?:at|for)\s+(.{3,60})/i, category: 'work', extract: (m) => `User works at ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    { re: /\bi(?:'m| am) (?:a |an |the )?(\w[\w\s]{2,40}?) (?:at|for|with)\s+(.{3,60})/i, category: 'role', extract: (m) => `User is ${m[1]!.trim()} at ${m[2]!.replace(/[.!?,;]+$/, '').trim()}` },
    { re: /\bmy (?:job|role|title|position) is\s+(.{3,60})/i, category: 'role', extract: (m) => `User's role is ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    // Name: "my name is X", "I'm X" (only if short — avoid "I'm happy")
    { re: /\bmy name is\s+(\w[\w\s]{1,30})/i, category: 'name', extract: (m) => `User's name is ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    { re: /\bcall me\s+(\w[\w\s]{1,20})/i, category: 'name', extract: (m) => `User goes by ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    // Family: "my wife/husband/partner is X", "I have X kids"
    { re: /\bmy (?:wife|husband|partner|spouse)(?:'s name)? is\s+(\w[\w\s]{1,30})/i, category: 'family', extract: (m) => `User's partner is ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
    { re: /\bi have\s+(\d+)\s+(?:kids?|children)/i, category: 'family', extract: (m) => `User has ${m[1]} children` },
    // Preferences: "I prefer X", "I like X", "I use X"
    { re: /\bi (?:prefer|always use|use)\s+(.{3,60})/i, category: 'preference', extract: (m) => `User prefers ${m[1]!.replace(/[.!?,;]+$/, '').trim()}` },
]

/**
 * Extract personal facts from a conversation turn and store as dedicated
 * `pattern` entries. Pattern entries embed tightly against factual queries,
 * unlike session entries which are full conversation transcripts.
 */
async function extractPersonalFacts(
    workspaceId: string,
    userMessage: string,
    _assistantReply: string,
    aiSettings?: Parameters<typeof import('./store.js').storeMemory>[0]['aiSettings'],
): Promise<void> {
    const facts: Array<{ content: string; category: string }> = []

    for (const { re, category, extract } of FACT_PATTERNS) {
        const m = userMessage.match(re)
        if (!m) continue
        const fact = extract(m, userMessage)
        if (fact && fact.length > 5) {
            facts.push({ content: fact, category })
        }
    }

    if (facts.length === 0) return

    const { storeMemory, searchMemory } = await import('./store.js')

    for (const { content, category } of facts) {
        // Deduplicate: skip if a similar fact already exists
        const existing = await searchMemory({ workspaceId, query: content, limit: 1 })
        if (existing.length > 0 && existing[0]!.content.toLowerCase().includes(content.toLowerCase().slice(0, 30))) {
            continue
        }

        await storeMemory({
            workspaceId,
            type: 'pattern',
            content,
            metadata: { category, source: 'fact_extraction', extracted_at: new Date().toISOString() },
            aiSettings,
        })
        logger.info({ workspaceId, category, fact: content }, 'Extracted personal fact from conversation')
    }
}
