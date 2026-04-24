// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth route handler — mounts the auth API at /api/auth/*.
 *
 * The next.config.ts rewrite intentionally excludes /api/auth so these
 * requests stay in this Next.js app rather than being proxied to plexo-ops.
 */

import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@web/lib/auth'

export const runtime = 'nodejs'

export const { GET, POST } = toNextJsHandler(getAuth().handler)
