// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

export function BrowserShell({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
    return (
        <div className="flex h-screen overflow-hidden">
            {sidebar}
            <main className="flex-1 overflow-auto bg-canvas p-6">
                {children}
            </main>
        </div>
    )
}
