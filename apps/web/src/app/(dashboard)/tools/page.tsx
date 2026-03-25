// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

/** @deprecated Tools page has been renamed to Functions in Fabric v0.3.0 */
export default function ToolsRedirect() {
    redirect('/functions')
}
