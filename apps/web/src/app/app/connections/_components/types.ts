// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export type AuthType = 'oauth2' | 'api_key' | 'webhook' | 'none'
export type ConnectionStatus = 'active' | 'disconnected' | 'error'
export type DetailTab = 'overview' | 'tools' | 'config'

export interface ChannelSummary {
    id: string
    type: string
    name: string
    enabled: boolean
}

export interface SetupField {
    key: string
    label: string
    type: 'text' | 'password' | 'url'
    required?: boolean
    placeholder?: string
    tokenUrl?: string
}

export interface RegistryItem {
    id: string
    name: string
    description: string
    category: string
    logoUrl: string | null
    authType: AuthType
    oauthScopes: string[]
    setupFields: SetupField[]
    toolsProvided: string[]
    cardsProvided: string[]
    isCore: boolean
    docUrl: string | null
    mcpPackage?: string | null
    stub?: boolean
}

export interface InstalledConnection {
    id: string
    registryId: string
    name: string
    status: ConnectionStatus
    enabledTools: string[] | null
    scopesGranted: string[]
    lastVerifiedAt: string | null
    createdAt: string
}

export interface LiveTool {
    name: string
    shortName: string
    description: string
    isWrite: boolean
    stub: boolean
    enabled: boolean
}

export interface LiveToolsResponse {
    connectionId: string
    registryId: string
    allEnabled: boolean
    enabledTools: string[] | null
    tools: LiveTool[]
    total: number
    enabledCount: number
}

export const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

export const CHANNEL_TO_REGISTRY: Record<string, string> = {
    telegram: 'telegram',
    slack: 'slack',
    discord: 'discord',
    github: 'github',
    linear: 'linear',
    jira: 'jira',
    notion: 'notion',
}
