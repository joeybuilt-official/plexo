// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { timingSafeEqual } from 'node:crypto'

/** Constant-time string equality. Returns false on length mismatch (still
 *  constant in the equal-length branch), preventing timing-side-channel leaks
 *  of webhook secrets and similar credentials. */
export function timingSafeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
}
