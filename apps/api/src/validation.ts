// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared validation constants for API routes.
 *
 * Consolidates the UUID_RE regex that was previously duplicated across 24+ route files.
 */

/** Standard UUID v4 regex (case-insensitive). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
