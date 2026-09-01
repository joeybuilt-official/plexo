// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Minimal health-check endpoint consumed by the scripts/deploy.sh smoke test.
 * Returns { status: "ok" } so the deploy pipeline can verify the app is up.
 */

import { NextResponse } from 'next/server'

export function GET() {
  return NextResponse.json({ status: 'ok' })
}
