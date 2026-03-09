// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

export default function BehaviorRedirect() {
    redirect('/settings/agent?tab=behavior')
}
