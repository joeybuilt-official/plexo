// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export type ProviderKey =
    | 'deepseek'
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'groq'
    | 'ollama'
    | string

export interface ProviderColorConfig {
    bg: string
    text: string
}

export const PROVIDER_COLOR_MAP: Record<string, ProviderColorConfig> = {
    deepseek: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
    anthropic: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
    openai: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
    google: { bg: 'bg-sky-500/15', text: 'text-sky-400' },
    groq: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
    ollama: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
}

export function getProviderColors(provider: string): ProviderColorConfig {
    const key = provider.toLowerCase() as ProviderKey
    return PROVIDER_COLOR_MAP[key] ?? { bg: 'bg-surface-2', text: 'text-text-muted' }
}

export function getProviderColorClass(provider: string): string {
    const { bg, text } = getProviderColors(provider)
    return `${bg} ${text}`
}