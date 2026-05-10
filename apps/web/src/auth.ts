// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth — server + client re-exports
 *
 * Central barrel file so the rest of the app imports auth from one place.
 */

export { getAuth } from './lib/auth'
export { authClient } from './lib/auth-client'
