// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outbound SMS via Twilio's Messages API.
 *
 * No npm `twilio` dependency — direct HTTPS POST with Basic Auth.
 * Reference: https://www.twilio.com/docs/messaging/api/message-resource
 */

export interface SendTwilioSmsParams {
    accountSid: string
    authToken: string
    from: string
    to: string
    body: string
}

export interface SendTwilioSmsResult {
    ok: boolean
    messageSid?: string
    error?: string
    status?: number
}

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'

export async function sendTwilioSms(params: SendTwilioSmsParams): Promise<SendTwilioSmsResult> {
    const { accountSid, authToken, from, to, body } = params
    if (!accountSid || !authToken) return { ok: false, error: 'Missing Twilio credentials' }
    if (!from || !to) return { ok: false, error: 'Missing from/to phone numbers' }
    if (!body || !body.trim()) return { ok: false, error: 'Empty message body' }

    const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    const form = new URLSearchParams({ From: from, To: to, Body: body })

    let res: Response
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
    }

    if (res.status === 401) {
        return { ok: false, status: 401, error: 'Twilio auth rejected (check accountSid / authToken)' }
    }

    let payload: { sid?: string; message?: string; code?: number } = {}
    try { payload = await res.json() as typeof payload } catch { /* non-JSON body */ }

    if (!res.ok) {
        const errMsg = payload.message ?? `Twilio HTTP ${res.status}`
        return { ok: false, status: res.status, error: errMsg }
    }
    return { ok: true, status: res.status, messageSid: payload.sid }
}
