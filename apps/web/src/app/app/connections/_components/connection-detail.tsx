// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import Image from 'next/image'
import {
    Link2, ExternalLink, Trash2, ToggleLeft, ToggleRight, Wrench,
    LayoutDashboard, Settings, Code2, Link as LinkIcon, MessageSquare,
    Globe2, CheckCircle2, AlertCircle, RefreshCw, TestTube, Key,
} from 'lucide-react'
import { AuthBadge, StatusDot, CopySnippet, categoryColor } from './badges'
import type { RegistryItem, InstalledConnection, LiveTool, ChannelSummary, DetailTab } from './types'

interface Props {
    selected: RegistryItem
    connectedItem: InstalledConnection | null
    isConnected: boolean
    activeTab: DetailTab
    setActiveTab: (t: DetailTab) => void
    installing: boolean
    disconnecting: boolean
    WS_ID: string
    testing: string | null
    testResult: Record<string, { ok: boolean; status: number; statusText: string } | null>
    onTest: (id: string) => void
    fieldValues: Record<string, string>
    setFieldValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
    liveTools: LiveTool[] | null
    loadingLiveTools: boolean
    hasLiveTools: boolean
    allTools: string[]
    enabledTools: string[] | null
    savingTools: boolean
    linkedChannels: ChannelSummary[]
    onInstall: () => void
    onDisconnect: () => void
    onToggleTool: (toolName: string, shortName: string) => void
    onReadOnly: () => void
    onEnableAll: () => void
}

