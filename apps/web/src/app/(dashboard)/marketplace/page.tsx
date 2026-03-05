import { cookies } from 'next/headers'
import MarketplaceClient from './MarketplaceClient'

interface RegistryItem {
    id: string
    name: string
    description: string
    category: string
    logo_url: string | null
    auth_type: string
    oauth_scopes: string[]
    setup_fields: Array<{ key: string; label: string; type: string }>
    tools_provided: string[]
    cards_provided: string[]
    is_core: boolean
    doc_url: string | null
}

interface InstalledItem {
    id: string
    registryId: string
    name: string
    status: 'active' | 'error' | 'expired' | 'disconnected'
}

interface KapselPlugin {
    id: string
    workspaceId: string
    name: string
    displayName: string
    description: string
    version: string
    type: string
    enabled: boolean
    installedAt: string
}

async function fetchMarketplaceData(workspaceId: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

    const [regRes, instRes, pluginsRes] = await Promise.all([
        fetch(`${apiBase}/api/v1/connections/registry`, { cache: 'no-store' })
            .catch(() => fetch(`${apiBase}/api/v1/connections/registry`, { cache: 'no-store' })),
        fetch(`${apiBase}/api/v1/connections/installed?workspaceId=${workspaceId}`, { cache: 'no-store' })
            .catch(() => fetch(`${apiBase}/api/v1/connections/installed?workspaceId=${workspaceId}`, { cache: 'no-store' })),
        fetch(`${apiBase}/api/v1/plugins?workspaceId=${workspaceId}`, { cache: 'no-store' }),
    ])

    const registry: RegistryItem[] = regRes.ok
        ? ((await regRes.json()) as { items: RegistryItem[] }).items
        : []

    const installed: InstalledItem[] = instRes.ok
        ? ((await instRes.json()) as { items: InstalledItem[] }).items
        : []

    const rawPlugins = pluginsRes.ok
        ? await pluginsRes.json() as unknown
        : []

    // API may return bare array, { items: [...] }, or { plugins: [...] }
    const plugins: KapselPlugin[] = Array.isArray(rawPlugins)
        ? (rawPlugins as KapselPlugin[])
        : Array.isArray((rawPlugins as { items?: unknown }).items)
            ? ((rawPlugins as { items: KapselPlugin[] }).items)
            : Array.isArray((rawPlugins as { plugins?: unknown }).plugins)
                ? ((rawPlugins as { plugins: KapselPlugin[] }).plugins)
                : []

    return { registry, installed, plugins }
}

export default async function MarketplacePage() {
    // Prefer the env var, but use a sensible default for dev
    const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
        ?? process.env.DEV_WORKSPACE_ID
        ?? '00000000-0000-0000-0000-000000000000'

    const { registry, installed, plugins } = await fetchMarketplaceData(workspaceId)

    return (
        <MarketplaceClient
            registry={registry}
            installed={installed}
            plugins={plugins}
            workspaceId={workspaceId}
        />
    )
}
