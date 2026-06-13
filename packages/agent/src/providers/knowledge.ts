// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'

const logger = pino({ name: 'knowledge-sync' })

export interface ModelKnowledge {
    id: string
    provider: string
    modelId: string
    contextWindow: number
    costPerMIn: number
    costPerMOut: number
    strengths: string[]
    reliabilityScore: number
}

// Layer 1: Provider Allowlist
export const ALLOWED_PROVIDERS = [
    'anthropic',
    'openai',
    'google', // gemini
    'groq',
    'together-ai',
    'deepseek',
]

/**
 * Sync knowledge base.
 * Pulls from Portkey-AI open-source models registry (pricing and general capabilities)
 * filtering only by ALLOWED_PROVIDERS to enforce Layer 1 isolation.
 */
export async function syncModelKnowledge() {
    try {
        const records: ModelKnowledge[] = []

        for (const provider of ALLOWED_PROVIDERS) {
            try {
                const portkeyName = provider === 'openai' ? 'openai' : provider

                const [priceRes, genRes] = await Promise.all([
                    fetch(`https://raw.githubusercontent.com/Portkey-AI/models/main/pricing/${portkeyName}.json`),
                    fetch(`https://raw.githubusercontent.com/Portkey-AI/models/main/general/${portkeyName}.json`)
                ])
                
                if (!priceRes.ok || !genRes.ok) {
                    logger.warn({ provider, pricingStatus: priceRes.status, generalStatus: genRes.status }, 'Failed to fetch Portkey models')
                    continue
                }

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Portkey JSON schema is untyped
                const priceData = await priceRes.json() as Record<string, any>
                const genData = await genRes.json() as Record<string, any>
                
                // Portkey object keys are model IDs, except for "default"
                for (const [key, value] of Object.entries(priceData)) {
                    if (key === 'default') continue
                    
                    const payAsYouGo = value.pricing_config?.pay_as_you_go
                    if (!payAsYouGo) continue

                    const promptPrice = payAsYouGo.request_token?.price || 0
                    const completionPrice = payAsYouGo.response_token?.price || 0

                    const costPerMIn = parseFloat(String(promptPrice)) * 1000000
                    const costPerMOut = parseFloat(String(completionPrice)) * 1000000

                    const strengths: string[] = []
                    let contextWindow = 128000 // default fallback
                    
                    // GenData keys map up to base capability maps (or model-specific overrides if present)
                    const modelGen = genData[key] || genData.default || {}
                    
                    if (modelGen.type) {
                        if (modelGen.type.supported?.includes('image')) strengths.push('vision')
                        if (modelGen.type.supported?.includes('tools')) strengths.push('tools')
                        if (modelGen.type.supported?.includes('video')) strengths.push('video')
                    }
                    
                    if (modelGen.params && Array.isArray(modelGen.params)) {
                        for (const param of modelGen.params) {
                            if (param.key === 'response_format') {
                                const hasJsonSchema = param.options?.some((opt: { value: string }) => opt.value === 'json_schema')
                                if (hasJsonSchema) strengths.push('structured_output')
                            }
                        }
                    }

                    // For now, reasoning and speed can still be partly designated by open-source community conventions if unlisted
                    if (key.includes('llama') || key.includes('mistral')) strengths.push('open-source')
                    if (key.includes('claude') || key.includes('gpt-4') || key.includes('o1') || key.includes('o3') || key.includes('deepseek')) strengths.push('reasoning', 'coding')
                    if (key.includes('haiku') || key.includes('mini') || key.includes('flash') || key.includes('8b')) strengths.push('speed')

                    records.push({
                        id: `${provider}/${key}`,
                        provider,
                        modelId: key,
                        contextWindow, 
                        costPerMIn: costPerMIn || 0,
                        costPerMOut: costPerMOut || 0,
                        strengths: Array.from(new Set(strengths)), // dedupe
                        reliabilityScore: 1.0,
                    })
                }
            } catch (err) {
                logger.error({ err, provider }, 'Portkey sync error')
            }
        }

        // Paginated upserts to bound memory/connection usage (GAP-004)
        // One INSERT ... VALUES (...),(...),... ON CONFLICT DO UPDATE per batch
        // instead of N individual statements.
        const BATCH_SIZE = 50
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE)
            // A6 cutover: dual-write per-token rates to both real + numeric.
            await db.insert(modelsKnowledge)
                .values(batch.map(record => ({
                    id: record.id,
                    provider: record.provider,
                    modelId: record.modelId,
                    contextWindow: record.contextWindow,
                    costPerMIn: record.costPerMIn,
                    costPerMInNumeric: String(record.costPerMIn),
                    costPerMOut: record.costPerMOut,
                    costPerMOutNumeric: String(record.costPerMOut),
                    strengths: record.strengths,
                    lastSyncedAt: new Date(),
                })))
                .onConflictDoUpdate({
                    target: modelsKnowledge.id,
                    set: {
                        contextWindow: sql`excluded.context_window`,
                        costPerMIn: sql`excluded.cost_per_m_in`,
                        costPerMInNumeric: sql`excluded.cost_per_m_in_numeric`,
                        costPerMOut: sql`excluded.cost_per_m_out`,
                        costPerMOutNumeric: sql`excluded.cost_per_m_out_numeric`,
                        strengths: sql`excluded.strengths`,
                        lastSyncedAt: sql`excluded.last_synced_at`,
                    },
                })
        }

        logger.info({ count: records.length, providers: ALLOWED_PROVIDERS.length }, 'Portkey models synced to knowledge base')
    } catch (err) {
        logger.error({ err }, 'Failed to sync model knowledge')
    }
}
