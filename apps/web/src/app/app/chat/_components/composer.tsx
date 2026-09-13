// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { forwardRef, useState } from 'react'
import { Send, RefreshCw, Mic, MicOff, Volume2, Image as ImageIcon, X, FileText, ChevronDown, ChevronUp, MessageSquareText, Brain } from 'lucide-react'
import type { PastedImage, PastedDocument } from '@web/lib/attachments'

export interface ProviderModelOption {
    /** Stable value sent to the API: `<providerType>/<modelId>` or bare `<modelId>`. */
    value: string
    /** Display label, e.g. `OpenAI / gpt-4o`. */
    label: string
    /**
     * True for the workspace's primary (highest-preference enabled) provider's
     * selected model. The empty-value "Default (agent)" option resolves to this
     * one, so we surface its name instead of an opaque placeholder.
     */
    isDefault?: boolean
}

interface ComposerProps {
    input: string
    setInput: (s: string) => void
    onSend: () => void
    sending: boolean
    pastedImages: PastedImage[]
    pastedDocs: PastedDocument[]
    onRemoveImage: (id: string) => void
    onRemoveDoc: (id: string) => void
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
    onFileInputClick: () => void
    fileInputRef: React.RefObject<HTMLInputElement | null>
    onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
    voiceSupported: boolean
    isListening: boolean
    onVoiceToggle: () => void
    isLiveMode: boolean
    onLiveModeToggle: () => void
    /** DD-5: workspace-configured provider/model rows for the picker. Empty = none configured. */
    modelOptions?: ProviderModelOption[]
    /** DD-5: current per-conversation model override; null = use agent default. */
    modelOverride?: string | null
    onModelOverrideChange?: (v: string | null) => void
    /** DD-5: current per-conversation system-prompt override; empty = use compiled default. */
    systemPromptOverride?: string
    onSystemPromptOverrideChange?: (v: string) => void
    /** DD-5: fired on textarea blur so the page can PATCH the persisted override. */
    onSystemPromptOverrideBlur?: () => void
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({
    input, setInput, onSend, sending,
    pastedImages, pastedDocs, onRemoveImage, onRemoveDoc,
    onPaste, onDrop, onKeyDown,
    onFileInputClick, fileInputRef, onFileInputChange,
    voiceSupported, isListening, onVoiceToggle,
    isLiveMode, onLiveModeToggle,
    modelOptions = [],
    modelOverride = null,
    onModelOverrideChange,
    systemPromptOverride = '',
    onSystemPromptOverrideChange,
    onSystemPromptOverrideBlur,
}, inputRef) {
    const placeholder = isListening ? 'Listening…' : 'Message your agent…'
    const [showSystemPrompt, setShowSystemPrompt] = useState(false)
    const hasModelPicker = modelOptions.length > 0 && onModelOverrideChange
    const hasSystemPromptControl = !!onSystemPromptOverrideChange
    // Surface what "Default (agent)" actually routes to, so the picker is never
    // an opaque placeholder. Falls back to the generic label when the workspace
    // has no primary row yet.
    const defaultOption = modelOptions.find((o) => o.isDefault)
    const defaultLabel = defaultOption ? `Default (agent) — ${defaultOption.label}` : 'Default (agent)'

    return (
        <>
            {(hasModelPicker || hasSystemPromptControl) && (
                <div className="flex flex-wrap items-center gap-2 px-1">
                    {hasModelPicker && (
                        <label className="flex items-center gap-1.5 text-xs text-text-muted">
                            <Brain className="h-3.5 w-3.5 shrink-0" />
                            <span>Model</span>
                            <select
                                value={modelOverride ?? ''}
                                onChange={(e) => onModelOverrideChange!(e.target.value || null)}
                                disabled={sending}
                                className="rounded-sm border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-dim disabled:opacity-50 max-w-[220px] truncate"
                                aria-label="Model override"
                            >
                                <option value="">{defaultLabel}</option>
                                {modelOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </label>
                    )}
                    {hasSystemPromptControl && (
                        <button
                            type="button"
                            onClick={() => setShowSystemPrompt((v) => !v)}
                            aria-label={showSystemPrompt ? 'Hide system prompt' : 'Edit system prompt'}
                            aria-expanded={showSystemPrompt}
                            className={`flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-all border ${
                                systemPromptOverride.trim()
                                    ? 'bg-azure/10 text-azure border-azure/20'
                                    : 'text-text-muted border-border bg-surface-1 hover:text-text-secondary'
                            }`}
                        >
                            <MessageSquareText className="h-3.5 w-3.5" />
                            <span>System prompt</span>
                            {showSystemPrompt ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </button>
                    )}
                </div>
            )}

            {showSystemPrompt && hasSystemPromptControl && (
                <div className="px-1">
                    <textarea
                        value={systemPromptOverride}
                        onChange={(e) => onSystemPromptOverrideChange!(e.target.value)}
                        onBlur={onSystemPromptOverrideBlur}
                        placeholder="System prompt override — leave empty to use the compiled behavior prompt. Your text is PREPENDED to the default so identity/capabilities stay intact."
                        rows={4}
                        disabled={sending}
                        aria-label="System prompt override"
                        className="w-full resize-y rounded border border-border bg-surface-1 px-3 py-2 text-xs font-mono text-text-primary placeholder:text-text-muted placeholder:font-mono focus:outline-none focus:border-accent-dim focus:ring-1 focus:ring-accent/20 disabled:opacity-50 max-h-48 leading-relaxed"
                    />
                </div>
            )}

            {(pastedImages.length > 0 || pastedDocs.length > 0) && (
                <div className="flex flex-wrap gap-2 px-1">
                    {pastedImages.map((img) => (
                        <div key={img.id} className="relative group">
                            {img.kind === 'image' ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={img.dataUrl}
                                    alt={img.name}
                                    className="h-20 w-20 rounded-sm border border-border object-cover"
                                />
                            ) : (
                                <div className="h-20 w-28 rounded-sm border border-border/60 bg-surface-2/60 flex flex-col items-center justify-center gap-1 px-2">
                                    <FileText className="h-6 w-6 text-azure shrink-0" />
                                    <span className="text-[11px] text-text-muted font-medium uppercase tracking-wide">{img.kind}</span>
                                    <span className="text-[11px] text-text-secondary truncate max-w-full px-1 text-center leading-tight">{img.name}</span>
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => onRemoveImage(img.id)}
                                aria-label="Remove image"
                                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-surface-2 border border-border flex items-center justify-center text-text-secondary hover:text-text-primary transition-all sm:opacity-0 sm:group-hover:opacity-100"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ))}
                    {pastedDocs.map((doc) => (
                        <div key={doc.id} className="relative group flex items-center gap-2 rounded-sm border border-border bg-surface-2/60 px-3 py-2 text-xs text-text-secondary">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                            <p className="font-medium truncate max-w-[120px]">{doc.name}</p>
                            <button
                                type="button"
                                onClick={() => onRemoveDoc(doc.id)}
                                aria-label="Remove document"
                                className="h-5 w-5 rounded-full bg-surface-2 flex items-center justify-center sm:opacity-0 sm:group-hover:opacity-100"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex gap-2 items-end">
                {/* Voice + Live toggles — hidden on mobile, visible on md+ */}
                {voiceSupported && (
                    <button
                        onClick={onVoiceToggle}
                        disabled={sending}
                        aria-label={isListening ? 'Stop listening' : 'Start voice input'}
                        className={`hidden sm:flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-sm p-3 transition-all ${
                            isListening ? 'bg-red/20 text-red animate-pulse' : 'border border-border bg-surface-1 text-text-muted'
                        }`}
                    >
                        {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </button>
                )}
                <button
                    onClick={onFileInputClick}
                    disabled={sending || isListening}
                    aria-label="Attach file"
                    className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-sm p-3 border border-border bg-surface-1 text-text-muted"
                >
                    <ImageIcon className="h-4 w-4" />
                </button>
                <input ref={fileInputRef} type="file" accept="image/*,image/svg+xml,application/pdf" multiple className="hidden" onChange={onFileInputChange} />

                <button
                    onClick={onLiveModeToggle}
                    aria-label={isLiveMode ? 'Disable live mode' : 'Enable live mode'}
                    className={`relative hidden sm:flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-sm p-3 border transition-all ${
                        isLiveMode ? 'bg-amber-500/10 border-amber-500/40 text-amber-500' : 'border-border bg-surface-1 text-text-muted'
                    }`}
                >
                    <Volume2 className={`h-4 w-4 ${isLiveMode ? 'animate-pulse' : ''}`} />
                    {isLiveMode && <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-amber-500" />}
                </button>

                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onDrop={onDrop}
                    onDragOver={(e) => e.preventDefault()}
                    placeholder={placeholder}
                    rows={1}
                    disabled={sending || isListening}
                    className="flex-1 resize-none rounded border border-border bg-surface-1 px-4 py-3.5 text-[16px] md:text-sm font-mono text-text-primary placeholder:text-text-muted placeholder:font-mono focus:outline-none focus:border-accent-dim focus:ring-1 focus:ring-accent/20 disabled:opacity-50 max-h-32 leading-relaxed transition-all"
                    style={{ minHeight: '48px' }}
                />

                <button
                    type="button"
                    onClick={onSend}
                    disabled={sending || (!input.trim() && pastedImages.length === 0 && pastedDocs.length === 0) || isListening}
                    aria-label={sending ? 'Sending…' : 'Send message'}
                    className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded bg-accent p-3 text-white hover:bg-accent-dim disabled:opacity-40 transition-colors"
                >
                    {sending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
            </div>
        </>
    )
})
