// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapters for the memory-port extraction batch 1
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * The ONLY memory module in this batch permitted to import the ORM.
 */

import { db, memoryEntries } from '@plexo/db'
import { sql } from 'drizzle-orm'
import type {
    BehaviorRuleStore,
    BehaviorRuleInput,
    MemoryEntryStore,
    MemoryEntryInput,
} from './memory.ports.js'

export class DrizzleBehaviorRuleStore implements BehaviorRuleStore {
    async insertIfAbsent(record: BehaviorRuleInput): Promise<void> {
        await db.execute(sql`
            INSERT INTO behavior_rules
                (id, workspace_id, type, key, label, description, value, source, tags)
            VALUES
                (gen_random_uuid(), ${record.workspaceId}::uuid,
                 ${record.type}, ${record.key}, ${record.label}, ${record.description},
                 ${JSON.stringify(record.value)}::jsonb,
                 ${record.source}, ARRAY[${sql.join(record.tags.map((t) => sql`${t}`), sql`, `)}]::text[])
            ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
            DO NOTHING
        `)
    }

    async upsert(record: BehaviorRuleInput): Promise<void> {
        await db.execute(sql`
            INSERT INTO behavior_rules
                (id, workspace_id, type, key, label, description, value, source, tags)
            VALUES
                (gen_random_uuid(), ${record.workspaceId}::uuid,
                 ${record.type}, ${record.key}, ${record.label}, ${record.description},
                 ${JSON.stringify(record.value)}::jsonb,
                 ${record.source}, ARRAY[${sql.join(record.tags.map((t) => sql`${t}`), sql`, `)}]::text[])
            ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
            DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = now()
        `)
    }
}

export class DrizzleMemoryEntryStore implements MemoryEntryStore {
    async insert(record: MemoryEntryInput): Promise<void> {
        await db.insert(memoryEntries).values(record as typeof memoryEntries.$inferInsert)
    }

    async setEmbedding(id: string, embedding: number[]): Promise<void> {
        const vecStr = `[${embedding.join(',')}]`
        await db.execute(sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`)
    }
}
