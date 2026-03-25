// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §25 — Plexo-Native Service Discovery
 * Plexo Fabric Specification v0.4.0
 *
 * Any service supporting Plexo natively MUST expose:
 *   GET /.well-known/plexo.json
 *
 * Detection flow:
 *   1. User initiates a Connection to an external service
 *   2. Host pings {serviceBaseUrl}/.well-known/plexo.json
 *   3. Valid manifest → Plexo-native: verify DID, surface shield badge,
 *      full disclosure pre-connection
 *   4. 404 or invalid → Standard Connection: no badge, OAuth/API key fallback,
 *      manual trust assumed
 *
 * Rules:
 *   - MUST be served over HTTPS, publicly accessible, no authentication required
 *   - MUST return Content-Type: application/json
 *   - Response MUST validate against Plexo manifest schema
 *   - DID MUST resolve via Extension Registry
 */

export interface WellKnownPlexo {
    /** Fabric spec version (e.g. '0.4.0') */
    plexo: string
    /** Service display name */
    name: string
    /** W3C DID of this service */
    did?: string
    capabilities: {
        /** Connection identifiers offered by this service */
        offered?: string[]
        /** Pre-built extensions available for this service */
        extensions?: WellKnownExtensionRef[]
    }
    dataResidency?: {
        sendsDataExternally: boolean
        regions?: string[]
    }
    auth: {
        schemes: ('oauth2' | 'api_key' | 'did')[]
        oauth2?: {
            authorizationUrl: string
            tokenUrl: string
        }
    }
    escalation?: {
        /** Whether this service supports escalation callback webhooks */
        supportsEscalationCallbacks: boolean
        webhookEndpoint?: string
    }
}

export interface WellKnownExtensionRef {
    /** Scoped extension name */
    name: string
    /** Registry URL where the extension is published */
    registry: string
}

/**
 * Result of a Plexo-native service discovery probe.
 */
export type ServiceDiscoveryResult =
    | { native: true; manifest: WellKnownPlexo }
    | { native: false; reason: 'not_found' | 'invalid_manifest' | 'network_error' }

/** @deprecated Use WellKnownPlexo instead. */
export type WellKnownKapsel = WellKnownPlexo
