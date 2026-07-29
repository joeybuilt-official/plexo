// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — provider API-key registry for link enrichment.
//
// Subset of the catalog in
// apps/web/src/app/app/settings/intelligence/page.tsx, lifted into a
// JSX-free module so the enrichment patterns can read it without
// pulling lucide-react/the whole page into the bundle. When an
// instruction work mentions a known provider domain or name, we render
// an "Open <provider> keys" pill.

export interface ApiKeyProvider {
    id: string
    name: string
    /** Domains that uniquely identify this provider when seen in text. */
    domains: string[]
    /** Where the user goes to create an API key. */
    keyUrl: string
}

export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    {
        id: 'openai',
        name: 'OpenAI',
        domains: ['platform.openai.com', 'openai.com'],
        keyUrl: 'https://platform.openai.com/api-keys',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        domains: ['console.anthropic.com', 'anthropic.com'],
        keyUrl: 'https://console.anthropic.com/keys',
    },
    {
        id: 'google',
        name: 'Google AI',
        domains: ['aistudio.google.com', 'ai.google.dev'],
        keyUrl: 'https://aistudio.google.com/apikey',
    },
    {
        id: 'mistral',
        name: 'Mistral',
        domains: ['console.mistral.ai', 'mistral.ai'],
        keyUrl: 'https://console.mistral.ai/api-keys',
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        domains: ['platform.deepseek.com', 'deepseek.com'],
        keyUrl: 'https://platform.deepseek.com/api_keys',
    },
    {
        id: 'groq',
        name: 'Groq',
        domains: ['console.groq.com', 'groq.com'],
        keyUrl: 'https://console.groq.com/keys',
    },
    {
        id: 'xai',
        name: 'xAI',
        domains: ['console.x.ai', 'x.ai'],
        keyUrl: 'https://console.x.ai',
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        domains: ['openrouter.ai'],
        keyUrl: 'https://openrouter.ai/keys',
    },
    {
        id: 'together',
        name: 'Together AI',
        domains: ['api.together.xyz', 'together.ai'],
        keyUrl: 'https://api.together.xyz/settings/api-keys',
    },
    {
        id: 'fireworks',
        name: 'Fireworks AI',
        domains: ['fireworks.ai'],
        keyUrl: 'https://fireworks.ai/api-keys',
    },
    {
        id: 'perplexity',
        name: 'Perplexity',
        domains: ['perplexity.ai'],
        keyUrl: 'https://www.perplexity.ai/settings/api',
    },
    {
        id: 'cohere',
        name: 'Cohere',
        domains: ['dashboard.cohere.com', 'cohere.com'],
        keyUrl: 'https://dashboard.cohere.com/api-keys',
    },
    {
        id: 'sambanova',
        name: 'SambaNova',
        domains: ['cloud.sambanova.ai', 'sambanova.ai'],
        keyUrl: 'https://cloud.sambanova.ai/apis',
    },
    {
        id: 'cloudflare',
        name: 'Cloudflare Workers AI',
        domains: ['dash.cloudflare.com', 'cloudflare.com'],
        keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    },
    {
        id: 'cerebras',
        name: 'Cerebras',
        domains: ['cloud.cerebras.ai', 'cerebras.ai'],
        keyUrl: 'https://cloud.cerebras.ai/platform',
    },
    {
        id: 'notion',
        name: 'Notion',
        domains: ['notion.so', 'www.notion.so'],
        keyUrl: 'https://www.notion.so/my-integrations',
    },
    {
        id: 'hub',
        name: 'Plexo Hub',
        domains: ['hub.getplexo.com'],
        keyUrl: 'https://hub.getplexo.com',
    },
]

/** Find a provider whose domain appears in the given URL. */
export function matchProviderByUrl(url: string): ApiKeyProvider | null {
    const lower = url.toLowerCase()
    for (const p of API_KEY_PROVIDERS) {
        for (const d of p.domains) {
            if (lower.includes(d)) return p
        }
    }
    return null
}

/** Find a provider whose lowercase name appears in the text as a whole word. */
export function matchProviderByName(text: string): ApiKeyProvider | null {
    const lower = text.toLowerCase()
    for (const p of API_KEY_PROVIDERS) {
        const nameLower = p.name.toLowerCase()
        const re = new RegExp(`\\b${escapeRegex(nameLower)}\\b`)
        if (re.test(lower)) return p
    }
    return null
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
