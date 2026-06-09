// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §5) — PEX contract version.
 *
 * Single source of truth for the protocol/contract version the SDK speaks. The
 * server advertises its own; connect() negotiates to a common MAJOR. Minor /
 * additive skew is tolerated (ignore-unknown JSON fields), so an older app keeps
 * working against a newer server within the same major.
 *
 * This file MUST stay dependency-free (the SDK is a pure shim — Guard A).
 */
export const PEX_CONTRACT_VERSION = '0.4.0'

function major(version: string): number {
    const n = Number.parseInt((version ?? '').split('.')[0] ?? '', 10)
    return Number.isNaN(n) ? -1 : n
}

/**
 * Two contract versions are compatible iff they share a major version.
 * Returns false for unparseable input (fail-loud at the call site).
 */
export function isContractCompatible(clientVersion: string, serverVersion: string): boolean {
    const a = major(clientVersion)
    const b = major(serverVersion)
    return a >= 0 && a === b
}
