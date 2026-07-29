// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

/**
 * Legacy /setup page — previously a 7-step standalone wizard.
 * Now redirects to /app/home
 * which triggers the setup wizard overlay (Path B) for unconfigured workspaces.
 */
export default function SetupPage() {
    redirect('/app/home')
}