export default function ConnectionDetail({
    selected, connectedItem, isConnected, activeTab, setActiveTab,
    installing, disconnecting, WS_ID,
    testing, testResult, onTest,
    fieldValues, setFieldValues,
    liveTools, loadingLiveTools, hasLiveTools, allTools, enabledTools,
    savingTools, linkedChannels,
    onInstall, onDisconnect, onToggleTool, onReadOnly, onEnableAll,
}: Props) {
    return (
        <>
            {/* Detail header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 border-b border-border">
                <div className="flex items-start gap-3">
                    {selected.logoUrl ? (
                        <Image src={selected.logoUrl} alt={selected.name} width={40} height={40} className="mt-1 sm:mt-0 rounded-sm object-contain bg-white/5 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    ) : (
                        <div className="h-10 w-10 mt-1 sm:mt-0 rounded-sm bg-surface-2 flex items-center justify-center text-sm font-medium text-text-secondary shrink-0">
                            {selected.name.slice(0, 2).toUpperCase()}
                        </div>
                    )}
                    <div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-medium text-text-primary">{selected.name}</h2>
                            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${categoryColor(selected.category)}`}>
                                {selected.category}
                            </span>
                            <AuthBadge type={selected.authType} />
                            {selected.mcpPackage && (
                                <span className="inline-flex items-center gap-1 rounded-sm border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[11px] font-medium text-rose-400">
                                    <Code2 className="h-2.5 w-2.5" />
                                    MCP
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            {isConnected && connectedItem && (
                                <>
                                    <StatusDot status={connectedItem.status} />
                                    <span className="text-xs text-azure">Connected</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                    {isConnected && connectedItem && (
                        <button
                            onClick={() => onTest(connectedItem.id)}
                            disabled={testing === connectedItem.id}
                            title={testResult[connectedItem.id]
                                ? testResult[connectedItem.id]!.ok
                                    ? `OK — ${testResult[connectedItem.id]!.statusText}`
                                    : `Failed: ${testResult[connectedItem.id]!.statusText}`
                                : 'Test connection'}
                            className="flex items-center justify-center gap-1 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 flex-1 sm:flex-initial"
                        >
                            {testing === connectedItem.id ? (
                                <RefreshCw className="h-3 w-3 animate-spin" />
                            ) : testResult[connectedItem.id]?.ok ? (
                                <CheckCircle2 className="h-3 w-3 text-azure" />
                            ) : testResult[connectedItem.id] && !testResult[connectedItem.id]?.ok ? (
                                <AlertCircle className="h-3 w-3 text-red" />
                            ) : (
                                <TestTube className="h-3 w-3" />
                            )}
                            Test
                        </button>
                    )}
                    {selected.docUrl && (
                        <a
                            href={selected.docUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-1 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors min-h-[44px] sm:min-h-0 flex-1 sm:flex-initial"
                        >
                            <ExternalLink className="h-3 w-3" />
                            Docs
                        </a>
                    )}
                    {isConnected ? (
                        <button
                            onClick={onDisconnect}
                            disabled={disconnecting}
                            className="flex items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-red hover:border-red-700 hover:bg-red-dim/50 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 flex-1 sm:flex-initial whitespace-nowrap"
                        >
                            <Trash2 className="h-3 w-3" />
                            {disconnecting ? 'Removing…' : 'Disconnect'}
                        </button>
                    ) : (
                        <button
                            onClick={onInstall}
                            disabled={installing || !WS_ID}
                            className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 sm:px-3 sm:py-1.5 text-sm sm:text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 flex-[2] sm:flex-initial"
                        >
                            <Link2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                            {installing ? 'Connecting…' : 'Connect'}
                        </button>
                    )}
                </div>
            </div>

            {/* Tabs (only shown when connected) */}
            {isConnected && (
                <div className="flex gap-0 border-b border-border">
                    {([
                        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
                        { id: 'tools', label: 'Tools', icon: Wrench },
                        { id: 'config', label: 'Config', icon: Settings },
                    ] as const).map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setActiveTab(id)}
                            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === id
                                ? 'border-azure text-azure'
                                : 'border-transparent text-text-muted hover:text-text-secondary'
                                }`}
                        >
                            <Icon className="h-3.5 w-3.5" />
                            {label}
                        </button>
                    ))}
                </div>
            )}

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-5">
                {(!isConnected || activeTab === 'overview') && (
                    <div className="flex flex-col gap-5">
                        <p className="text-sm text-text-secondary">{selected.description}</p>

                        {isConnected && connectedItem && (
                            <div className="rounded-sm border border-border bg-surface-1/60 p-4 flex flex-col gap-2">
                                <p className="text-xs font-medium text-text-muted uppercase tracking-wider">Integration details</p>
                                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 sm:gap-y-1.5 text-sm">
                                    <div>
                                        <dt className="text-text-muted text-[11px] sm:text-xs">Status</dt>
                                        <dd className="flex items-center gap-1.5">
                                            <StatusDot status={connectedItem.status} />
                                            <span className="text-text-secondary capitalize">{connectedItem.status}</span>
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-text-muted text-[11px] sm:text-xs">Connected</dt>
                                        <dd className="text-text-secondary">{new Date(connectedItem.createdAt).toLocaleDateString()}</dd>
                                    </div>
                                    {connectedItem.lastVerifiedAt && (
                                        <div>
                                            <dt className="text-text-muted text-[11px] sm:text-xs">Last verified</dt>
                                            <dd className="text-text-secondary">{new Date(connectedItem.lastVerifiedAt).toLocaleDateString()}</dd>
                                        </div>
                                    )}
                                    {connectedItem.scopesGranted.length > 0 && (
                                        <div className="sm:col-span-2">
                                            <dt className="text-text-muted text-[11px] sm:text-xs">Scopes</dt>
                                            <dd className="text-text-secondary">{connectedItem.scopesGranted.join(', ')}</dd>
                                        </div>
                                    )}
                                </dl>
                            </div>
                        )}

                        {isConnected && connectedItem && testResult[connectedItem.id] && !testResult[connectedItem.id]?.ok && (
                            <div className="rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 flex items-start gap-2">
                                <AlertCircle className="h-3.5 w-3.5 text-red shrink-0 mt-0.5" />
                                <span className="text-xs text-red">{testResult[connectedItem.id]!.statusText || 'Connection test failed'}</span>
                            </div>
                        )}

                        {isConnected && connectedItem && testResult[connectedItem.id]?.ok && (
                            <div className="rounded-sm border border-green-800/50 bg-green-500/10 px-3 py-2.5 flex items-start gap-2">
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" />
                                <span className="text-xs text-green-400">
                                    {testResult[connectedItem.id]!.statusText
                                        ? `Connection OK — ${testResult[connectedItem.id]!.statusText}`
                                        : 'Connection OK'}
                                </span>
                            </div>
                        )}

                        {!isConnected && (selected.setupFields ?? []).length > 0 && (
                            <div className="flex flex-col gap-3">
                                <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">Configuration</h3>
                                {selected.setupFields.map((field) => (
                                    <div key={field.key} className="flex flex-col gap-1">
                                        <div className="flex items-center justify-between">
                                            <label className="text-sm font-medium text-text-secondary">
                                                {field.label} {field.required && <span className="text-red">*</span>}
                                            </label>
                                            {field.tokenUrl && (
                                                <a
                                                    href={field.tokenUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1 text-[11px] text-azure hover:text-azure transition-colors"
                                                >
                                                    <ExternalLink className="h-3 w-3" />
                                                    Create token
                                                </a>
                                            )}
                                        </div>
                                        <input
                                            type={field.type === 'password' ? 'password' : 'text'}
                                            value={fieldValues[field.key] ?? ''}
                                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                            placeholder={field.placeholder ?? ''}
                                            className="min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                        />
                                    </div>
                                ))}
                            </div>
                        )}

                        {!isConnected && selected.authType === 'oauth2' && (
                            <div className="rounded-sm border border-azure-800/40 bg-azure-dim px-3 py-3 text-xs text-azure">
                                <p className="font-medium mb-1">OAuth2 — secure redirect flow</p>
                                <p className="text-azure">Clicking Connect will open a popup to authenticate with {selected.name}. Requires <code className="text-azure/80">{selected.id.toUpperCase().replace('-', '_')}_CLIENT_ID</code> set in the API environment.</p>
                            </div>
                        )}

                        {linkedChannels.length > 0 && (
                            <div className="rounded-sm border border-teal-800/30 bg-surface-2 px-3 py-3 flex flex-col gap-1.5">
                                <p className="text-xs font-medium text-teal-400 flex items-center gap-1.5">
                                    <MessageSquare className="h-3.5 w-3.5" />
                                    {linkedChannels.length === 1 ? 'Channel adapter active' : `${linkedChannels.length} channel adapters active`}
                                </p>
                                <div className="flex flex-col gap-1">
                                    {linkedChannels.map((ch) => (
                                        <div key={ch.id} className="flex items-center justify-between gap-3">
                                            <span className="text-[11px] text-teal-400/70 truncate">{ch.name}</span>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <a
                                                    href={`/app/channels/${ch.id}`}
                                                    className="flex items-center gap-1 text-[11px] text-teal-400 hover:text-teal-300 transition-colors"
                                                >
                                                    Open in Plexo viewer
                                                    <ExternalLink className="h-3 w-3" />
                                                </a>
                                                <span className={`text-[11px] font-medium ${ch.enabled ? 'text-azure' : 'text-text-muted'}`}>
                                                    {ch.enabled ? 'enabled' : 'disabled'}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <a
                                    href="/app/settings/channels"
                                    className="flex items-center gap-1 text-[11px] text-teal-400 hover:text-teal-300 transition-colors mt-0.5"
                                >
                                    <LinkIcon className="h-3 w-3" />
                                    Manage in Channels →
                                </a>
                            </div>
                        )}

                        {!isConnected && selected.authType === 'api_key' && selected.mcpPackage && (
                            <div className="rounded-sm border border-rose-800/30 bg-red-dim px-3 py-3 flex flex-col gap-1.5">
                                <p className="text-xs font-medium text-rose-400 flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" /> Plexo manages the MCP integration</p>
                                <p className="text-[11px] text-rose-400/70 leading-relaxed">
                                    After you save your token, Plexo automatically adds <code className="text-rose-300">{selected.mcpPackage}</code> to the agent&apos;s MCP runtime. No manual config editing required.
                                </p>
                            </div>
                        )}

                        {allTools.length > 0 && (
                            <div>
                                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Tools provided</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {allTools.map((t) => (
                                        <span key={t} className="rounded border border-border bg-surface-2/60 px-2 py-0.5 text-xs text-text-secondary font-mono">{t}</span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {selected.oauthScopes.length > 0 && (
                            <div>
                                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">OAuth scopes requested</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {selected.oauthScopes.map((s) => (
                                        <span key={s} className="rounded border border-border bg-surface-2/60 px-2 py-0.5 text-xs text-text-secondary font-mono">{s}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {isConnected && activeTab === 'tools' && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-text-muted">
                                Every tool this integration provides is enabled by default.
                                Toggle individual tools off here — disabled tools are hidden from
                                the agent on the next task. In-flight tasks keep their current tool set.
                            </p>
                            {(savingTools || loadingLiveTools) && <RefreshCw className="h-3.5 w-3.5 text-text-muted animate-spin shrink-0 ml-2" />}
                        </div>

                        {hasLiveTools && liveTools!.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={onReadOnly}
                                    disabled={savingTools}
                                    className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-surface-2/60 px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-60"
                                    title="Disable every tool that writes/creates/updates/deletes/sends data"
                                >
                                    <Key className="h-3 w-3" />
                                    Read-only mode
                                </button>
                                <button
                                    onClick={onEnableAll}
                                    disabled={savingTools || enabledTools === null}
                                    className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-surface-2/60 px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-60"
                                    title="Re-enable every tool for this integration"
                                >
                                    <CheckCircle2 className="h-3 w-3" />
                                    Enable all
                                </button>
                            </div>
                        )}

                        {!hasLiveTools && loadingLiveTools ? (
                            <p className="text-sm text-text-muted">Loading tools…</p>
                        ) : !hasLiveTools || liveTools!.length === 0 ? (
                            <p className="text-sm text-text-muted">This integration provides no agent tools.</p>
                        ) : (
                            <div className="flex flex-col gap-1">
                                {liveTools!.map((t) => {
                                    const enabled = t.enabled
                                    return (
                                        <button
                                            key={t.name}
                                            onClick={() => onToggleTool(t.name, t.shortName)}
                                            disabled={savingTools}
                                            title={t.name}
                                            className={`flex items-start justify-between gap-3 min-h-[48px] rounded-sm border px-3 py-2.5 text-left transition-all disabled:opacity-60 ${enabled
                                                ? 'border-border/60 bg-surface-1/60 hover:border-border'
                                                : 'border-border/40 bg-surface-1/20 opacity-60 hover:opacity-80'
                                                }`}
                                        >
                                            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <Wrench className="h-3.5 w-3.5 text-text-muted shrink-0" />
                                                    <span className="text-sm font-mono text-text-secondary truncate">{t.shortName}</span>
                                                    {t.isWrite && (
                                                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-400 shrink-0">
                                                            write
                                                        </span>
                                                    )}
                                                    {t.stub && (
                                                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-muted shrink-0">
                                                            stub
                                                        </span>
                                                    )}
                                                </div>
                                                {t.description && (
                                                    <span className="text-[11px] text-text-muted line-clamp-2">{t.description}</span>
                                                )}
                                            </div>
                                            {enabled
                                                ? <ToggleRight className="h-6 w-6 sm:h-5 sm:w-5 text-azure shrink-0 mt-0.5" />
                                                : <ToggleLeft className="h-6 w-6 sm:h-5 sm:w-5 text-text-muted shrink-0 mt-0.5" />
                                            }
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                        <p className="text-xs text-text-muted mt-1">
                            {hasLiveTools
                                ? (enabledTools === null
                                    ? `All ${liveTools!.length} tools enabled`
                                    : `${liveTools!.filter((t) => t.enabled).length} / ${liveTools!.length} tools enabled`)
                                : ''
                            }
                        </p>

                        {selected.mcpPackage && (
                            <div className="mt-3 flex flex-col gap-2">
                                <div className="flex items-center gap-1.5">
                                    <Code2 className="h-3.5 w-3.5 text-rose-400" />
                                    <p className="text-xs font-medium text-text-secondary">Managed MCP config</p>
                                    <span className="text-[11px] text-text-muted">— Plexo writes this for you</span>
                                </div>
                                <CopySnippet code={JSON.stringify({
                                    [selected.id]: {
                                        command: 'npx',
                                        args: ['-y', selected.mcpPackage, 'stdio'],
                                        env: {
                                            [`${selected.id.toUpperCase().replace(/-/g, '_')}_PERSONAL_ACCESS_TOKEN`]: '*** stored securely ***',
                                        }
                                    }
                                }, null, 2)} />
                                <p className="text-[11px] text-text-muted">The actual token is stored encrypted in the database and injected at agent runtime. It is never written to disk.</p>
                            </div>
                        )}
                    </div>
                )}

                {isConnected && activeTab === 'config' && (
                    <div className="flex flex-col gap-4">
                        {(selected.setupFields ?? []).length > 0 ? (
                            <>
                                <p className="text-xs text-text-muted">Update credentials for this integration.</p>
                                {selected.setupFields.map((field) => (
                                    <div key={field.key} className="flex flex-col gap-1">
                                        <label className="text-sm font-medium text-text-secondary">
                                            {field.label}
                                        </label>
                                        <input
                                            type={field.type === 'password' ? 'password' : 'text'}
                                            value={fieldValues[field.key] ?? ''}
                                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                            placeholder="Leave blank to keep current value"
                                            className="min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                        />
                                    </div>
                                ))}
                            </>
                        ) : selected.authType === 'oauth2' ? (
                            <div className="flex flex-col gap-2">
                                <p className="text-sm text-text-secondary">OAuth2 integration — no manual credentials required.</p>
                                <div className="rounded-sm border border-border bg-surface-1/60 px-3 py-2 flex items-center gap-2">
                                    <Globe2 className="h-4 w-4 text-azure" />
                                    <span className="text-xs text-text-muted">Scopes: {connectedItem?.scopesGranted.join(', ') || 'none recorded'}</span>
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-text-muted">No configuration fields for this integration.</p>
                        )}
                    </div>
                )}
            </div>
        </>
    )
}
