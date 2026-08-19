// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export * from './schema'
export * from './pushd-schema'
export * from './gmessages-schema'
export { db, type Database } from './client'
// ADR-0045 Phase 2: drizzle operators are intentionally NOT re-exported here.
// Import operators (eq, and, sql, …) directly from 'drizzle-orm' in
// adapter/repository code — the ORM stays inside the adapter ring, so the
// barrel no longer couples every consumer to drizzle (the Dependency Rule).