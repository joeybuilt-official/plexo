// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { createHash } from 'node:crypto'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../../logger.js'

export const ovhcloudRouter = Router()

const ENDPOINTS: Record<string, string> = {
    'ovh-eu': 'https://eu.api.ovh.com/1.0',
    'ovh-us': 'https://api.us.ovhcloud.com/1.0',
    'ovh-ca': 'https://ca.api.ovh.com/1.0',
}

async function ovhRequest(creds: Record<string, unknown>, method: string, path: string): Promise<any> {
    const appKey = (creds.application_key ?? '') as string
    const appSecret = (creds.application_secret ?? '') as string
    const consumerKey = (creds.consumer_key ?? '') as string
    const endpoint = (creds.endpoint ?? 'ovh-eu') as string
    const baseUrl = ENDPOINTS[endpoint] ?? ENDPOINTS['ovh-eu']!
    const url = `${baseUrl}${path}`

    const timeRes = await fetch(`${baseUrl}/auth/time`)
    const timestamp = await timeRes.text()
    const sig = '$1$' + createHash('sha1')
        .update(`${appSecret}+${consumerKey}+${method}+${url}++${timestamp}`)
        .digest('hex')

    const res = await fetch(url, {
        method,
        headers: {
            'X-Ovh-Application': appKey, 'X-Ovh-Consumer': consumerKey,
            'X-Ovh-Timestamp': timestamp, 'X-Ovh-Signature': sig,
            'Content-Type': 'application/json',
        },
    })
    if (!res.ok) throw new Error(`OVH: ${res.status}`)
    return res.json()
}

ovhcloudRouter.get('/servers', async (req, res) => {
    try {
        let wsId: string | null = null
        try { wsId = await resolveWorkspaceId(req) } catch (e) { logger.warn({ err: e }, 'cmd-center: workspace resolution failed') }
        if (!wsId) { res.json(freshResponse([])); return }
        const creds = await resolveCredentials(wsId, 'ovhcloud')
        if (!creds) { res.json(freshResponse([])); return }

        const result = await cachedFetch('cmd-center:ovhcloud:servers', 120, async () => {
            const serverNames = await ovhRequest(creds, 'GET', '/dedicated/server') as string[]
            const servers = await Promise.allSettled(
                serverNames.map(async (name) => {
                    const info = await ovhRequest(creds, 'GET', `/dedicated/server/${encodeURIComponent(name)}`)
                    return {
                        id: name, name: info.reverse ?? name,
                        status: info.state === 'ok' ? 'ok' : info.state === 'error' ? 'critical' : 'warning',
                        uptime: null,
                        metrics: { cpuPercent: null, memoryPercent: null, diskPercent: null, networkIn: null, networkOut: null },
                    }
                }),
            )
            return servers.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map(r => r.value)
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: ovhcloud servers failed')
        res.json(freshResponse([]))
    }
})
