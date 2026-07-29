// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { SignJWT, jwtVerify } from 'jose'
import { logger } from '../logger.js'

const RUN_JWT_LIFETIME_S = 300

let cachedSecret: Uint8Array | null = null

function getSecret(): Uint8Array {
    if (cachedSecret) return cachedSecret
    const raw = process.env.PLEXO_RUN_JWT_SECRET
    if (!raw || raw.length < 32) {
        throw new Error(
            'PLEXO_RUN_JWT_SECRET must be set to a ≥32-char secret for runCustom callback signing',
        )
    }
    cachedSecret = new TextEncoder().encode(raw)
    return cachedSecret
}

export interface RunJwtClaims {
    workspaceId: string
    runId: string
    allowedTools: string[]
}

export async function issueRunJwt(claims: RunJwtClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return await new SignJWT({
        workspaceId: claims.workspaceId,
        runId: claims.runId,
        allowedTools: claims.allowedTools,
    })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + RUN_JWT_LIFETIME_S)
        .setIssuer('plexo-api')
        .sign(getSecret())
}

export async function verifyRunJwt(token: string): Promise<RunJwtClaims | null> {
    try {
        const { payload } = await jwtVerify(token, getSecret(), {
            issuer: 'plexo-api',
            algorithms: ['HS256'],
        })
        const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : null
        const runId = typeof payload.runId === 'string' ? payload.runId : null
        const allowedTools = Array.isArray(payload.allowedTools)
            ? payload.allowedTools.filter((t): t is string => typeof t === 'string')
            : null
        if (!workspaceId || !runId || !allowedTools) return null
        return { workspaceId, runId, allowedTools }
    } catch (err) {
        logger.warn({ err: (err as Error).message }, 'run-jwt verify failed')
        return null
    }
}
