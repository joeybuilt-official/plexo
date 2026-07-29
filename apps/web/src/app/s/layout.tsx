// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { ThemeProvider } from '@web/components/theme-provider'

export default function ShareLayout({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            storageKey="plexo-theme"
            disableTransitionOnChange
        >
            {children}
        </ThemeProvider>
    )
}
