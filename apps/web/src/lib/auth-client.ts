// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth — browser client singleton.
 *
 * Thin wrapper around `createAuthClient` so UI code (signup, login,
 * forgot-password, account page) can import one typed handle from here.
 *
 * baseURL defaults to the current window origin; `/api/auth/*` is served
 * by the Next.js route handler in `apps/web/src/app/api/auth/[...all]/route.ts`.
 */

import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient()
