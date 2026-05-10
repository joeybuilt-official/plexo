// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

export function DesktopShell({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
    return (
        <div className="flex h-screen overflow-hidden">
            {/* Desktop apps typically have subtle differences, like window drag regions or specific paddings.
                Tauri adds OS-level drag regions if configured. For now, it mirrors BrowserShell mostly.
                The main view relies on `isDesktop` for the two-pane Chat + Status view. */}
            <div className="shrink-0 hidden md:block" data-tauri-drag-region>
               {sidebar}
            </div>
            <main className="flex-1 overflow-auto bg-canvas p-6 relative">
                <div className="absolute top-0 left-0 right-0 h-4 z-50 pointer-events-none" data-tauri-drag-region />
                {children}
            </main>
        </div>
    )
}
