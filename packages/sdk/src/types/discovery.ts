// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §25 — Kapsel-Native Service Discovery
 * Kapsel Protocol Specification v0.3.0
 *
 * Any service supporting Kapsel natively MUST expose:
 *   GET /.well-known/kapsel.json
 *
 * Detection flow:
 *   1. User initiates a Connection to an external service
 *   2. Host pings {serviceBaseUrl}/.well-known/kapsel.json
 *   3. Valid manifest → Kapsel-native: verify DID, surface shield badge,
 *      full disclosure pre-connection
 *   4. 404 or invalid → Standard Connection: no badge, OAuth/API key fallback,
 *      manual trust assumed
 *
 * Rules:
 *   - MUST be served over HTTPS, publicly accessible, no authentication required
 *   - MUST return Content-Type: application/json
 *   - Response MUST validate against Kapsel manifest schema
 *   - DID MUST resolve via Kapsel Registry
 */

export interface WellKnownKapsel {
    /** Kapsel protocol version (e.g. '0.3.0') */
    kapsel: string
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
 * Result of a Kapsel-native service discovery probe.
 */
export type ServiceDiscoveryResult =
    | { native: true; manifest: WellKnownKapsel }
    | { native: false; reason: 'not_found' | 'invalid_manifest' | 'network_error' }
