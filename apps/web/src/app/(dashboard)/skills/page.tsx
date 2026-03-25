// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

/** @deprecated Skills page has been renamed to Extensions in Fabric v0.3.0 */
export default function SkillsRedirect() {
    redirect('/extensions')
}
