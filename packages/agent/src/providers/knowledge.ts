import { db, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'

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

/**
 * Sync knowledge base from OpenRouter's free JSON endpoint.
 */
export async function syncModelKnowledge() {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models')
        if (!res.ok) {
            console.error('Failed to fetch openrouter models', await res.text())
            return
        }

        const data = await res.json() as {
            data: {
                id: string
                context_length: number
                pricing: { prompt: string; completion: string }
            }[]
        }

        const records = data.data.map(m => {
            const parts = m.id.split('/')
            const provider = parts.length > 1 ? parts[0] : 'unknown'
            const modelId = parts.length > 1 ? parts.slice(1).join('/') : m.id

            // Heuristics for strengths
            const strengths: string[] = []
            if (m.id.includes('llama')) strengths.push('open-source')
            if (m.id.includes('claude') || m.id.includes('gpt-4') || m.id.includes('o1')) strengths.push('reasoning', 'coding')
            if (m.id.includes('haiku') || m.id.includes('mini') || m.id.includes('flash')) strengths.push('speed')

            return {
                id: m.id,
                provider: provider!,
                modelId: modelId!,
                contextWindow: m.context_length,
                costPerMIn: parseFloat(m.pricing.prompt) * 1000000 || 0,
                costPerMOut: parseFloat(m.pricing.completion) * 1000000 || 0,
                strengths,
            }
        })

        // Upsert DB
        for (const record of records) {
            await db.insert(modelsKnowledge).values({
                id: record.id,
                provider: record.provider,
                modelId: record.modelId,
                contextWindow: record.contextWindow,
                costPerMIn: record.costPerMIn,
                costPerMOut: record.costPerMOut,
                strengths: record.strengths,
                lastSyncedAt: new Date()
            }).onConflictDoUpdate({
                target: modelsKnowledge.id,
                set: {
                    contextWindow: record.contextWindow,
                    costPerMIn: record.costPerMIn,
                    costPerMOut: record.costPerMOut,
                    strengths: record.strengths,
                    lastSyncedAt: new Date()
                }
            })
        }

        console.log(`Synced ${records.length} models into knowledge base.`)
    } catch (err) {
        console.error('Failed to sync model knowledge', err)
    }
}
