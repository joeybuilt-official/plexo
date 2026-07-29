// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Injection port for resolving a workspace user's IANA timezone.
 *
 * Connection & Profile Standard (ADR 0001): the core executor must stay
 * domain-agnostic and may NOT reach into a specific app's connector. The
 * timezone of the connected user is app-supplied data, so the composition
 * root (apps/api) wires a resolver at boot via `setUserTimezoneResolver`;
 * core calls through `resolveUserTimezone` without knowing the source.
 *
 * Unset (unit tests, agent-only contexts) → resolves null = no injection
 * (the prompt simply omits the timezone line, today's silent-no-op).
 */

export type UserTimezoneResolver = (workspaceId: string) => Promise<string | null>

let resolver: UserTimezoneResolver | null = null

export function setUserTimezoneResolver(r: UserTimezoneResolver | null): void {
    resolver = r
}

/** Resolve the user's IANA timezone for a workspace, or null if none/unavailable. Never throws. */
export async function resolveUserTimezone(workspaceId: string): Promise<string | null> {
    if (!resolver) return null
    try {
        return await resolver(workspaceId)
    } catch {
        return null
    }
}
