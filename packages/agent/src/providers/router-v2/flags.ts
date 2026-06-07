// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 — model-level router feature flags (db-free so both the pure
 * selector and the db-backed shadow path can import them). ADR 0006.
 */

/**
 * Serving flip (default OFF). When ON, the model-level router's pick is actually
 * served (Phase 2 selector integration). Stays OFF in prod until Phase 5.
 */
export function isModelRouterEnabled(): boolean {
    return process.env.PLEXO_MODEL_ROUTER === '1'
}

/**
 * Observe-only shadow logging (default OFF). Distinct from the serving flip so
 * shadow would-pick data can accrue in prod (Phases 1–4) with the served model
 * UNCHANGED. The serving flip implies shadow too.
 */
export function isShadowLoggingEnabled(): boolean {
    return process.env.PLEXO_MODEL_ROUTER_SHADOW === '1' || isModelRouterEnabled()
}
