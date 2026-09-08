// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the routing-event port (Stage 3). The only telemetry
 * module permitted to import the ORM. The INSERT is unchanged from the one
 * that used to sit in `providers/router-v2/telemetry.ts`.
 */

import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'
import type { RoutingEventStore, RoutingEventRecord } from './routing-events.ports.js'

export class DrizzleRoutingEventStore implements RoutingEventStore {
    async append(event: RoutingEventRecord): Promise<void> {
        await db.execute(sql`
            INSERT INTO routing_events
                (workspace_id, task_id, task_type, provider, model, fallback_engaged, selector_duration_ms, shadow_model_choice, model_routed)
            VALUES (
                ${event.workspaceId},
                ${event.taskId},
                ${event.taskType},
                ${event.provider},
                ${event.model},
                ${event.fallbackEngaged},
                ${event.selectorDurationMs},
                ${event.shadowModelChoice},
                ${event.modelRouted}
            )
        `)
    }
}
