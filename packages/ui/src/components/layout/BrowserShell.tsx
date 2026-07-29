// SPDX-License-Identifier: MIT
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
