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
 * Pulls from Portkey-AI open-source models registry (pricing and general capabilities)
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
                
                // Fetch Pricing and General Metadata in parallel
                const [priceRes, genRes] = await Promise.all([
                    fetch(`https://raw.githubusercontent.com/Portkey-AI/models/main/pricing/${portkeyName}.json`),
                    fetch(`https://raw.githubusercontent.com/Portkey-AI/models/main/general/${portkeyName}.json`)
                ])
                
                if (!priceRes.ok || !genRes.ok) {
                    console.warn(`Failed to fetch Portkey models for ${provider}: Pricing=${priceRes.status}, General=${genRes.status}`)
                    continue
                }

                const priceData = await priceRes.json() as Record<string, any>
                const genData = await genRes.json() as Record<string, any>
                
                // Parse Portkey pricing format
                // the object keys are model IDs, except for "default"
                for (const [key, value] of Object.entries(priceData)) {
                    if (key === 'default') continue
                    
                    const payAsYouGo = value.pricing_config?.pay_as_you_go
                    if (!payAsYouGo) continue

                    const promptPrice = payAsYouGo.request_token?.price || 0
                    const completionPrice = payAsYouGo.response_token?.price || 0

                    // Convert per-token to per-million (Portkey gives fractional cents per token usually, or exact tokens)
                    const costPerMIn = parseFloat(String(promptPrice)) * 1000000
                    const costPerMOut = parseFloat(String(completionPrice)) * 1000000

                    // Dynamic Strengths heuristics via capabilities registry mapped
                    const strengths: string[] = []
                    let contextWindow = 128000 // default fallback
                    
                    // GenData keys map up to base capability maps (or model-specific overrides if present)
                    const modelGen = genData[key] || genData.default || {}
                    
                    if (modelGen.type) {
                        if (modelGen.type.supported?.includes('image')) strengths.push('vision')
                        if (modelGen.type.supported?.includes('tools')) strengths.push('tools')
                        if (modelGen.type.supported?.includes('video')) strengths.push('video')
                    }
                    
                    // Parse params mapping for specialized outputs/inputs
                    if (modelGen.params && Array.isArray(modelGen.params)) {
                        for (const param of modelGen.params) {
                            if (param.key === 'max_tokens' && param.maxValue) {
                                // this is max output tokens
                            }
                            if (param.key === 'response_format') {
                                // If true json_schema represents deep structured output capability
                                const hasJsonSchema = param.options?.some((opt: any) => opt.value === 'json_schema')
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
                console.error(`Portkey sync error for ${provider}`, err)
            }
        }

        // Paginated upserts to bound memory/connection usage (GAP-004)
        const BATCH_SIZE = 50
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE)
            await Promise.all(batch.map(record => 
                db.insert(modelsKnowledge).values({
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
            ))
        }

        console.log(`Synced ${records.length} Portkey models into knowledge base across ${ALLOWED_PROVIDERS.length} providers.`)
    } catch (err) {
        console.error('Failed to sync model knowledge', err)
    }
}
