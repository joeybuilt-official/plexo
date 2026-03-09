// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useEffect, useState } from 'react'
import { getRuntimeContext } from '../../lib/runtime'
import { DesktopShell } from './DesktopShell'
import { MobileShell } from './MobileShell'
import { BrowserShell } from './BrowserShell'

export function AppShell({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
  const [runtime, setRuntime] = useState<'tauri' | 'capacitor' | 'browser' | null>(null)

  useEffect(() => {
    setRuntime(getRuntimeContext())
  }, [])

  if (runtime === null) {
    // Avoid hydration mismatch by rendering a minimal shell initially
    return <div className="flex h-screen overflow-hidden bg-zinc-950 items-center justify-center">Loading Plexo...</div>
  }

  if (runtime === 'capacitor') {
    return <MobileShell>{children}</MobileShell>
  } else if (runtime === 'tauri') {
    return <DesktopShell sidebar={sidebar}>{children}</DesktopShell>
  } else {
    return <BrowserShell sidebar={sidebar}>{children}</BrowserShell>
  }
}
