// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Supabase Auth — shared joeybuilt-platform instance
 *
 * Replaces the previous NextAuth setup. All Joeybuilt apps use the same
 * Supabase auth project for a unified user identity.
 */

export { createClient as createServerClient } from './lib/supabase/server'
export { createClient as createBrowserClient } from './lib/supabase/client'
