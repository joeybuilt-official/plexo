// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify a Twilio webhook signature.
 *
 * Algorithm (per https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 *   1. Take the full request URL (incl. query string).
 *   2. Sort the form-encoded POST params by key.
 *   3. Concatenate: url + key1 + value1 + key2 + value2 + ...
 *   4. HMAC-SHA1 with the channel's auth_token, base64-encoded.
 *   5. timing-safe compare to X-Twilio-Signature header.
 */
export function verifyTwilioSignature(
    url: string,
    params: Record<string, string>,
    signature: string,
    authToken: string,
): boolean {
    if (!signature || !authToken) return false

    const sortedKeys = Object.keys(params).sort()
    let data = url
    for (const key of sortedKeys) {
        data += key + params[key]
    }

    const expected = createHmac('sha1', authToken).update(data).digest('base64')

    const expectedBuf = Buffer.from(expected)
    const receivedBuf = Buffer.from(signature)
    if (expectedBuf.length !== receivedBuf.length) return false
    try {
        return timingSafeEqual(expectedBuf, receivedBuf)
    } catch {
        return false
    }
}
