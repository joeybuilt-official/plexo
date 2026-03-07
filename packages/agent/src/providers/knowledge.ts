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
 * Pulls from Portkey-AI open-source models registry (pricing JSONs)
 * filtering only by ALLOWED_PROVIDERS to enforce Layer 1 isolation.
 */
export async function syncModelKnowledge() {
    try {
        const records: ModelKnowledge[] = []

        // Iterate strictly over the permitted allowlist to fetch from Portkey
        for (const provider of ALLOWED_PROVIDERS) {
            try {
                // Map local plexo names to Portkey github filenames
                const portkeyName = provider === 'openai' ? 'openai' : provider
                const res = await fetch(`https://raw.githubusercontent.com/Portkey-AI/models/main/pricing/${portkeyName}.json`)
                
                if (!res.ok) {
                    console.warn(`Failed to fetch Portkey models for ${provider}: ${res.status}`)
                    continue
                }

                const data = await res.json() as Record<string, any>
                
                // Parse Portkey pricing format
                // the object keys are model IDs, except for "default"
                for (const [key, value] of Object.entries(data)) {
                    if (key === 'default') continue
                    
                    const payAsYouGo = value.pricing_config?.pay_as_you_go
                    if (!payAsYouGo) continue

                    const promptPrice = payAsYouGo.request_token?.price || 0
                    const completionPrice = payAsYouGo.response_token?.price || 0

                    // Convert per-token to per-million (Portkey gives fractional cents per token usually, or exact tokens)
                    const costPerMIn = parseFloat(String(promptPrice)) * 1000000
                    const costPerMOut = parseFloat(String(completionPrice)) * 1000000

                    // Dynamic Strengths heuristics (simplified map)
                    const strengths: string[] = []
                    if (key.includes('llama')) strengths.push('open-source')
                    if (key.includes('claude') || key.includes('gpt-4') || key.includes('o1') || key.includes('o3')) strengths.push('reasoning', 'coding')
                    if (key.includes('haiku') || key.includes('mini') || key.includes('flash') || key.includes('8b')) strengths.push('speed')
                    
                    if (provider === 'deepseek') strengths.push('coding', 'reasoning')
                    if (provider === 'groq') strengths.push('speed')

                    records.push({
                        id: `${provider}/${key}`,
                        provider,
                        modelId: key,
                        // Portkey pricing doesn't strictly have context embedded here, assume standard 128k fallback
                        contextWindow: 128000, 
                        costPerMIn: costPerMIn || 0,
                        costPerMOut: costPerMOut || 0,
                        strengths,
                        reliabilityScore: 1.0,
                    })
                }
            } catch (err) {
                console.error(`Portkey sync error for ${provider}`, err)
            }
        }

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

        console.log(`Synced ${records.length} Portkey models into knowledge base across ${ALLOWED_PROVIDERS.length} providers.`)
    } catch (err) {
        console.error('Failed to sync model knowledge', err)
    }
}
