// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { ulid } from 'ulid'

export function generateId(): string {
    return ulid()
}
