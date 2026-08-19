// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared bridge types — factored out of bridge.ts so that registry.ts and
 * individual factory files can import them without creating a circular load
 * with bridge.ts itself.
 */

export interface ConnectionCredentials {
    access_token?: string
    refresh_token?: string
    bot_token?: string
    secret_key?: string
    token?: string
    api_token?: string
    [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolSet = Record<string, any>

export type ToolFactory = (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
) => ToolSet | Promise<ToolSet>
