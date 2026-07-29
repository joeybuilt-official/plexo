// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

export default function BehaviorRedirect() {
    redirect('/app/agents?tab=behavior')
}
