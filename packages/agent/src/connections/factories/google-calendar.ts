// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Calendar tool factory — calendar-only subset of the Google Workspace tools.
 *
 * Tools: gcal__list_calendars, gcal__list_events, gcal__create_event, gcal__update_event, gcal__delete_event
 *
 * Auth: OAuth2 access_token with Calendar scope only.
 * Delegates to GOOGLE_WORKSPACE_TOOLS and re-exports under the gcal__ prefix.
 */

import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import { GOOGLE_WORKSPACE_TOOLS } from './google-workspace.js'

export const GOOGLE_CALENDAR_TOOLS = (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): ToolSet => {
    const gws = GOOGLE_WORKSPACE_TOOLS(creds, opts)
    return {
        gcal__list_calendars: gws.gws__list_calendars,
        gcal__list_events: gws.gws__list_events,
        gcal__create_event: gws.gws__create_event,
        gcal__update_event: gws.gws__update_event,
        gcal__delete_event: gws.gws__delete_event,
    }
}
