// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §16 — Personal Entity Schema
 * Plexo Fabric Specification v0.4.0
 *
 * Standard first-class personal entity types all Plexo Fabric-compatible hosts
 * must support. When multiple Extensions reference the same person, task,
 * or thread, entity resolution prevents fragmentation.
 *
 * Rules:
 *   - Entity IDs are host-scoped UUIDs, stable across sessions
 *   - Extensions reference entities by ID — no duplicating entity data
 *   - Hosts MUST provide a resolution API: entities.resolve(type, id)
 *     and entities.search(type, query)
 *   - Extensions MAY create new entities with entity:create:<type> capability
 *   - Cross-entity linking uses linkedEntities[] — a typed reference array
 */

import type { EntityTypeName } from './manifest.js'

// ---------------------------------------------------------------------------
// Linked Entity Reference
// ---------------------------------------------------------------------------

export interface LinkedEntity {
    type: EntityTypeName
    id: string
}

// ---------------------------------------------------------------------------
// Core Entity Types
// ---------------------------------------------------------------------------

export interface PersonEntity {
    id: string
    name: string
    email?: string[]
    phone?: string[]
    tags?: string[]
    source?: string
    linkedEntities?: LinkedEntity[]
}

export interface TaskEntity {
    id: string
    title: string
    status: string
    due?: string           // ISO 8601
    assignee?: string      // Person entity ID
    tags?: string[]
    linkedEntities?: LinkedEntity[]
}

export interface ThreadEntity {
    id: string
    participants: string[] // Person entity IDs
    subject?: string
    channel?: string       // Channel extension name or ID
    lastActivity?: string  // ISO 8601
    linkedEntities?: LinkedEntity[]
}

export interface NoteEntity {
    id: string
    body: string
    tags?: string[]
    createdAt: string      // ISO 8601
    linkedEntities?: LinkedEntity[]
}

export interface TransactionEntity {
    id: string
    amount: number
    currency: string
    direction: 'inbound' | 'outbound'
    merchant?: string
    category?: string
    date: string           // ISO 8601
    tags?: string[]
    linkedEntities?: LinkedEntity[]
}

export interface CalendarEventEntity {
    id: string
    title: string
    start: string          // ISO 8601
    end: string            // ISO 8601
    attendees?: string[]   // Person entity IDs
    location?: string
    tags?: string[]
    linkedEntities?: LinkedEntity[]
}

export interface FileEntity {
    id: string
    name: string
    type: string
    mimeType?: string
    sizeBytes?: number
    capturedAt?: string    // ISO 8601
    source?: string
    tags?: string[]
    storageUri?: string
    checksum?: string
    linkedEntities?: LinkedEntity[]
}

// ---------------------------------------------------------------------------
// Entity Union & Type Map
// ---------------------------------------------------------------------------

export type PlexoEntity =
    | PersonEntity
    | TaskEntity
    | ThreadEntity
    | NoteEntity
    | TransactionEntity
    | CalendarEventEntity
    | FileEntity

/** @deprecated Use PlexoEntity instead. */
export type KapselEntity = PlexoEntity

/** Maps entity type names to their TypeScript interfaces */
export interface EntityTypeMap {
    person: PersonEntity
    task: TaskEntity
    thread: ThreadEntity
    note: NoteEntity
    transaction: TransactionEntity
    calendar_event: CalendarEventEntity
    file: FileEntity
}

// ---------------------------------------------------------------------------
// Entity Resolution API (Host-provided)
// ---------------------------------------------------------------------------

export interface EntitySearchQuery {
    text?: string
    tags?: string[]
    limit?: number
    offset?: number
}

export interface EntitySearchResult<T extends PlexoEntity = PlexoEntity> {
    entities: T[]
    total: number
    hasMore: boolean
}
