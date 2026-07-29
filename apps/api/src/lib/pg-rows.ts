// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export function pgRows<T = Record<string, unknown>>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[]
    return ((result as { rows?: T[] }).rows) ?? []
}
