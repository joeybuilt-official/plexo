// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §19 — Data Residency Declaration
 * Plexo Fabric Specification v0.4.0
 *
 * All Extensions MUST declare external data destinations in their manifest.
 *
 * Rules:
 *   - Extensions with sendsDataExternally: false making external HTTP calls
 *     MUST be flagged non-compliant at runtime
 *   - Hosts MAY enforce an allowlist of permitted external destinations
 *   - Omitted dataResidency field treated as sendsDataExternally: true with
 *     unknown destinations — blocked at Full compliance
 *   - Declaration surfaced verbatim to users at install
 */

import type { EntityTypeName } from './manifest.js'

export interface ExternalDestination {
    /** Hostname of the external service */
    host: string
    /** Human-readable purpose */
    purpose: string
    /** Entity types sent to this destination */
    dataTypes?: EntityTypeName[]
}

export interface DataResidencyDeclaration {
    sendsDataExternally: boolean
    externalDestinations?: ExternalDestination[]
}
