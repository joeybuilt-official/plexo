// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Gmail tool factory — email-only subset of the Google Workspace tools.
 *
 * Tools: gmail__list_emails, gmail__read_email, gmail__send_email
 *
 * Auth: OAuth2 access_token with Gmail scopes only.
 * Delegates to GOOGLE_WORKSPACE_TOOLS and re-exports under the gmail__ prefix.
 */

import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import { GOOGLE_WORKSPACE_TOOLS } from './google-workspace.js'

export const GMAIL_TOOLS = (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): ToolSet => {
    const gws = GOOGLE_WORKSPACE_TOOLS(creds, opts)
    return {
        gmail__list_emails: gws.gws__list_emails,
        gmail__read_email: gws.gws__read_email,
        gmail__send_email: gws.gws__send_email,
    }
}
